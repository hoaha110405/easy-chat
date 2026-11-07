import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { conversationFilterSchema, paginationSchema } from '@zalo/shared';
import type { ChannelAccount } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import {
  MessageStore,
  type NormalizedMessage,
} from '../src/modules/inbox/message-store';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { config } from './helpers';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test.',
  );
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
const inbox = new InboxService(db);
const store = new MessageStore();
const owner = 'administrator';
async function clean() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
}
async function account(type = 'ZALO_PERSONAL', ownerId = owner) {
  return db.channelAccount.create({
    data: {
      ownerId,
      channelType: type,
      externalAccountId: randomUUID(),
      name: 'Unread fixture',
    },
  });
}
function message(extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    oaId: 'fixture-oa',
    userId: 'customer-1',
    externalMessageId: randomUUID(),
    direction: 'INCOMING',
    type: 'text',
    content: 'Incoming unread fixture',
    sentAt: new Date(),
    metadata: {},
    source: 'FACEBOOK',
    ...extra,
  };
}
function save(a: ChannelAccount, extra: Partial<NormalizedMessage> = {}) {
  const m = message(extra);
  return db.$transaction((tx) =>
    store.persistChannel(tx, a.id, m, 'sender-fixture'),
  );
}
beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  await db.$connect();
}, 30000);
beforeEach(clean);
afterAll(async () => {
  await clean();
  await db.$disconnect();
});

describe('durable easyChat unread state', () => {
  it.each(['ZALO_PERSONAL', 'FACEBOOK_PAGE', 'TIKTOK_BUSINESS', 'TIKTOK_SHOP'])(
    'tracks incoming and outgoing separately for %s without provider read receipts',
    async (type) => {
      const a = await account(type);
      const incoming = await save(a);
      const outgoing = await save(a, { direction: 'OUTGOING' });
      expect(
        (await inbox.conversation(incoming.conversationId, owner))
          .inboxUnreadCount,
      ).toBe(1);
      expect(
        (
          await db.message.findUniqueOrThrow({
            where: { id: outgoing.messageId },
          })
        ).inboxUnread,
      ).toBe(false);
      const before = await db.conversation.findUniqueOrThrow({
        where: { id: incoming.conversationId },
      });
      expect(
        await inbox.markRead(
          incoming.conversationId,
          [incoming.messageId, outgoing.messageId],
          owner,
        ),
      ).toEqual({ markedRead: 1 });
      const after = await inbox.conversation(incoming.conversationId, owner);
      expect(after.inboxUnreadCount).toBe(0);
      expect(after.lastInboundAt).toEqual(before.lastInboundAt);
      expect(
        await db.message.findUniqueOrThrow({
          where: { id: incoming.messageId },
        }),
      ).toMatchObject({
        inboxUnread: false,
        readAt: null,
        deliveryStatus: 'SENT',
      });
    },
  );
  it('includes both Zalo OA and the actual personal-message persistence path', async () => {
    const oa = await db.zaloConnection.create({
      data: {
        oaId: 'oa-unread-fixture',
        oaName: 'OA unread',
        tokenExpiresAt: new Date(),
      },
    });
    const saved = await db.$transaction((tx) =>
      store.persist(tx, oa.id, message({ source: 'WEBHOOK' })),
    );
    const a = await account();
    const personal = await db.$transaction((tx) =>
      store.persistPersonal(tx, a.id, {
        externalThreadId: '111',
        externalMessageId: '222',
        externalSenderId: '111',
        direction: 'INCOMING',
        type: 'text',
        content: 'Personal unread',
        sentAt: new Date().toISOString(),
        attachments: [],
      }),
    );
    expect(
      (await inbox.conversation(saved.conversationId)).inboxUnreadCount,
    ).toBe(1);
    expect(
      (await inbox.conversation(personal.conversationId)).inboxUnreadCount,
    ).toBe(1);
    const accounts = (await inbox.accounts()).accounts;
    expect(
      accounts.find((x) => x.key === `oa:${oa.id}`)?.unreadMessageCount,
    ).toBe(1);
    expect(
      accounts.find((x) => x.key === `personal:${a.id}`)?.unreadMessageCount,
    ).toBe(1);
    await inbox.markRead(saved.conversationId, [saved.messageId]);
    expect(
      (await inbox.accounts()).accounts.find((x) => x.key === `oa:${oa.id}`)
        ?.unreadMessageCount,
    ).toBe(0);
  });
  it('does not re-mark read messages as unread on duplicate webhook/history delivery', async () => {
    const a = await account();
    const event = message();
    const saved = await save(a, event);
    await inbox.markRead(saved.conversationId, [saved.messageId]);
    expect((await save(a, { ...event, source: 'HISTORY' })).duplicate).toBe(
      true,
    );
    expect(
      (await inbox.conversation(saved.conversationId)).inboxUnreadCount,
    ).toBe(0);
    expect(await db.message.count()).toBe(1);
  });
  it('marks exactly visible IDs, preserving a concurrent new arrival and hidden older messages', async () => {
    const a = await account();
    const hidden = await save(a);
    const seen = await save(a);
    const snapshot = await inbox.messages(
      seen.conversationId,
      paginationSchema.parse({}),
    );
    expect(snapshot.items.every((m) => m.inboxUnread)).toBe(true);
    const newer = await save(a);
    const results = await Promise.all([
      inbox.markRead(seen.conversationId, [seen.messageId]),
      inbox.markRead(seen.conversationId, [seen.messageId]),
    ]);
    expect(results.reduce((sum, r) => sum + r.markedRead, 0)).toBe(1);
    expect(
      (await inbox.conversation(seen.conversationId)).inboxUnreadCount,
    ).toBe(2);
    const persisted = await inbox.messages(
      seen.conversationId,
      paginationSchema.parse({}),
    );
    expect(
      persisted.items.find((m) => m.id === seen.messageId)?.inboxUnread,
    ).toBe(false);
    for (const id of [hidden.messageId, newer.messageId])
      expect(persisted.items.find((m) => m.id === id)?.inboxUnread).toBe(true);
  });
  it('enforces owner and conversation boundaries even when another message ID is submitted', async () => {
    const a = await account();
    const one = await save(a);
    const other = await save(a, { userId: 'customer-2' });
    const foreign = await account('FACEBOOK_PAGE', 'other-owner');
    const theirs = await save(foreign);
    await expect(
      inbox.markRead(theirs.conversationId, [theirs.messageId], owner),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect(
      await inbox.markRead(
        one.conversationId,
        [other.messageId, theirs.messageId],
        owner,
      ),
    ).toEqual({ markedRead: 0 });
    expect(
      (await inbox.conversation(one.conversationId)).inboxUnreadCount,
    ).toBe(1);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: theirs.messageId } }))
        .inboxUnread,
    ).toBe(true);
  });
  it('counts all unread messages per account independently of loaded conversation pages and channel filters', async () => {
    const a = await account();
    await save(a);
    await save(a);
    await save(a, { userId: 'customer-2' });
    const b = await account('TIKTOK_SHOP');
    await save(b);
    const foreign = await account('FACEBOOK_PAGE', 'other-owner');
    await save(foreign);
    const accounts = (await inbox.accounts(owner)).accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts.find((x) => x.id === a.id)?.unreadMessageCount).toBe(3);
    expect(accounts.find((x) => x.id === b.id)?.unreadMessageCount).toBe(1);
    const first = await inbox.conversations(
      conversationFilterSchema.parse({ limit: 1, account: `personal:${a.id}` }),
      owner,
    );
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.items[0].inboxUnreadCount).toBeGreaterThan(0);
    const page = await inbox.conversations(
      conversationFilterSchema.parse({ channelType: 'TIKTOK_SHOP' }),
      owner,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].inboxUnreadCount).toBe(1);
  });
  it('keeps provider unread counts and local read state independent', async () => {
    const a = await account('TIKTOK_SHOP');
    const saved = await save(a);
    await db.conversation.update({
      where: { id: saved.conversationId },
      data: { unreadCount: 7 },
    });
    await inbox.markRead(saved.conversationId, [saved.messageId]);
    expect(await inbox.conversation(saved.conversationId)).toMatchObject({
      inboxUnreadCount: 0,
      unreadCount: 7,
    });
  });
  it('protects the real HTTP read endpoint with session, origin and validated message IDs', async () => {
    const a = await account();
    const saved = await save(a);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(ConfigService)
      .useValue({
        ...config,
        env: { ...config.env, DATABASE_URL: testUrl },
      } as ConfigService)
      .compile();
    const app = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
      logger: false,
    });
    configureApp(app);
    await app.init();
    try {
      const path = `/api/conversations/${saved.conversationId}/read`;
      const server = app.getHttpServer();
      const browser = request.agent(server);
      await request(server)
        .post(path)
        .send({ messageIds: [saved.messageId] })
        .expect(401);
      await browser
        .post('/api/auth/login')
        .set('Origin', config.env.FRONTEND_URL)
        .send({ password: config.env.ADMIN_PASSWORD })
        .expect(200);
      await browser
        .post(path)
        .send({ messageIds: [saved.messageId] })
        .expect(403);
      await browser
        .post(path)
        .set('Origin', config.env.FRONTEND_URL)
        .send({ messageIds: [] })
        .expect(400);
      const result = await browser
        .post(path)
        .set('Origin', config.env.FRONTEND_URL)
        .send({ messageIds: [saved.messageId] })
        .expect(200);
      expect(result.body.data).toEqual({ markedRead: 1 });
      const refreshed = await browser
        .get(`/api/conversations/${saved.conversationId}`)
        .expect(200);
      expect(refreshed.body.data.inboxUnreadCount).toBe(0);
    } finally {
      await app.close();
      await db.$connect();
    }
  });
});
