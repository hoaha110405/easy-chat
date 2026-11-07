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
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AxiosRequestConfig } from 'axios';
import type { ChannelAccount } from '@prisma/client';
import request from 'supertest';
import { Client } from 'pg';
import {
  conversationFilterSchema,
  paginationSchema,
  whatsappStatusSchema,
} from '@zalo/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '../src/config/config.service';
import { CryptoService } from '../src/common/crypto.service';
import {
  PersonalService,
  WORKER_ID,
} from '../src/modules/zalo-personal/personal.service';
import { PersonalWorker } from '../src/modules/zalo-personal/personal.worker';
import type { ZaloSessionManager } from '../src/modules/zalo-personal/personal-session.manager';
import { InboxService } from '../src/modules/inbox/inbox.service';
import { MessageStore } from '../src/modules/inbox/message-store';
import { WhatsAppClient } from '../src/modules/whatsapp/whatsapp.client';
import { WhatsAppService } from '../src/modules/whatsapp/whatsapp.service';
import { WhatsAppWebhook } from '../src/modules/whatsapp/whatsapp.webhook';
import { WhatsAppWorker } from '../src/modules/whatsapp/whatsapp.worker';
import { templateInputSchema } from '../src/modules/whatsapp/whatsapp.templates';
import { config } from './helpers';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('TEST_DATABASE_URL must end in _test.');
const db = new PrismaService({ datasources: { db: { url } } });
const owner = 'administrator',
  wa = '84901234567',
  token = 'test-private-whatsapp-access-token';
const template = {
  id: '900',
  name: 'order_update',
  language: 'vi',
  category: 'UTILITY',
  status: 'APPROVED',
  parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Chào {{1}}, đơn {{2}} đã giao.' }],
};
const image = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);
const now = () => Math.floor(Date.now() / 1000) - 10;
let app: NestExpressApplication,
  service: WhatsAppService,
  webhook: WhatsAppWebhook,
  worker: WhatsAppWorker,
  personal: PersonalService,
  inbox: InboxService,
  crypto: CryptoService,
  cfg: ConfigService,
  browser: ReturnType<typeof request.agent>;
let transport = vi.fn(),
  failure: number | null = null,
  networkFailure = false,
  badWebhook = false,
  phoneStatus = 'CONNECTED',
  coexistence = false,
  scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'],
  templates = [template],
  sendCount = 0,
  subscribeFailure = false,
  uploadCount = 0,
  uploadFailure = false,
  mediaBytes = image,
  mediaMime = 'image/png';
const phone = (id: string) => ({
  id,
  display_phone_number: id === '101' ? '+84 900 111 111' : '+84 900 222 222',
  verified_name: 'Business ' + id,
  platform_type: 'CLOUD_API',
  status: phoneStatus,
  code_verification_status: 'VERIFIED',
  is_on_biz_app: coexistence,
});
async function clean() {
  await db.message.deleteMany();
  await db.conversation.deleteMany();
  await db.channelAccount.deleteMany();
  await db.webhookEvent.deleteMany();
  await db.zaloConnection.deleteMany();
  await db.adminSession.deleteMany();
  await db.personalWorkerState.deleteMany();
}
async function current(id: string) {
  return db.channelAccount.findUniqueOrThrow({ where: { id } });
}
async function run(kind?: 'SEND' | 'SYNC' | 'SYNC_MESSAGES') {
  const item = await db.personalCommand.findFirst({
    where: {
      status: 'PENDING',
      availableAt: { lte: new Date() },
      ...(kind ? { kind } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!item) return false;
  const job = await db.personalCommand.update({
    where: { id: item.id },
    data: { status: 'PROCESSING', attempts: { increment: 1 } },
  });
  await worker.process(job, await current(job.channelAccountId), () => true);
  return true;
}
async function drain() {
  for (let i = 0; i < 20; i++) {
    const receipt = await db.webhookEvent.findFirst({
      where: { eventName: { startsWith: 'whatsapp.' }, status: 'RECEIVED' },
    });
    if (!receipt) return;
    await worker.processInbound(receipt.id);
  }
  throw Error('Receipt fixture did not drain');
}
async function connect(phoneNumberId = '101', ownerId = owner) {
  return service.connect(ownerId, token, '201', phoneNumberId);
}
async function accept(data: unknown) {
  const raw = Buffer.from(JSON.stringify(data)),
    signature =
      'sha256=' +
      createHmac('sha256', cfg.env.WHATSAPP_META_APP_SECRET)
        .update(raw)
        .digest('hex');
  return webhook.receive(raw, signature);
}
async function incoming(
  a: ChannelAccount | { id: string; externalAccountId: string | null },
  id = 'wamid.incoming',
  stamp = now(),
  text = 'Customer hello',
  sender = wa,
) {
  await accept({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '201',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: a.externalAccountId },
              contacts: [
                { wa_id: sender, profile: { name: 'Customer fixture' } },
              ],
              messages: [
                {
                  id,
                  from: sender,
                  timestamp: String(stamp),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await drain();
  return db.conversation.findFirstOrThrow({
    where: { channelAccountId: a.id, externalContactId: sender },
  });
}
async function status(
  a: { externalAccountId: string | null },
  id: string,
  state: string,
  opaque?: string,
  stamp = now() + 1,
  extra: Record<string, unknown> = {},
) {
  if (opaque && !opaque.includes('.')) {
    const m = await db.message.findUnique({ where: { id: opaque } });
    const stored = m?.metadata as
      { whatsapp?: { callbackData?: string } } | undefined;
    opaque = stored?.whatsapp?.callbackData ?? opaque;
  }
  await accept({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '201',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: a.externalAccountId },
              statuses: [
                {
                  id,
                  status: state,
                  timestamp: String(stamp),
                  recipient_id: wa,
                  ...(opaque ? { biz_opaque_callback_data: opaque } : {}),
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await drain();
}
function templateInput() {
  return templateInputSchema.parse({
    templateId: '900',
    templateName: 'order_update',
    language: 'vi',
    parameters: [
      { component: 'body', name: '1', value: 'An' },
      { component: 'body', name: '2', value: 'A1' },
    ],
    optInConfirmed: true,
    idempotencyKey: randomUUID(),
  });
}
beforeAll(async () => {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  await db.$connect();
}, 30000);
beforeEach(async () => {
  await db.$connect();
  await clean();
  failure = null;
  networkFailure = false;
  badWebhook = false;
  phoneStatus = 'CONNECTED';
  coexistence = false;
  scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'];
  templates = [template];
  sendCount = 0;
  subscribeFailure = false;
  uploadCount = 0;
  uploadFailure = false;
  mediaBytes = image;
  mediaMime = 'image/png';
  cfg = {
    ...config,
    whatsappConfigured: true,
    telegramConfigured: false,
    tiktokConfigured: false,
    env: {
      ...config.env,
      ZALO_PERSONAL_ENABLED: false,
      DATABASE_URL: url,
      FRONTEND_URL: 'https://easy.example',
      WHATSAPP_ENABLED: true,
      WHATSAPP_GRAPH_API_VERSION: 'v27.0',
      WHATSAPP_META_APP_ID: '301',
      WHATSAPP_META_APP_SECRET: 'private-test-meta-app-secret',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'private-verify-token',
      WHATSAPP_WEBHOOK_CALLBACK_URL:
        'https://easy.example/api/webhooks/whatsapp',
      WHATSAPP_EMBEDDED_SIGNUP_ENABLED: true,
      WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '401',
    },
  } as ConfigService;
  transport = vi.fn(async (q: AxiosRequestConfig) => {
    const path = new URL(q.url!).pathname.replace(/^\/v\d+\.\d+\//, '');
    let result: unknown;
    if (q.url!.startsWith('https://lookaside.fbsbx.com/'))
      return { status: 200, data: mediaBytes };
    if (path === 'debug_token')
      result = {
        data: {
          app_id: '301',
          is_valid: true,
          type: 'SYSTEM_USER',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scopes,
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['201'] },
          ],
        },
      };
    else if (path === 'oauth/access_token')
      result = { access_token: token, expires_in: 3600 };
    else if (path === '301/subscriptions')
      result = {
        data: [
          {
            object: 'whatsapp_business_account',
            callback_url: badWebhook
              ? 'https://wrong.example/callback'
              : cfg.env.WHATSAPP_WEBHOOK_CALLBACK_URL,
            active: true,
            fields: [
              { name: 'messages' },
              { name: 'account_update' },
              { name: 'message_template_status_update' },
            ],
          },
        ],
      };
    else if (path === '201')
      result = { id: '201', name: 'Authorized business' };
    else if (path === '201/phone_numbers')
      result = { data: [phone('101'), phone('102')] };
    else if (['101', '102'].includes(path)) result = phone(path);
    else if (path.endsWith('/register')) {
      phoneStatus = 'CONNECTED';
      result = { success: true };
    } else if (path === '201/subscribed_apps') {
      if (subscribeFailure)
        return {
          status: 400,
          data: {
            error: { code: 200, message: 'private-provider-diagnostic' },
          },
        };
      result =
        q.method === 'GET'
          ? {
              data: [
                { whatsapp_business_api_data: { id: '301', name: 'easyChat' } },
              ],
            }
          : { success: true };
    } else if (path === '201/message_templates') result = { data: templates };
    else if (path.endsWith('/media')) {
      uploadCount++;
      if (uploadFailure) throw Error('private-provider-upload-error');
      const form = q.data as FormData,
        file = form.get('file') as File;
      mediaBytes = Buffer.from(await file.arrayBuffer());
      mediaMime = file.type;
      result = { id: '700' };
    } else if (path.endsWith('/messages')) {
      const data = q.data as { status?: string; to?: string };
      if (data.status === 'read') result = { success: true };
      else {
        sendCount++;
        if (networkFailure) throw Error('private-token');
        if (failure)
          return {
            status:
              failure === 190
                ? 401
                : failure === 130429
                  ? 429
                  : failure === 131000
                    ? 500
                    : 400,
            data: {
              error: {
                code: failure,
                message: 'private diagnostic',
                fbtrace_id: 'trace-safe',
              },
            },
          };
        result = {
          messaging_product: 'whatsapp',
          contacts: [{ input: data.to, wa_id: data.to }],
          messages: [{ id: 'wamid.provider' + sendCount }],
        };
      }
    } else if (path === '700')
      result = {
        id: '700',
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=700',
        mime_type: mediaMime,
        file_size: mediaBytes.length,
        sha256: createHash('sha256').update(mediaBytes).digest('hex'),
      };
    else throw Error('Unexpected official fixture path ' + path);
    return { status: 200, data: result };
  });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(db)
    .overrideProvider(ConfigService)
    .useValue(cfg)
    .overrideProvider(WhatsAppClient)
    .useValue(new WhatsAppClient(cfg, { request: transport }))
    .compile();
  app = module.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app);
  await app.init();
  service = module.get(WhatsAppService);
  worker = module.get(WhatsAppWorker);
  webhook = module.get(WhatsAppWebhook);
  personal = module.get(PersonalService);
  inbox = module.get(InboxService);
  crypto = module.get(CryptoService);
  await db.personalWorkerState.create({
    data: {
      id: WORKER_ID,
      instanceId: 'whatsapp-fixture-worker',
      heartbeatAt: new Date(),
    },
  });
  browser = request.agent(app.getHttpServer());
  await browser
    .post('/api/auth/login')
    .set('Origin', cfg.env.FRONTEND_URL)
    .send({ password: cfg.env.ADMIN_PASSWORD })
    .expect(200);
});
afterEach(async () => {
  await app.close();
  await db.$connect();
  await clean();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('WhatsApp authorization, onboarding and isolation', () => {
  it('requires admin session/origin and reports CONNECTED only after remote identity and subscriptions', async () => {
    await request(app.getHttpServer())
      .post('/api/channels/whatsapp/connect')
      .send({})
      .expect(401);
    await browser
      .post('/api/channels/whatsapp/connect')
      .send({ accessToken: token, wabaId: '201', phoneNumberId: '101' })
      .expect(403);
    const response = await browser
      .post('/api/channels/whatsapp/connect')
      .set('Origin', cfg.env.FRONTEND_URL)
      .send({ accessToken: token, wabaId: '201', phoneNumberId: '101' })
      .expect(200);
    expect(response.body.data).toMatchObject({
      connectionStatus: 'CONNECTED',
      externalAccountId: '101',
      metadata: { wabaId: '201', phoneNumberId: '101' },
    });
    const a = await current(response.body.data.id);
    expect(a.encryptedCredentials).not.toContain(token);
    expect(JSON.parse(crypto.decrypt(a.encryptedCredentials!))).toMatchObject({
      accessToken: token,
      appId: '301',
      wabaId: '201',
      phoneNumberId: '101',
    });
    const output = await browser.get('/api/channels/whatsapp').expect(200);
    expect(whatsappStatusSchema.safeParse(output.body.data).success).toBe(true);
    expect(JSON.stringify(output.body)).not.toMatch(
      /private-test-meta|private-whatsapp-access|accessToken|encryptedCredentials/,
    );
  });
  it('rejects missing WhatsApp scopes, unowned phone IDs, wrong app callback and Coexistence without fake success', async () => {
    scopes = ['pages_messaging'];
    await expect(connect()).rejects.toMatchObject({
      code: 'WHATSAPP_PERMISSION_REQUIRED',
    });
    scopes = ['whatsapp_business_management', 'whatsapp_business_messaging'];
    await expect(connect('999')).rejects.toMatchObject({
      code: 'WHATSAPP_PHONE_NOT_AUTHORIZED',
    });
    badWebhook = true;
    await expect(connect()).rejects.toMatchObject({
      code: 'WHATSAPP_WEBHOOK_NOT_CONFIGURED',
    });
    badWebhook = false;
    coexistence = true;
    await expect(connect()).rejects.toMatchObject({
      code: 'WHATSAPP_COEXISTENCE_APPROVAL_REQUIRED',
    });
    expect(await db.channelAccount.count()).toBe(0);
  });
  it('rejects Facebook Page tokens, another Meta app and expired token inspections before storing credentials', async () => {
    for (const data of [
      { app_id: '301', is_valid: true, type: 'PAGE', scopes },
      { app_id: '999', is_valid: true, type: 'SYSTEM_USER', scopes },
      { app_id: '301', is_valid: false, type: 'SYSTEM_USER', scopes },
      {
        app_id: '301',
        is_valid: true,
        type: 'SYSTEM_USER',
        scopes,
        expires_at: now() - 100,
      },
    ]) {
      transport.mockResolvedValueOnce({ status: 200, data: { data } });
      await expect(connect()).rejects.toMatchObject({
        code: 'WHATSAPP_REAUTH_REQUIRED',
      });
    }
    expect(await db.channelAccount.count()).toBe(0);
  });
  it('does not call a number connected when registration/subscription has not succeeded', async () => {
    phoneStatus = 'PENDING';
    await expect(connect()).rejects.toMatchObject({
      code: 'WHATSAPP_REGISTRATION_REQUIRED',
    });
    expect(await db.channelAccount.count()).toBe(0);
    const registered = await service.connect(
      owner,
      token,
      '201',
      '101',
      'DIRECT',
      '123456',
    );
    expect(registered.connectionStatus).toBe('CONNECTED');
    expect(
      crypto.decrypt((await current(registered.id)).encryptedCredentials!),
    ).not.toContain('123456');
    subscribeFailure = true;
    await expect(connect()).rejects.toMatchObject({
      code: 'WHATSAPP_PERMISSION_REQUIRED',
    });
    expect((await current(registered.id)).connectionStatus).toBe('ERROR');
  });
  it('keeps each phone/account scoped and prevents another tenant attaching an active number', async () => {
    const a = await connect(),
      b = await connect('102');
    const one = await incoming(a),
      two = await incoming(b);
    expect(one.id).not.toBe(two.id);
    expect(await db.message.count()).toBe(2);
    await expect(connect('101', 'other-owner')).rejects.toMatchObject({
      code: 'WHATSAPP_PHONE_ALREADY_CONNECTED',
    });
    await expect(service.owned(a.id, 'other-owner')).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
    expect(
      (
        await inbox.conversations(
          conversationFilterSchema.parse({
            account: 'whatsapp-business:' + a.id,
          }),
          owner,
        )
      ).items.map((c) => c.id),
    ).toEqual([one.id]);
  });
  it('routes two businesses with independent tokens and WABA/phone identity to separate conversations', async () => {
    const a = await connect();
    await incoming(a);
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (q: AxiosRequestConfig) => {
      const path = new URL(q.url!).pathname.replace(/^\/v\d+\.\d+\//, '');
      if (path === '202')
        return { status: 200, data: { id: '202', name: 'Second business' } };
      if (path === '202/phone_numbers')
        return { status: 200, data: { data: [phone('103')] } };
      if (path === '103') return { status: 200, data: phone('103') };
      if (path === '202/subscribed_apps')
        return {
          status: 200,
          data:
            q.method === 'GET'
              ? { data: [{ whatsapp_business_api_data: { id: '301' } }] }
              : { success: true },
        };
      return original(q);
    });
    const b = await service.connect(
      owner,
      'independent-business-token',
      '202',
      '103',
    );
    await accept({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '202',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '103' },
                messages: [
                  {
                    id: 'wamid.incoming',
                    from: wa,
                    timestamp: String(now()),
                    type: 'text',
                    text: { body: 'Second business customer' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();
    const thread = await db.conversation.findFirstOrThrow({
      where: { channelAccountId: b.id },
    });
    const message = await personal.send(thread.id, owner, {
      content: 'Second business reply',
      idempotencyKey: randomUUID(),
    });
    await run('SEND');
    expect(
      await db.message.findUnique({ where: { id: message.id } }),
    ).toMatchObject({ deliveryStatus: 'SENT' });
    const posted = transport.mock.calls.find(([q]) =>
      q.url?.endsWith('/103/messages'),
    )![0];
    expect(posted.headers).toMatchObject({
      Authorization: 'Bearer independent-business-token',
    });
    expect(posted.data).toMatchObject({ messaging_account_id: '202', to: wa });
    expect(await db.conversation.count()).toBe(2);
    expect(
      JSON.parse(crypto.decrypt((await current(a.id)).encryptedCredentials!))
        .accessToken,
    ).toBe(token);
  });
  it('binds Embedded Signup state and token exchange to one admin session and rejects replay', async () => {
    const first = await browser
      .post('/api/channels/whatsapp/embedded/begin')
      .set('Origin', cfg.env.FRONTEND_URL)
      .send({})
      .expect(200);
    const begin = first.body.data;
    expect(begin).toMatchObject({
      appId: '301',
      configId: '401',
      graphVersion: 'v27.0',
    });
    const post = (state: string) =>
      browser
        .post('/api/channels/whatsapp/embedded/complete')
        .set('Origin', cfg.env.FRONTEND_URL)
        .send({
          authorizationId: begin.authorizationId,
          state,
          code: 'ephemeral-meta-code',
        });
    await post('x'.repeat(43)).expect(409);
    await post(begin.state).expect(200);
    await post(begin.state).expect(409);
    const row = await db.channelAuthorization.findUniqueOrThrow({
      where: { id: begin.authorizationId },
    });
    expect(row.stateHash).not.toBe(begin.state);
    expect(row.encryptedSelection).not.toContain(token);
    expect(crypto.decrypt(row.encryptedSelection!)).not.toContain(
      'ephemeral-meta-code',
    );
    const phones = await browser
      .get(
        `/api/channels/whatsapp/embedded/${begin.authorizationId}/phones?wabaId=201`,
      )
      .expect(200);
    expect(phones.body.data.items).toHaveLength(2);
    expect(JSON.stringify(phones.body)).not.toContain(token);
    await browser
      .post('/api/channels/whatsapp/embedded/select')
      .set('Origin', cfg.env.FRONTEND_URL)
      .send({
        authorizationId: begin.authorizationId,
        wabaId: '201',
        phoneNumberId: '101',
      })
      .expect(200);
    expect(
      (
        await db.channelAuthorization.findUniqueOrThrow({
          where: { id: begin.authorizationId },
        })
      ).encryptedSelection,
    ).toBeNull();
    expect((await db.channelAccount.findFirstOrThrow()).connectionStatus).toBe(
      'CONNECTED',
    );
  });
  it('expires OAuth state and blocks cross-session selection', async () => {
    const session = await db.adminSession.findFirstOrThrow(),
      begin = await service.begin(owner, session.id);
    await db.channelAuthorization.update({
      where: { id: begin.authorizationId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      service.complete(
        owner,
        session.id,
        begin.authorizationId,
        begin.state,
        'code',
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_OAUTH_STATE_INVALID' });
    const second = await service.begin(owner, session.id);
    await expect(
      service.complete(
        owner,
        'other-session',
        second.authorizationId,
        second.state,
        'code',
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_OAUTH_STATE_INVALID' });
    expect(
      transport.mock.calls.some(([q]) =>
        q.url?.endsWith('/oauth/access_token'),
      ),
    ).toBe(false);
  });
});

describe('Meta webhooks, messages and provider statuses', () => {
  it('serves the exact verification challenge and rejects the wrong verification token', async () => {
    const p =
      '/api/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=';
    expect(
      (
        await request(app.getHttpServer())
          .get(p + 'private-verify-token')
          .expect(200)
      ).text,
    ).toBe('12345');
    await request(app.getHttpServer())
      .get(p + 'bad')
      .expect(403);
  });
  it('verifies raw HMAC before parsing and durable ACK; rejects tampered or malformed payloads', async () => {
    const a = await connect();
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '201',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '101' },
                messages: [
                  {
                    id: 'wamid.raw',
                    from: wa,
                    timestamp: String(now()),
                    type: 'text',
                    text: { body: 'Raw body fixture' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig =
      'sha256=' +
      createHmac('sha256', cfg.env.WHATSAPP_META_APP_SECRET)
        .update(body)
        .digest('hex');
    await request(app.getHttpServer())
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(body + ' ')
      .expect(401);
    expect(await db.webhookEvent.count()).toBe(0);
    await request(app.getHttpServer())
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sig)
      .send(body)
      .expect(200);
    expect(await db.webhookEvent.findFirst()).toMatchObject({
      channelAccountId: a.id,
      status: 'RECEIVED',
    });
    expect(await db.message.count()).toBe(0);
    await drain();
    expect(await db.message.count()).toBe(1);
    const raw = Buffer.from('{}');
    await request(app.getHttpServer())
      .post('/api/webhooks/whatsapp')
      .set(
        'X-Hub-Signature-256',
        'sha256=' +
          createHmac('sha256', cfg.env.WHATSAPP_META_APP_SECRET)
            .update(raw)
            .digest('hex'),
      )
      .send({})
      .expect(400);
  });
  it('deduplicates retries without restoring local unread state and never mixes numbers', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await db.message.findFirstOrThrow();
    expect((await inbox.conversation(c.id)).inboxUnreadCount).toBe(1);
    await inbox.markRead(c.id, [m.id]);
    await incoming(a);
    expect(await db.message.count()).toBe(1);
    expect((await inbox.conversation(c.id)).inboxUnreadCount).toBe(0);
    await accept({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '999',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '101' },
                messages: [
                  {
                    id: 'wamid.wrong',
                    from: wa,
                    timestamp: String(now()),
                    type: 'text',
                    text: { body: 'Wrong WABA' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();
    expect(await db.message.count()).toBe(1);
  });
  it('opens the window from the newest qualifying customer message and never from status/outbound/system events', async () => {
    const a = await connect(),
      c = await incoming(a, 'wamid.recent', now());
    await incoming(a, 'wamid.old', now() - 25 * 3600);
    const before = await db.conversation.findUniqueOrThrow({
      where: { id: c.id },
    });
    expect(before.lastInboundAt?.getTime()).toBeGreaterThan(Date.now() - 60000);
    const outgoing = await personal.send(c.id, owner, {
      content: 'Reply',
      idempotencyKey: randomUUID(),
    });
    await run('SEND');
    await status(a, 'wamid.provider1', 'read', outgoing.id);
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
        .lastInboundAt,
    ).toEqual(before.lastInboundAt);
    await accept({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '201',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '101' },
                messages: [
                  {
                    id: 'wamid.system',
                    from: wa,
                    timestamp: String(now() + 5),
                    type: 'system',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();
    expect(
      (await db.conversation.findUniqueOrThrow({ where: { id: c.id } }))
        .lastInboundAt,
    ).toEqual(before.lastInboundAt);
  });
  it('updates delivered/read from Meta and preserves stronger evidence when events arrive out of order', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Reply',
        idempotencyKey: randomUUID(),
      });
    await run('SEND');
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'SENT',
      readAt: null,
      deliveredAt: null,
    });
    await status(a, 'wamid.provider1', 'read', m.id, now() + 3);
    await status(a, 'wamid.provider1', 'delivered', m.id, now() + 2);
    await status(a, 'wamid.provider1', 'sent', m.id, now() + 1);
    await status(a, 'wamid.provider1', 'failed', m.id, now() + 4, {
      errors: [{ code: 131026 }],
    });
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'READ',
      readAt: expect.any(Date),
      deliveredAt: expect.any(Date),
      deliveryError: null,
    });
  });
  it('reconciles a webhook before HTTP ACK and after restart using opaque callback identity', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Reply',
        idempotencyKey: randomUUID(),
      });
    await db.message.update({
      where: { id: m.id },
      data: { deliveryStatus: 'SENDING' },
    });
    const root = new PersonalWorker(
      db,
      cfg,
      crypto,
      {} as ZaloSessionManager,
      new MessageStore(),
    );
    await root.recoverAfterRestart();
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    await status(a, 'wamid.recovered', 'delivered', m.id);
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'DELIVERED',
      externalMessageId: 'wamid.recovered',
    });
    expect(sendCount).toBe(0);
  });
  it('rejects status correlation to a different recipient without altering the intent', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Reply',
        idempotencyKey: randomUUID(),
      });
    await status(a, 'wamid.wrong', 'read', m.id, now(), {
      recipient_id: '84909999999',
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
        .deliveryStatus,
    ).toBe('PENDING');
    expect(
      await db.webhookEvent.findFirst({
        where: { eventName: 'whatsapp.status' },
      }),
    ).toMatchObject({ status: 'FAILED', error: 'WHATSAPP_STATUS_MISMATCH' });
  });
  it('publishes owner-scoped realtime identifiers after transaction commit', async () => {
    const pg = new Client({ connectionString: url });
    await pg.connect();
    const events: string[] = [];
    pg.on('notification', (e) => events.push(e.payload ?? ''));
    await pg.query('LISTEN zalo_inbox_events');
    try {
      const a = await connect();
      await incoming(a);
      await vi.waitFor(() =>
        expect(events.some((e) => e.includes('message.created'))).toBe(true),
      );
      expect(
        JSON.parse(events.find((e) => e.includes('message.created'))!),
      ).toMatchObject({
        ownerId: owner,
        event: { channelAccountId: a.id, type: 'message.created' },
      });
      expect(events.join('')).not.toMatch(
        /Customer hello|private-test|accessToken/,
      );
    } finally {
      await pg.end();
    }
  });
});

describe('outbox, policy, templates, media and disconnect', () => {
  it('sends only once for the same idempotency key and includes only same-conversation reply context', async () => {
    const a = await connect(),
      c = await incoming(a),
      incomingMessage = await db.message.findFirstOrThrow();
    const input = {
      content: 'Text reply',
      idempotencyKey: randomUUID(),
      replyToMessageId: incomingMessage.id,
    };
    const first = await personal.send(c.id, owner, input),
      again = await personal.send(c.id, owner, input);
    expect(first.id).toBe(again.id);
    await run('SEND');
    expect(sendCount).toBe(1);
    const request = transport.mock.calls.find(
      ([q]) => q.method === 'POST' && q.url?.endsWith('/messages'),
    )![0];
    expect(request.data).toMatchObject({
      context: { message_id: 'wamid.incoming' },
      text: { body: 'Text reply' },
      biz_opaque_callback_data: expect.stringMatching(
        new RegExp('^' + first.id + '\\.'),
      ),
    });
    await expect(
      personal.send(c.id, 'other-owner', input),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(
      personal.send(c.id, owner, { ...input, replyToMessageId: undefined }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('blocks freeform outside 24h both at queue time and again before dispatch', async () => {
    const a = await connect(),
      c = await incoming(a, 'wamid.old', now() - 25 * 3600);
    expect((await inbox.conversation(c.id)).canSend).toBe(false);
    await expect(
      personal.send(c.id, owner, {
        content: 'Blocked',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_WINDOW_CLOSED' });
    await incoming(a, 'wamid.new');
    const m = await personal.send(c.id, owner, {
      content: 'Queued',
      idempotencyKey: randomUUID(),
    });
    await db.conversation.update({
      where: { id: c.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600000) },
    });
    await run('SEND');
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'FAILED',
      deliveryError: 'WHATSAPP_WINDOW_CLOSED',
    });
    expect(sendCount).toBe(0);
  });
  it.each([
    [130429, 'PENDING', 'CONNECTED'],
    [190, 'FAILED', 'REAUTH_REQUIRED'],
    [200, 'FAILED', 'PERMISSION_REQUIRED'],
    [131047, 'FAILED', 'CONNECTED'],
    [131049, 'FAILED', 'CONNECTED'],
    [131000, 'UNKNOWN', 'CONNECTED'],
  ])(
    'maps provider error %s into durable delivery/account states',
    async (code, state, connection) => {
      const a = await connect(),
        c = await incoming(a),
        m = await personal.send(c.id, owner, {
          content: 'Reply',
          idempotencyKey: randomUUID(),
        });
      failure = code;
      await run('SEND');
      expect(
        await db.message.findUnique({ where: { id: m.id } }),
      ).toMatchObject({ deliveryStatus: state });
      expect((await current(a.id)).connectionStatus).toBe(connection);
      if (code === 130429) {
        expect(
          (await current(a.id)).rateLimitedUntil!.getTime(),
        ).toBeGreaterThan(Date.now());
        expect(
          await db.personalCommand.findFirst({ where: { messageId: m.id } }),
        ).toMatchObject({ status: 'PENDING' });
      }
      if (code === 131000)
        await expect(personal.retry(c.id, m.id, owner)).rejects.toMatchObject({
          code: 'MESSAGE_NOT_RETRYABLE',
        });
    },
  );
  it('does not re-POST ambiguous network sends', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Reply',
        idempotencyKey: randomUUID(),
      });
    networkFailure = true;
    await run('SEND');
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
        .deliveryStatus,
    ).toBe('UNKNOWN');
    expect(await run('SEND')).toBe(false);
    expect(sendCount).toBe(1);
  });
  it('sends approved templates outside the window only with validated variables and explicit consent', async () => {
    const a = await connect(),
      c = await incoming(a, 'wamid.old', now() - 25 * 3600),
      input = templateInput();
    const results = await Promise.all([
      service.sendTemplate(owner, c.id, input),
      service.sendTemplate(owner, c.id, input),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results[0]).toMatchObject({
      type: 'template',
      source: 'WHATSAPP',
      deliveryStatus: 'PENDING',
      content: 'Chào An, đơn A1 đã giao.',
    });
    await run('SEND');
    const body = transport.mock.calls.find(
      ([q]) => q.method === 'POST' && q.url?.endsWith('/messages'),
    )![0].data;
    expect(body).toMatchObject({
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'vi' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'An' },
              { type: 'text', text: 'A1' },
            ],
          },
        ],
      },
    });
    const msg = await db.message.findUniqueOrThrow({
      where: { id: results[0].id },
    });
    expect(msg.deliveryStatus).toBe('SENT');
    expect(msg.metadata).toMatchObject({
      whatsapp: { optInConfirmedAt: expect.any(String), authorizedBy: owner },
    });
    expect((await inbox.conversation(c.id)).canSend).toBe(false);
  });
  it('revalidates template approval at dispatch and rejects unknown variables/unapproved templates', async () => {
    const a = await connect(),
      c = await incoming(a, 'wamid.old', now() - 25 * 3600);
    await expect(
      service.sendTemplate(owner, c.id, { ...templateInput(), parameters: [] }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_TEMPLATE_PARAMETERS_INVALID' });
    const m = await service.sendTemplate(owner, c.id, templateInput());
    templates = [{ ...template, status: 'PAUSED' }];
    await run('SEND');
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'FAILED',
      deliveryError: 'WHATSAPP_TEMPLATE_NOT_APPROVED',
    });
    expect(sendCount).toBe(0);
  });
  it('serves media only through an owner-authenticated endpoint, with correct token, size and digest', async () => {
    const a = await connect();
    await accept({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '201',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '101' },
                messages: [
                  {
                    id: 'wamid.photo',
                    from: wa,
                    timestamp: String(now()),
                    type: 'image',
                    image: {
                      id: '700',
                      mime_type: 'image/png',
                      sha256: createHash('sha256')
                        .update(image)
                        .digest('base64'),
                      caption: 'Photo caption',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();
    const m = await db.message.findFirstOrThrow(),
      path = `/api/channels/whatsapp/messages/${m.id}/media`;
    await request(app.getHttpServer()).get(path).expect(401);
    const result = await browser.get(path).expect(200);
    expect(Buffer.from(result.body)).toEqual(image);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['content-type']).toContain('image/png');
    const c = await db.conversation.findFirstOrThrow({
        where: { channelAccountId: a.id },
      }),
      messages = await inbox.messages(c.id, paginationSchema.parse({}));
    expect(messages.items[0].attachments[0]).toMatchObject({
      url: null,
      authenticatedPath: path.slice(4),
    });
    expect(JSON.stringify(messages)).not.toMatch(
      /lookaside|private-whatsapp-access|accessToken/,
    );
    await expect(service.media('other-owner', m.id)).rejects.toMatchObject({
      code: 'WHATSAPP_MEDIA_UNAVAILABLE',
    });
  });
  it('rejects tampered media, wrong MIME and oversized files before serving content', async () => {
    const a = await connect();
    await accept({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '201',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '101' },
                messages: [
                  {
                    id: 'wamid.photo',
                    from: wa,
                    timestamp: String(now()),
                    type: 'image',
                    image: { id: '700', mime_type: 'image/png' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await drain();
    const m = await db.message.findFirstOrThrow();
    for (const extra of [
      { file_size: 6000000 },
      { mime_type: 'text/html' },
      { sha256: 'not-the-content-digest' },
    ]) {
      transport.mockResolvedValueOnce({
        status: 200,
        data: {
          id: '700',
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=700',
          mime_type: 'image/png',
          file_size: image.length,
          sha256: createHash('sha256').update(image).digest('hex'),
          ...extra,
        },
      });
      await expect(service.media(owner, m.id)).rejects.toMatchObject({
        code: extra.sha256
          ? 'WHATSAPP_MEDIA_UNAVAILABLE'
          : 'WHATSAPP_MEDIA_UNSUPPORTED',
      });
    }
    expect((await current(a.id)).connectionStatus).toBe('CONNECTED');
  });
  it('keeps local read separate from explicit WhatsApp mark-read operations', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await db.message.findFirstOrThrow();
    await inbox.markRead(c.id, [m.id]);
    expect(
      transport.mock.calls.some(
        ([q]) => (q.data as { status?: string })?.status === 'read',
      ),
    ).toBe(false);
    await service.enqueueRead(owner, c.id, [m.id]);
    await run('SYNC_MESSAGES');
    expect(
      transport.mock.calls.some(
        ([q]) => (q.data as { status?: string })?.status === 'read',
      ),
    ).toBe(true);
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      inboxUnread: false,
      readAt: null,
      metadata: { whatsapp: { providerMarkedReadAt: expect.any(String) } },
    });
  });
  it('disconnects one phone without removing sibling WABA subscriptions; last phone unsubscribes', async () => {
    const a = await connect(),
      b = await connect('102');
    await incoming(a);
    await personal.disconnect(a.id, owner);
    expect(
      transport.mock.calls.filter(
        ([q]) => q.method === 'DELETE' && q.url?.endsWith('/subscribed_apps'),
      ),
    ).toHaveLength(0);
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
    });
    expect((await current(b.id)).connectionStatus).toBe('CONNECTED');
    await personal.disconnect(b.id, owner);
    expect(
      transport.mock.calls.filter(
        ([q]) => q.method === 'DELETE' && q.url?.endsWith('/subscribed_apps'),
      ),
    ).toHaveLength(1);
    expect(await db.message.count()).toBe(1);
  });
  it('clears local credentials and reports cleanup uncertainty if Meta refuses unsubscribe', async () => {
    const a = await connect();
    await incoming(a);
    subscribeFailure = true;
    await personal.disconnect(a.id, owner);
    expect(await current(a.id)).toMatchObject({
      connectionStatus: 'DISCONNECTED',
      encryptedCredentials: null,
      lastError: 'WHATSAPP_CLEANUP_UNCONFIRMED',
    });
    expect(await db.message.count()).toBe(1);
  });
  it('uses the existing real worker dispatcher and never invents Cloud API history', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Worker routed',
        idempotencyKey: randomUUID(),
      });
    const sessions = {
      entries: () => [],
      get: () => undefined,
      disconnectAll: vi.fn(),
    } as unknown as ZaloSessionManager;
    const root = new PersonalWorker(
      db,
      cfg,
      crypto,
      sessions,
      new MessageStore(),
      undefined,
      undefined,
      undefined,
      worker,
    );
    try {
      await root.start(false);
      await root.tick();
      expect(
        await db.message.findUnique({ where: { id: m.id } }),
      ).toMatchObject({ deliveryStatus: 'SENT' });
    } finally {
      await root.stop();
    }
    await expect(worker.enqueue(owner, a.id, c.id)).rejects.toMatchObject({
      code: 'WHATSAPP_HISTORY_UNAVAILABLE',
    });
  });
});

describe('WhatsApp documents and audio in the shared inbox', () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture document\n%%EOF'),
    mp3 = Buffer.from('ID3\x04\x00\x00fixture audio');
  function upload(
    conversationId: string,
    key: string,
    bytes = pdf,
    name = 'invoice.pdf',
    mime = 'application/pdf',
    kind = 'document',
    caption = '',
  ) {
    return browser
      .post(`/api/conversations/${conversationId}/whatsapp/media`)
      .set('Origin', cfg.env.FRONTEND_URL)
      .field('kind', kind)
      .field('caption', caption)
      .field('idempotencyKey', key)
      .attach('file', bytes, { filename: name, contentType: mime });
  }
  it('uploads a document once for concurrent identical requests, persists one intent and sends through the worker', async () => {
    const a = await connect(),
      c = await incoming(a),
      key = randomUUID();
    const [r1, r2] = await Promise.all([
      upload(
        c.id,
        key,
        pdf,
        'Hóa đơn.pdf',
        'application/pdf',
        'document',
        'Hóa đơn',
      ),
      upload(
        c.id,
        key,
        pdf,
        'Hóa đơn.pdf',
        'application/pdf',
        'document',
        'Hóa đơn',
      ),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.data.id).toBe(r2.body.data.id);
    expect(uploadCount).toBe(1);
    expect(sendCount).toBe(0);
    expect(r1.body.data).toMatchObject({
      type: 'file',
      content: 'Hóa đơn',
      deliveryStatus: 'PENDING',
      attachments: [{ name: 'Hóa đơn.pdf', url: null }],
    });
    expect(JSON.stringify(r1.body)).not.toMatch(
      /accessToken|private-whatsapp|lookaside/,
    );
    await run('SEND');
    const post = transport.mock.calls.find(
      ([q]) =>
        q.method === 'POST' &&
        (q.data as { type?: string })?.type === 'document',
    )![0];
    expect(post.data).toMatchObject({
      to: wa,
      type: 'document',
      document: { id: '700', filename: 'Hóa đơn.pdf', caption: 'Hóa đơn' },
    });
    expect(post.headers?.Authorization).toBe('Bearer ' + token);
    const download = await browser
      .get(`/api/channels/whatsapp/messages/${r1.body.data.id}/media`)
      .expect(200);
    expect(Buffer.from(download.body)).toEqual(pdf);
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
    await upload(c.id, key, Buffer.from('%PDF-changed')).expect(409);
    expect(sendCount).toBe(1);
  });
  it('uploads and queues audio without a caption and provides a protected playback endpoint', async () => {
    const a = await connect(),
      c = await incoming(a);
    const r = await upload(
      c.id,
      randomUUID(),
      mp3,
      'recording.mp3',
      'audio/mpeg',
      'audio',
    ).expect(200);
    expect(r.body.data).toMatchObject({
      type: 'audio',
      attachments: [{ type: 'audio', name: 'recording.mp3' }],
    });
    await run('SEND');
    expect(
      transport.mock.calls.find(
        ([q]) => (q.data as { type?: string })?.type === 'audio',
      )![0].data,
    ).toMatchObject({ type: 'audio', audio: { id: '700' } });
    const file = await service.media(owner, r.body.data.id);
    expect(file.bytes).toEqual(mp3);
    expect(file.inline).toBe(true);
    expect(uploadCount).toBe(1);
    expect(sendCount).toBe(1);
  });
  it('rejects spoofed, unsupported and oversized uploads and does not create a send intent', async () => {
    const a = await connect(),
      c = await incoming(a);
    await upload(c.id, randomUUID(), Buffer.from('not a PDF')).expect(409);
    await upload(
      c.id,
      randomUUID(),
      mp3,
      'recording.mp3',
      'audio/mpeg',
      'audio',
      'invalid caption',
    ).expect(409);
    await upload(
      c.id,
      randomUUID(),
      Buffer.from('OggSnot opus'),
      'recording.ogg',
      'audio/ogg',
      'audio',
    ).expect(409);
    await upload(
      c.id,
      randomUUID(),
      mp3,
      'recording.exe',
      'audio/mpeg',
      'audio',
    ).expect(409);
    await upload(c.id, randomUUID(), Buffer.alloc(20_000_001, 1)).expect(413);
    expect(uploadCount).toBe(0);
    expect(sendCount).toBe(0);
    expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(0);
  });
  it('checks session, origin, ownership and 24-hour policy before uploading', async () => {
    const a = await connect(),
      c = await incoming(a),
      path = `/api/conversations/${c.id}/whatsapp/media`;
    await request(app.getHttpServer()).post(path).expect(401);
    await browser.post(path).set('Origin', 'https://evil.example').expect(403);
    await db.channelAccount.update({
      where: { id: a.id },
      data: { ownerId: 'someone-else' },
    });
    await upload(c.id, randomUUID()).expect(404);
    await db.channelAccount.update({
      where: { id: a.id },
      data: { ownerId: owner },
    });
    await db.conversation.update({
      where: { id: c.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600000) },
    });
    const r = await upload(c.id, randomUUID()).expect(409);
    expect(r.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(uploadCount).toBe(0);
  });
  it('does not enqueue a send when upload fails and rechecks the window after queueing', async () => {
    const a = await connect(),
      c = await incoming(a),
      key = randomUUID();
    uploadFailure = true;
    await upload(c.id, key).expect(503);
    expect(await db.personalCommand.count({ where: { kind: 'SEND' } })).toBe(0);
    uploadFailure = false;
    const r = await upload(c.id, key).expect(200);
    await db.conversation.update({
      where: { id: c.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600000) },
    });
    await run('SEND');
    expect(sendCount).toBe(0);
    expect(
      await db.message.findUnique({ where: { id: r.body.data.id } }),
    ).toMatchObject({
      deliveryStatus: 'FAILED',
      deliveryError: 'WHATSAPP_WINDOW_CLOSED',
    });
  });
  it.each(['document', 'audio'])(
    'receives %s, marks it locally unread and returns private media without provider credentials',
    async (kind) => {
      const a = await connect();
      mediaBytes = kind === 'document' ? pdf : mp3;
      mediaMime = kind === 'document' ? 'application/pdf' : 'audio/mpeg';
      await accept({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '201',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: a.externalAccountId },
                  messages: [
                    {
                      id: 'wamid.' + kind,
                      from: wa,
                      timestamp: String(now()),
                      type: kind,
                      [kind]: {
                        id: '700',
                        mime_type: mediaMime,
                        ...(kind === 'document'
                          ? {
                              filename: 'received.pdf',
                              caption: 'Tài liệu đến',
                            }
                          : {}),
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      await drain();
      const c = await db.conversation.findFirstOrThrow(),
        messages = await inbox.messages(c.id, paginationSchema.parse({})),
        m = messages.items[0];
      expect(m.type).toBe(kind === 'document' ? 'file' : 'audio');
      expect(m.inboxUnread).toBe(true);
      expect(m.attachments).toHaveLength(1);
      const path = '/api' + m.attachments[0].authenticatedPath;
      await request(app.getHttpServer()).get(path).expect(401);
      const file = await service.media(owner, m.id);
      expect(file.bytes).toEqual(mediaBytes);
      expect(file.mime).toBe(mediaMime);
      expect(JSON.stringify(messages)).not.toMatch(
        /accessToken|private-whatsapp|lookaside/,
      );
    },
  );
  it('isolates retries from late status callbacks for an earlier failed attempt', async () => {
    const a = await connect(),
      c = await incoming(a),
      m = await personal.send(c.id, owner, {
        content: 'Retry fixture',
        idempotencyKey: randomUUID(),
      });
    await run('SEND');
    const old = await db.message.findUniqueOrThrow({ where: { id: m.id } }),
      oldCallback = (old.metadata as { whatsapp: { callbackData: string } })
        .whatsapp.callbackData;
    await status(a, old.externalMessageId!, 'failed', oldCallback, now() + 1, {
      errors: [{ code: 131026 }],
    });
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
        .deliveryStatus,
    ).toBe('FAILED');
    await personal.retry(c.id, m.id, owner);
    await status(a, old.externalMessageId!, 'read', oldCallback, now() + 2);
    expect(await db.message.findUnique({ where: { id: m.id } })).toMatchObject({
      deliveryStatus: 'PENDING',
      externalMessageId: null,
      readAt: null,
    });
    await db.channelAccount.update({
      where: { id: a.id },
      data: { lastSendAt: null },
    });
    await run('SEND');
    const next = await db.message.findUniqueOrThrow({ where: { id: m.id } });
    expect(next.externalMessageId).not.toBe(old.externalMessageId);
    await status(a, next.externalMessageId!, 'read', m.id, now() + 3);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: m.id } }))
        .deliveryStatus,
    ).toBe('READ');
    expect(sendCount).toBe(2);
  });
});
