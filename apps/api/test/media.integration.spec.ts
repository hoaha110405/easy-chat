import 'reflect-metadata';
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AxiosRequestConfig } from 'axios';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { CryptoService } from '../src/common/crypto.service';
import { MediaStore } from '../src/common/media-store';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import type { PersonalAdapter } from '../src/modules/zalo-personal/personal-adapter';
import { FacebookGraphClient } from '../src/modules/facebook-page/facebook-graph.client';
import { FacebookPageWorker } from '../src/modules/facebook-page/facebook-page.worker';
import { TelegramBotClient } from '../src/modules/telegram-bot/telegram-bot.client';
import { TelegramWorker } from '../src/modules/telegram/telegram.worker';
import { TelegramReceipts } from '../src/modules/telegram/telegram-receipts.service';
import { TdLibManager } from '../src/modules/telegram-personal/tdlib.manager';
import { ZaloHttpService } from '../src/modules/zalo/zalo-http.service';
import { ZaloOaMediaWorker } from '../src/modules/zalo/zalo-oa-media.worker';
import { ZaloService } from '../src/modules/zalo/zalo.service';
import { MessageStore } from '../src/modules/inbox/message-store';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { PersonalService } from '../src/modules/zalo-personal/personal.service';
import { normalizePersonalContent } from '../src/modules/zalo-personal/personal-media';
import { paginationSchema } from '@zalo/shared';
import { config } from './helpers';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Dedicated _test database required.');
const db = new PrismaService({ datasources: { db: { url } } }),
  owner = 'administrator',
  peer = '200000000000000001',
  botToken = '1234567890:' + 'A'.repeat(35);
const pdf = Buffer.from('%PDF-1.7\nprivate fixture\n%%EOF'),
  mp3 = Buffer.from('ID3fixture audio');
let app: NestExpressApplication,
  browser: ReturnType<typeof request.agent>,
  worker: PersonalWorker,
  sessions: ZaloSessionManager,
  store: MediaStore,
  crypto: CryptoService,
  inbox: InboxService,
  cfg: ConfigService;
let remoteBytes = pdf;
let graphCalls: AxiosRequestConfig[] = [],
  botCalls: AxiosRequestConfig[] = [],
  oaCalls: AxiosRequestConfig[] = [],
  graphSendFailure = false,
  uploadFailure = false;
let adapter: {
  sendTextMessage: ReturnType<typeof vi.fn>;
  sendMediaMessage: ReturnType<typeof vi.fn>;
};
const native = {
  poll: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  sendMedia: vi.fn(),
  downloadMedia: vi.fn(),
};
const now = () => Math.floor(Date.now() / 1000) - 5;
beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  await db.$connect();
}, 30000);
beforeEach(async () => {
  await db.$connect();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
  remoteBytes = pdf;
  graphCalls = [];
  botCalls = [];
  oaCalls = [];
  graphSendFailure = false;
  uploadFailure = false;
  cfg = {
    ...config,
    env: {
      ...config.env,
      DATABASE_URL: url,
      ZALO_PERSONAL_ENABLED: true,
      ZALO_APP_ID: '123',
      FRONTEND_URL: 'https://easy.example',
      TELEGRAM_BOT_ENABLED: true,
      TELEGRAM_PERSONAL_ENABLED: true,
      TELEGRAM_API_ID: 12345,
      TELEGRAM_API_HASH: 'a'.repeat(32),
      TELEGRAM_RPC_SOCKET:
        '/tmp/easychat-media-tests-' + process.pid + '/worker.sock',
      TELEGRAM_BOT_WEBHOOK_BASE_URL: 'https://easy.example',
      WHATSAPP_ENABLED: false,
    },
    telegramConfigured: true,
    whatsappConfigured: false,
    facebookConfigured: true,
  } as ConfigService;
  const graph = new FacebookGraphClient(
    { appId: '100', appSecret: 'private-app', graphVersion: 'v26.0' },
    {
      request: async (q) => {
        graphCalls.push(q);
        if (q.url?.endsWith('/message_attachments')) {
          if (uploadFailure) throw Error('upload unavailable');
          return { status: 200, data: { attachment_id: '700' } };
        }
        if (q.url?.endsWith('/messages')) {
          if (graphSendFailure) throw Error('private-provider-timeout');
          return {
            status: 200,
            data: { recipient_id: peer, message_id: 'mid.media' },
          };
        }
        throw Error('Unexpected Graph fixture');
      },
    },
  );
  const bot = new TelegramBotClient({
    request: async (q) => {
      botCalls.push(q);
      if (q.url?.includes('/file/bot'))
        return { status: 200, data: remoteBytes };
      if (q.url?.endsWith('/getFile'))
        return {
          status: 200,
          data: {
            ok: true,
            result: {
              file_id: 'file-document',
              file_path: 'documents/file_1.pdf',
              file_size: remoteBytes.length,
            },
          },
        };
      if (q.url?.endsWith('/sendDocument') || q.url?.endsWith('/sendAudio')) {
        const form = q.data as FormData,
          kind = q.url.endsWith('/sendAudio') ? 'audio' : 'document',
          file = form.get(kind) as File;
        return {
          status: 200,
          data: {
            ok: true,
            result: {
              message_id: 99,
              date: now(),
              chat: { id: 42, type: 'private' },
              from: { id: 1234567890 },
              caption: form.get('caption') ?? '',
              [kind]: {
                file_id: 'file-' + kind,
                file_name: file.name,
                mime_type: file.type,
              },
            },
          },
        };
      }
      throw Error('Unexpected Bot fixture');
    },
  });
  native.poll.mockClear();
  native.stop.mockClear();
  native.sendMedia.mockReset().mockResolvedValue({
    id: 99,
    chat_id: 42,
    date: now(),
    is_outgoing: true,
    sender_id: { '@type': 'messageSenderUser', user_id: 123 },
    content: {
      '@type': 'messageDocument',
      document: {
        file_name: 'native.pdf',
        mime_type: 'application/pdf',
        document: { id: 701 },
      },
    },
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(ConfigService)
    .useValue(cfg)
    .overrideProvider(FacebookGraphClient)
    .useValue(graph)
    .overrideProvider(TelegramBotClient)
    .useValue(bot)
    .overrideProvider(TdLibManager)
    .useValue(native)
    .overrideProvider(ZaloHttpService)
    .useValue({
      request: async (
        q: AxiosRequestConfig,
        schema: { parse: (v: unknown) => unknown },
      ) => {
        oaCalls.push(q);
        return schema.parse({
          error: 0,
          data: q.url?.includes('/upload/')
            ? { token: 'file-token-private' }
            : { message_id: 'oa.mid.media', user_id: peer },
        });
      },
    })
    .compile();
  app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app);
  await app.init();
  store = module.get(MediaStore);
  crypto = module.get(CryptoService);
  inbox = module.get(InboxService);
  adapter = {
    sendTextMessage: vi.fn(async () => ({ externalMessageId: '900' })),
    sendMediaMessage: vi.fn(async () => ({ externalMessageId: '901' })),
  };
  sessions = new ZaloSessionManager(
    () =>
      ({
        ...adapter,
        disconnect: () => {},
        getConnectionStatus: () => 'CONNECTED',
        getUserProfiles: async () => [],
        getStickerAssets: async () => [],
        getRecentMessages: async () => [],
      }) as unknown as PersonalAdapter,
  );
  worker = new PersonalWorker(
    db,
    cfg,
    crypto,
    sessions,
    module.get(MessageStore),
    module.get(FacebookPageWorker),
    undefined,
    module.get(TelegramWorker),
    undefined,
    store,
    module.get(ZaloOaMediaWorker),
  );
  await worker.start(false);
  browser = request.agent(app.getHttpServer());
  await browser
    .post('/api/auth/login')
    .set('Origin', cfg.env.FRONTEND_URL)
    .send({ password: cfg.env.ADMIN_PASSWORD })
    .expect(200);
});
afterEach(async () => {
  await worker?.stop();
  await app?.close();
});
afterAll(async () => {
  await db.$connect();
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.$disconnect();
});
async function chat(type = 'ZALO_PERSONAL', foreign = false) {
  const a = await db.channelAccount.create({
    data: {
      ownerId: foreign ? 'someone-else' : owner,
      channelType: type,
      name: 'Media account',
      externalAccountId:
        type === 'TELEGRAM_BOT' ? '1234567890' : foreign ? '101' : '100',
      connectionStatus: 'CONNECTED',
      capabilities: { sendMessages: true },
      encryptedCredentials:
        type === 'FACEBOOK_PAGE'
          ? crypto.encrypt(
              JSON.stringify({
                pageId: '100',
                accessToken: 'private-page-token',
              }),
            )
          : type === 'TELEGRAM_BOT'
            ? crypto.encrypt(
                JSON.stringify({
                  token: botToken,
                  webhookSecret: 's'.repeat(40),
                }),
              )
            : null,
    },
  });
  const c = await db.conversation.create({
    data: {
      channelAccountId: a.id,
      externalUserId: type.startsWith('TELEGRAM_') ? '42' : peer,
      externalContactId: peer,
      externalConversationId: type.startsWith('TELEGRAM_') ? '42' : peer,
      lastInboundAt: new Date(),
      providerState: { canSend: true, chatType: 'private' },
    },
  });
  if (type === 'ZALO_PERSONAL') {
    const entry = sessions.create(a.id, a.generation);
    entry.ready = true;
    entry.profileSync.complete = true;
    entry.profileSync.nextAt = Infinity;
  }
  return { a, c };
}
function upload(
  id: string,
  kind = 'document',
  bytes = pdf,
  key = randomUUID(),
  caption = '',
) {
  return browser
    .post(`/api/conversations/${id}/media`)
    .set('Origin', cfg.env.FRONTEND_URL)
    .field('kind', kind)
    .field('caption', caption)
    .field('idempotencyKey', key)
    .attach('file', bytes, {
      filename: kind === 'audio' ? 'recording.mp3' : 'Hóa đơn.pdf',
      contentType: kind === 'audio' ? 'audio/mpeg' : 'application/pdf',
    });
}
describe('shared document and audio outbox', () => {
  it.each(['document', 'audio'])(
    'queues and dispatches Zalo %s with encrypted private bytes',
    async (kind) => {
      const { c } = await chat(),
        bytes = kind === 'audio' ? mp3 : pdf;
      const r = await upload(c.id, kind, bytes).expect(202),
        id = r.body.data.id;
      expect(r.body.data.deliveryStatus).toBe('PENDING');
      expect(adapter.sendMediaMessage).not.toHaveBeenCalled();
      const asset = await db.messageMedia.findUniqueOrThrow({
        where: { messageId: id },
      });
      expect(Buffer.from(asset.encryptedBytes).includes(bytes)).toBe(false);
      expect((await store.read(id)).bytes).toEqual(bytes);
      await worker.tick();
      expect(adapter.sendMediaMessage).toHaveBeenCalledExactlyOnceWith(
        peer,
        expect.objectContaining({
          bytes,
          name: kind === 'audio' ? 'recording.mp3' : 'Hóa đơn.pdf',
        }),
        kind,
      );
      expect(
        (await db.message.findUniqueOrThrow({ where: { id } })).deliveryStatus,
      ).toBe('SENT');
      await request(app.getHttpServer())
        .get(`/api/messages/${id}/media`)
        .expect(401);
      const download = await browser
        .get(`/api/messages/${id}/media`)
        .expect(200);
      expect(download.headers['cache-control']).toContain('no-store');
      const ranged = await browser
        .get(`/api/messages/${id}/media`)
        .set('Range', 'bytes=0-3')
        .expect(206);
      expect(ranged.headers['content-range']).toBe(`bytes 0-3/${bytes.length}`);
      expect(ranged.headers['content-length']).toBe('4');
      await browser
        .get(`/api/messages/${id}/media`)
        .set('Range', 'bytes=999999-')
        .expect(416);
    },
  );
  it.each(['FACEBOOK_PAGE', 'TELEGRAM_BOT', 'TELEGRAM_PERSONAL'])(
    'sends documents through the existing %s worker',
    async (type) => {
      const { c } = await chat(type),
        r = await upload(c.id).expect(202);
      await worker.tick();
      expect(
        await db.message.findUniqueOrThrow({ where: { id: r.body.data.id } }),
      ).toMatchObject({ deliveryStatus: 'SENT', deliveryError: null });
      if (type === 'FACEBOOK_PAGE') {
        const form = graphCalls.find((q) =>
          q.url?.endsWith('/message_attachments'),
        )!.data as FormData;
        expect(form.get('filedata')).toBeInstanceOf(File);
        expect(JSON.parse(String(form.get('message')))).toEqual({
          attachment: { type: 'file', payload: { is_reusable: true } },
        });
        expect(
          graphCalls.find((q) => q.url?.endsWith('/messages'))!.data,
        ).toMatchObject({
          recipient: { id: peer },
          message: {
            attachment: { type: 'file', payload: { attachment_id: '700' } },
          },
        });
      } else if (type === 'TELEGRAM_BOT')
        expect(
          botCalls.find((q) => q.url?.endsWith('/sendDocument'))!.data,
        ).toBeInstanceOf(FormData);
      else
        expect(native.sendMedia).toHaveBeenCalledWith(
          expect.objectContaining({ channelType: type }),
          '42',
          expect.objectContaining({ bytes: pdf }),
          'document',
          '',
          expect.any(Function),
        );
    },
  );
  it.each(['FACEBOOK_PAGE', 'TELEGRAM_BOT', 'TELEGRAM_PERSONAL'])(
    'dispatches audio through %s and preserves a playable attachment',
    async (type) => {
      const { c } = await chat(type),
        r = await upload(c.id, 'audio', mp3).expect(202);
      await worker.tick();
      const result = (await inbox.messages(c.id, paginationSchema.parse({})))
        .items[0];
      expect(result.deliveryStatus).toBe('SENT');
      expect(result.attachments[0]).toMatchObject({
        type: 'audio',
        authenticatedPath: `/messages/${r.body.data.id}/media`,
      });
      if (type === 'FACEBOOK_PAGE')
        expect(
          graphCalls.find((q) => q.url?.endsWith('/messages'))!.data,
        ).toMatchObject({ message: { attachment: { type: 'audio' } } });
      if (type === 'TELEGRAM_BOT')
        expect(botCalls.some((q) => q.url?.endsWith('/sendAudio'))).toBe(true);
    },
  );
  it('deduplicates concurrent uploads, rejects changed content and enforces ownership', async () => {
    const { c } = await chat(),
      key = randomUUID(),
      [r1, r2] = await Promise.all([
        upload(c.id, 'document', pdf, key),
        upload(c.id, 'document', pdf, key),
      ]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r1.body.data.id).toBe(r2.body.data.id);
    expect(await db.messageMedia.count()).toBe(1);
    await upload(c.id, 'document', Buffer.from('%PDF-changed'), key).expect(
      409,
    );
    const foreign = await chat('ZALO_PERSONAL', true);
    await upload(foreign.c.id).expect(404);
    await db.channelAccount.update({
      where: { id: foreign.a.id },
      data: { ownerId: owner },
    });
    const file = await upload(foreign.c.id).expect(202);
    await db.channelAccount.update({
      where: { id: foreign.a.id },
      data: { ownerId: 'someone-else' },
    });
    await browser.get(`/api/messages/${file.body.data.id}/media`).expect(404);
  });
  it('blocks unsupported TikTok uploads, wrong signatures and captions that a channel cannot send', async () => {
    const { c } = await chat('TIKTOK_SHOP');
    const r = await upload(c.id).expect(409);
    expect(r.body.error.code).toBe('MEDIA_CHANNEL_UNSUPPORTED');
    const zalo = await chat();
    await upload(zalo.c.id, 'document', Buffer.from('executable')).expect(400);
    await upload(
      zalo.c.id,
      'document',
      pdf,
      randomUUID(),
      'separate text',
    ).expect(400);
    await browser
      .post(`/api/conversations/${zalo.c.id}/media`)
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(0);
  });
  it('expires only the file bytes, retains the message and refuses a deleted message download', async () => {
    const { c } = await chat(),
      r = await upload(c.id).expect(202),
      id = r.body.data.id;
    await db.messageMedia.update({
      where: { messageId: id },
      data: { expiresAt: new Date(0) },
    });
    await store.cleanup();
    expect(await db.messageMedia.count()).toBe(0);
    expect(await db.message.findUnique({ where: { id } })).toBeTruthy();
    await browser.get(`/api/messages/${id}/media`).expect(410);
    await db.message.update({ where: { id }, data: { deletedAt: new Date() } });
    await browser.get(`/api/messages/${id}/media`).expect(404);
  });
  it('does not send twice after an ambiguous Facebook media POST', async () => {
    const { c } = await chat('FACEBOOK_PAGE'),
      r = await upload(c.id).expect(202);
    graphSendFailure = true;
    await worker.tick();
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: r.body.data.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    expect(graphCalls.filter((q) => q.url?.endsWith('/messages'))).toHaveLength(
      1,
    );
    await expect(
      app.get(PersonalService).retry(c.id, r.body.data.id, owner),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_RETRYABLE' });
  });
  it('marks a restarted SENDING file as UNKNOWN and does not dispatch it again', async () => {
    const { c } = await chat(),
      r = await upload(c.id).expect(202);
    await db.message.update({
      where: { id: r.body.data.id },
      data: { deliveryStatus: 'SENDING' },
    });
    await worker.recoverAfterRestart();
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: r.body.data.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    expect(adapter.sendMediaMessage).not.toHaveBeenCalled();
  });
  it.each(['document', 'audio'])(
    'downloads incoming Telegram %s through the authenticated media endpoint',
    async (kind) => {
      remoteBytes = kind === 'audio' ? mp3 : pdf;
      const { a } = await chat('TELEGRAM_BOT');
      await app.get(TelegramReceipts).webhook(
        a.id,
        Buffer.from(
          JSON.stringify({
            update_id: 700,
            message: {
              message_id: 701,
              date: now(),
              chat: { id: 42, type: 'private' },
              from: { id: 42 },
              [kind]: {
                file_id: 'file-document',
                file_name: kind === 'audio' ? 'received.mp3' : 'received.pdf',
                mime_type: kind === 'audio' ? 'audio/mpeg' : 'application/pdf',
              },
            },
          }),
        ),
        's'.repeat(40),
      );
      const receipt = await db.webhookEvent.findFirstOrThrow();
      await app.get(TelegramWorker).processInbound(receipt.id);
      const m = await db.message.findFirstOrThrow({
        where: { direction: 'INCOMING' },
      });
      const file = await browser.get(`/api/messages/${m.id}/media`).expect(200);
      expect((await store.read(m.id)).bytes).toEqual(remoteBytes);
      expect(
        (
          await db.messageMedia.findUniqueOrThrow({
            where: { messageId: m.id },
          })
        ).mime,
      ).toBe(kind === 'audio' ? 'audio/mpeg' : 'application/pdf');
      expect(file.headers['content-disposition']).toContain(
        kind === 'audio' ? 'received.mp3' : 'received.pdf',
      );
    },
  );
  it('queues an OA document using its existing connection and checks disconnect before provider send', async () => {
    const connection = await db.zaloConnection.create({
      data: {
        oaId: '800',
        oaName: 'OA',
        status: 'CONNECTED',
        tokenExpiresAt: new Date(Date.now() + 3600000),
        encryptedAccessToken: crypto.encrypt('oa-access-private'),
        encryptedRefreshToken: crypto.encrypt('oa-refresh-private'),
      },
    });
    const c = await db.conversation.create({
      data: {
        connectionId: connection.id,
        externalUserId: peer,
        lastInboundAt: new Date(),
      },
    });
    const r = await upload(c.id).expect(202);
    await worker.tick();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: r.body.data.id } }))
        .deliveryStatus,
    ).toBe('SENT');
    expect(oaCalls.map((q) => q.url)).toEqual([
      'https://openapi.zalo.me/v2.0/oa/upload/file',
      'https://openapi.zalo.me/v3.0/oa/message/cs',
    ]);
    const second = await upload(c.id).expect(202);
    await app.get(ZaloService).disconnect();
    await worker.tick();
    expect(
      (
        await db.message.findUniqueOrThrow({
          where: { id: second.body.data.id },
        })
      ).deliveryStatus,
    ).toBe('FAILED');
    expect(oaCalls).toHaveLength(2);
    const accounts = await inbox.accounts(owner);
    expect(
      accounts.accounts.filter((a) => a.channelType === 'ZALO_OA'),
    ).toHaveLength(1);
  });
  it('normalizes Zalo document and voice content into attachments instead of unsupported', () => {
    expect(
      normalizePersonalContent('chat.file', {
        title: 'received.pdf',
        href: 'https://f7.zdn.vn/file.pdf',
      }),
    ).toMatchObject({
      type: 'file',
      attachments: [{ type: 'file', payload: { name: 'received.pdf' } }],
    });
    expect(
      normalizePersonalContent(
        'chat.voice',
        JSON.stringify({ params: { voiceUrl: 'https://f7.zdn.vn/audio.mp3' } }),
      ),
    ).toMatchObject({
      type: 'audio',
      attachments: [
        { type: 'audio', payload: { url: 'https://f7.zdn.vn/audio.mp3' } },
      ],
    });
  });
});

describe('private media integrity', () => {
  it('rejects swapped ciphertext across message IDs while retaining both messages', async () => {
    const { c } = await chat(),
      first = await upload(c.id).expect(202),
      second = await upload(c.id).expect(202);
    const asset = await db.messageMedia.findUniqueOrThrow({
      where: { messageId: first.body.data.id },
    });
    await db.messageMedia.update({
      where: { messageId: second.body.data.id },
      data: { encryptedBytes: asset.encryptedBytes },
    });
    await browser.get(`/api/messages/${second.body.data.id}/media`).expect(503);
    expect(await db.message.count()).toBe(2);
    expect((await store.read(first.body.data.id)).bytes).toEqual(pdf);
  });
});
