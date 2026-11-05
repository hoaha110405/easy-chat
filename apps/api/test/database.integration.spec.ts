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
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { ZaloApiClient } from '../src/modules/zalo/zalo-api.client';
import { ZaloHistoryService } from '../src/modules/zalo/zalo-history.service';
import { ZaloHttpService } from '../src/modules/zalo/zalo-http.service';
import { ZaloOAuthService } from '../src/modules/zalo/zalo-oauth.service';
import { MessageStore } from '../src/modules/inbox/message-store';
import { hash } from '../src/common/crypto.service';
import incoming from './fixtures/user-send-text.json';
import outgoing from './fixtures/oa-send-text.json';
import { config, crypto } from './helpers';
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test. This suite deletes its rows.',
  );
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
let app: NestExpressApplication;
const origin = config.env.FRONTEND_URL;
async function connection() {
  return db.zaloConnection.create({
    data: {
      oaId: incoming.recipient.id,
      oaName: 'Integration test OA',
      encryptedAccessToken: crypto.encrypt('old-access'),
      encryptedRefreshToken: crypto.encrypt('old-refresh'),
      tokenExpiresAt: new Date(Date.now() + 900000),
    },
  });
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
function deliver(event: object, valid = true) {
  const raw = JSON.stringify(event);
  const timestamp = (event as { timestamp: string }).timestamp;
  const signature = createHash('sha256')
    .update(config.env.ZALO_APP_ID)
    .update(raw)
    .update(timestamp)
    .update(config.env.ZALO_OA_SECRET_KEY)
    .digest('hex');
  return request(app.getHttpServer())
    .post('/api/webhooks/zalo')
    .set('Content-Type', 'application/json')
    .set('X-ZEvent-Signature', valid ? `mac=${signature}` : 'invalid')
    .send(raw);
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
    .useValue({ ...config, env: { ...config.env, DATABASE_URL: testUrl } })
    .compile();
  app = module.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app);
  await app.init();
}, 30000);
beforeEach(async () => {
  app.get<ThrottlerStorageService>(ThrottlerStorage).onApplicationShutdown();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (app) await app.close();
  await db.$disconnect();
});
describe('PostgreSQL and protected HTTP API', () => {
  it('rate limits repeated administrator login attempts', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ password: 'incorrect-password' })
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ password: 'incorrect-password' })
      .expect(429);
  });
  it('returns a validation error for malformed JSON', async () => {
    await request(app.getHttpServer())
      .post('/api/webhooks/zalo')
      .set('Content-Type', 'application/json')
      .send('{invalid')
      .expect(400);
  });
  it('exposes and recovers stale receipts left between commit and processing', async () => {
    await connection();
    const receipt = await db.webhookEvent.create({
      data: {
        digest: 'crash-recovery-fixture',
        eventName: incoming.event_name,
        payload: incoming,
        receivedAt: new Date(Date.now() - 120000),
      },
    });
    const agent = await admin();
    const status = await agent.get('/api/zalo/status').expect(200);
    expect(status.body.data.failedWebhookCount).toBe(1);
    const receipts = await agent
      .get('/api/zalo/webhook-events/failed')
      .expect(200);
    expect(receipts.body.data[0].id).toBe(receipt.id);
    await agent
      .post(`/api/zalo/webhook-events/${receipt.id}/retry`)
      .set('Origin', origin)
      .expect(200);
    expect(await db.message.count()).toBe(1);
  });
  it('requires a server session, rejects cross-origin mutations and revokes logout sessions', async () => {
    await request(app.getHttpServer()).get('/api/conversations').expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('Origin', 'https://untrusted.example')
      .send({ password: config.env.ADMIN_PASSWORD })
      .expect(403);
    const agent = await admin();
    await agent.get('/api/auth/session').expect(200);
    await agent.delete('/api/zalo/connection').expect(403);
    await agent.post('/api/auth/logout').set('Origin', origin).expect(200);
    await agent.get('/api/conversations').expect(401);
  });
  it('persists a conversation exactly once across concurrent duplicate webhook deliveries', async () => {
    const conn = await connection();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => deliver(incoming)),
    );
    expect(responses.map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(await db.message.count()).toBe(1);
    expect(await db.conversation.count()).toBe(1);
    expect((await db.message.findFirst())?.connectionId).toBe(conn.id);
    expect((await db.webhookEvent.findFirst())?.status).toBe('PROCESSED');
  });
  it('creates one conversation when distinct first messages arrive simultaneously', async () => {
    await connection();
    const deliveries = Array.from({ length: 6 }, (_, index) => ({
      ...incoming,
      message: {
        text: `Concurrent fixture ${index}`,
        msg_id: `concurrent-${index}`,
      },
      timestamp: String(Number(incoming.timestamp) + index),
    }));
    const responses = await Promise.all(
      deliveries.map((event) => deliver(event)),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(6).fill(200),
    );
    expect(await db.conversation.count()).toBe(1);
    expect(await db.message.count()).toBe(6);
    expect((await db.conversation.findFirstOrThrow()).lastMessagePreview).toBe(
      'Concurrent fixture 5',
    );
  });
  it('deduplicates messages even when delivery payloads differ and preserves the newest preview', async () => {
    await connection();
    await deliver(outgoing).expect(200);
    await deliver(incoming).expect(200);
    await deliver({
      ...incoming,
      user_id_by_app: 'different-delivery-field',
    }).expect(200);
    expect(await db.message.count()).toBe(2);
    const conv = await db.conversation.findFirstOrThrow();
    expect(conv.lastMessagePreview).toBe(outgoing.message.text);
    expect(conv.lastMessageAt?.getTime()).toBe(Number(outgoing.timestamp));
    const agent = await admin();
    const list = await agent
      .get('/api/conversations?page=1&limit=1')
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
    const messages = await agent
      .get(`/api/conversations/${conv.id}/messages?limit=1`)
      .expect(200);
    expect(messages.body.data.hasMore).toBe(true);
    expect(messages.body.data.items[0].direction).toBe('OUTGOING');
    const older = await agent
      .get(`/api/conversations/${conv.id}/messages?page=2&limit=1`)
      .expect(200);
    expect(older.body.data.items[0].direction).toBe('INCOMING');
    await agent.get('/api/conversations?limit=101').expect(400);
    await agent
      .get('/api/conversations/c000000000000000000000000/messages')
      .expect(404);
  });
  it('rejects tampered signatures without persisting untrusted events', async () => {
    await deliver(incoming, false).expect(401);
    expect(await db.webhookEvent.count()).toBe(0);
  });
  it('keeps authenticated failures durable and allows administrator retry after reconnection', async () => {
    await deliver(incoming).expect(503);
    const event = await db.webhookEvent.findFirstOrThrow();
    expect(event.status).toBe('FAILED');
    expect(event.error).toBe('OA_NOT_CONNECTED');
    expect(await db.message.count()).toBe(0);
    await connection();
    const agent = await admin();
    const failed = await agent
      .get('/api/zalo/webhook-events/failed')
      .expect(200);
    expect(failed.body.data).toHaveLength(1);
    await agent
      .post(`/api/zalo/webhook-events/${event.id}/retry`)
      .set('Origin', origin)
      .expect(200);
    expect(await db.message.count()).toBe(1);
    expect(
      (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } }))
        .status,
    ).toBe('PROCESSED');
  });
  it('records malformed supported events and explicitly acknowledges unsupported non-message events', async () => {
    await connection();
    await deliver({ ...incoming, message: { text: 'missing ID' } }).expect(422);
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('FAILED');
    await deliver({ ...incoming, event_name: 'follow' }).expect(200);
    expect(await db.webhookEvent.count({ where: { status: 'IGNORED' } })).toBe(
      1,
    );
    expect(await db.message.count()).toBe(0);
  });
  it('rolls back partial message work on storage failure and successfully replays the receipt', async () => {
    await connection();
    const store = app.get(MessageStore);
    const persist = store.persist.bind(store);
    const messageCreate = vi
      .spyOn(store, 'persist')
      .mockImplementationOnce(async (tx, connectionId, message) => {
        await persist(tx, connectionId, message);
        throw new Error('synthetic storage failure after writes');
      });
    await deliver(incoming).expect(500);
    expect(await db.conversation.count()).toBe(0);
    expect(await db.message.count()).toBe(0);
    expect((await db.webhookEvent.findFirstOrThrow()).status).toBe('FAILED');
    messageCreate.mockRestore();
    await deliver(incoming).expect(200);
    expect(await db.message.count()).toBe(1);
  });
  it('serializes concurrent refreshes against the same rotating token in PostgreSQL', async () => {
    const conn = await connection();
    await db.zaloConnection.update({
      where: { id: conn.id },
      data: { tokenExpiresAt: new Date(0) },
    });
    const exchange = vi
      .spyOn(app.get(ZaloApiClient), 'exchangeToken')
      .mockResolvedValue({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 90000,
      });
    const tokens = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.get(ZaloApiClient).accessToken(conn.id),
      ),
    );
    expect(tokens).toEqual(Array(6).fill('rotated-access'));
    expect(exchange).toHaveBeenCalledTimes(1);
    const saved = await db.zaloConnection.findUniqueOrThrow({
      where: { id: conn.id },
    });
    expect(crypto.decrypt(saved.encryptedRefreshToken!)).toBe(
      'rotated-refresh',
    );
  });
  it('consumes OAuth state only once across simultaneous callbacks', async () => {
    const state = 'single-use-state';
    await db.adminSession.create({
      data: {
        id: 'oauth-session',
        expiresAt: new Date(Date.now() + 60000),
        oauthExpiresAt: new Date(Date.now() + 60000),
        oauthStateHash: hash(state),
        encryptedVerifier: crypto.encrypt('test-verifier'),
      },
    });
    const api = app.get(ZaloApiClient);
    const exchange = vi.spyOn(api, 'exchangeToken').mockResolvedValue({
      access_token: 'oauth-access',
      refresh_token: 'oauth-refresh',
      expires_in: 90000,
    });
    vi.spyOn(api, 'profileWithToken').mockResolvedValue({
      oaid: incoming.recipient.id,
      name: 'Authorized test OA',
    });
    const results = await Promise.allSettled([
      app.get(ZaloOAuthService).callback('oauth-session', state, 'code'),
      app.get(ZaloOAuthService).callback('oauth-session', state, 'code'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await db.zaloConnection.count()).toBe(1);
  });
  it('completes the browser OAuth callback without exposing tokens', async () => {
    const agent = await admin();
    const connect = await agent.get('/api/zalo/connect').expect(200);
    const state = new URL(connect.body.data.authorizationUrl).searchParams.get(
      'state',
    )!;
    const api = app.get(ZaloApiClient);
    vi.spyOn(api, 'exchangeToken').mockResolvedValue({
      access_token: 'private-access',
      refresh_token: 'private-refresh',
      expires_in: 90000,
    });
    vi.spyOn(api, 'profileWithToken').mockResolvedValue({
      oaid: incoming.recipient.id,
      name: 'Authorized test OA',
    });
    const callback = await agent
      .get(
        `/api/zalo/callback?state=${state}&code=test-code&oa_id=${incoming.recipient.id}`,
      )
      .expect(303);
    expect(callback.headers.location).toBe(
      'http://localhost:5173/connection?oauth=connected',
    );
    const status = await agent.get('/api/zalo/status').expect(200);
    expect(status.body.data.connection.oaName).toBe('Authorized test OA');
    expect(JSON.stringify(status.body)).not.toMatch(
      /private-access|private-refresh|encryptedAccessToken/,
    );
    await agent
      .get(`/api/zalo/callback?state=${state}&code=test-code`)
      .expect(303)
      .expect(
        'Location',
        'http://localhost:5173/connection?oauth=INVALID_OAUTH_STATE',
      );
    await agent
      .delete('/api/zalo/connection')
      .set('Origin', origin)
      .expect(200);
    const saved = await db.zaloConnection.findFirstOrThrow();
    expect(saved.encryptedAccessToken).toBeNull();
    expect(saved.encryptedRefreshToken).toBeNull();
  });
  it('deduplicates authorized known-user history against webhook messages', async () => {
    await connection();
    await deliver(incoming).expect(200);
    const conversation = await db.conversation.findFirstOrThrow();
    vi.spyOn(app.get(ZaloHttpService), 'request').mockResolvedValue({
      data: [
        {
          message_id: incoming.message.msg_id,
          src: 1,
          time: Number(incoming.timestamp),
          type: 'text',
          message: incoming.message.text,
          from_id: incoming.sender.id,
          to_id: incoming.recipient.id,
        },
        {
          message_id: 'historical-message',
          src: 0,
          time: Number(incoming.timestamp) - 1000,
          type: 'text',
          message: 'Imported fixture',
          from_id: incoming.recipient.id,
          to_id: incoming.sender.id,
        },
      ],
    });
    const result = await app
      .get(ZaloHistoryService)
      .syncConversationPage(conversation.id);
    expect(result.inserted).toBe(1);
    expect(await db.message.count()).toBe(2);
    expect(await db.message.count({ where: { source: 'HISTORY' } })).toBe(1);
  });
});
