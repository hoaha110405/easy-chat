import 'reflect-metadata';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { conversationFilterSchema, paginationSchema } from '@zalo/shared';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import type { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import { FACEBOOK_PAGE_PERMISSIONS } from '../src/modules/facebook-page/facebook-page.service';
import { FacebookPageWorker } from '../src/modules/facebook-page/facebook-page.worker';
import {
  FacebookGraphClient,
  FacebookGraphError,
} from '../src/modules/facebook-page/facebook-graph.client';
import {
  MessageStore,
  type NormalizedMessage,
} from '../src/modules/inbox/message-store';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { PAGE_WINDOW_MS } from '../src/modules/messaging/channel-policy';
import {
  PersonalService,
  WORKER_ID,
} from '../src/modules/zalo-personal/personal.service';
import { config, crypto } from './helpers';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test.',
  );
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
const testConfig = {
  ...config,
  env: { ...config.env, DATABASE_URL: testUrl },
} as ConfigService;
const owner = 'administrator';
const store = new MessageStore();
const inbox = new InboxService(db);
const personal = new PersonalService(db, testConfig, crypto);
const pageId = '100000000000001';
const peerId = '200000000000002';
const fixtureToken = 'private-page-fixture-token';
function graphMock() {
  return {
    listConversations: vi
      .fn<FacebookGraphClient['listConversations']>()
      .mockResolvedValue({ items: [], after: null }),
    listMessages: vi
      .fn<FacebookGraphClient['listMessages']>()
      .mockResolvedValue({ items: [], after: null }),
    getUserProfile: vi
      .fn<FacebookGraphClient['getUserProfile']>()
      .mockResolvedValue({
        id: peerId,
        name: 'Page customer',
        avatarUrl: 'https://example.com/contact.jpg',
      }),
    sendText: vi
      .fn<FacebookGraphClient['sendText']>()
      .mockResolvedValue({ messageId: 'mid.outbound', recipientId: peerId }),
  };
}
let graph: ReturnType<typeof graphMock>;
let worker: FacebookPageWorker;
async function cleanup() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
}
async function account(data: Partial<Prisma.ChannelAccountCreateInput> = {}) {
  return db.channelAccount.create({
    data: {
      ownerId: owner,
      channelType: 'FACEBOOK_PAGE',
      externalAccountId: pageId,
      name: 'Facebook fixture Page',
      connectionStatus: 'CONNECTED',
      encryptedCredentials: crypto.encrypt(
        JSON.stringify({
          pageId: data.externalAccountId ?? pageId,
          accessToken: fixtureToken,
        }),
      ),
      ...data,
    },
  });
}
function normalized(input: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    oaId: '',
    userId: peerId,
    externalMessageId: 'mid.inbound',
    direction: 'INCOMING',
    type: 'text',
    content: 'Incoming Page fixture',
    sentAt: new Date(Date.now() - 1000),
    metadata: {},
    source: 'FACEBOOK',
    ...input,
  };
}
async function persist(
  channel: ChannelAccount,
  input: Partial<NormalizedMessage> = {},
) {
  const message = normalized(input);
  return db.$transaction((tx) =>
    store.persistChannel(
      tx,
      channel.id,
      message,
      message.direction === 'OUTGOING'
        ? channel.externalAccountId!
        : message.userId,
    ),
  );
}
async function activeConversation(
  channel: ChannelAccount,
  input: Partial<NormalizedMessage> = {},
) {
  const saved = await persist(channel, input);
  return db.conversation.findUniqueOrThrow({
    where: { id: saved.conversationId },
  });
}
async function claim(id: string) {
  return db.personalCommand.update({
    where: { id },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
}
async function queued(channel: ChannelAccount, content = 'Page reply') {
  const conversation = await activeConversation(channel);
  const message = await personal.send(conversation.id, channel.ownerId, {
    content,
    idempotencyKey: randomUUID(),
  });
  const command = await db.personalCommand.findUniqueOrThrow({
    where: { messageId: message.id },
  });
  return { conversation, message, command: await claim(command.id) };
}
async function run(command: PersonalCommand, channel: ChannelAccount) {
  await worker.process(command, channel, () => true);
}
async function receipt(
  channel: ChannelAccount,
  event: Prisma.InputJsonObject,
  overrides: Partial<Prisma.WebhookEventUncheckedCreateInput> = {},
) {
  return db.webhookEvent.create({
    data: {
      digest: randomUUID(),
      channelAccountId: channel.id,
      eventName: 'facebook.page',
      payload: { pageId: channel.externalAccountId!, event },
      ...overrides,
    },
  });
}
function event(input: Prisma.InputJsonObject = {}): Prisma.InputJsonObject {
  return {
    sender: { id: peerId },
    recipient: { id: pageId },
    timestamp: Date.now(),
    message: { mid: 'mid.webhook', text: 'Webhook fixture' },
    ...input,
  };
}

beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  await db.$connect();
}, 30000);
beforeEach(async () => {
  await cleanup();
  await db.personalWorkerState.create({
    data: { id: WORKER_ID, instanceId: randomUUID(), heartbeatAt: new Date() },
  });
  graph = graphMock();
  worker = new FacebookPageWorker(
    db,
    crypto,
    graph as unknown as FacebookGraphClient,
    store,
  );
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe('Facebook Page on the shared PostgreSQL inbox and outbox', () => {
  it('routes real authenticated OAuth, Page selection and signed raw webhooks through the existing HTTP app', async () => {
    const appId = '999000111';
    const appSecret = 'fixture-meta-app-secret';
    const verifyToken = 'fixture-meta-verify';
    const httpConfig = {
      ...testConfig,
      env: {
        ...testConfig.env,
        FACEBOOK_APP_ID: appId,
        FACEBOOK_APP_SECRET: appSecret,
        FACEBOOK_VERIFY_TOKEN: verifyToken,
      },
      facebookConfigured: true,
      facebookWebhookConfigured: true,
    } as ConfigService;
    const provider = {
      ...graph,
      exchangeCode: vi
        .fn()
        .mockResolvedValue({ accessToken: 'short-private-token' }),
      exchangeLongLivedToken: vi
        .fn()
        .mockResolvedValue({ accessToken: 'long-private-token' }),
      inspectToken: vi.fn(async (token: string) => ({
        valid: true,
        appId,
        type: token === fixtureToken ? 'PAGE' : 'USER',
        profileId: token === fixtureToken ? pageId : null,
        expiresAt: 0,
        dataAccessExpiresAt: 0,
        scopes: FACEBOOK_PAGE_PERMISSIONS,
        granularScopes: [],
      })),
      grantedPermissions: vi.fn().mockResolvedValue(
        FACEBOOK_PAGE_PERMISSIONS.map((permission) => ({
          permission,
          status: 'granted',
        })),
      ),
      listPages: vi.fn().mockResolvedValue({
        items: [
          {
            id: pageId,
            name: 'OAuth Page',
            avatarUrl: null,
            accessToken: fixtureToken,
            tasks: ['MESSAGING'],
          },
        ],
        after: null,
      }),
      getPage: vi
        .fn()
        .mockResolvedValue({ id: pageId, name: 'OAuth Page', avatarUrl: null }),
      subscribePage: vi.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(httpConfig)
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(FacebookGraphClient)
      .useValue(provider)
      .compile();
    const app = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
      logger: false,
    });
    configureApp(app);
    await app.init();
    try {
      const server = app.getHttpServer();
      await request(server)
        .get('/api/channels/facebook-personal/status')
        .expect(401);
      await request(server).get('/api/channels/facebook-page').expect(401);
      const session = request.agent(server);
      await session
        .post('/api/auth/login')
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .send({ password: httpConfig.env.ADMIN_PASSWORD })
        .expect(200);
      const personalStatus = await session
        .get('/api/channels/facebook-personal/status')
        .expect(200);
      expect(personalStatus.body.data).toMatchObject({
        status: 'UNSUPPORTED',
        capabilities: { connect: false, e2ee: false, sendText: false },
      });
      await session
        .post('/api/channels/facebook-personal/connect')
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .send({})
        .expect(501);
      await session
        .post('/api/channels/facebook-page/select')
        .send({ pageId })
        .expect(403);
      const connect = await session
        .get('/api/channels/facebook-page/connect')
        .expect(200);
      const state = new URL(
        connect.body.data.authorizationUrl,
      ).searchParams.get('state');
      const callback = await session
        .get('/api/channels/facebook-page/oauth/callback')
        .query({ state, code: 'actual-authorization-fixture' })
        .expect(303);
      expect(callback.headers.location).toBe(
        httpConfig.env.FRONTEND_URL + '/facebook/page?oauth=select',
      );
      const status = await session
        .get('/api/channels/facebook-page')
        .expect(200);
      expect(status.body.data.availablePages).toEqual([
        { id: pageId, name: 'OAuth Page', avatarUrl: null },
      ]);
      expect(JSON.stringify(status.body)).not.toContain(fixtureToken);
      const selected = await session
        .post('/api/channels/facebook-page/select')
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .send({ pageId })
        .expect(200);
      const linked = await db.channelAccount.findUniqueOrThrow({
        where: { id: selected.body.data.id },
      });
      expect(linked.connectionStatus).toBe('CONNECTED');
      expect(crypto.decrypt(linked.encryptedCredentials!)).toContain(
        fixtureToken,
      );
      expect(selected.body.data.encryptedCredentials).toBeUndefined();
      expect(
        await db.personalCommand.count({
          where: { channelAccountId: linked.id, kind: 'SYNC' },
        }),
      ).toBe(1);
      await request(server)
        .get('/api/channels/facebook-page/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': verifyToken,
          'hub.challenge': 'exact-challenge',
        })
        .expect(200, 'exact-challenge');
      const raw = JSON.stringify({
        object: 'page',
        entry: [{ id: pageId, messaging: [event()] }],
      });
      const signature =
        'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
      await request(server)
        .post('/api/channels/facebook-page/webhook')
        .set('Content-Type', 'application/json')
        .send(raw)
        .expect(401);
      for (let i = 0; i < 2; i++)
        await request(server)
          .post('/api/channels/facebook-page/webhook')
          .set('Content-Type', 'application/json')
          .set('X-Hub-Signature-256', signature)
          .send(raw)
          .expect(200);
      expect(await db.message.count()).toBe(0);
      const savedReceipt = await db.webhookEvent.findFirstOrThrow({
        where: { channelAccountId: linked.id },
      });
      expect(await db.webhookEvent.count()).toBe(1);
      await worker.processInbound(savedReceipt.id);
      const chats = await session
        .get('/api/conversations')
        .query({ channelType: 'FACEBOOK_PAGE' })
        .expect(200);
      expect(chats.body.data.items).toHaveLength(1);
      const chat = chats.body.data.items[0];
      expect(chat.channelType).toBe('FACEBOOK_PAGE');
      expect(chat.canSend).toBe(true);
      const body = { content: 'HTTP user reply', idempotencyKey: randomUUID() };
      const sent = await session
        .post(`/api/conversations/${chat.id}/messages`)
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .send(body)
        .expect(202);
      const again = await session
        .post(`/api/conversations/${chat.id}/messages`)
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .send(body)
        .expect(202);
      expect(again.body.data.id).toBe(sent.body.data.id);
      expect(provider.sendText).not.toHaveBeenCalled();
      await session
        .get(`/api/conversations/${chat.id}/messages`)
        .query({ cursor: 'bad-cursor' })
        .expect(400);
      const foreign = await account({
        ownerId: 'foreign-owner',
        externalAccountId: '999888777',
      });
      await session
        .delete(`/api/channels/${foreign.id}`)
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .expect(404);
      await session
        .delete(`/api/channels/${linked.id}`)
        .set('Origin', httpConfig.env.FRONTEND_URL)
        .expect(200);
      expect(
        (
          await db.channelAccount.findUniqueOrThrow({
            where: { id: linked.id },
          })
        ).encryptedCredentials,
      ).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reuses the one leased worker for Page receipts and sending without restoring a Page as Zalo', async () => {
    const page = await account();
    const disabledZalo = await account({
      channelType: 'ZALO_PERSONAL',
      name: 'Disabled Zalo fixture',
    });
    const disabledLogin = await db.personalCommand.create({
      data: {
        channelAccountId: disabledZalo.id,
        generation: disabledZalo.generation,
        kind: 'LOGIN_QR',
        deduplicationKey: randomUUID(),
      },
    });
    const interrupted = await queued(page);
    await db.message.update({
      where: { id: interrupted.message.id },
      data: { deliveryStatus: 'SENDING' },
    });
    const resumed = await queued(page, 'Resume after restart');
    const inbound = await receipt(
      page,
      event({ message: { mid: 'mid.worker.inbound', text: 'Worker message' } }),
    );
    const sessions = {
      disconnectAll: vi.fn(),
      entries: () => [],
      restore: vi.fn(),
    } as unknown as ZaloSessionManager;
    const main = new PersonalWorker(
      db,
      {
        ...testConfig,
        env: { ...testConfig.env, ZALO_PERSONAL_ENABLED: false },
        facebookConfigured: true,
      } as ConfigService,
      crypto,
      sessions,
      store,
      worker,
    );
    try {
      await main.start(false);
      expect(
        (
          await db.message.findUniqueOrThrow({
            where: { id: interrupted.message.id },
          })
        ).deliveryStatus,
      ).toBe('UNKNOWN');
      await main.tick();
      expect(
        (await db.webhookEvent.findUniqueOrThrow({ where: { id: inbound.id } }))
          .status,
      ).toBe('PROCESSED');
      expect(
        (
          await db.message.findUniqueOrThrow({
            where: { id: resumed.message.id },
          })
        ).deliveryStatus,
      ).toBe('SENT');
      expect(graph.sendText).toHaveBeenCalledTimes(1);
      expect(sessions.restore).not.toHaveBeenCalled();
      await main.tick();
      expect(
        (
          await db.personalCommand.findUniqueOrThrow({
            where: { id: disabledLogin.id },
          })
        ).status,
      ).toBe('FAILED');
    } finally {
      await main.stop();
    }
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }))
        .connectionStatus,
    ).toBe('CONNECTED');
  });
  it('scopes equal external account IDs by channel and owner, with explicit inbox filters and owner isolation', async () => {
    const page = await account();
    const zalo = await account({
      channelType: 'ZALO_PERSONAL',
      name: 'Existing Zalo fixture',
    });
    const foreign = await account({
      ownerId: 'another-workspace',
      name: 'Foreign Page',
    });
    const pageConversation = await activeConversation(page);
    const foreignConversation = await activeConversation(foreign);
    const zaloConversation = await db.conversation.create({
      data: { channelAccountId: zalo.id, externalUserId: peerId },
    });
    const listed = await inbox.accounts(owner);
    expect(listed.accounts.map((a) => a.key)).toEqual(
      expect.arrayContaining([
        `facebook-page:${page.id}`,
        `personal:${zalo.id}`,
      ]),
    );
    expect(listed.accounts.some((a) => a.id === foreign.id)).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(fixtureToken);
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({ channelType: 'FACEBOOK_PAGE' }),
          owner,
        )
      ).items.map((c) => c.id),
    ).toEqual([pageConversation.id]);
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({
            account: `facebook-page:${page.id}`,
          }),
          owner,
        )
      ).items.map((c) => c.id),
    ).toEqual([pageConversation.id]);
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({ account: `personal:${page.id}` }),
          owner,
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({ account: `personal:${zalo.id}` }),
          owner,
        )
      ).items.map((c) => c.id),
    ).toEqual([zaloConversation.id]);
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({
            account: `facebook-page:${foreign.id}`,
          }),
          owner,
        )
      ).items,
    ).toEqual([]);
    await expect(
      inbox.conversation(foreignConversation.id, owner),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(
      inbox.messages(foreignConversation.id, paginationSchema.parse({}), owner),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(
      personal.send(foreignConversation.id, owner, {
        content: 'Forbidden',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(worker.enqueue(owner, foreign.id)).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    await expect(personal.startQr(page.id, owner)).rejects.toMatchObject({
      code: 'CHANNEL_UNSUPPORTED',
    });
  });

  it('deduplicates Page messages and keeps incoming clocks independent of echoes, old backfill and replay payloads', async () => {
    const page = await account();
    const at = new Date(Date.now() - 20000);
    const first = await persist(page, { sentAt: at });
    const again = await persist(page, { sentAt: at });
    expect(again).toMatchObject({
      duplicate: true,
      messageId: first.messageId,
    });
    await persist(page, {
      externalMessageId: 'mid.echo',
      direction: 'OUTGOING',
      sentAt: new Date(),
    });
    await persist(page, {
      externalMessageId: 'mid.oldhistory',
      sentAt: new Date(at.getTime() - PAGE_WINDOW_MS * 2),
    });
    await persist(page, {
      externalMessageId: 'mid.inbound',
      sentAt: new Date(at.getTime() + 10000),
    });
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { id: first.conversationId },
    });
    expect(conversation.externalThreadType).toBe('PAGE_PSID');
    expect(conversation.lastInboundAt).toEqual(at);
    expect(
      await db.message.count({ where: { channelAccountId: page.id } }),
    ).toBe(3);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: first.messageId } }))
        .sentAt,
    ).toEqual(at);
    const other = await account({ externalAccountId: '100000000000009' });
    await persist(other, { sentAt: at });
    expect(
      await db.message.count({ where: { externalMessageId: 'mid.inbound' } }),
    ).toBe(2);
  });

  it('queues Page UUIDs once, rejects conflicts, and retrieves the same pending request after the window closes', async () => {
    const page = await account();
    const conversation = await activeConversation(page);
    const input = {
      content: 'Explicit Page reply',
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([
      personal.send(conversation.id, owner, input),
      personal.send(conversation.id, owner, input),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0]).toMatchObject({
      source: 'FACEBOOK',
      deliveryStatus: 'PENDING',
    });
    expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(1);
    await expect(
      personal.send(conversation.id, owner, {
        ...input,
        content: 'Changed request',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await db.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: new Date(Date.now() - PAGE_WINDOW_MS - 1000) },
    });
    await expect(
      personal.send(conversation.id, owner, input),
    ).resolves.toMatchObject({ id: results[0].id });
    await expect(
      personal.send(conversation.id, owner, {
        content: 'New prohibited reply',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED' });
    expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(1);
    expect(await inbox.conversation(conversation.id, owner)).toMatchObject({
      canSend: false,
      sendBlockedReason: 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED',
    });
  });

  it('checks the Page reply window again at dispatch and prevents provider calls after expiry', async () => {
    const page = await account();
    const { conversation, message, command } = await queued(page);
    await db.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: new Date(Date.now() - PAGE_WINDOW_MS - 1000) },
    });
    await run(command, page);
    expect(graph.sendText).not.toHaveBeenCalled();
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryStatus: 'FAILED',
      deliveryError: 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED',
      sendAttempts: 0,
    });
  });

  it('sends with the account token and recipient PSID, retaining idempotency and the shared message record', async () => {
    const page = await account();
    const { message, command } = await queued(page);
    await run(command, page);
    expect(graph.sendText).toHaveBeenCalledExactlyOnceWith(
      pageId,
      fixtureToken,
      peerId,
      'Page reply',
    );
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      externalMessageId: 'mid.outbound',
      sendAttempts: 1,
      idempotencyKey: message.idempotencyKey,
    });
    expect(
      await db.personalCommand.findUniqueOrThrow({ where: { id: command.id } }),
    ).toMatchObject({ status: 'DONE' });
    await run(command, page);
    expect(graph.sendText).toHaveBeenCalledTimes(1);
  });

  it('merges an early provider echo into the queued outgoing message without duplicating the conversation', async () => {
    const page = await account();
    const { message, command } = await queued(page);
    graph.sendText.mockImplementationOnce(async () => {
      await persist(page, {
        externalMessageId: 'mid.outbound',
        direction: 'OUTGOING',
        content: message.content,
      });
      return { messageId: 'mid.outbound', recipientId: peerId };
    });
    await run(command, page);
    expect(
      await db.message.count({
        where: { channelAccountId: page.id, direction: 'OUTGOING' },
      }),
    ).toBe(1);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      externalMessageId: 'mid.outbound',
    });
  });

  it('marks a definite rejection FAILED, and expires Page access on revoked permissions', async () => {
    const page = await account();
    const { message, command } = await queued(page);
    graph.sendText.mockRejectedValueOnce(
      new FacebookGraphError(
        'FACEBOOK_PERMISSION_DENIED',
        'Safe permission denial',
        { status: 403 },
      ),
    );
    await run(command, page);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: message.id } }),
    ).toMatchObject({
      deliveryStatus: 'FAILED',
      deliveryError: 'FACEBOOK_PERMISSION_DENIED',
    });
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }),
    ).toMatchObject({ connectionStatus: 'REAUTH_REQUIRED' });
    expect(
      await db.personalCommand.findUniqueOrThrow({ where: { id: command.id } }),
    ).toMatchObject({ status: 'FAILED' });
    expect(graph.sendText).toHaveBeenCalledTimes(1);
  });

  it('retries a proven retryable rejection with bounded backoff, while timed-out sends become UNKNOWN without retry', async () => {
    const page = await account();
    const first = await queued(page);
    graph.sendText.mockRejectedValueOnce(
      new FacebookGraphError('FACEBOOK_RATE_LIMITED', 'Safe rate limit', {
        retryable: true,
        status: 429,
      }),
    );
    await run(first.command, page);
    const retry = await db.personalCommand.findUniqueOrThrow({
      where: { id: first.command.id },
    });
    expect(retry.status).toBe('PENDING');
    expect(retry.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      await db.message.findUniqueOrThrow({ where: { id: first.message.id } }),
    ).toMatchObject({ deliveryStatus: 'PENDING', sendAttempts: 1 });
    await db.channelAccount.update({
      where: { id: page.id },
      data: { lastSendAt: new Date(Date.now() - 5000) },
    });
    const finalAttempt = await db.personalCommand.update({
      where: { id: retry.id },
      data: { status: 'PROCESSING', attempts: 3 },
    });
    graph.sendText.mockRejectedValueOnce(
      new FacebookGraphError('FACEBOOK_RATE_LIMITED', 'Safe rate limit', {
        retryable: true,
      }),
    );
    await run(finalAttempt, page);
    expect(
      (await db.personalCommand.findUniqueOrThrow({ where: { id: retry.id } }))
        .status,
    ).toBe('FAILED');
    const secondPage = await account({ externalAccountId: '100000000000099' });
    const second = await queued(secondPage);
    graph.sendText.mockRejectedValueOnce(
      new FacebookGraphError('FACEBOOK_UNAVAILABLE', 'Provider response lost', {
        ambiguous: true,
        retryable: true,
      }),
    );
    await run(second.command, secondPage);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: second.message.id } }),
    ).toMatchObject({
      deliveryStatus: 'UNKNOWN',
      deliveryError: 'FACEBOOK_SEND_UNKNOWN',
      sendAttempts: 1,
    });
    expect(
      (
        await db.personalCommand.findUniqueOrThrow({
          where: { id: second.command.id },
        })
      ).status,
    ).toBe('FAILED');
    await expect(
      personal.retry(second.conversation.id, second.message.id, owner),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_RETRYABLE' });
    const calls = graph.sendText.mock.calls.length;
    await run(second.command, secondPage);
    expect(graph.sendText).toHaveBeenCalledTimes(calls);
  });

  it('recovers a Page send interrupted after SENDING as UNKNOWN rather than issuing another external POST', async () => {
    const page = await account();
    const { message, command } = await queued(page);
    await db.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: 'SENDING',
        sendAttempts: 1,
        sendingAt: new Date(),
      },
    });
    await worker.recoverDispatch(command, page);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: message.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    expect(
      (
        await db.personalCommand.findUniqueOrThrow({
          where: { id: command.id },
        })
      ).status,
    ).toBe('FAILED');
    expect(graph.sendText).not.toHaveBeenCalled();
  });

  it('throttles a Page independently before claiming the next pending message', async () => {
    const page = await account({ lastSendAt: new Date() });
    const { message, command } = await queued(page);
    await run(command, page);
    expect(graph.sendText).not.toHaveBeenCalled();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: message.id } }))
        .deliveryStatus,
    ).toBe('PENDING');
    expect(
      await db.personalCommand.findUniqueOrThrow({ where: { id: command.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('syncs bounded conversation/message pages, persists resumable cursors and deduplicates repeated enqueue requests', async () => {
    const page = await account();
    graph.listConversations
      .mockResolvedValueOnce({
        items: [
          {
            id: 't.thread',
            updatedAt: new Date().toISOString(),
            participants: [
              { id: pageId },
              { id: peerId, name: 'History customer' },
            ],
          },
        ],
        after: 'conversation-cursor',
      })
      .mockResolvedValueOnce({ items: [], after: null });
    await Promise.all([
      worker.enqueue(owner, page.id),
      worker.enqueue(owner, page.id),
    ]);
    expect(await db.personalCommand.count({ where: { kind: 'SYNC' } })).toBe(1);
    const initial = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC' },
    });
    await run(await claim(initial.id), page);
    expect(graph.listConversations).toHaveBeenCalledExactlyOnceWith(
      pageId,
      fixtureToken,
      { after: null, limit: 25 },
    );
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }))
        .syncCursor,
    ).toBe('conversation-cursor');
    const next = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC', status: 'PENDING' },
    });
    expect(next.payload).toMatchObject({
      after: 'conversation-cursor',
      page: 1,
    });
    const conversation = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: page.id },
    });
    const history = {
      id: 'mid.history',
      createdAt: new Date(Date.now() - 1000).toISOString(),
      from: { id: peerId, name: 'History customer' },
      to: [{ id: pageId }],
      text: 'History message',
      attachments: [],
    };
    graph.listMessages
      .mockResolvedValueOnce({ items: [history], after: 'message-cursor' })
      .mockResolvedValueOnce({ items: [history], after: null });
    const messageJob = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES', status: 'PENDING' },
    });
    await run(await claim(messageJob.id), page);
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).syncCursor,
    ).toBe('message-cursor');
    expect((await db.message.findFirstOrThrow()).content).toBe(
      'History message',
    );
    const nextMessageJob = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES', status: 'PENDING' },
    });
    await run(await claim(nextMessageJob.id), page);
    await run(await claim(next.id), page);
    expect(await db.message.count()).toBe(1);
    expect(graph.listMessages).toHaveBeenNthCalledWith(
      2,
      't.thread',
      fixtureToken,
      { after: 'message-cursor', limit: 25 },
    );
    expect(
      await db.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      }),
    ).toMatchObject({
      syncComplete: true,
      syncCursor: null,
      customerAvatar: 'https://example.com/contact.jpg',
    });
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }),
    ).toMatchObject({
      syncComplete: true,
      syncCursor: null,
      lastSyncError: null,
    });
  });

  it('loads a new contact profile in the background without replacing its pending history job', async () => {
    const page = await account({ syncCursor: 'page-list-cursor' });
    const inbound = await receipt(page, event());
    await worker.processInbound(inbound.id);
    expect(graph.getUserProfile).not.toHaveBeenCalled();
    const contact = await db.conversation.findFirstOrThrow();
    const profileJob = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES' },
    });
    expect(profileJob.payload).toMatchObject({
      conversationId: contact.id,
      profileOnly: true,
    });
    // A contact's null message cursor must never inherit the Page list cursor.
    await db.conversation.update({
      where: { id: contact.id },
      data: { externalConversationId: 't.profile-history' },
    });
    await worker.enqueue(owner, page.id, contact.id);
    const jobs = await db.personalCommand.findMany({
      where: { kind: 'SYNC_MESSAGES' },
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.id !== profileJob.id)?.payload).toMatchObject(
      { after: null, conversationId: contact.id },
    );
    await run(await claim(profileJob.id), page);
    expect(graph.getUserProfile).toHaveBeenCalledExactlyOnceWith(
      peerId,
      fixtureToken,
    );
    expect(
      await db.conversation.findUniqueOrThrow({ where: { id: contact.id } }),
    ).toMatchObject({
      customerName: 'Page customer',
      customerAvatar: 'https://example.com/contact.jpg',
      syncComplete: false,
    });
    expect(graph.listMessages).not.toHaveBeenCalled();
  });

  it('keeps a failed Page listing incomplete when the remaining message job finishes', async () => {
    const page = await account({
      syncCursor: 'unread-list-tail',
      lastSyncAt: new Date(),
      lastSyncError: 'FACEBOOK_RATE_LIMITED',
    });
    const contact = await activeConversation(page, {
      externalConversationId: 't.complete-last-message',
    });
    await worker.enqueue(owner, page.id, contact.id);
    const messageJob = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES' },
    });
    await run(await claim(messageJob.id), page);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: contact.id } }))
        .syncComplete,
    ).toBe(true);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }),
    ).toMatchObject({ syncComplete: false, syncCursor: 'unread-list-tail' });
  });

  it('resumes older incomplete message checkpoints even when the Page list cursor has moved beyond them', async () => {
    const page = await account({ syncCursor: 'list-tail' });
    const contact = await activeConversation(page, {
      externalConversationId: 't.older-incomplete',
    });
    await db.conversation.update({
      where: { id: contact.id },
      data: { syncCursor: 'older-message-tail', syncComplete: false },
    });
    await worker.enqueue(owner, page.id);
    await worker.enqueue(owner, page.id);
    const jobs = await db.personalCommand.findMany();
    expect(jobs).toHaveLength(2);
    expect(
      jobs.find((job) => job.kind === 'SYNC_MESSAGES')?.payload,
    ).toMatchObject({
      conversationId: contact.id,
      after: 'older-message-tail',
    });
    expect(jobs.find((job) => job.kind === 'SYNC')?.payload).toMatchObject({
      after: 'list-tail',
    });
    expect(graph.listMessages).not.toHaveBeenCalled();
  });

  it('throttles the same Page across different owners while keeping other Pages independent', async () => {
    await account({ ownerId: 'another-owner', lastSendAt: new Date() });
    const page = await account();
    const pending = await queued(page);
    await run(pending.command, page);
    expect(graph.sendText).not.toHaveBeenCalled();
    expect(
      (
        await db.message.findUniqueOrThrow({
          where: { id: pending.message.id },
        })
      ).deliveryStatus,
    ).toBe('PENDING');
    const other = await account({ externalAccountId: '100000000000123' });
    const second = await queued(other);
    await run(second.command, other);
    expect(graph.sendText).toHaveBeenCalledTimes(1);
  });

  it('batches large read receipts across ticks without losing durable work or reopening the reply window', async () => {
    const page = await account();
    const contact = await activeConversation(page);
    const inboundAt = contact.lastInboundAt;
    await db.message.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        conversationId: contact.id,
        channelAccountId: page.id,
        externalMessageId: `mid.bulk.read.${i}`,
        direction: 'OUTGOING' as const,
        type: 'text',
        content: 'Read receipt fixture',
        metadata: {},
        source: 'FACEBOOK' as const,
        sentAt: new Date(Date.now() - 5000),
      })),
    });
    const incoming = await receipt(
      page,
      event({
        message: undefined,
        read: { watermark: Date.now() },
      } as unknown as Prisma.InputJsonObject),
    );
    await worker.processInbound(incoming.id);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } }))
        .status,
    ).toBe('RECEIVED');
    expect(await db.message.count({ where: { readAt: { not: null } } })).toBe(
      200,
    );
    await worker.processInbound(incoming.id);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } }))
        .status,
    ).toBe('PROCESSED');
    expect(await db.message.count({ where: { readAt: { not: null } } })).toBe(
      205,
    );
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: contact.id } }))
        .lastInboundAt,
    ).toEqual(inboundAt);
  });

  it('stops at the history page bound with an honest resumable sync error', async () => {
    const page = await account();
    graph.listConversations.mockResolvedValue({
      items: [],
      after: 'resumable-cursor',
    });
    const command = await db.personalCommand.create({
      data: {
        channelAccountId: page.id,
        generation: page.generation,
        kind: 'SYNC',
        status: 'PROCESSING',
        attempts: 1,
        deduplicationKey: randomUUID(),
        payload: { runId: randomUUID(), page: 199, after: 'prior-cursor' },
      },
    });
    await run(command, page);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }),
    ).toMatchObject({
      syncCursor: 'resumable-cursor',
      syncComplete: false,
      lastSyncError: 'FACEBOOK_SYNC_LIMIT_REACHED',
    });
    expect(
      await db.personalCommand.count({ where: { status: 'PENDING' } }),
    ).toBe(0);
    await worker.enqueue(owner, page.id);
    expect(
      (
        await db.personalCommand.findFirstOrThrow({
          where: { status: 'PENDING' },
        })
      ).payload,
    ).toMatchObject({ after: 'resumable-cursor', page: 0 });
  });

  it('ignores late sync results after disconnect and clears credentials while retaining stored history', async () => {
    const page = await account();
    const conversation = await activeConversation(page);
    let resolvePage!: (value: { items: []; after: null }) => void;
    graph.listConversations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );
    await worker.enqueue(owner, page.id);
    const command = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC' },
    });
    const syncing = run(await claim(command.id), page);
    await vi.waitFor(() =>
      expect(graph.listConversations).toHaveBeenCalledTimes(1),
    );
    await personal.disconnect(page.id, owner);
    resolvePage({ items: [], after: null });
    await syncing;
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: page.id } }),
    ).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      syncComplete: false,
    });
    expect(
      await db.message.count({ where: { conversationId: conversation.id } }),
    ).toBe(1);
    expect(
      (
        await db.personalCommand.findUniqueOrThrow({
          where: { id: command.id },
        })
      ).status,
    ).toBe('FAILED');
  });

  it('processes durable media receipts once and applies delivery/read watermarks only to this Page and recipient', async () => {
    const page = await account();
    const inbound = await receipt(
      page,
      event({
        message: {
          mid: 'mid.photo',
          attachments: [
            {
              type: 'image',
              payload: { url: 'https://example.com/photo.jpg' },
            },
          ],
        },
      }),
    );
    await worker.processInbound(inbound.id);
    await worker.processInbound(inbound.id);
    expect(await db.message.count()).toBe(1);
    const conversation = await db.conversation.findFirstOrThrow();
    expect(
      (await inbox.messages(conversation.id, paginationSchema.parse({}), owner))
        .items[0],
    ).toMatchObject({
      type: 'image',
      attachments: [{ type: 'image', url: 'https://example.com/photo.jpg' }],
    });
    const incomingAt = conversation.lastInboundAt;
    const echoAt = Date.now();
    const echo = await receipt(
      page,
      event({
        sender: { id: pageId },
        recipient: { id: peerId },
        timestamp: echoAt,
        message: {
          mid: 'mid.echo.receipt',
          text: 'External reply',
          is_echo: true,
        },
      }),
    );
    await worker.processInbound(echo.id);
    const outgoing = await db.message.findFirstOrThrow({
      where: { direction: 'OUTGOING' },
    });
    const otherPage = await account({ externalAccountId: '100000000000077' });
    await persist(otherPage, {
      externalMessageId: 'mid.echo.receipt',
      direction: 'OUTGOING',
      sentAt: new Date(echoAt),
    });
    const otherPeer = await persist(page, {
      userId: '200000000000099',
      externalMessageId: 'mid.otherpeer',
      direction: 'OUTGOING',
      sentAt: new Date(echoAt),
    });
    const delivery = await receipt(
      page,
      event({
        message: undefined,
        delivery: { mids: ['mid.echo.receipt'], watermark: echoAt + 1000 },
      }),
    );
    const read = await receipt(
      page,
      event({ message: undefined, read: { watermark: echoAt + 2000 } }),
    );
    await worker.processInbound(delivery.id);
    await worker.processInbound(read.id);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: outgoing.id } }),
    ).toMatchObject({
      deliveredAt: new Date(echoAt + 1000),
      readAt: new Date(echoAt + 2000),
    });
    expect(
      await db.message.findUniqueOrThrow({
        where: { id: otherPeer.messageId },
      }),
    ).toMatchObject({ deliveredAt: null, readAt: null });
    expect(
      await db.message.findFirstOrThrow({
        where: { channelAccountId: otherPage.id },
      }),
    ).toMatchObject({ deliveredAt: null, readAt: null });
    expect(
      (
        await db.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).lastInboundAt,
    ).toEqual(incomingAt);
    expect(
      await db.webhookEvent.count({ where: { status: 'PROCESSED' } }),
    ).toBe(4);
  });

  it('ignores durable receipts for a disconnected Page or a mismatched Page identity', async () => {
    const page = await account();
    const wrong = await receipt(page, event(), {
      payload: { pageId: 'different-page', event: event() },
    });
    await worker.processInbound(wrong.id);
    await personal.disconnect(page.id, owner);
    const old = await receipt(page, event());
    await worker.processInbound(old.id);
    expect(await db.message.count()).toBe(0);
    expect(await db.webhookEvent.count({ where: { status: 'IGNORED' } })).toBe(
      2,
    );
  });

  it('uses stable database cursors when new conversations/messages arrive between pages', async () => {
    const page = await account();
    const base = Date.now() - 100000;
    for (let i = 0; i < 3; i++)
      await persist(page, {
        userId: String(300 + i),
        externalMessageId: `mid.cursor.${i}`,
        sentAt: new Date(base + i * 1000),
      });
    const first = await inbox.conversations(
      conversationFilterSchema.parse({
        limit: 2,
        channelType: 'FACEBOOK_PAGE',
      }),
      owner,
    );
    expect(first.hasMore).toBe(true);
    await persist(page, {
      userId: '999',
      externalMessageId: 'mid.cursor.new',
      sentAt: new Date(),
    });
    const second = await inbox.conversations(
      conversationFilterSchema.parse({
        limit: 2,
        channelType: 'FACEBOOK_PAGE',
        cursor: first.nextCursor,
      }),
      owner,
    );
    expect(second.items).toHaveLength(1);
    expect(
      second.items.some((item) =>
        first.items.some((previous) => previous.id === item.id),
      ),
    ).toBe(false);
    const conversation = await activeConversation(page);
    for (let i = 0; i < 3; i++)
      await persist(page, {
        externalMessageId: `mid.message.cursor.${i}`,
        sentAt: new Date(base + i * 1000),
      });
    const firstMessages = await inbox.messages(
      conversation.id,
      paginationSchema.parse({ limit: 2 }),
      owner,
    );
    await persist(page, {
      externalMessageId: 'mid.newmessage',
      sentAt: new Date(),
    });
    const older = await inbox.messages(
      conversation.id,
      paginationSchema.parse({ limit: 2, cursor: firstMessages.nextCursor }),
      owner,
    );
    expect(
      older.items.some((item) =>
        firstMessages.items.some((previous) => previous.id === item.id),
      ),
    ).toBe(false);
    expect(
      older.items.some((item) => item.externalMessageId === 'mid.newmessage'),
    ).toBe(false);
  });
});
