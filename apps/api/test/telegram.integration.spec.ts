import 'reflect-metadata';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  rm,
  stat,
  mkdir,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Client } from 'pg';
import { paginationSchema, telegramStatusSchema } from '@zalo/shared';
import type { ChannelAccount } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { CryptoService } from '../src/common/crypto.service';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { MessageStore } from '../src/modules/inbox/message-store';
import {
  PersonalService,
  WORKER_ID,
} from '../src/modules/zalo-personal/personal.service';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import type { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import { TelegramBotClient } from '../src/modules/telegram-bot/telegram-bot.client';
import {
  TdLibManager,
  TDLIB_CLIENT_FACTORY,
} from '../src/modules/telegram-personal/tdlib.manager';
import type {
  TdClient,
  TdObject,
} from '../src/modules/telegram-personal/tdjson.client';
import { TelegramSettings } from '../src/modules/telegram/telegram.config';
import { TelegramRpcClient } from '../src/modules/telegram/telegram.rpc';
import { TelegramReceipts } from '../src/modules/telegram/telegram-receipts.service';
import { TelegramService } from '../src/modules/telegram/telegram.service';
import { TelegramWorker } from '../src/modules/telegram/telegram.worker';
import {
  TelegramError,
  botCredentialsSchema,
} from '../src/modules/telegram/telegram.types';
import { config } from './helpers';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw Error(
    'TEST_DATABASE_URL must name a dedicated database ending in _test.',
  );
const db = new PrismaService({ datasources: { db: { url: testUrl } } });
const owner = 'administrator',
  token = `1234567890:${'A'.repeat(35)}`;
const date = Math.floor(Date.now() / 1000) - 100;

const tdChat = {
  id: 42,
  title: 'Cloud Peer',
  type: { '@type': 'chatTypePrivate', user_id: 42 },
  permissions: { can_send_basic_messages: true },
  unread_count: 2,
  last_read_inbox_message_id: 0,
  last_read_outbox_message_id: 0,
};
function tdMessage(id = 1048576, outgoing = false, text = 'Cloud hello') {
  return {
    id,
    chat_id: 42,
    sender_id: { '@type': 'messageSenderUser', user_id: outgoing ? 77 : 42 },
    is_outgoing: outgoing,
    date,
    edit_date: 0,
    content: {
      '@type': 'messageText',
      text: { '@type': 'formattedText', text, entities: [] },
    },
    sending_state: null,
    topic_id: null,
  };
}
class FakeTdClient extends EventEmitter implements TdClient {
  state: TdObject = { '@type': 'authorizationStateWaitTdlibParameters' };
  chat: Record<string, unknown> = { ...tdChat };
  messages = [tdMessage(2097152), tdMessage()];
  ownId = 77;
  restoring = false;
  sendMode: 'success' | 'pending' | 'crash' = 'success';
  close = vi.fn(async () => {
    this.emit('closed');
  });
  advance(state: string) {
    this.state = { '@type': state };
    this.emit('update', {
      '@type': 'updateAuthorizationState',
      authorization_state: this.state,
    });
  }
  request = vi.fn(async (q: Record<string, unknown>): Promise<TdObject> => {
    const type = q['@type'];
    if (type === 'getOption')
      return { '@type': 'optionValueString', value: '1.8.69' };
    if (type === 'getAuthorizationState') return this.state;
    if (type === 'setTdlibParameters') {
      queueMicrotask(() =>
        this.advance(
          this.restoring
            ? 'authorizationStateReady'
            : 'authorizationStateWaitPhoneNumber',
        ),
      );
      return { '@type': 'ok' };
    }
    if (type === 'setAuthenticationPhoneNumber') {
      queueMicrotask(() => this.advance('authorizationStateWaitCode'));
      return { '@type': 'ok' };
    }
    if (type === 'checkAuthenticationCode') {
      queueMicrotask(() => this.advance('authorizationStateWaitPassword'));
      return { '@type': 'ok' };
    }
    if (type === 'checkAuthenticationPassword') {
      queueMicrotask(() => {
        this.advance('authorizationStateReady');
        this.emit('update', {
          '@type': 'updateConnectionState',
          state: { '@type': 'connectionStateReady' },
        });
      });
      return { '@type': 'ok' };
    }
    if (type === 'setAuthenticationEmailAddress') {
      queueMicrotask(() => this.advance('authorizationStateWaitEmailCode'));
      return { '@type': 'ok' };
    }
    if (type === 'checkAuthenticationEmailCode') {
      queueMicrotask(() => this.advance('authorizationStateWaitCode'));
      return { '@type': 'ok' };
    }
    if (type === 'getMe')
      return {
        '@type': 'user',
        id: this.ownId,
        first_name: 'Personal fixture',
      };
    if (type === 'getChat') return { '@type': 'chat', ...this.chat };
    if (type === 'getBasicGroup' || type === 'getSupergroup')
      return {
        '@type': type === 'getBasicGroup' ? 'basicGroup' : 'supergroup',
        status: { '@type': 'chatMemberStatusAdministrator' },
      };
    if (type === 'loadChats') throw new TelegramError('TELEGRAM_NOT_FOUND');
    if (type === 'getChats')
      return {
        '@type': 'chats',
        chat_ids:
          q.chat_list &&
          (q.chat_list as TdObject)['@type'] === 'chatListArchive'
            ? []
            : [this.chat.id],
      };
    if (type === 'getChatHistory')
      return {
        '@type': 'messages',
        messages: String(q.from_message_id) === '0' ? this.messages : [],
      };
    if (type === 'getMessage')
      return {
        '@type': 'message',
        ...tdMessage(Number(q.message_id), false, 'Current content'),
        edit_date: date + 5,
      };
    if (type === 'sendMessage') {
      if (this.sendMode === 'crash') {
        queueMicrotask(() => this.emit('closed'));
        throw new TelegramError('TELEGRAM_SEND_UNKNOWN', true);
      }
      const input = q.input_message_content as Record<string, unknown>;
      const text = (input.text ?? input.caption) as
        { text?: string } | undefined;
      const content: Record<string, unknown> =
        input['@type'] === 'inputMessageText'
          ? tdMessage(999, true, text?.text ?? '').content
          : input['@type'] === 'inputMessageAudio'
            ? {
                '@type': 'messageAudio',
                audio: {
                  file_name: 'voice.mp3',
                  mime_type: 'audio/mpeg',
                  audio: { id: 701 },
                },
                caption: input.caption,
              }
            : {
                '@type': 'messageDocument',
                document: {
                  file_name: 'invoice.pdf',
                  mime_type: 'application/pdf',
                  document: { id: 701 },
                },
                caption: input.caption,
              };
      const m = { ...tdMessage(999, true, text?.text ?? ''), content };
      if (this.sendMode === 'success')
        setTimeout(
          () =>
            this.emit('update', {
              '@type': 'updateMessageSendSucceeded',
              old_message_id: 999,
              message: { ...m, id: 3145728 },
            }),
          200,
        );
      return {
        '@type': 'message',
        ...m,
        sending_state: { '@type': 'messageSendingStatePending' },
      };
    }
    return { '@type': 'ok' };
  });
}
let app: NestExpressApplication,
  worker: TelegramWorker,
  native: TdLibManager,
  service: TelegramService,
  receipts: TelegramReceipts,
  personal: PersonalService,
  inbox: InboxService,
  crypto: CryptoService,
  settings: TelegramSettings,
  cfg: ConfigService;
let directory = '',
  clients: FakeTdClient[] = [];
let browser: ReturnType<typeof request.agent>;
let botRequest = vi.fn();
async function clean() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
}
async function current(id: string) {
  return db.channelAccount.findUniqueOrThrow({ where: { id } });
}
async function run(kind?: 'SEND' | 'SYNC' | 'SYNC_MESSAGES') {
  const next = await db.personalCommand.findFirst({
    where: { status: 'PENDING', ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (!next) return false;
  const job = await db.personalCommand.update({
    where: { id: next.id },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  await worker.process(job, await current(job.channelAccountId), () => true);
  return true;
}
async function drain() {
  for (let i = 0; i < 15; i++) {
    if (!(await run())) return;
  }
  throw Error('Fixture command queue did not drain');
}
async function connectBot() {
  const r = await browser
    .post('/api/channels/telegram-bot/connect')
    .set('Origin', config.env.FRONTEND_URL)
    .send({ token })
    .expect(200);
  return current(r.body.data.id);
}
async function inbound(
  a: ChannelAccount,
  update = 1,
  chat = 42,
  text = 'Hello',
) {
  const creds = botCredentialsSchema.parse(
    JSON.parse(crypto.decrypt(a.encryptedCredentials!)),
  );
  await browser
    .post(`/api/channels/telegram-bot/${a.id}/webhook`)
    .set('X-Telegram-Bot-Api-Secret-Token', creds.webhookSecret)
    .send({
      update_id: update,
      message: {
        message_id: 9,
        date,
        chat: { id: chat, type: 'private', first_name: 'Peer' },
        from: { id: chat, first_name: 'Peer' },
        text,
      },
    })
    .expect(200);
  return db.conversation.findFirstOrThrow({
    where: { channelAccountId: a.id, externalConversationId: String(chat) },
  });
}
async function startPersonal() {
  const response = await browser
    .post('/api/channels/telegram-personal/connect')
    .set('Origin', config.env.FRONTEND_URL)
    .send({ name: 'Fixture' })
    .expect(200);
  return current(response.body.data.id);
}
async function auth(a: ChannelAccount, action: string, value: string) {
  return browser
    .post(`/api/channels/telegram-personal/${a.id}/auth`)
    .set('Origin', config.env.FRONTEND_URL)
    .send({ action, value })
    .expect(200);
}
async function ready() {
  let a = await startPersonal();
  await vi.waitFor(() =>
    expect(clients.at(-1)!.state['@type']).toBe(
      'authorizationStateWaitPhoneNumber',
    ),
  );
  await auth(a, 'phone', '+84123456789');
  await vi.waitFor(() =>
    expect(clients.at(-1)!.state['@type']).toBe('authorizationStateWaitCode'),
  );
  await auth(a, 'code', 'test-otp-code');
  await vi.waitFor(() =>
    expect(clients.at(-1)!.state['@type']).toBe(
      'authorizationStateWaitPassword',
    ),
  );
  await auth(a, 'password', 'test-2fa-password');
  await vi.waitFor(async () =>
    expect((await current(a.id)).connectionStatus).toBe('CONNECTED'),
  );
  a = await current(a.id);
  return a;
}
beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
  await db.$connect();
}, 30000);
beforeEach(async () => {
  await db.$connect();
  await clean();
  clients = [];
  directory = await mkdtemp(join(tmpdir(), 'easychat-tg-db-'));
  cfg = {
    ...config,
    telegramConfigured: true,
    env: {
      ...config.env,
      DATABASE_URL: testUrl,
      TELEGRAM_PERSONAL_ENABLED: true,
      TELEGRAM_API_ID: 12345,
      TELEGRAM_API_HASH: 'test-app-hash',
      TELEGRAM_BOT_ENABLED: true,
      TELEGRAM_BOT_WEBHOOK_BASE_URL: 'https://easy.example',
      TELEGRAM_DATA_DIR: directory,
      TELEGRAM_RPC_SOCKET: join(directory, 'worker.sock'),
    },
  } as ConfigService;
  settings = new TelegramSettings(cfg);
  vi.spyOn(settings, 'nativeAvailable').mockResolvedValue(true);
  botRequest = vi.fn(async (options: { url: string; data?: unknown }) => {
    const method = options.url.split('/').at(-1);
    let result: unknown = true;
    if (method === 'getMe')
      result = {
        id: 1234567890,
        is_bot: true,
        first_name: 'Fixture bot',
        username: 'fixture_bot',
      };
    if (method === 'getWebhookInfo') {
      const a = await db.channelAccount.findFirstOrThrow({
        where: { channelType: 'TELEGRAM_BOT' },
      });
      result = { url: settings.webhookUrl(a.id), pending_update_count: 0 };
    }
    if (method === 'sendMessage') {
      const data = options.data as { chat_id: string; text: string };
      result = {
        message_id: 10,
        date,
        chat: { id: data.chat_id, type: 'private' },
        from: { id: 1234567890, is_bot: true },
        text: data.text,
      };
    }
    return { status: 200, data: { ok: true, result } };
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(ConfigService)
    .useValue(cfg)
    .overrideProvider(TelegramSettings)
    .useValue(settings)
    .overrideProvider(TelegramBotClient)
    .useValue(new TelegramBotClient({ request: botRequest }))
    .overrideProvider(TDLIB_CLIENT_FACTORY)
    .useValue(() => {
      const client = new FakeTdClient();
      clients.push(client);
      return client;
    })
    .compile();
  app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app);
  await app.init();
  worker = module.get(TelegramWorker);
  native = module.get(TdLibManager);
  service = module.get(TelegramService);
  receipts = module.get(TelegramReceipts);
  personal = module.get(PersonalService);
  inbox = module.get(InboxService);
  crypto = module.get(CryptoService);
  await db.personalWorkerState.create({
    data: {
      id: WORKER_ID,
      instanceId: 'telegram-test-worker',
      heartbeatAt: new Date(),
    },
  });
  await worker.start();
  browser = request.agent(app.getHttpServer());
  await browser
    .post('/api/auth/login')
    .set('Origin', config.env.FRONTEND_URL)
    .send({ password: config.env.ADMIN_PASSWORD })
    .expect(200);
});
afterEach(async () => {
  await worker?.stop();
  await app?.close();
  await db.$connect();
  await clean();
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db.$disconnect();
});

describe('Telegram Bot in the shared HTTP inbox and PostgreSQL outbox', () => {
  it('protects session/origin, validates the bot, encrypts credentials and exposes no token', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/telegram-bot/connect')
      .send({ token })
      .expect(401);
    await browser
      .post('/api/channels/telegram-bot/connect')
      .send({ token })
      .expect(403);
    const a = await connectBot();
    expect(a.encryptedCredentials).not.toContain(token);
    expect(crypto.decrypt(a.encryptedCredentials!)).toContain(token);
    const response = await browser
      .get('/api/channels/telegram-bot')
      .expect(200);
    expect(telegramStatusSchema.safeParse(response.body.data).success).toBe(
      true,
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /webhookSecret|databaseKey|AAAAAAAAAA/,
    );
    expect(response.body.data.accounts[0]).toMatchObject({
      externalAccountId: '1234567890',
      connectionStatus: 'CONNECTED',
      name: 'Fixture bot @fixture_bot',
    });
  });
  it('verifies the header before durable ACK, deduplicates updates and scopes message IDs by chat', async () => {
    const a = await connectBot(),
      path = `/api/channels/telegram-bot/${a.id}/webhook`;
    await request(app.getHttpServer())
      .post(path)
      .set('X-Telegram-Bot-Api-Secret-Token', 'bad')
      .send({ update_id: 1 })
      .expect(401);
    expect(await db.webhookEvent.count()).toBe(0);
    const c = await inbound(a);
    await inbound(a);
    await inbound(a, 2, 43);
    expect(await db.message.count()).toBe(2);
    expect(await db.webhookEvent.count()).toBe(2);
    expect((await inbox.conversation(c.id)).inboxUnreadCount).toBe(1);
    expect(
      (await db.message.findMany()).map((m) => m.externalMessageId).sort(),
    ).toEqual(['42:9', '43:9']);
    await expect(service.owned(a.id, 'other-owner')).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    await expect(
      personal.send(c.id, 'other-owner', {
        content: 'No',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });
  it('preserves large negative chat IDs from raw webhook JSON', async () => {
    const a = await connectBot(),
      creds = JSON.parse(crypto.decrypt(a.encryptedCredentials!));
    await browser
      .post(`/api/channels/telegram-bot/${a.id}/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Telegram-Bot-Api-Secret-Token', creds.webhookSecret)
      .send(
        `{"update_id":100,"message":{"message_id":55,"date":${date},"chat":{"id":-9223372036854775807,"type":"supergroup","title":"Large"},"from":{"id":42},"text":"Safe ID"}}`,
      )
      .expect(200);
    expect(await db.message.findFirst()).toMatchObject({
      externalMessageId: '-9223372036854775807:55',
    });
  });
  it('handles edits without increasing unread counts or resurrecting local read state', async () => {
    const a = await connectBot(),
      c = await inbound(a),
      m = await db.message.findFirstOrThrow();
    await inbox.markRead(c.id, [m.id]);
    await receipts.accept(
      a,
      {
        kind: 'edit',
        data: {
          message_id: 9,
          date,
          edit_date: date + 10,
          chat: { id: 42, type: 'private' },
          from: { id: 42 },
          text: 'Edited',
        },
      },
      'edit-fixture',
    );
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      content: 'Edited',
      inboxUnread: false,
      editedAt: new Date((date + 10) * 1000),
    });
    expect(await db.message.count()).toBe(1);
  });
  it('sends exactly one reply for an idempotency key through the existing outbox', async () => {
    const a = await connectBot(),
      c = await inbound(a),
      input = { content: 'Reply', idempotencyKey: randomUUID() };
    const one = await personal.send(c.id, owner, input),
      two = await personal.send(c.id, owner, input);
    expect(one.id).toBe(two.id);
    expect(one.deliveryStatus).toBe('PENDING');
    await run('SEND');
    expect(
      await db.message.findUnique({ where: { id: one.id } }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      source: 'TELEGRAM',
      externalMessageId: '42:10',
    });
    expect(
      botRequest.mock.calls.filter(([q]) => q.url.endsWith('/sendMessage')),
    ).toHaveLength(1);
    await expect(
      personal.send(c.id, owner, { ...input, content: 'Conflict' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it.each([
    [429, 'PENDING', 'CONNECTED'],
    [401, 'FAILED', 'REAUTH_REQUIRED'],
    [403, 'FAILED', 'CONNECTED'],
    [500, 'UNKNOWN', 'CONNECTED'],
  ])(
    'persists provider %s results with safe retry semantics',
    async (code, status, connection) => {
      const a = await connectBot(),
        c = await inbound(a),
        sent = await personal.send(c.id, owner, {
          content: 'Reply',
          idempotencyKey: randomUUID(),
        });
      botRequest.mockResolvedValueOnce({
        status: code,
        data: {
          ok: false,
          error_code: code,
          parameters: code === 429 ? { retry_after: 17 } : {},
        },
      });
      await run('SEND');
      expect(
        await db.message.findUnique({ where: { id: sent.id } }),
      ).toMatchObject({ deliveryStatus: status });
      expect((await current(a.id)).connectionStatus).toBe(connection);
      if (code === 429) {
        expect(
          (await current(a.id)).rateLimitedUntil!.getTime(),
        ).toBeGreaterThan(Date.now());
        expect(
          await db.personalCommand.findFirst({ where: { messageId: sent.id } }),
        ).toMatchObject({ status: 'PENDING' });
      }
      if (code === 403)
        expect(
          (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
            .providerState,
        ).toMatchObject({ canSend: false });
      if (code === 500) {
        expect(await run('SEND')).toBe(false);
        expect(
          botRequest.mock.calls.filter(([q]) => q.url.endsWith('/sendMessage')),
        ).toHaveLength(1);
      }
    },
  );
  it('does not offer arbitrary Bot history and removes webhook/credentials on disconnect', async () => {
    const a = await connectBot(),
      c = await inbound(a);
    await expect(worker.enqueue(owner, a.id, c.id)).rejects.toMatchObject({
      code: 'TELEGRAM_BOT_HISTORY_UNAVAILABLE',
    });
    await personal.disconnect(a.id, owner);
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
    });
    expect(
      botRequest.mock.calls.some(([q]) => q.url.endsWith('/deleteWebhook')),
    ).toBe(true);
    expect(await db.message.count()).toBe(1);
    await request(app.getHttpServer())
      .post(`/api/channels/telegram-bot/${a.id}/webhook`)
      .set('X-Telegram-Bot-Api-Secret-Token', 'old')
      .send({})
      .expect(401);
  });
  it('emits owner-scoped PostgreSQL realtime events after persistence with IDs only', async () => {
    const listener = new Client({ connectionString: testUrl });
    await listener.connect();
    const events: string[] = [];
    listener.on('notification', (m) => events.push(m.payload ?? ''));
    await listener.query('LISTEN zalo_inbox_events');
    try {
      const a = await connectBot();
      await inbound(a);
      await vi.waitFor(() =>
        expect(events.some((e) => e.includes('message.created'))).toBe(true),
      );
      const event = JSON.parse(
        events.find((e) => e.includes('message.created'))!,
      );
      expect(event).toMatchObject({
        ownerId: owner,
        event: { type: 'message.created', channelAccountId: a.id },
      });
      expect(events.join('')).not.toMatch(
        /Hello|databaseKey|webhookSecret|AAAAAAAAAA/,
      );
    } finally {
      await listener.end();
    }
  });
});

describe('official TDLib boundary, auth, history and restart handling', () => {
  it('runs phone → OTP → 2FA → verified Ready without storing secrets in any durable payload', async () => {
    const a = await ready(),
      sdk = clients[0];
    expect(a.externalAccountId).toBe('77');
    const credentials = JSON.parse(crypto.decrypt(a.encryptedCredentials!));
    expect(credentials).toEqual({
      apiId: 12345,
      databaseKey: expect.any(String),
    });
    expect(Buffer.from(credentials.databaseKey, 'base64')).toHaveLength(32);
    const params = sdk.request.mock.calls.find(
      ([q]) => q['@type'] === 'setTdlibParameters',
    )![0];
    expect(params).toMatchObject({
      api_id: 12345,
      use_secret_chats: false,
      device_model: 'easyChat',
      database_encryption_key: credentials.databaseKey,
    });
    expect(params.database_directory).toBe(join(directory, a.id, 'database'));
    expect((await stat(join(directory, a.id))).mode & 0o777).toBe(0o700);
    const durable = JSON.stringify([
      await db.channelAccount.findMany(),
      await db.personalCommand.findMany(),
      await db.webhookEvent.findMany(),
    ]);
    expect(durable).not.toMatch(/test-otp-code|test-2fa-password|84123456789/);
    const status = await browser
      .get('/api/channels/telegram-personal')
      .expect(200);
    expect(status.body.data.accounts[0].authorization.state).toBe('READY');
    expect(JSON.stringify(status.body)).not.toContain(credentials.databaseKey);
  });
  it('supports actual email states and binds partial login to the initiating admin session', async () => {
    const a = await startPersonal();
    await vi.waitFor(() =>
      expect(clients[0].state['@type']).toBe(
        'authorizationStateWaitPhoneNumber',
      ),
    );
    clients[0].advance('authorizationStateWaitEmailAddress');
    await vi.waitFor(async () =>
      expect(
        (
          await service.status(
            'TELEGRAM_PERSONAL',
            owner,
            (await db.adminSession.findFirstOrThrow()).id,
          )
        ).accounts[0].authorization,
      ).toMatchObject({ state: 'EMAIL_REQUIRED' }),
    );
    await auth(a, 'email', 'test@example.com');
    await vi.waitFor(() =>
      expect(clients[0].state['@type']).toBe('authorizationStateWaitEmailCode'),
    );
    await auth(a, 'email_code', 'email-otp-fixture');
    const stranger = await db.adminSession.create({
      data: { id: randomUUID(), expiresAt: new Date(Date.now() + 60000) },
    });
    await expect(
      app.get(TelegramRpcClient).request({
        action: 'auth',
        accountId: a.id,
        ownerId: owner,
        sessionId: stranger.id,
        authAction: 'code',
        value: 'wrong-session',
      }),
    ).rejects.toMatchObject({ code: 'TELEGRAM_AUTH_SESSION_EXPIRED' });
    await expect(
      app.get(TelegramRpcClient).request({
        action: 'status',
        accountId: a.id,
        ownerId: 'other-owner',
        sessionId: stranger.id,
      }),
    ).rejects.toMatchObject({ code: 'TELEGRAM_ACCOUNT_NOT_FOUND' });
    expect(JSON.stringify(await db.webhookEvent.findMany())).not.toContain(
      'email-otp-fixture',
    );
  });
  it('expires abandoned authentication on logout and wipes isolated session storage', async () => {
    const a = await startPersonal();
    await db.adminSession.deleteMany();
    await native.poll();
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      lastError: 'TELEGRAM_AUTH_SESSION_EXPIRED',
    });
    await expect(stat(join(directory, a.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('synchronizes Cloud chats, paginates accessible history and does not mark provider chats as read', async () => {
    const a = await ready();
    await drain();
    const c = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: a.id },
    });
    expect(c).toMatchObject({
      customerName: 'Cloud Peer',
      externalConversationId: '42',
      externalContactId: '42',
      syncComplete: true,
      unreadCount: 2,
    });
    expect(await db.message.count()).toBe(2);
    expect((await inbox.conversation(c.id)).inboxUnreadCount).toBe(2);
    const calls = clients[0].request.mock.calls.map(([q]) => q);
    expect(
      calls
        .filter((q) => q['@type'] === 'getChatHistory')
        .map((q) => String(q.from_message_id)),
    ).toEqual(['0', '1048576']);
    expect(
      calls.some((q) =>
        ['viewMessages', 'openChat', 'readAllChatMentions'].includes(
          String(q['@type']),
        ),
      ),
    ).toBe(false);
    await worker.enqueue(owner, a.id, c.id);
    await drain();
    expect(await db.message.count()).toBe(2);
  });
  it('accepts device outgoing and realtime incoming updates, edits, permanent deletes and delete tombstones', async () => {
    const a = await ready();
    await drain();
    const sdk = clients[0];
    sdk.emit('update', {
      '@type': 'updateNewMessage',
      message: tdMessage(4194304, true, 'From another device'),
    });
    await vi.waitFor(async () => expect(await db.message.count()).toBe(3));
    await receipts.accept(
      a,
      { kind: 'edit', data: { chatId: '42', messageId: '1048576' } },
      'edit-fixture',
    );
    expect(
      await db.message.findFirst({
        where: { externalMessageId: '42:1048576' },
      }),
    ).toMatchObject({
      content: 'Current content',
      editedAt: new Date((date + 5) * 1000),
    });
    sdk.emit('update', {
      '@type': 'updateDeleteMessages',
      chat_id: 42,
      message_ids: [1048576, 5242880],
      is_permanent: true,
      from_cache: false,
    });
    await vi.waitFor(async () =>
      expect(
        await db.message.findFirst({
          where: { externalMessageId: '42:1048576' },
        }),
      ).toMatchObject({
        content: '',
        deletedAt: expect.any(Date),
        inboxUnread: false,
      }),
    );
    sdk.emit('update', {
      '@type': 'updateNewMessage',
      message: tdMessage(5242880, false, 'Must not resurrect'),
    });
    await vi.waitFor(async () =>
      expect(
        await db.webhookEvent.count({ where: { status: 'RECEIVED' } }),
      ).toBe(0),
    );
    expect(
      await db.message.findFirst({
        where: { externalMessageId: '42:5242880' },
      }),
    ).toBeNull();
    const c = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: a.id },
    });
    const result = await inbox.messages(c.id, paginationSchema.parse({}));
    expect(
      result.items.find((m) => m.externalMessageId === '42:1048576')?.deletedAt,
    ).toBeTruthy();
  });
  it('keeps cache eviction distinct from deletion and applies verified private-chat read watermarks', async () => {
    const a = await ready();
    await drain();
    const sdk = clients[0];
    sdk.emit('update', {
      '@type': 'updateDeleteMessages',
      chat_id: 42,
      message_ids: [1048576],
      is_permanent: false,
      from_cache: true,
    });
    sdk.emit('update', {
      '@type': 'updateNewMessage',
      message: tdMessage(3145728, true),
    });
    await vi.waitFor(async () => expect(await db.message.count()).toBe(3));
    sdk.emit('update', {
      '@type': 'updateChatReadInbox',
      chat_id: 42,
      last_read_inbox_message_id: 2097152,
      unread_count: 0,
    });
    sdk.emit('update', {
      '@type': 'updateChatReadOutbox',
      chat_id: 42,
      last_read_outbox_message_id: 3145728,
    });
    await vi.waitFor(async () =>
      expect(
        await db.message.findFirst({
          where: { externalMessageId: '42:3145728' },
        }),
      ).toMatchObject({ readAt: expect.any(Date) }),
    );
    const c = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: a.id },
    });
    expect(c.unreadCount).toBe(0);
    expect((await inbox.conversation(c.id)).inboxUnreadCount).toBe(2);
    expect(
      await db.message.findFirst({
        where: { externalMessageId: '42:1048576' },
      }),
    ).toMatchObject({ deletedAt: null });
  });
  it('waits for native send success instead of marking a pending TDLib message as sent', async () => {
    const a = await ready();
    await drain();
    const c = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: a.id },
    });
    const outgoing = await personal.send(c.id, owner, {
      content: 'Cloud reply',
      idempotencyKey: randomUUID(),
    });
    const sending = run('SEND');
    await vi.waitFor(async () =>
      expect(
        await db.message.findUnique({ where: { id: outgoing.id } }),
      ).toMatchObject({ deliveryStatus: 'SENDING', externalMessageId: null }),
    );
    await sending;
    expect(
      await db.message.findUnique({ where: { id: outgoing.id } }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      externalMessageId: '42:3145728',
    });
    expect(await db.message.count()).toBe(3);
    expect(
      clients[0].request.mock.calls.filter(
        ([q]) => q['@type'] === 'sendMessage',
      ),
    ).toHaveLength(1);
  });
  it('restores multiple authorized accounts with the same encrypted database keys and isolated paths', async () => {
    const a = await ready();
    let b = await startPersonal();
    clients[1].ownId = 88;
    clients[1].advance('authorizationStateReady');
    await vi.waitFor(async () =>
      expect((await current(b.id)).connectionStatus).toBe('CONNECTED'),
    );
    b = await current(b.id);
    const keys = [a, b].map(
      (x) => JSON.parse(crypto.decrypt(x.encryptedCredentials!)).databaseKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
    await native.stop();
    const restored: FakeTdClient[] = [];
    let next = 0;
    const replacement = new TdLibManager(db, crypto, settings, receipts, () => {
      const sdk = new FakeTdClient();
      sdk.ownId = [77, 88][next++];
      sdk.restoring = true;
      restored.push(sdk);
      return sdk;
    });
    try {
      await replacement.poll();
      expect(restored).toHaveLength(2);
      await vi.waitFor(async () => {
        expect((await current(a.id)).connectionStatus).toBe('CONNECTED');
        expect((await current(b.id)).connectionStatus).toBe('CONNECTED');
      });
      expect(
        restored.map(
          (sdk) =>
            sdk.request.mock.calls.find(
              ([q]) => q['@type'] === 'setTdlibParameters',
            )![0].database_encryption_key,
        ),
      ).toEqual(keys);
      expect(
        [a, b].map(
          (x) =>
            JSON.parse(crypto.decrypt(x.encryptedCredentials!)).databaseKey,
        ),
      ).toEqual(keys);
      await replacement.start(await current(a.id));
      expect(restored).toHaveLength(2);
    } finally {
      await replacement.stop();
    }
  });
  it.each(['chatTypeBasicGroup', 'chatTypeSupergroup'])(
    'synchronizes %s and verifies administrator rights before group replies',
    async (type) => {
      const a = await ready(),
        sdk = clients[0];
      sdk.chat = {
        id: -100123,
        title: 'Admin group',
        type: {
          '@type': type,
          ...(type === 'chatTypeBasicGroup'
            ? { basic_group_id: 123 }
            : { supergroup_id: 123, is_channel: false }),
        },
        permissions: { can_send_basic_messages: false },
        unread_count: 0,
      };
      sdk.messages = [];
      await drain();
      const c = await db.conversation.findFirstOrThrow({
        where: { channelAccountId: a.id, externalConversationId: '-100123' },
      });
      expect(c.providerState).toMatchObject({ canSend: true, chatType: type });
      expect((await inbox.conversation(c.id)).canSend).toBe(true);
      sdk.emit('update', {
        '@type': 'updateNewMessage',
        message: { ...tdMessage(1048576, true), chat_id: -100123 },
      });
      await vi.waitFor(async () =>
        expect(
          await db.message.findFirst({
            where: { externalMessageId: '-100123:1048576' },
          }),
        ).not.toBeNull(),
      );
      sdk.emit('update', {
        '@type': 'updateChatReadOutbox',
        chat_id: -100123,
        last_read_outbox_message_id: 1048576,
      });
      await vi.waitFor(async () =>
        expect(
          (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
            .providerState,
        ).toMatchObject({ readOutboxId: '1048576' }),
      );
      expect(
        await db.message.findFirst({
          where: { externalMessageId: '-100123:1048576' },
        }),
      ).toMatchObject({ readAt: null });
      expect(
        sdk.request.mock.calls.some(
          ([q]) =>
            q['@type'] ===
            (type === 'chatTypeBasicGroup' ? 'getBasicGroup' : 'getSupergroup'),
        ),
      ).toBe(true);
    },
  );
  it('recovers uncertain outbound work after worker restart without repeating the native send', async () => {
    const a = await ready();
    await drain();
    const c = await db.conversation.findFirstOrThrow({
        where: { channelAccountId: a.id },
      }),
      outgoing = await personal.send(c.id, owner, {
        content: 'Restart fixture',
        idempotencyKey: randomUUID(),
      });
    await db.message.update({
      where: { id: outgoing.id },
      data: {
        deliveryStatus: 'SENDING',
        metadata: { telegram: { chatId: '42', temporaryMessageId: '999' } },
      },
    });
    await db.personalCommand.updateMany({
      where: { messageId: outgoing.id },
      data: { status: 'PROCESSING' },
    });
    const rootWorker = new PersonalWorker(
      db,
      cfg,
      crypto,
      {} as ZaloSessionManager,
      new MessageStore(),
      undefined,
      undefined,
      worker,
    );
    await rootWorker.recoverAfterRestart();
    expect(
      await db.message.findUnique({ where: { id: outgoing.id } }),
    ).toMatchObject({ deliveryStatus: 'UNKNOWN' });
    expect(await run('SEND')).toBe(false);
    await receipts.accept(
      a,
      {
        kind: 'send_succeeded',
        data: {
          oldMessageId: '999',
          message: tdMessage(3145728, true, 'Restart fixture'),
        },
      },
      'recovery-ack',
    );
    expect(
      await db.message.findUnique({ where: { id: outgoing.id } }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      externalMessageId: '42:3145728',
    });
    expect(
      clients[0].request.mock.calls.filter(
        ([q]) => q['@type'] === 'sendMessage',
      ),
    ).toHaveLength(0);
  });
  it('logs out a live native session, clears its database key and retains easyChat history', async () => {
    const a = await ready();
    await drain();
    await personal.disconnect(a.id, owner);
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      lastError: null,
    });
    expect(
      clients[0].request.mock.calls.some(([q]) => q['@type'] === 'logOut'),
    ).toBe(true);
    expect(await db.message.count()).toBe(2);
    await expect(stat(join(directory, a.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('isolates native crashes from the API and disconnects without deleting easyChat history', async () => {
    const a = await ready();
    await drain();
    clients[0].emit('closed');
    await vi.waitFor(async () =>
      expect((await current(a.id)).connectionStatus).toBe('RECONNECTING'),
    );
    await browser.get('/api/channels/telegram-personal').expect(200);
    await personal.disconnect(a.id, owner);
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      lastError: 'TELEGRAM_SESSION_CLEANUP_UNCONFIRMED',
    });
    expect(await db.message.count()).toBe(2);
    await expect(stat(join(directory, a.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('TDLib media contract and private file boundaries', () => {
  it.each(['document', 'audio'] as const)(
    'uses the pinned TDLib input structure for %s and removes the temporary source after confirmation',
    async (kind) => {
      const a = await ready();
      await drain();
      const client = clients[0],
        original = client.request.getMockImplementation()!;
      let temporary = '';
      const bytes = Buffer.from(
        kind === 'audio' ? 'ID3fixture' : '%PDF-fixture',
      );
      client.request.mockImplementation(async (q) => {
        if (q['@type'] === 'sendMessage') {
          const input = q.input_message_content as Record<string, unknown>,
            outer = input[kind] as Record<string, unknown>,
            source = outer[kind] as { path: string };
          temporary = source.path;
          expect(
            temporary.startsWith(join(directory, a.id, 'outbound') + '/'),
          ).toBe(true);
          expect((await stat(temporary)).mode & 0o777).toBe(0o600);
          expect(await readFile(temporary)).toEqual(bytes);
          expect(input['@type']).toBe(
            kind === 'audio' ? 'inputMessageAudio' : 'inputMessageDocument',
          );
        }
        return original(q);
      });
      const result = await native.sendMedia(
        a,
        '42',
        {
          bytes,
          name: kind === 'audio' ? 'voice.mp3' : 'invoice.pdf',
          mime: kind === 'audio' ? 'audio/mpeg' : 'application/pdf',
        },
        kind,
        'Caption',
        async () => {},
      );
      expect(String(result.id)).toBe('3145728');
      await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('downloads only a completed file under the current account cache and rejects another account path', async () => {
    const a = await ready();
    await drain();
    const files = join(directory, a.id, 'files');
    await mkdir(files, { recursive: true });
    const file = join(files, 'invoice.pdf'),
      bytes = Buffer.from('%PDF-native-cache');
    await writeFile(file, bytes);
    const client = clients[0],
      original = client.request.getMockImplementation()!;
    let path = file;
    client.request.mockImplementation(async (q) => {
      if (q['@type'] === 'getFile')
        return { '@type': 'file', id: 701, size: bytes.length };
      if (q['@type'] === 'downloadFile')
        return {
          '@type': 'file',
          id: 701,
          size: bytes.length,
          local: { path, is_downloading_completed: true },
        };
      return original(q);
    });
    expect(await native.downloadMedia(a, '701')).toEqual(bytes);
    path = join(directory, 'foreign.pdf');
    await writeFile(path, bytes);
    await expect(native.downloadMedia(a, '701')).rejects.toMatchObject({
      code: 'TELEGRAM_MEDIA_UNAVAILABLE',
    });
  });
});
