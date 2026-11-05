import 'reflect-metadata';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { ChannelAccount } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import {
  PersonalService,
  WORKER_ID,
} from '../src/modules/zalo-personal/personal.service';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import { MessageStore } from '../src/modules/inbox/message-store';
import {
  PersonalAdapterError,
  type PersonalAdapter,
  type QrEvent,
  type PersonalLogin,
  type PersonalProfile,
} from '../src/modules/zalo-personal/personal-adapter';
import { publishEvent } from '../src/modules/realtime/publish';
import { config, crypto } from './helpers';
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test.',
  );
const personalConfig = {
  ...config,
  env: { ...config.env, DATABASE_URL: testUrl },
} as ConfigService;
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
const credentials = JSON.stringify({
  imei: 'fixture-imei',
  cookie: [{ key: 'fixture-cookie', value: 'private-fixture-cookie' }],
  userAgent: 'fixture-agent',
});
class FakeAdapter implements PersonalAdapter {
  state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' = 'DISCONNECTED';
  qr?: (event: QrEvent) => void;
  incoming?: (value: unknown) => void;
  closed?: (code: string) => void;
  resolveLogin?: (value: PersonalLogin) => void;
  rejectLogin?: (error: unknown) => void;
  getUserProfiles = vi.fn<(ids: string[]) => Promise<PersonalProfile[]>>(
    async () => [],
  );
  getStickerAssets = vi.fn(
    async (_ids: number[]) => [] as { stickerId: number; url: string }[],
  );
  getRecentMessages = vi.fn(async () => [] as unknown[]);
  restoreSession = vi.fn(async () => ({
    externalAccountId: '100000000000000001',
    credentials,
  }));
  sendTextMessage = vi.fn(async () => ({
    externalMessageId: '900000000000000001',
  }));
  connectWithQR(onEvent: (event: QrEvent) => void) {
    this.state = 'CONNECTING';
    this.qr = onEvent;
    onEvent({
      type: 'generated',
      image: 'data:image/png;base64,aGVsbG8=',
      expiresAt: new Date(Date.now() + 100000),
    });
    return new Promise<PersonalLogin>((resolve, reject) => {
      this.resolveLogin = resolve;
      this.rejectLogin = reject;
    });
  }
  getConnectionStatus() {
    return this.state;
  }
  async startListening(
    incoming: (value: unknown) => void,
    closed: (code: string) => void,
  ) {
    this.incoming = incoming;
    this.closed = closed;
    this.state = 'CONNECTED';
  }
  stopListening() {
    this.state = 'DISCONNECTED';
  }
  disconnect() {
    this.stopListening();
    this.rejectLogin?.(new PersonalAdapterError('ZALO_LOGIN_CANCELLED'));
  }
}
let app: NestExpressApplication;
let worker: PersonalWorker;
let sessions: ZaloSessionManager;
let personal: PersonalService;
let adapters: FakeAdapter[] = [];
const owner = 'administrator';
const origin = config.env.FRONTEND_URL;
const inbound = (id = '700000000000000001', self = false) => ({
  type: 0,
  threadId: '200000000000000001',
  isSelf: self,
  data: {
    msgId: id,
    uidFrom: self ? '100000000000000001' : '200000000000000001',
    idTo: self ? '200000000000000001' : '100000000000000001',
    dName: 'Fixture contact',
    ts: String(Date.now()),
    msgType: 'webchat',
    content: self ? 'Self-sent fixture' : 'Incoming fixture',
  },
});
function newWorker(configure?: (adapter: FakeAdapter) => void) {
  sessions = new ZaloSessionManager(() => {
    const adapter = new FakeAdapter();
    configure?.(adapter);
    adapters.push(adapter);
    return adapter;
  });
  return new PersonalWorker(
    db,
    personalConfig,
    crypto,
    sessions,
    new MessageStore(),
  );
}
async function cleanup() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
}
async function admin() {
  const agent = request.agent(app.getHttpServer());
  await agent
    .post('/api/auth/login')
    .set('Origin', origin)
    .send({ password: config.env.ADMIN_PASSWORD })
    .expect(200);
  return agent;
}
async function connected() {
  const account = await personal.create(owner, 'Fixture personal account');
  await personal.startQr(account.id, owner);
  await worker.tick();
  const adapter = adapters.at(-1)!;
  adapter.resolveLogin!({
    externalAccountId: '100000000000000001',
    credentials,
    name: 'Fixture account',
    avatarUrl: 'https://example.com/owner.jpg',
  });
  await vi.waitFor(async () =>
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'CONNECTED',
    ),
  );
  return {
    account: await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
    }),
    adapter,
  };
}
async function conversation(account: ChannelAccount) {
  await worker.receive(account, inbound(), '100000000000000001');
  return db.conversation.findFirstOrThrow({
    where: { channelAccountId: account.id },
  });
}
beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(ConfigService)
    .useValue(personalConfig)
    .compile();
  app = module.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  personal = app.get(PersonalService);
}, 30000);
beforeEach(async () => {
  app.get<ThrottlerStorageService>(ThrottlerStorage).onApplicationShutdown();
  await cleanup();
  adapters = [];
  worker = newWorker();
  await worker.start(false);
});
afterEach(async () => {
  await worker.stop();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await cleanup();
  if (app) await app.close();
  await db.$disconnect();
});
describe('personal channels, durable outbox and real PostgreSQL', () => {
  it('persists incoming and self-sent images with captions and previews without duplicate messages', async () => {
    const { account } = await connected();
    const event = {
      ...inbound(),
      data: {
        ...inbound().data,
        msgType: 'chat.photo',
        content: {
          href: 'https://example.com/photo.jpg',
          thumb: 'https://example.com/thumb.jpg',
          description: 'Photo caption',
          extraPrivateField: 'discarded',
        },
      },
    };
    await worker.receive(account, event, account.externalAccountId!);
    await worker.receive(account, event, account.externalAccountId!);
    const self = inbound('700000000000000002', true);
    await worker.receive(
      account,
      {
        ...self,
        data: {
          ...self.data,
          msgType: 'chat.photo',
          content: { href: 'https://example.com/outgoing.jpg' },
        },
      },
      account.externalAccountId!,
    );
    const conv = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: account.id },
    });
    const agent = await admin();
    const items = (
      await agent.get(`/api/conversations/${conv.id}/messages`).expect(200)
    ).body.data.items;
    expect(items).toHaveLength(2);
    expect(
      items.find((m: { direction: string }) => m.direction === 'INCOMING'),
    ).toMatchObject({
      type: 'image',
      content: 'Photo caption',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/photo.jpg',
          previewUrl: 'https://example.com/thumb.jpg',
        },
      ],
    });
    expect(
      items.find((m: { direction: string }) => m.direction === 'OUTGOING'),
    ).toMatchObject({
      type: 'image',
      attachments: [{ url: 'https://example.com/outgoing.jpg' }],
    });
    const receipts = await db.webhookEvent.findMany({
      where: { channelAccountId: account.id },
    });
    expect(JSON.stringify(receipts)).not.toContain('discarded');
    expect(
      (
        await db.message.findMany({ where: { channelAccountId: account.id } })
      ).every((m) => m.type === 'image'),
    ).toBe(true);
  });
  it('retains stickers before resolving assets and updates the same message after the asset lookup', async () => {
    const { account, adapter } = await connected();
    let resolveAssets!: (assets: { stickerId: number; url: string }[]) => void;
    adapter.getStickerAssets.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAssets = resolve;
        }),
    );
    const event = {
      ...inbound(),
      data: {
        ...inbound().data,
        msgType: 'chat.sticker',
        content: { id: '123' },
      },
    };
    await worker.receive(account, event, account.externalAccountId!);
    await vi.waitFor(() =>
      expect(adapter.getStickerAssets).toHaveBeenCalledWith([123]),
    );
    expect(await db.message.count()).toBe(1);
    const message = await db.message.findFirstOrThrow();
    expect(message).toMatchObject({
      type: 'sticker',
      metadata: {
        attachments: [{ type: 'sticker', payload: { stickerId: 123 } }],
      },
    });
    resolveAssets([
      { stickerId: 123, url: 'https://example.com/sticker.webp' },
    ]);
    await vi.waitFor(async () =>
      expect(
        (await db.message.findUniqueOrThrow({ where: { id: message.id } }))
          .metadata,
      ).toMatchObject({
        attachments: [{ payload: { url: 'https://example.com/sticker.webp' } }],
      }),
    );
    const agent = await admin();
    expect(
      (
        await agent
          .get(`/api/conversations/${message.conversationId}/messages`)
          .expect(200)
      ).body.data.items[0],
    ).toMatchObject({
      id: message.id,
      type: 'sticker',
      attachments: [
        { type: 'sticker', url: 'https://example.com/sticker.webp' },
      ],
    });
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'CONNECTED',
    );
  });
  it('repairs only known unsupported media IDs from one recent page without importing unrelated history', async () => {
    const { account, adapter } = await connected();
    const event = { ...inbound(), data: { ...inbound().data, content: {} } };
    await worker.receive(account, event, account.externalAccountId!);
    const saved = await db.message.findFirstOrThrow();
    const other = await personal.create('foreign-owner', 'Foreign');
    const foreignConv = await db.conversation.create({
      data: { channelAccountId: other.id, externalUserId: event.threadId },
    });
    const foreign = await db.message.create({
      data: {
        channelAccountId: other.id,
        conversationId: foreignConv.id,
        externalMessageId: event.data.msgId,
        direction: 'INCOMING',
        source: 'PERSONAL',
        type: 'unsupported',
        content: '',
        metadata: {},
        sentAt: new Date(Number(event.data.ts)),
      },
    });
    const photo = {
      ...event,
      data: {
        ...event.data,
        msgType: 'chat.photo',
        content: { href: 'https://example.com/recovered.jpg' },
      },
    };
    adapter.getRecentMessages.mockResolvedValue([
      { ...photo, threadId: '999' },
      { ...photo, data: { ...photo.data, msgId: '700000000000009999' } },
      photo,
    ]);
    await worker.repairRecentMedia(account, account.externalAccountId!);
    expect(adapter.getRecentMessages).toHaveBeenCalledTimes(1);
    expect(await db.message.count()).toBe(2);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({
      type: 'image',
      metadata: {
        attachments: [
          { payload: { url: 'https://example.com/recovered.jpg' } },
        ],
      },
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: foreign.id } })).type,
    ).toBe('unsupported');
    expect(
      (
        await db.webhookEvent.findFirstOrThrow({
          where: { channelAccountId: account.id },
        })
      ).payload,
    ).toMatchObject({
      type: 'image',
      attachments: [{ payload: { url: 'https://example.com/recovered.jpg' } }],
    });
  });
  it('ignores late history results after disconnect', async () => {
    const { account, adapter } = await connected();
    const event = { ...inbound(), data: { ...inbound().data, content: {} } };
    await worker.receive(account, event, account.externalAccountId!);
    const saved = await db.message.findFirstOrThrow();
    let resolveRecent!: (messages: unknown[]) => void;
    adapter.getRecentMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRecent = resolve;
        }),
    );
    const repairing = worker.repairRecentMedia(
      account,
      account.externalAccountId!,
    );
    await vi.waitFor(() =>
      expect(adapter.getRecentMessages).toHaveBeenCalledTimes(1),
    );
    await personal.disconnect(account.id, owner);
    resolveRecent([
      {
        ...event,
        data: {
          ...event.data,
          msgType: 'chat.photo',
          content: { href: 'https://example.com/late.jpg' },
        },
      },
    ]);
    await repairing;
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: saved.id } })).type,
    ).toBe('unsupported');
    expect(await db.message.count()).toBe(1);
  });
  it('retains media messages and keeps receiving text when sticker or recent-history lookup fails', async () => {
    const { account, adapter } = await connected();
    adapter.getStickerAssets.mockRejectedValue(new Error('Asset unavailable'));
    adapter.getRecentMessages.mockRejectedValue(
      new Error('History unavailable'),
    );
    await worker.receive(
      account,
      {
        ...inbound(),
        data: {
          ...inbound().data,
          msgType: 'chat.sticker',
          content: { id: 123 },
        },
      },
      account.externalAccountId!,
    );
    await vi.waitFor(() =>
      expect(adapter.getStickerAssets).toHaveBeenCalledTimes(1),
    );
    const legacy = inbound('700000000000000002');
    await worker.receive(
      account,
      { ...legacy, data: { ...legacy.data, content: {} } },
      account.externalAccountId!,
    );
    await worker.repairRecentMedia(account, account.externalAccountId!);
    await worker.receive(
      account,
      inbound('700000000000000003'),
      account.externalAccountId!,
    );
    expect(await db.message.count()).toBe(3);
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'CONNECTED',
    );
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
    expect(
      (await db.message.findFirstOrThrow({ where: { type: 'sticker' } }))
        .metadata,
    ).toMatchObject({ attachments: [{ payload: { stickerId: 123 } }] });
  });
  it('stores incoming messages before slow contact lookup completes and exposes contact avatars in list and detail DTOs', async () => {
    const { account, adapter } = await connected();
    const entry = sessions.get(account.id)!;
    await vi.waitFor(() => expect(entry.profileSync.busy).toBe(false));
    entry.profileSync.retryAt = 0;
    let resolveProfiles!: (profiles: PersonalProfile[]) => void;
    adapter.getUserProfiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve;
        }),
    );
    await worker.receive(account, inbound(), account.externalAccountId!);
    await vi.waitFor(() =>
      expect(adapter.getUserProfiles).toHaveBeenCalledWith([
        '200000000000000001',
      ]),
    );
    expect(await db.message.count()).toBe(1);
    const conv = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: account.id },
    });
    expect(conv.customerAvatar).toBeNull();
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'CONNECTED',
    );
    resolveProfiles([
      {
        externalUserId: conv.externalUserId,
        name: 'Profile contact',
        avatarUrl: 'https://example.com/contact.jpg',
      },
    ]);
    await vi.waitFor(async () =>
      expect(
        (await db.conversation.findUniqueOrThrow({ where: { id: conv.id } }))
          .customerAvatar,
      ).toBe('https://example.com/contact.jpg'),
    );
    const agent = await admin();
    expect(
      (await agent.get(`/api/conversations/${conv.id}`).expect(200)).body.data,
    ).toMatchObject({
      customerName: 'Profile contact',
      customerAvatar: 'https://example.com/contact.jpg',
      accountAvatar: 'https://example.com/owner.jpg',
    });
    expect(
      (await agent.get('/api/conversations').expect(200)).body.data.items[0]
        .customerAvatar,
    ).toBe('https://example.com/contact.jpg');
  });
  it('backfills old contacts after session restoration in bounded batches scoped to that account', async () => {
    const { account } = await connected();
    await db.conversation.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        channelAccountId: account.id,
        externalUserId: String(1000 + i),
      })),
    });
    const other = await personal.create('another-owner', 'Foreign channel');
    const foreign = await db.conversation.create({
      data: { channelAccountId: other.id, externalUserId: '1000' },
    });
    await worker.stop();
    worker = newWorker((adapter) =>
      adapter.getUserProfiles.mockImplementation(async (ids) =>
        ids.map((id) => ({
          externalUserId: id,
          name: `Contact ${id}`,
          avatarUrl: `https://example.com/${id}.jpg`,
        })),
      ),
    );
    await worker.start(false);
    await vi.waitFor(async () =>
      expect(
        await db.conversation.count({
          where: {
            channelAccountId: account.id,
            customerAvatar: { not: null },
          },
        }),
      ).toBe(50),
    );
    const entry = sessions.get(account.id)!;
    await vi.waitFor(() => expect(entry.profileSync.busy).toBe(false));
    entry.profileSync.nextAt = 0;
    entry.profileSync.retryAt = 0;
    await worker.tick();
    await vi.waitFor(async () =>
      expect(
        await db.conversation.count({
          where: {
            channelAccountId: account.id,
            customerAvatar: { not: null },
          },
        }),
      ).toBe(51),
    );
    expect(
      adapters.at(-1)!.getUserProfiles.mock.calls.map(([ids]) => ids.length),
    ).toEqual([50, 1]);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: foreign.id } }))
        .customerAvatar,
    ).toBeNull();
  });
  it('backs off failed profile requests without interrupting chats and ignores a late profile after disconnect', async () => {
    const { account, adapter } = await connected();
    const entry = sessions.get(account.id)!;
    await vi.waitFor(() => expect(entry.profileSync.busy).toBe(false));
    const conv = await db.conversation.create({
      data: {
        channelAccountId: account.id,
        externalUserId: '200000000000000001',
      },
    });
    adapter.getUserProfiles.mockRejectedValueOnce(
      new Error('Profile transport unavailable'),
    );
    entry.profileSync.nextAt = 0;
    entry.profileSync.retryAt = 0;
    await worker.syncContactProfiles(account);
    expect(entry.profileSync.retryAt).toBeGreaterThan(Date.now() + 50000);
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'CONNECTED',
    );
    await worker.tick();
    expect(adapter.getUserProfiles).toHaveBeenCalledTimes(1);
    let resolveProfiles!: (profiles: PersonalProfile[]) => void;
    adapter.getUserProfiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProfiles = resolve;
        }),
    );
    entry.profileSync.nextAt = 0;
    entry.profileSync.retryAt = 0;
    const syncing = worker.syncContactProfiles(account);
    await vi.waitFor(() =>
      expect(adapter.getUserProfiles).toHaveBeenCalledTimes(2),
    );
    await personal.disconnect(account.id, owner);
    resolveProfiles([
      {
        externalUserId: conv.externalUserId,
        name: 'Stale contact',
        avatarUrl: 'https://example.com/late.jpg',
      },
    ]);
    await syncing;
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: conv.id } }))
        .customerAvatar,
    ).toBeNull();
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'DISCONNECTED',
    );
  });
  it('filters accounts before pagination, distinguishes the same contact across accounts, and hides foreign accounts and credentials', async () => {
    const { account } = await connected();
    const first = await conversation(account);
    const second = await db.channelAccount.create({
      data: {
        ownerId: owner,
        name: 'Second account',
        externalAccountId: '300000000000000001',
        avatarUrl: 'https://example.com/second.jpg',
        encryptedCredentials: 'private-second-credentials',
      },
    });
    const secondChat = await db.conversation.create({
      data: {
        channelAccountId: second.id,
        externalUserId: first.externalUserId,
        lastMessageAt: new Date(Date.now() + 1000),
      },
    });
    await db.conversation.createMany({
      data: Array.from({ length: 31 }, (_, i) => ({
        channelAccountId: account.id,
        externalUserId: String(100 + i),
        lastMessageAt: new Date(Date.now() + 2000),
      })),
    });
    const foreign = await personal.create(
      'another-owner',
      'Hidden foreign account',
    );
    const oa = await db.zaloConnection.create({
      data: {
        oaId: '400000000000000001',
        oaName: 'Fixture OA',
        avatarUrl: 'https://example.com/oa.jpg',
        tokenExpiresAt: new Date(Date.now() + 100000),
      },
    });
    const oaChat = await db.conversation.create({
      data: { connectionId: oa.id, externalUserId: first.externalUserId },
    });
    await request(app.getHttpServer())
      .get('/api/conversations/accounts')
      .expect(401);
    const agent = await admin();
    const listed = (await agent.get('/api/conversations/accounts').expect(200))
      .body.data.accounts;
    expect(listed).toHaveLength(3);
    expect(
      listed.find((a: { id: string }) => a.id === account.id),
    ).toMatchObject({
      name: 'Fixture account',
      avatarUrl: 'https://example.com/owner.jpg',
      conversationCount: 32,
    });
    expect(JSON.stringify(listed)).not.toMatch(
      /encrypted|private-second-credentials|Hidden foreign account/,
    );
    const filtered = (
      await agent
        .get(`/api/conversations?account=personal:${second.id}&limit=1`)
        .expect(200)
    ).body.data;
    expect(filtered.hasMore).toBe(false);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id: secondChat.id,
      accountName: second.name,
      accountAvatar: second.avatarUrl,
      accountExternalId: second.externalAccountId,
    });
    const oaFiltered = (
      await agent.get(`/api/conversations?account=oa:${oa.id}`).expect(200)
    ).body.data;
    expect(oaFiltered.items).toMatchObject([
      { id: oaChat.id, channelType: 'ZALO_OA', accountAvatar: oa.avatarUrl },
    ]);
    expect(
      (
        await agent
          .get(`/api/conversations?account=personal:${foreign.id}`)
          .expect(200)
      ).body.data.items,
    ).toEqual([]);
    await agent.get('/api/conversations?account=invalid').expect(400);
    const all = (await agent.get('/api/conversations?limit=100').expect(200))
      .body.data.items;
    expect(all).toHaveLength(34);
    expect(
      all.filter(
        (c: { externalUserId: string }) =>
          c.externalUserId === first.externalUserId,
      ),
    ).toHaveLength(3);
    expect(
      (await agent.get(`/api/conversations/${first.id}`).expect(200)).body.data,
    ).toMatchObject({
      accountName: 'Fixture account',
      accountAvatar: 'https://example.com/owner.jpg',
    });
  });
  it('resumes a command claimed before the SENDING marker without losing queued work', async () => {
    const { account } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Claimed before send',
      idempotencyKey: randomUUID(),
    });
    await db.personalCommand.update({
      where: { messageId: queued.id },
      data: { status: 'PROCESSING', attempts: 1 },
    });
    await worker.stop();
    worker = newWorker();
    await worker.start(false);
    await vi.waitFor(async () =>
      expect((await personal.status(account.id, owner)).connectionStatus).toBe(
        'CONNECTED',
      ),
    );
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('SENT');
    expect(adapters.at(-1)!.sendTextMessage).toHaveBeenCalledTimes(1);
  });
  it('bounds safe retries and allows an explicit retry only after a proven failure', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Bounded retry',
      idempotencyKey: randomUUID(),
    });
    adapter.sendTextMessage.mockRejectedValue(
      new PersonalAdapterError('ZALO_NOT_CONNECTED', true),
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.personalCommand.update({
        where: { messageId: queued.id },
        data: { availableAt: new Date(0) },
      });
      await db.channelAccount.update({
        where: { id: account.id },
        data: { lastSendAt: null },
      });
      await worker.tick();
    }
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('FAILED');
    await worker.tick();
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(3);
    adapter.sendTextMessage.mockResolvedValue({
      externalMessageId: '900000000000000003',
    });
    await personal.retry(conv.id, queued.id, owner);
    await db.channelAccount.update({
      where: { id: account.id },
      data: { lastSendAt: null },
    });
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('SENT');
  });
  it('throttles external sends per account without counting the delay as a delivery attempt', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    await personal.send(conv.id, owner, {
      content: 'First',
      idempotencyKey: randomUUID(),
    });
    const second = await personal.send(conv.id, owner, {
      content: 'Second',
      idempotencyKey: randomUUID(),
    });
    await worker.tick();
    await worker.tick();
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(1);
    const command = await db.personalCommand.findUniqueOrThrow({
      where: { messageId: second.id },
    });
    expect(command.status).toBe('PENDING');
    expect(command.attempts).toBe(0);
    expect(command.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
  it('retains a failed personal inbound receipt and replays it without duplicate messages', async () => {
    const { account } = await connected();
    const persist = vi
      .spyOn(MessageStore.prototype, 'persistPersonal')
      .mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(
      worker.receive(account, inbound(), '100000000000000001'),
    ).rejects.toThrow('synthetic persistence failure');
    const receipt = await db.webhookEvent.findFirstOrThrow({
      where: { channelAccountId: account.id },
    });
    expect(receipt.status).toBe('FAILED');
    expect(await db.message.count()).toBe(0);
    persist.mockRestore();
    await worker.processInbound(receipt.id);
    await worker.processInbound(receipt.id);
    expect(await db.message.count()).toBe(1);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }))
        .status,
    ).toBe('PROCESSED');
  });
  it('authenticates endpoints and rejects cross-owner account and conversation access', async () => {
    await request(app.getHttpServer())
      .get('/api/channels/zalo-personal')
      .expect(401);
    await request(app.getHttpServer()).get('/api/events').expect(401);
    const foreign = await personal.create('another-owner', 'Private account');
    const conv = await db.conversation.create({
      data: { channelAccountId: foreign.id, externalUserId: '99' },
    });
    const agent = await admin();
    await agent.get(`/api/channels/${foreign.id}/status`).expect(404);
    await agent
      .post(`/api/channels/${foreign.id}/login/qr`)
      .set('Origin', origin)
      .expect(404);
    await agent.get(`/api/conversations/${conv.id}/messages`).expect(404);
    await agent
      .post(`/api/conversations/${conv.id}/messages`)
      .set('Origin', origin)
      .send({ content: 'No access', idempotencyKey: randomUUID() })
      .expect(404);
    expect(
      (await agent.get('/api/conversations').expect(200)).body.data.items,
    ).toHaveLength(0);
  });
  it('creates a single QR attempt for repeated requests and returns no session credentials', async () => {
    const agent = await admin();
    const created = await agent
      .post('/api/channels/zalo-personal')
      .set('Origin', origin)
      .send({ name: 'Test channel' })
      .expect(201);
    const id = created.body.data.id;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        agent
          .post(`/api/channels/${id}/login/qr`)
          .set('Origin', origin)
          .expect(202),
      ),
    );
    expect(
      await db.personalCommand.count({ where: { kind: 'LOGIN_QR' } }),
    ).toBe(1);
    await worker.tick();
    await vi.waitFor(async () =>
      expect((await personal.status(id, owner)).qrStatus).toBe('GENERATED'),
    );
    const status = await agent.get(`/api/channels/${id}/status`).expect(200);
    expect(status.body.data.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(status.body)).not.toMatch(
      /imei|encryptedCredentials|private-fixture-cookie/,
    );
    await agent
      .post(`/api/channels/${id}/login/cancel`)
      .set('Origin', origin)
      .expect(200);
    await worker.tick();
    adapters[0].qr?.({ type: 'scanned' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await personal.status(id, owner)).connectionStatus).toBe(
      'DISCONNECTED',
    );
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id } }))
        .encryptedQr,
    ).toBeNull();
  });
  it.each(['expired', 'declined'] as const)(
    'handles QR %s state without leaking or retaining QR data',
    async (type) => {
      const account = await personal.create(owner, 'QR fixture');
      await personal.startQr(account.id, owner);
      await worker.tick();
      const adapter = adapters[0];
      adapter.qr?.({ type });
      adapter.rejectLogin?.(
        new PersonalAdapterError(
          type === 'expired' ? 'ZALO_QR_EXPIRED' : 'ZALO_QR_DECLINED',
        ),
      );
      await vi.waitFor(async () =>
        expect((await personal.status(account.id, owner)).qrStatus).toBe(
          type === 'expired' ? 'EXPIRED' : 'DECLINED',
        ),
      );
      expect((await personal.status(account.id, owner)).qrImage).toBeNull();
    },
  );
  it('persists inbound and self-sent text once in the existing unified inbox', async () => {
    const { account, adapter } = await connected();
    adapter.incoming?.(inbound());
    adapter.incoming?.(inbound());
    await vi.waitFor(async () => expect(await db.message.count()).toBe(1));
    await worker.receive(
      account,
      inbound('700000000000000002', true),
      '100000000000000001',
    );
    expect(await db.conversation.count()).toBe(1);
    expect(await db.message.count()).toBe(2);
    const agent = await admin();
    const list = await agent.get('/api/conversations').expect(200);
    expect(list.body.data.items[0]).toMatchObject({
      channelType: 'ZALO_PERSONAL',
      canSend: true,
    });
    expect(JSON.stringify(list.body)).not.toContain('private-fixture-cookie');
    expect(
      (await db.message.findFirstOrThrow({ where: { direction: 'OUTGOING' } }))
        .source,
    ).toBe('PERSONAL');
  });
  it('queues an idempotent outbound message through HTTP and completes its worker delivery', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const agent = await admin();
    const body = { content: 'Reply fixture', idempotencyKey: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        agent
          .post(`/api/conversations/${conv.id}/messages`)
          .set('Origin', origin)
          .send(body)
          .expect(202),
      ),
    );
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
    expect(results[0].body.data.deliveryStatus).toBe('PENDING');
    await worker.tick();
    const sent = await db.message.findUniqueOrThrow({
      where: { id: results[0].body.data.id },
    });
    expect(sent.deliveryStatus).toBe('SENT');
    expect(sent.externalMessageId).toBe('900000000000000001');
    expect(adapter.sendTextMessage).toHaveBeenCalledExactlyOnceWith(
      conv.externalUserId,
      body.content,
    );
    const replay = await agent
      .post(`/api/conversations/${conv.id}/messages`)
      .set('Origin', origin)
      .send(body)
      .expect(202);
    expect(replay.body.data.deliveryStatus).toBe('SENT');
    await worker.tick();
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(1);
    await agent
      .post(`/api/conversations/${conv.id}/messages`)
      .set('Origin', origin)
      .send({ ...body, content: 'Different content' })
      .expect(409);
    await agent
      .post(`/api/conversations/${conv.id}/messages`)
      .set('Origin', origin)
      .send({ ...body, idempotencyKey: 'invalid' })
      .expect(400);
  });
  it('deduplicates a self echo received before the send acknowledgement is saved', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Self-sent fixture',
      idempotencyKey: randomUUID(),
    });
    adapter.sendTextMessage.mockImplementationOnce(async () => {
      await worker.receive(
        account,
        inbound('900000000000000001', true),
        '100000000000000001',
      );
      return { externalMessageId: '900000000000000001' };
    });
    await worker.tick();
    expect(await db.message.count({ where: { direction: 'OUTGOING' } })).toBe(
      1,
    );
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('SENT');
  });
  it('marks the delivery UNKNOWN if persistence fails after an external send succeeds', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const input = {
      content: 'Ambiguous fixture',
      idempotencyKey: randomUUID(),
    };
    const queued = await personal.send(conv.id, owner, input);
    vi.spyOn(worker, 'finalizeSend').mockRejectedValueOnce(
      new Error('synthetic database failure after provider success'),
    );
    await worker.tick();
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    expect((await personal.send(conv.id, owner, input)).id).toBe(queued.id);
    await worker.tick();
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(1);
    await expect(
      personal.retry(conv.id, queued.id, owner),
    ).rejects.toMatchObject({ code: 'ZALO_SEND_UNKNOWN' });
  });
  it('recovers interrupted sends as UNKNOWN after restart and restores encrypted sessions', async () => {
    const { account } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Crash fixture',
      idempotencyKey: randomUUID(),
    });
    await db.message.update({
      where: { id: queued.id },
      data: { deliveryStatus: 'SENDING', sendingAt: new Date() },
    });
    await db.personalCommand.update({
      where: { messageId: queued.id },
      data: { status: 'PROCESSING' },
    });
    const encrypted = (
      await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } })
    ).encryptedCredentials!;
    expect(encrypted).not.toContain('private-fixture-cookie');
    expect(crypto.decrypt(encrypted)).toBe(credentials);
    await worker.stop();
    worker = newWorker();
    await worker.start(false);
    await vi.waitFor(async () =>
      expect((await personal.status(account.id, owner)).connectionStatus).toBe(
        'CONNECTED',
      ),
    );
    expect(adapters.at(-1)!.restoreSession).toHaveBeenCalledWith(credentials);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    await worker.tick();
    expect(adapters.at(-1)!.sendTextMessage).not.toHaveBeenCalled();
  });
  it('retries only proven pre-send failures with bounded attempts and backoff', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Safe retry fixture',
      idempotencyKey: randomUUID(),
    });
    adapter.sendTextMessage.mockRejectedValueOnce(
      new PersonalAdapterError('ZALO_NOT_CONNECTED', true),
    );
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('PENDING');
    expect(
      (
        await db.personalCommand.findUniqueOrThrow({
          where: { messageId: queued.id },
        })
      ).availableAt.getTime(),
    ).toBeGreaterThan(Date.now());
    await db.personalCommand.update({
      where: { messageId: queued.id },
      data: { availableAt: new Date(0) },
    });
    await db.channelAccount.update({
      where: { id: account.id },
      data: { lastSendAt: null },
    });
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('SENT');
    expect(adapter.sendTextMessage).toHaveBeenCalledTimes(2);
  });
  it('requires reauthorization when encrypted restore credentials are invalid', async () => {
    const account = await db.channelAccount.create({
      data: {
        ownerId: owner,
        encryptedCredentials: 'tampered',
        connectionStatus: 'RECONNECTING',
      },
    });
    await worker.restore(account);
    expect((await personal.status(account.id, owner)).connectionStatus).toBe(
      'REAUTH_REQUIRED',
    );
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .encryptedCredentials,
    ).toBeNull();
  });
  it('prevents a second worker from controlling the same accounts', async () => {
    const second = new PersonalWorker(
      db,
      personalConfig,
      crypto,
      new ZaloSessionManager(() => new FakeAdapter()),
      new MessageStore(),
    );
    await expect(second.start(false)).rejects.toThrow(
      'already owns this database',
    );
    await second.stop();
    expect(
      await db.personalWorkerState.count({ where: { id: WORKER_ID } }),
    ).toBe(1);
  });
  it('disconnects listeners, removes local credentials and cancels queued sends', async () => {
    const { account, adapter } = await connected();
    const conv = await conversation(account);
    const queued = await personal.send(conv.id, owner, {
      content: 'Cancelled fixture',
      idempotencyKey: randomUUID(),
    });
    await personal.disconnect(account.id, owner);
    await worker.tick();
    const saved = await db.channelAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(saved.encryptedCredentials).toBeNull();
    expect(saved.encryptedQr).toBeNull();
    expect(adapter.getConnectionStatus()).toBe('DISCONNECTED');
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: queued.id } }))
        .deliveryStatus,
    ).toBe('FAILED');
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
    expect(await db.conversation.count()).toBe(1);
  });
  it('streams committed owner-filtered events over authenticated SSE', async () => {
    const server = app.getHttpServer();
    const login = await request(server)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ password: config.env.ADMIN_PASSWORD })
      .expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const address = server.address();
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/events`,
      { headers: { Cookie: cookie }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    try {
      await db.$transaction(async (tx) => {
        await publishEvent(tx, 'another-owner', {
          type: 'message.created',
          messageId: 'foreign',
        });
        await publishEvent(tx, owner, {
          type: 'message.created',
          messageId: 'visible',
        });
      });
      const result = await reader.read();
      const text = new TextDecoder().decode(result.value);
      expect(text).toContain('visible');
      expect(text).not.toContain('foreign');
      await expect(
        db.$transaction(async (tx) => {
          await publishEvent(tx, owner, {
            type: 'message.created',
            messageId: 'rolled-back',
          });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
