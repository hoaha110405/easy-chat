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
import { createHmac, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Client } from 'pg';
import type { ChannelAccount, Prisma } from '@prisma/client';
import {
  conversationFilterSchema,
  paginationSchema,
  tiktokStatusSchema,
} from '@zalo/shared';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { MessageStore } from '../src/modules/inbox/message-store';
import { InboxService } from '../src/modules/inbox/inbox.service';
import {
  PersonalService,
  WORKER_ID,
} from '../src/modules/zalo-personal/personal.service';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import type { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import { TikTokRegistry } from '../src/modules/tiktok/tiktok.registry';
import { TikTokAuthService } from '../src/modules/tiktok/tiktok-auth.service';
import { TikTokTokenService } from '../src/modules/tiktok/tiktok-token.service';
import { TikTokWebhookService } from '../src/modules/tiktok/tiktok-webhook.service';
import { TikTokWorker } from '../src/modules/tiktok/tiktok.worker';
import { TikTokError } from '../src/modules/tiktok/tiktok-http';
import type {
  TikTokAdapter,
  TikTokMessage,
  TikTokToken,
  TikTokType,
} from '../src/modules/tiktok/tiktok.types';
import {
  TikTokBusinessClient,
  BUSINESS_SCOPES,
} from '../src/modules/tiktok-business/tiktok-business.client';
import { TikTokShopClient } from '../src/modules/tiktok-shop/tiktok-shop.client';
import { config, crypto } from './helpers';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test.',
  );
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
const settings = {
  ...config,
  env: {
    ...config.env,
    DATABASE_URL: testUrl,
    TIKTOK_BUSINESS_ENABLED: true,
    TIKTOK_BUSINESS_APP_ID: 'test-business-app',
    TIKTOK_BUSINESS_APP_SECRET: 'test-business-secret',
    TIKTOK_BUSINESS_REDIRECT_URI:
      'https://easy.example/api/channels/tiktok-business/oauth/callback',
    TIKTOK_BUSINESS_AUTHORIZATION_URL:
      'https://www.tiktok.com/v2/auth/authorize?client_key=test-business-app&redirect_uri=https%3A%2F%2Feasy.example%2Fapi%2Fchannels%2Ftiktok-business%2Foauth%2Fcallback',
    TIKTOK_SHOP_ENABLED: true,
    TIKTOK_SHOP_APP_KEY: 'test-shop-key',
    TIKTOK_SHOP_APP_SECRET: 'test-shop-secret',
    TIKTOK_SHOP_REDIRECT_URI:
      'https://easy.example/api/channels/tiktok-shop/oauth/callback',
    TIKTOK_SHOP_AUTHORIZATION_URL:
      'https://services.tiktokshop.com/open/authorize?service_id=test-service',
  },
  tiktokConfigured: true,
} as ConfigService;
const owner = 'administrator';
const ownId = '9223372036854775807';
const peerId = '9223372036854775806';
const caps = {
  receiveMessages: true,
  sendMessages: true,
  syncConversations: true,
  readReceipts: true,
};
const store = new MessageStore();
const inbox = new InboxService(db);
const personal = new PersonalService(db, settings, crypto);
function credentials(type: TikTokType = 'TIKTOK_BUSINESS'): TikTokToken {
  return {
    accessToken: 'private-tiktok-access',
    refreshToken: 'private-tiktok-refresh',
    openId: ownId,
    expiresAt: Date.now() + 86400000,
    refreshExpiresAt: Date.now() + 31536000000,
    appId: type === 'TIKTOK_BUSINESS' ? 'test-business-app' : 'test-shop-key',
    scopes:
      type === 'TIKTOK_BUSINESS'
        ? [...BUSINESS_SCOPES]
        : ['seller.customer_service', 'seller.authorization.info'],
    ...(type === 'TIKTOK_SHOP' ? { shopCipher: 'private-shop-cipher' } : {}),
  };
}
function adapter(type: TikTokType) {
  return {
    type,
    exchange: vi
      .fn<TikTokAdapter['exchange']>()
      .mockImplementation(async () => credentials(type)),
    refresh: vi
      .fn<TikTokAdapter['refresh']>()
      .mockImplementation(async (token) => ({
        ...token,
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 86400000,
      })),
    identities: vi.fn<TikTokAdapter['identities']>().mockResolvedValue(
      type === 'TIKTOK_BUSINESS'
        ? [
            {
              id: ownId,
              name: 'Business fixture',
              avatarUrl: 'https://cdn.example/business.jpg',
              region: null,
            },
          ]
        : [
            {
              id: 'shop-1',
              name: 'Shop 1',
              avatarUrl: null,
              region: 'VN',
              cipher: 'private-shop-cipher',
            },
            {
              id: 'shop-2',
              name: 'Shop 2',
              avatarUrl: null,
              region: 'US',
              cipher: 'private-shop-cipher-2',
            },
          ],
    ),
    verify: vi
      .fn<TikTokAdapter['verify']>()
      .mockResolvedValue({ ...caps, readReceipts: type === 'TIKTOK_BUSINESS' }),
    subscribe: vi.fn<TikTokAdapter['subscribe']>().mockResolvedValue(),
    conversations: vi
      .fn<TikTokAdapter['conversations']>()
      .mockResolvedValue({ items: [], cursor: null }),
    messages: vi
      .fn<TikTokAdapter['messages']>()
      .mockResolvedValue({ items: [], cursor: null }),
    sendText: vi
      .fn<TikTokAdapter['sendText']>()
      .mockResolvedValue('outgoing-1'),
  };
}
let business: ReturnType<typeof adapter>;
let shop: ReturnType<typeof adapter>;
let registry: TikTokRegistry;
let worker: TikTokWorker;
let tokens: TikTokTokenService;
let webhooks: TikTokWebhookService;
let auth: TikTokAuthService;
async function cleanup() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
}
async function account(
  type: TikTokType = 'TIKTOK_BUSINESS',
  extra: Partial<Prisma.ChannelAccountCreateInput> = {},
) {
  return db.channelAccount.create({
    data: {
      ownerId: owner,
      channelType: type,
      externalAccountId: type === 'TIKTOK_BUSINESS' ? ownId : 'shop-1',
      name: 'TikTok fixture',
      connectionStatus: 'CONNECTED',
      capabilities: caps,
      encryptedCredentials: crypto.encrypt(JSON.stringify(credentials(type))),
      ...extra,
    },
  });
}
function incoming(extra: Partial<TikTokMessage> = {}): TikTokMessage {
  return {
    id: 'inbound-1',
    conversationId: 'conversation-1',
    senderId: peerId,
    contactId: peerId,
    direction: 'INCOMING',
    type: 'text',
    content: 'Tin khách gửi',
    at: new Date(Date.now() - 1000),
    name: 'Khách TikTok',
    avatar: 'https://cdn.example/peer.jpg',
    attachments: [],
    ...extra,
  };
}
async function persist(a: ChannelAccount, extra: Partial<TikTokMessage> = {}) {
  const m = incoming(extra);
  return db.$transaction((tx) =>
    store.persistChannel(
      tx,
      a.id,
      {
        oaId: '',
        userId: m.conversationId,
        externalConversationId: m.conversationId,
        externalThreadType: a.channelType,
        externalContactId: m.contactId,
        externalMessageId: m.id,
        direction: m.direction,
        type: m.type,
        content: m.content,
        sentAt: m.at,
        source: 'TIKTOK',
        metadata: { attachments: m.attachments },
        customerName: m.name,
        customerAvatar: m.avatar,
      },
      m.senderId,
    ),
  );
}
async function conversation(
  a: ChannelAccount,
  extra: Partial<TikTokMessage> = {},
) {
  const saved = await persist(a, extra);
  const c = await db.conversation.findUniqueOrThrow({
    where: { id: saved.conversationId },
  });
  if (a.channelType === 'TIKTOK_SHOP')
    return db.conversation.update({
      where: { id: c.id },
      data: { providerState: { canSend: true, checkedAt: Date.now() } },
    });
  return c;
}
async function claim(id: string) {
  return db.personalCommand.update({
    where: { id },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
}
async function queue(a: ChannelAccount, idempotencyKey = randomUUID()) {
  const c = await conversation(a);
  const m = await personal.send(c.id, a.ownerId, {
    content: 'Trả lời TikTok',
    idempotencyKey,
  });
  const job = await db.personalCommand.findUniqueOrThrow({
    where: { messageId: m.id },
  });
  return { c, m, job: await claim(job.id) };
}
async function receipt(a: ChannelAccount, event: Prisma.InputJsonObject) {
  return db.webhookEvent.create({
    data: {
      channelAccountId: a.id,
      eventName: 'tiktok.' + a.channelType,
      digest: randomUUID(),
      payload: {
        channelType: a.channelType,
        accountId: a.externalAccountId,
        ...event,
      },
    },
  });
}
async function session() {
  return db.adminSession.create({
    data: { id: randomUUID(), expiresAt: new Date(Date.now() + 3600000) },
  });
}
async function selection(type: TikTokType, s: { id: string }) {
  const url = new URL((await auth.connect(type, owner, s.id)).authorizationUrl);
  await auth.callback(
    type,
    owner,
    s.id,
    url.searchParams.get('state')!,
    'fixture-code',
  );
  return (await auth.status(type, owner, s.id)).selection!;
}
function signedBusiness(m = incoming()) {
  const raw = Buffer.from(
    JSON.stringify({
      client_key: 'test-business-app',
      user_openid: ownId,
      event: 'im_receive_msg',
      create_time: Math.floor(Date.now() / 1000),
      content: JSON.stringify({
        message_id: m.id,
        conversation_id: m.conversationId,
        timestamp: m.at.getTime(),
        type: 'text',
        text: { body: m.content },
        from_user: { id: peerId, role: 'personal_account' },
        to_user: { id: ownId, role: 'business_account' },
      }),
    }),
  );
  const t = String(Math.floor(Date.now() / 1000));
  return {
    raw,
    signature: `t=${t},s=${createHmac('sha256', 'test-business-secret')
      .update(t + '.')
      .update(raw)
      .digest('hex')}`,
  };
}
async function httpApp() {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(settings)
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(TikTokBusinessClient)
    .useValue(business)
    .overrideProvider(TikTokShopClient)
    .useValue(shop)
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app);
  await app.init();
  return app;
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
  business = adapter('TIKTOK_BUSINESS');
  shop = adapter('TIKTOK_SHOP');
  registry = new TikTokRegistry(
    settings,
    business as unknown as TikTokBusinessClient,
    shop as unknown as TikTokShopClient,
  );
  tokens = new TikTokTokenService(db, crypto, registry);
  worker = new TikTokWorker(db, registry, tokens, store);
  webhooks = new TikTokWebhookService(db, registry);
  auth = new TikTokAuthService(db, crypto, registry);
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe('TikTok on the existing HTTP app, PostgreSQL inbox and outbox', () => {
  it('routes authenticated OAuth, selection, sync and exact signed raw webhooks through the actual Nest app', async () => {
    const app = await httpApp();
    try {
      const server = app.getHttpServer();
      const browser = request.agent(server);
      await request(server).get('/api/channels/tiktok-business').expect(401);
      await browser
        .post('/api/auth/login')
        .set('Origin', settings.env.FRONTEND_URL)
        .send({ password: settings.env.ADMIN_PASSWORD })
        .expect(200);
      const initial = await browser
        .get('/api/channels/tiktok-business')
        .expect(200);
      expect(tiktokStatusSchema.parse(initial.body.data)).toMatchObject({
        configured: true,
        status: 'NOT_CONNECTED',
        approvalStatus: 'UNVERIFIED',
      });
      await browser
        .post('/api/channels/tiktok-business/connect')
        .send({})
        .expect(403);
      const begin = await browser
        .post('/api/channels/tiktok-business/connect')
        .set('Origin', settings.env.FRONTEND_URL)
        .send({})
        .expect(200);
      const state = new URL(begin.body.data.authorizationUrl).searchParams.get(
        'state',
      );
      const callback = await browser
        .get('/api/channels/tiktok-business/oauth/callback')
        .query({ state, auth_code: 'authorized-code' })
        .expect(303);
      expect(callback.headers.location).toBe(
        settings.env.FRONTEND_URL + '/tiktok/business?oauth=select',
      );
      const reused = await browser
        .get('/api/channels/tiktok-business/oauth/callback')
        .query({ state, code: 'reused-code' })
        .expect(303);
      expect(reused.headers.location).toContain('error=INVALID_OAUTH_STATE');
      expect(business.exchange).toHaveBeenCalledTimes(1);
      const choices = await browser
        .get('/api/channels/tiktok-business')
        .expect(200);
      expect(choices.body.data.status).toBe('NOT_CONNECTED');
      expect(JSON.stringify(choices.body)).not.toContain('private-tiktok');
      const select = await browser
        .post('/api/channels/tiktok-business/select')
        .set('Origin', settings.env.FRONTEND_URL)
        .send({
          authorizationId: choices.body.data.selection.id,
          externalAccountId: ownId,
        })
        .expect(200);
      expect(select.body.data).toMatchObject({
        connectionStatus: 'CONNECTED',
        capabilities: caps,
      });
      expect(business.subscribe).toHaveBeenCalledExactlyOnceWith(
        expect.any(Object),
        'https://easy.example/api/channels/tiktok-business/webhook',
      );
      const channel = await db.channelAccount.findFirstOrThrow();
      expect(channel.encryptedCredentials).not.toContain('private-tiktok');
      expect(
        JSON.parse(crypto.decrypt(channel.encryptedCredentials!)).accessToken,
      ).toBe('private-tiktok-access');
      await browser
        .post(`/api/channels/${channel.id}/sync`)
        .set('Origin', settings.env.FRONTEND_URL)
        .send({})
        .expect(202);
      expect(await db.personalCommand.count({ where: { kind: 'SYNC' } })).toBe(
        1,
      );
      const delivery = signedBusiness();
      await request(server)
        .post('/api/channels/tiktok-business/webhook')
        .set('Content-Type', 'application/json')
        .set('TikTok-Signature', delivery.signature)
        .send(delivery.raw.toString())
        .expect(200, '');
      expect(await db.webhookEvent.count()).toBe(1);
      expect(await db.message.count()).toBe(0);
      await request(server)
        .post('/api/channels/tiktok-business/webhook')
        .set('Content-Type', 'application/json')
        .set('TikTok-Signature', delivery.signature)
        .send(delivery.raw.toString())
        .expect(200);
      expect(await db.webhookEvent.count()).toBe(1);
      await request(server)
        .post('/api/channels/tiktok-business/webhook')
        .send({ invalid: true })
        .expect(401);
      const r = await db.webhookEvent.findFirstOrThrow();
      await worker.processInbound(r.id);
      const list = await browser
        .get('/api/conversations')
        .query({
          channelType: 'TIKTOK_BUSINESS',
          account: `tiktok-business:${channel.id}`,
        })
        .expect(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0]).toMatchObject({
        customerName: null,
        externalContactId: peerId,
        canSend: true,
        channelType: 'TIKTOK_BUSINESS',
      });
    } finally {
      await app.close();
      await db.$connect();
    }
  });

  it('binds OAuth state to provider, session and owner, consumes it once, and invalidates older attempts', async () => {
    const s = await session();
    const other = await session();
    const begin = new URL(
      (await auth.connect('TIKTOK_BUSINESS', owner, s.id)).authorizationUrl,
    );
    const state = begin.searchParams.get('state')!;
    await expect(
      auth.callback('TIKTOK_BUSINESS', owner, other.id, state, 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    await expect(
      auth.callback('TIKTOK_SHOP', owner, s.id, state, 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    await expect(
      auth.callback('TIKTOK_BUSINESS', 'other-owner', s.id, state, 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    await auth.connect('TIKTOK_BUSINESS', owner, s.id);
    await expect(
      auth.callback('TIKTOK_BUSINESS', owner, s.id, state, 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    const fresh = await selection('TIKTOK_BUSINESS', s);
    expect(fresh.accounts[0].id).toBe(ownId);
    const row = await db.channelAuthorization.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    await expect(
      auth.callback('TIKTOK_BUSINESS', owner, s.id, row.stateHash, 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    expect(business.exchange).toHaveBeenCalledTimes(1);
    await db.adminSession.delete({ where: { id: s.id } });
    await expect(
      auth.select('TIKTOK_BUSINESS', owner, s.id, fresh.id, ownId),
    ).rejects.toMatchObject({ code: 'TIKTOK_SELECTION_EXPIRED' });
  });

  it('never connects when capability checks or webhook registration fail', async () => {
    const s = await session();
    const choices = await selection('TIKTOK_BUSINESS', s);
    business.verify.mockRejectedValueOnce(
      new TikTokError('TIKTOK_PERMISSION_DENIED'),
    );
    await expect(
      auth.select('TIKTOK_BUSINESS', owner, s.id, choices.id, ownId),
    ).rejects.toMatchObject({ code: 'TIKTOK_PERMISSION_DENIED' });
    expect(business.subscribe).not.toHaveBeenCalled();
    expect(await db.channelAccount.count()).toBe(0);
    business.subscribe.mockRejectedValueOnce(
      new TikTokError('TIKTOK_WEBHOOK_INVALID'),
    );
    await expect(
      auth.select('TIKTOK_BUSINESS', owner, s.id, choices.id, ownId),
    ).rejects.toMatchObject({ code: 'TIKTOK_WEBHOOK_INVALID' });
    expect(await db.channelAccount.count()).toBe(0);
    expect(
      (await auth.status('TIKTOK_BUSINESS', owner, s.id)).approvalStatus,
    ).toBe('UNVERIFIED');
  });

  it('supports multiple shops with encrypted per-shop context, one-time selection and owner-scoped visibility', async () => {
    const s = await session();
    const choices = await selection('TIKTOK_SHOP', s);
    expect(choices.accounts.map((a) => a.id)).toEqual(['shop-1', 'shop-2']);
    expect(JSON.stringify(choices)).not.toContain('cipher');
    await expect(
      auth.select('TIKTOK_SHOP', owner, s.id, choices.id, 'unowned-shop'),
    ).rejects.toMatchObject({ code: 'TIKTOK_ACCOUNT_MISMATCH' });
    const one = await auth.select(
      'TIKTOK_SHOP',
      owner,
      s.id,
      choices.id,
      'shop-1',
    );
    await expect(
      auth.select('TIKTOK_SHOP', owner, s.id, choices.id, 'shop-2'),
    ).rejects.toMatchObject({ code: 'TIKTOK_SELECTION_EXPIRED' });
    const again = await selection('TIKTOK_SHOP', s);
    const two = await auth.select(
      'TIKTOK_SHOP',
      owner,
      s.id,
      again.id,
      'shop-2',
    );
    expect(two.id).not.toBe(one.id);
    const accountTwo = await db.channelAccount.findUniqueOrThrow({
      where: { id: two.id },
    });
    expect(
      JSON.parse(crypto.decrypt(accountTwo.encryptedCredentials!)).shopCipher,
    ).toBe('private-shop-cipher-2');
    const status = await auth.status('TIKTOK_SHOP', owner, s.id);
    expect(status.accounts).toHaveLength(2);
    expect(JSON.stringify(status)).not.toMatch(
      /private-tiktok|private-shop-cipher|encryptedCredentials/,
    );
    expect(
      (await auth.status('TIKTOK_SHOP', 'other-owner', s.id)).accounts,
    ).toEqual([]);
  });

  it('refreshes expiring seller credentials once under a row lock and preserves the selected shop cipher', async () => {
    const a = await account('TIKTOK_SHOP', {
      encryptedCredentials: crypto.encrypt(
        JSON.stringify({
          ...credentials('TIKTOK_SHOP'),
          expiresAt: Date.now() - 1000,
        }),
      ),
    });
    const [first, second] = await Promise.all([
      tokens.get(a, () => true),
      tokens.get(a, () => true),
    ]);
    expect(shop.refresh).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe('rotated-access');
    expect(second).toEqual(first);
    expect(first.shopCipher).toBe('private-shop-cipher');
    const saved = await db.channelAccount.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(saved.encryptedCredentials).not.toContain('rotated-access');
    expect(saved.tokenExpiresAt?.getTime()).toBe(first.expiresAt);
  });

  it('marks expired/revoked tokens as reauthorization required without repeated unauthorized jobs', async () => {
    const a = await account('TIKTOK_BUSINESS', {
      encryptedCredentials: crypto.encrypt(
        JSON.stringify({
          ...credentials(),
          expiresAt: Date.now() - 1000,
          refreshExpiresAt: Date.now() - 1,
        }),
      ),
    });
    await worker.enqueue(owner, a.id);
    const job = await db.personalCommand.findFirstOrThrow();
    await worker.process(await claim(job.id), a, () => true);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      connectionStatus: 'REAUTH_REQUIRED',
      capabilities: {},
      lastError: 'TIKTOK_TOKEN_EXPIRED',
    });
    expect(business.refresh).not.toHaveBeenCalled();
    expect(business.conversations).not.toHaveBeenCalled();
    expect(
      (await db.personalCommand.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe('FAILED');
    await expect(worker.enqueue(owner, a.id)).rejects.toMatchObject({
      code: 'TIKTOK_PERMISSION_DENIED',
    });
  });

  it('rejects a rotated identity or lost permission before persisting replacement credentials', async () => {
    const a = await account('TIKTOK_BUSINESS', {
      encryptedCredentials: crypto.encrypt(
        JSON.stringify({ ...credentials(), expiresAt: Date.now() - 1000 }),
      ),
    });
    business.refresh.mockResolvedValueOnce({
      ...credentials(),
      openId: 'foreign-account',
    });
    await expect(tokens.get(a, () => true)).rejects.toMatchObject({
      code: 'TIKTOK_TOKEN_EXPIRED',
    });
    business.refresh.mockResolvedValueOnce({
      ...credentials(),
      scopes: ['message.list.read'],
    });
    await expect(tokens.get(a, () => true)).rejects.toMatchObject({
      code: 'TIKTOK_PERMISSION_DENIED',
    });
    expect(
      (await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }))
        .encryptedCredentials,
    ).toBe(a.encryptedCredentials);
  });

  it('deduplicates webhooks and history within an account, isolates identical IDs across providers and preserves the inbound clock', async () => {
    const a = await account();
    const b = await account('TIKTOK_SHOP');
    const m = incoming({ at: new Date(Date.now() - 3600000) });
    const delivery = signedBusiness(m);
    expect(
      await webhooks.receive(
        'TIKTOK_BUSINESS',
        delivery.raw,
        delivery.signature,
      ),
    ).toEqual({ accepted: 1 });
    expect(
      await webhooks.receive(
        'TIKTOK_BUSINESS',
        delivery.raw,
        delivery.signature,
      ),
    ).toEqual({ accepted: 0 });
    const r = await db.webhookEvent.findFirstOrThrow();
    await worker.processInbound(r.id);
    await worker.processInbound(r.id);
    await persist(a, m);
    await persist(b, m);
    expect(await db.message.count()).toBe(2);
    const c = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: a.id },
    });
    expect(c.lastInboundAt).toEqual(m.at);
    await persist(a, {
      id: 'older-history',
      at: new Date(m.at.getTime() - 86400000),
    });
    await persist(a, {
      id: 'outbound-new',
      direction: 'OUTGOING',
      senderId: ownId,
    });
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
        .lastInboundAt,
    ).toEqual(m.at);
    await expect(
      persist(a, { id: m.id, conversationId: 'foreign-thread' }),
    ).rejects.toThrow();
    expect(
      await db.conversation.count({
        where: { externalConversationId: 'foreign-thread' },
      }),
    ).toBe(0);
  });

  it('does not acknowledge webhook persistence failure or accept an invalid signature', async () => {
    await account();
    const delivery = signedBusiness();
    await expect(
      webhooks.receive('TIKTOK_BUSINESS', delivery.raw, 'invalid'),
    ).rejects.toMatchObject({ code: 'TIKTOK_WEBHOOK_INVALID' });
    expect(await db.webhookEvent.count()).toBe(0);
    const failDb = {
      ...db,
      channelAccount: db.channelAccount,
      $transaction: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    } as unknown as PrismaService;
    await expect(
      new TikTokWebhookService(failDb, registry).receive(
        'TIKTOK_BUSINESS',
        delivery.raw,
        delivery.signature,
      ),
    ).rejects.toThrow('DB unavailable');
  });

  it('syncs resumable conversation/message pages with real Shop unread/reply state and stable API account filters', async () => {
    const a = await account('TIKTOK_SHOP');
    await account();
    shop.conversations
      .mockResolvedValueOnce({
        items: [
          {
            id: 'conversation-1',
            name: 'Buyer',
            contactId: peerId,
            unreadCount: 3,
            canSend: true,
          },
        ],
        cursor: 'list-next',
      })
      .mockResolvedValueOnce({ items: [], cursor: null });
    await Promise.all([
      worker.enqueue(owner, a.id),
      worker.enqueue(owner, a.id),
    ]);
    expect(await db.personalCommand.count()).toBe(1);
    let job = await db.personalCommand.findFirstOrThrow();
    await worker.process(await claim(job.id), a, () => true);
    const c = await db.conversation.findFirstOrThrow();
    expect(c).toMatchObject({
      unreadCount: 3,
      externalContactId: peerId,
      providerState: { canSend: true },
      syncComplete: false,
    });
    shop.messages
      .mockResolvedValueOnce({ items: [incoming()], cursor: 'history-next' })
      .mockResolvedValueOnce({ items: [incoming()], cursor: null });
    job = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES', status: 'PENDING' },
    });
    await worker.process(await claim(job.id), a, () => true);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
        .syncCursor,
    ).toBe('history-next');
    job = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC_MESSAGES', status: 'PENDING' },
    });
    await worker.process(await claim(job.id), a, () => true);
    job = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC', status: 'PENDING' },
    });
    await worker.process(await claim(job.id), a, () => true);
    expect(await db.message.count()).toBe(1);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({ syncComplete: true, syncCursor: null });
    const list = await inbox.conversations(
      conversationFilterSchema.parse({ account: `tiktok-shop:${a.id}` }),
      owner,
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      channelType: 'TIKTOK_SHOP',
      unreadCount: 3,
      canSend: true,
    });
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({ channelType: 'TIKTOK_BUSINESS' }),
          owner,
        )
      ).items,
    ).toHaveLength(0);
    expect((await inbox.accounts(owner)).accounts.map((x) => x.key)).toContain(
      `tiktok-shop:${a.id}`,
    );
  });

  it('retains bounded backfill checkpoints and resumes older incomplete message pages on the next sync', async () => {
    const a = await account();
    const c = await conversation(a);
    await db.conversation.update({
      where: { id: c.id },
      data: { syncCursor: 'old-history-tail' },
    });
    await db.channelAccount.update({
      where: { id: a.id },
      data: { syncCursor: 'old-list-tail' },
    });
    await worker.enqueue(owner, a.id);
    const jobs = await db.personalCommand.findMany();
    expect(jobs.find((j) => j.kind === 'SYNC_MESSAGES')?.payload).toMatchObject(
      { conversationId: c.id, cursor: 'old-history-tail' },
    );
    const job = jobs.find((j) => j.kind === 'SYNC')!;
    await db.personalCommand.update({
      where: { id: job.id },
      data: { payload: { cursor: 'old-list-tail', page: 99 } },
    });
    business.conversations.mockResolvedValueOnce({
      items: [],
      cursor: 'bounded-list-tail',
    });
    await worker.process(await claim(job.id), a, () => true);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      syncCursor: 'bounded-list-tail',
      syncComplete: false,
      lastSyncError: 'TIKTOK_SYNC_LIMIT_REACHED',
    });
  });

  it.each(['TIKTOK_BUSINESS', 'TIKTOK_SHOP'] as const)(
    'sends %s through the existing idempotent outbox and shows provider-acknowledged IDs',
    async (type) => {
      const a = await account(type);
      const key = randomUUID();
      const { c, m, job } = await queue(a, key);
      const duplicate = await personal.send(c.id, owner, {
        content: 'Trả lời TikTok',
        idempotencyKey: key,
      });
      expect(duplicate.id).toBe(m.id);
      expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(
        1,
      );
      await worker.process(job, a, () => true);
      const client = type === 'TIKTOK_BUSINESS' ? business : shop;
      expect(client.sendText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ accessToken: 'private-tiktok-access' }),
        'conversation-1',
        'Trả lời TikTok',
      );
      expect(
        await db.message.findUniqueOrThrow({ where: { id: m.id } }),
      ).toMatchObject({
        deliveryStatus: 'SENT',
        externalMessageId: 'outgoing-1',
        sendAttempts: 1,
        source: 'TIKTOK',
      });
      await worker.process(job, a, () => true);
      expect(client.sendText).toHaveBeenCalledTimes(1);
      await expect(
        personal.send(c.id, 'other-owner', {
          content: 'wrong owner',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
      await expect(worker.enqueue('other-owner', a.id)).rejects.toMatchObject({
        code: 'CHANNEL_NOT_FOUND',
      });
      expect(
        (await inbox.messages(c.id, paginationSchema.parse({}), owner)).items,
      ).toHaveLength(2);
    },
  );

  it('enforces Business window and ten-message budget at queue, retry and dispatch time under concurrency', async () => {
    const a = await account();
    const c = await conversation(a);
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, () =>
        personal.send(c.id, owner, {
          content: 'Reply',
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'TIKTOK_REPLY_LIMIT_REACHED' },
    });
    const pending = await db.message.findFirstOrThrow({
      where: { direction: 'OUTGOING' },
    });
    await db.message.update({
      where: { id: pending.id },
      data: { deliveryStatus: 'FAILED' },
    });
    await personal.send(c.id, owner, {
      content: 'Replacement',
      idempotencyKey: randomUUID(),
    });
    await expect(personal.retry(c.id, pending.id, owner)).rejects.toMatchObject(
      { code: 'TIKTOK_REPLY_LIMIT_REACHED' },
    );
    const cmd = await db.personalCommand.findFirstOrThrow({
      where: { message: { deliveryStatus: 'PENDING' } },
    });
    await db.conversation.update({
      where: { id: c.id },
      data: { lastInboundAt: new Date(Date.now() - 49 * 3600000) },
    });
    await worker.process(await claim(cmd.id), a, () => true);
    expect(business.sendText).not.toHaveBeenCalled();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: cmd.messageId! } }))
        .deliveryError,
    ).toBe('TIKTOK_REPLY_WINDOW_CLOSED');
  });

  it('rechecks Shop can_send_message at dispatch and does not send when a later sync closes it', async () => {
    const a = await account('TIKTOK_SHOP');
    const q = await queue(a);
    await db.conversation.update({
      where: { id: q.c.id },
      data: { providerState: { canSend: false, checkedAt: Date.now() } },
    });
    await worker.process(q.job, a, () => true);
    expect(shop.sendText).not.toHaveBeenCalled();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: q.m.id } }))
        .deliveryError,
    ).toBe('TIKTOK_REPLY_NOT_ALLOWED');
  });

  it('retries explicit rate denials at most three times while lost send acknowledgements remain UNKNOWN', async () => {
    const a = await account();
    const q = await queue(a);
    business.sendText.mockRejectedValueOnce(
      new TikTokError('TIKTOK_RATE_LIMITED', false, true),
    );
    await worker.process(q.job, a, () => true);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: q.m.id } }),
    ).toMatchObject({
      deliveryStatus: 'PENDING',
      deliveryError: 'TIKTOK_RATE_LIMITED',
    });
    const lastTry = await db.personalCommand.update({
      where: { id: q.job.id },
      data: { status: 'PROCESSING', attempts: 3 },
    });
    await db.channelAccount.update({
      where: { id: a.id },
      data: { lastSendAt: null },
    });
    business.sendText.mockRejectedValueOnce(
      new TikTokError('TIKTOK_RATE_LIMITED', false, true),
    );
    await worker.process(lastTry, a, () => true);
    expect(
      (await db.personalCommand.findUniqueOrThrow({ where: { id: q.job.id } }))
        .status,
    ).toBe('FAILED');
    const other = await account('TIKTOK_SHOP');
    const second = await queue(other);
    shop.sendText.mockRejectedValueOnce(
      new TikTokError('TIKTOK_SEND_UNKNOWN', true),
    );
    await worker.process(second.job, other, () => true);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: second.m.id } }),
    ).toMatchObject({ deliveryStatus: 'UNKNOWN', sendAttempts: 1 });
    await expect(
      personal.retry(second.c.id, second.m.id, owner),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_RETRYABLE' });
    await worker.process(second.job, other, () => true);
    expect(shop.sendText).toHaveBeenCalledTimes(1);
  });

  it('recovers interrupted SENDING through the shared worker without replaying an external send', async () => {
    const a = await account();
    const q = await queue(a);
    await db.message.update({
      where: { id: q.m.id },
      data: {
        deliveryStatus: 'SENDING',
        sendingAt: new Date(),
        sendAttempts: 1,
      },
    });
    const shared = new PersonalWorker(
      db,
      settings,
      crypto,
      {} as ZaloSessionManager,
      store,
    );
    await shared.recoverAfterRestart();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: q.m.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    await worker.process(q.job, a, () => true);
    expect(business.sendText).not.toHaveBeenCalled();
  });

  it('throttles the same external account across owners independently of other accounts', async () => {
    await account('TIKTOK_BUSINESS', {
      ownerId: 'another-owner',
      lastSendAt: new Date(),
    });
    const a = await account();
    const q = await queue(a);
    await worker.process(q.job, a, () => true);
    expect(business.sendText).not.toHaveBeenCalled();
    expect(
      await db.personalCommand.findUniqueOrThrow({ where: { id: q.job.id } }),
    ).toMatchObject({ status: 'PENDING', attempts: 0 });
    const other = await account('TIKTOK_SHOP');
    const second = await queue(other);
    await worker.process(second.job, other, () => true);
    expect(shop.sendText).toHaveBeenCalledTimes(1);
  });

  it('merges an early outbound webhook echo into the existing intent instead of creating a duplicate', async () => {
    const a = await account();
    const q = await queue(a);
    business.sendText.mockImplementationOnce(async () => {
      await persist(a, {
        id: 'outgoing-1',
        direction: 'OUTGOING',
        senderId: ownId,
        content: 'Trả lời TikTok',
      });
      return 'outgoing-1';
    });
    await worker.process(q.job, a, () => true);
    expect(await db.message.count()).toBe(2);
    expect(
      await db.message.findUniqueOrThrow({ where: { id: q.m.id } }),
    ).toMatchObject({
      externalMessageId: 'outgoing-1',
      deliveryStatus: 'SENT',
    });
  });

  it('applies Business read receipts only to outgoing messages in that account/conversation without reopening the reply window', async () => {
    const a = await account();
    const c = await conversation(a);
    const at = Date.now();
    const sent = await persist(a, {
      id: 'out-read',
      direction: 'OUTGOING',
      senderId: ownId,
      at: new Date(at - 100),
    });
    const other = await account('TIKTOK_SHOP');
    await persist(other, {
      id: 'out-read',
      direction: 'OUTGOING',
      at: new Date(at - 100),
    });
    const r = await receipt(a, {
      kind: 'read',
      conversationId: 'conversation-1',
      at,
      watermark: at,
    });
    await worker.processInbound(r.id);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: sent.messageId } }))
        .readAt,
    ).toEqual(new Date(at));
    expect(
      (
        await db.message.findFirstOrThrow({
          where: { channelAccountId: other.id },
        })
      ).readAt,
    ).toBeNull();
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
        .lastInboundAt,
    ).toEqual(c.lastInboundAt);
  });

  it('clears revoked seller credentials and cancels pending jobs while preserving stored conversations', async () => {
    const a = await account('TIKTOK_SHOP');
    const q = await queue(a);
    const raw = Buffer.from(
      JSON.stringify({
        type: 6,
        shop_id: 'shop-1',
        tts_notification_id: 'revoke-1',
        timestamp: Math.floor(Date.now() / 1000),
        data: {},
      }),
    );
    const signature = createHmac('sha256', 'test-shop-secret')
      .update('test-shop-key')
      .update(raw)
      .digest('hex');
    await webhooks.receive('TIKTOK_SHOP', raw, signature);
    const r = await db.webhookEvent.findFirstOrThrow();
    await worker.processInbound(r.id);
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      connectionStatus: 'REAUTH_REQUIRED',
      encryptedCredentials: null,
      capabilities: {},
      generation: a.generation + 1,
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: q.m.id } }))
        .deliveryStatus,
    ).toBe('FAILED');
    expect(
      (await db.personalCommand.findUniqueOrThrow({ where: { id: q.job.id } }))
        .status,
    ).toBe('FAILED');
    expect(await db.conversation.count()).toBe(1);
  });

  it('ignores late sync/webhook results after local disconnect, retains history and isolates owners', async () => {
    const a = await account();
    const c = await conversation(a);
    let resolve!: (value: { items: []; cursor: null }) => void;
    business.conversations.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await worker.enqueue(owner, a.id);
    const job = await db.personalCommand.findFirstOrThrow({
      where: { kind: 'SYNC' },
    });
    const syncing = worker.process(await claim(job.id), a, () => true);
    await vi.waitFor(() => expect(business.conversations).toHaveBeenCalled());
    await personal.disconnect(a.id, owner);
    resolve({ items: [], cursor: null });
    await syncing;
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      capabilities: {},
    });
    const late = await receipt(a, {
      kind: 'message',
      message: { ...incoming({ id: 'late-msg' }), at: Date.now() },
    });
    await worker.processInbound(late.id);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: late.id } }))
        .status,
    ).toBe('IGNORED');
    expect(await db.message.count({ where: { conversationId: c.id } })).toBe(1);
    await expect(inbox.conversation(c.id, 'other-owner')).rejects.toMatchObject(
      { code: 'CONVERSATION_NOT_FOUND' },
    );
  });

  it('ignores revocations from a previous connection generation or before the latest authorization', async () => {
    const a = await account('TIKTOK_SHOP', { lastConnectedAt: new Date() });
    const accepted = await receipt(a, {
      kind: 'message',
      generation: a.generation,
      message: { ...incoming(), at: Date.now() - 1000 },
    });
    const stale = await receipt(a, {
      kind: 'revoked',
      generation: a.generation,
    });
    await db.channelAccount.update({
      where: { id: a.id },
      data: { generation: { increment: 1 } },
    });
    await worker.processInbound(stale.id);
    await worker.processInbound(accepted.id);
    expect(await db.message.count()).toBe(1);
    const delayed = await receipt(a, {
      kind: 'revoked',
      at: Date.now() - 60000,
    });
    await worker.processInbound(delayed.id);
    expect(await db.webhookEvent.count({ where: { status: 'IGNORED' } })).toBe(
      2,
    );
    expect(
      await db.channelAccount.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({
      connectionStatus: 'CONNECTED',
      encryptedCredentials: a.encryptedCredentials,
    });
  });

  it('emits owner-scoped realtime notification only after inbound transaction commits, without credentials or message content', async () => {
    const a = await account();
    const listener = new Client({ connectionString: testUrl });
    await listener.connect();
    try {
      const events: string[] = [];
      listener.on('notification', (e) => events.push(e.payload ?? ''));
      await listener.query('LISTEN zalo_inbox_events');
      const delivery = signedBusiness();
      await webhooks.receive(
        'TIKTOK_BUSINESS',
        delivery.raw,
        delivery.signature,
      );
      const r = await db.webhookEvent.findFirstOrThrow();
      await worker.processInbound(r.id);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(JSON.parse(events[0])).toMatchObject({
        ownerId: owner,
        event: { type: 'message.created', channelAccountId: a.id },
      });
      expect(events[0]).not.toMatch(/private-tiktok|Tin khách gửi|cipher/);
      expect(await db.message.count()).toBe(1);
    } finally {
      await listener.end();
    }
  });
});
