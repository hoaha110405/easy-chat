import { createServer } from 'node:http';
import axios from 'axios';
import { validateWhatsAppUpload } from '../src/modules/whatsapp/whatsapp.media';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '../src/config/config.service';
import { WhatsAppClient } from '../src/modules/whatsapp/whatsapp.client';
import { WhatsAppSettings } from '../src/modules/whatsapp/whatsapp.service';
import {
  waFailure,
  waJson,
  waWindow,
  waTemplateSchema,
} from '../src/modules/whatsapp/whatsapp.types';
import {
  templatePresentation,
  prepareTemplate,
  templateInputSchema,
} from '../src/modules/whatsapp/whatsapp.templates';
import { channelSendPolicy } from '../src/modules/messaging/channel-policy';
import { config } from './helpers';
const cfg = {
  ...config,
  env: {
    ...config.env,
    WHATSAPP_ENABLED: true,
    WHATSAPP_GRAPH_API_VERSION: 'v27.0',
    WHATSAPP_META_APP_ID: '301',
    WHATSAPP_META_APP_SECRET: 'private-test-app',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'private-verify',
    WHATSAPP_WEBHOOK_CALLBACK_URL: 'https://easy.example/api/webhooks/whatsapp',
    WHATSAPP_EMBEDDED_SIGNUP_ENABLED: true,
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: '401',
  },
} as ConfigService;
const template = waTemplateSchema.parse({
  id: '900',
  name: 'order_update',
  language: 'vi',
  category: 'UTILITY',
  status: 'APPROVED',
  parameter_format: 'POSITIONAL',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Đơn {{1}}' },
    { type: 'BODY', text: 'Chào {{1}}, đơn {{2}} đã giao.' },
    { type: 'FOOTER', text: 'easyChat' },
  ],
});
const input = () =>
  templateInputSchema.parse({
    templateId: '900',
    templateName: 'order_update',
    language: 'vi',
    parameters: [
      { component: 'header', name: '1', value: 'A1' },
      { component: 'body', name: '1', value: 'An' },
      { component: 'body', name: '2', value: 'A1' },
    ],
    optInConfirmed: true,
    idempotencyKey: randomUUID(),
  });
describe('official WhatsApp Cloud API boundary', () => {
  it('uses fixed HTTPS Graph host, explicit version, Bearer/proof, timeout and safe JSON IDs', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { id: '201', name: 'Business' },
    });
    const client = new WhatsAppClient(cfg, { request });
    expect(await client.business('private-access-token', '201')).toEqual({
      id: '201',
      name: 'Business',
    });
    const q = request.mock.calls[0][0];
    expect(q).toMatchObject({
      method: 'GET',
      url: 'https://graph.facebook.com/v27.0/201',
      headers: { Authorization: 'Bearer private-access-token' },
      timeout: 8000,
      maxRedirects: 0,
      proxy: false,
    });
    expect(q.params.appsecret_proof).toMatch(/^[a-f0-9]{64}$/);
    expect(q.transformResponse[0]('{"id":9223372036854775807}')).toEqual({
      id: '9223372036854775807',
    });
  });
  it('sends one-to-one text with callback correlation and explicit messaging-account context', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '84901234567', wa_id: '84901234567' }],
        messages: [{ id: 'wamid.accepted' }],
      },
    });
    const client = new WhatsAppClient(cfg, { request });
    const id = 'cmh0000000000000000000001';
    const result = await client.send(
      'private-access-token',
      '101',
      '201',
      '84901234567',
      { type: 'text', text: { body: 'Hello' } },
      id,
    );
    expect(result).toEqual({ id: 'wamid.accepted' });
    expect(request.mock.calls[0][0].data).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '84901234567',
      type: 'text',
      text: { body: 'Hello' },
      biz_opaque_callback_data: id,
      messaging_account_id: '201',
    });
    expect(result).not.toHaveProperty('delivered');
  });
  it.each([
    [190, 'WHATSAPP_REAUTH_REQUIRED', false],
    [200, 'WHATSAPP_PERMISSION_REQUIRED', false],
    [131047, 'WHATSAPP_WINDOW_CLOSED', false],
    [130429, 'WHATSAPP_RATE_LIMITED', false],
    [131056, 'WHATSAPP_RATE_LIMITED', false],
    [131049, 'WHATSAPP_RECIPIENT_RESTRICTED', false],
    [132001, 'WHATSAPP_TEMPLATE_REJECTED', false],
    [133010, 'WHATSAPP_REGISTRATION_REQUIRED', false],
    [131000, 'WHATSAPP_SEND_UNKNOWN', true],
  ])(
    'maps provider code %s without leaking private diagnostic text',
    async (code, expected, ambiguous) => {
      const request = vi.fn().mockResolvedValue({
        status: 400,
        data: { error: { code, message: 'private content and token' } },
      });
      await expect(
        new WhatsAppClient(cfg, { request }).send(
          'private-access-token',
          '101',
          '201',
          '84901234567',
          { type: 'text', text: { body: 'hello' } },
          'cmh0000000000000000000001',
        ),
      ).rejects.toMatchObject({ code: expected, message: expected, ambiguous });
    },
  );
  it('keeps timeouts, malformed ACKs, proxy errors and mismatched recipient outcomes UNKNOWN', async () => {
    const responses = [
      null,
      { status: 200, data: {} },
      { status: 408, data: 'timeout proxy' },
      { status: 502, data: 'bad gateway' },
      {
        status: 200,
        data: {
          messaging_product: 'whatsapp',
          contacts: [{ input: 'other', wa_id: '84911111111' }],
          messages: [{ id: 'wamid.other' }],
        },
      },
    ];
    for (const r of responses) {
      const request = r
        ? vi.fn().mockResolvedValue(r)
        : vi.fn().mockRejectedValue(Error('private-token'));
      await expect(
        new WhatsAppClient(cfg, { request }).send(
          'private-access-token',
          '101',
          '201',
          '84901234567',
          { type: 'text', text: { body: 'hello' } },
          'cmh0000000000000000000001',
        ),
      ).rejects.toMatchObject({
        code: 'WHATSAPP_SEND_UNKNOWN',
        ambiguous: true,
      });
    }
  });
  it('never automatically retries Meta spam restrictions and honors bounded rate waits', () => {
    expect(waFailure(131048, 400, 'send')).toMatchObject({ retryable: false });
    expect(waFailure(130429, 429, 'send', 999999)).toMatchObject({
      retryAfter: 86400,
      retryable: true,
    });
    expect(waFailure(131000, 500, 'read')).toMatchObject({
      ambiguous: false,
      retryable: true,
    });
  });
  it('rejects arbitrary graph paths and media hosts before network access', async () => {
    const request = vi.fn();
    const client = new WhatsAppClient(cfg, { request });
    expect(() => client.business('token', '../me')).toThrow();
    for (const url of [
      'http://lookaside.fbsbx.com/x',
      'https://evil.example/x',
      'https://lookaside.fbsbx.com.evil.example/x',
      'https://user:pass@lookaside.fbsbx.com/x',
    ])
      await expect(client.download('token', url, 1024)).rejects.toMatchObject({
        code: 'WHATSAPP_MEDIA_UNAVAILABLE',
      });
    expect(request).not.toHaveBeenCalled();
  });
  it('uses authenticated bounded media downloads without exposing bearer tokens in URLs', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 200, data: Buffer.from('bytes') });
    const client = new WhatsAppClient(cfg, { request });
    expect(
      await client.download(
        'private-access-token',
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123',
        100,
      ),
    ).toEqual(Buffer.from('bytes'));
    expect(request.mock.calls[0][0]).toMatchObject({
      headers: { Authorization: 'Bearer private-access-token' },
      maxContentLength: 100,
      maxRedirects: 0,
      responseType: 'arraybuffer',
    });
  });
  it('uses official register and mark-read request bodies', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { success: true } });
    const client = new WhatsAppClient(cfg, { request });
    await client.register('token', '101', '123456');
    await client.markRead('token', '101', 'wamid.inbound');
    expect(request.mock.calls[0][0].data).toEqual({
      messaging_product: 'whatsapp',
      pin: '123456',
    });
    expect(request.mock.calls[1][0].data).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.inbound',
    });
  });
});
describe('customer-service window and approved templates', () => {
  it('opens only from a verified incoming timestamp, closes exactly at 24h and rejects future clocks', () => {
    const now = Date.now();
    expect(waWindow(null, now).open).toBe(false);
    expect(waWindow(new Date(now - 24 * 3600000), now).open).toBe(false);
    expect(waWindow(new Date(now - 24 * 3600000 + 1), now).open).toBe(true);
    expect(waWindow(new Date(now + 120000), now).open).toBe(false);
  });
  it('keeps WhatsApp freeform policy separate from last outbound activity and provider rejections', () => {
    const a = {
      channelType: 'WHATSAPP_BUSINESS',
      connectionStatus: 'CONNECTED' as const,
      capabilities: { sendMessages: true },
    };
    const old = new Date(Date.now() - 25 * 3600000);
    expect(channelSendPolicy(a, { lastInboundAt: old }, true)).toMatchObject({
      allowed: false,
      code: 'WHATSAPP_WINDOW_CLOSED',
    });
    expect(
      channelSendPolicy(
        a,
        {
          lastInboundAt: new Date(),
          providerState: { replyBlockedUntilInbound: true },
        },
        true,
      ).allowed,
    ).toBe(false);
    expect(
      channelSendPolicy(a, { lastInboundAt: new Date() }, true).allowed,
    ).toBe(true);
    expect(
      channelSendPolicy(a, { lastInboundAt: new Date() }, false),
    ).toMatchObject({ code: 'CHANNEL_WORKER_UNAVAILABLE' });
  });
  it('constructs positional header/body parameters from the actual approved definition', () => {
    const result = prepareTemplate(template, input());
    expect(result.content).toBe('Đơn A1\nChào An, đơn A1 đã giao.\neasyChat');
    expect(result.payload.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'A1' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'An' },
          { type: 'text', text: 'A1' },
        ],
      },
    ]);
  });
  it('supports named parameters with parameter_name and repeated variables only once', () => {
    const t = {
      ...template,
      parameter_format: 'NAMED' as const,
      components: [{ type: 'BODY', text: 'Chào {{customer}}, {{customer}}!' }],
    };
    const v = {
      ...input(),
      parameters: [
        { component: 'body' as const, name: 'customer', value: 'An' },
      ],
    };
    expect(templatePresentation(t).variables).toHaveLength(1);
    expect(prepareTemplate(t, v).payload.template.components).toEqual([
      {
        type: 'body',
        parameters: [{ type: 'text', text: 'An', parameter_name: 'customer' }],
      },
    ]);
  });
  it.each(['PENDING', 'REJECTED', 'PAUSED', 'DISABLED'])(
    'does not send template status %s',
    (status) => {
      expect(() => prepareTemplate({ ...template, status }, input())).toThrow(
        'WHATSAPP_TEMPLATE_NOT_APPROVED',
      );
    },
  );
  it('rejects media/button/authentication templates and unknown/missing/duplicate variables', () => {
    for (const t of [
      { ...template, components: [{ type: 'HEADER', format: 'IMAGE' }] },
      { ...template, components: [{ type: 'BUTTONS' }] },
      { ...template, category: 'AUTHENTICATION' },
    ])
      expect(templatePresentation(t).supported).toBe(false);
    expect(() =>
      prepareTemplate(template, { ...input(), parameters: [] }),
    ).toThrow('WHATSAPP_TEMPLATE_PARAMETERS_INVALID');
    expect(() =>
      prepareTemplate(template, {
        ...input(),
        parameters: [
          input().parameters[0],
          input().parameters[0],
          input().parameters[2],
        ],
      }),
    ).toThrow('WHATSAPP_TEMPLATE_PARAMETERS_INVALID');
    expect(() =>
      templateInputSchema.parse({ ...input(), optInConfirmed: false }),
    ).toThrow();
  });
  it('gates Embedded Signup on configured HTTPS and explicit activation; tokens stay backend-only', () => {
    expect(new WhatsAppSettings(cfg).embedded).toBe(false);
    const secure = {
      ...cfg,
      env: { ...cfg.env, FRONTEND_URL: 'https://easy.example' },
    } as ConfigService;
    expect(new WhatsAppSettings(secure).embedded).toBe(true);
    expect(
      new WhatsAppSettings({
        ...secure,
        env: { ...secure.env, WHATSAPP_EMBEDDED_SIGNUP_ENABLED: false },
      } as ConfigService).embedded,
    ).toBe(false);
    for (const callback of [
      'http://easy.example/api/webhooks/whatsapp',
      'https://evil.example/other',
      'https://user:pass@easy.example/api/webhooks/whatsapp',
    ])
      expect(
        new WhatsAppSettings({
          ...cfg,
          env: { ...cfg.env, WHATSAPP_WEBHOOK_CALLBACK_URL: callback },
        } as ConfigService).configured,
      ).toBe(false);
  });
  it('keeps large provider IDs as strings', () => {
    expect(waJson.parse('{"id":9223372036854775807}')).toEqual({
      id: '9223372036854775807',
    });
  });
});

describe('WhatsApp upload byte validation', () => {
  it.each([
    [
      'document',
      'file.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.7\nfixture'),
    ],
    [
      'document',
      'file.txt',
      'text/plain',
      Buffer.from('Nội dung tài liệu UTF-8'),
    ],
    ['audio', 'file.mp3', 'audio/mpeg', Buffer.from('ID3fixture')],
    ['audio', 'file.amr', 'audio/amr', Buffer.from('#!AMR\nfixture')],
    ['audio', 'file.m4a', 'audio/mp4', Buffer.from('0000ftypM4A fixture')],
    [
      'audio',
      'file.ogg',
      'audio/ogg',
      Buffer.concat([
        Buffer.from('OggSfixtureOpusHead'),
        Buffer.from([1, 1]),
        Buffer.from('fixture'),
      ]),
    ],
  ] as const)(
    'accepts supported %s bytes for %s',
    (kind, name, mime, buffer) => {
      expect(
        validateWhatsAppUpload(
          { buffer, originalname: name, mimetype: mime, size: buffer.length },
          kind,
        ),
      ).toMatchObject({ kind, mime, name, size: buffer.length });
    },
  );
  it.each([
    ['file.pdf', 'application/pdf', Buffer.from('executable bytes')],
    ['file.txt', 'text/plain', Buffer.from([0xff, 0x00, 0x10])],
    [
      'file.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.from('PK\x03\x04not-an-office-document'),
    ],
    ['file.mp3', 'application/pdf', Buffer.from('ID3fixture')],
    ['file.ogg', 'audio/ogg', Buffer.from('OggSnon-Opus')],
    [
      'file.ogg',
      'audio/ogg',
      Buffer.concat([
        Buffer.from('OggSOpusHead'),
        Buffer.from([1, 2]),
        Buffer.from('stereo'),
      ]),
    ],
  ] as const)(
    'rejects malformed bytes or MIME for %s',
    (name, mime, buffer) => {
      expect(() =>
        validateWhatsAppUpload(
          { buffer, originalname: name, mimetype: mime, size: buffer.length },
          name.endsWith('.mp3') || name.endsWith('.ogg') ? 'audio' : 'document',
        ),
      ).toThrow();
    },
  );
});

describe('WhatsApp multipart transport', () => {
  it('encodes the real HTTP upload with a multipart boundary and original file bytes', async () => {
    let body = Buffer.alloc(0),
      contentType = '';
    const server = createServer((req, res) => {
      contentType = req.headers['content-type'] ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"id":"700"}');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('No fixture address');
      const client = new WhatsAppClient(cfg, {
        request: (q) =>
          axios.request({
            ...q,
            url: `http://127.0.0.1:${address.port}/fixture`,
            params: {},
            timeout: 2000,
            signal: AbortSignal.timeout(2000),
          }),
      });
      const bytes = Buffer.from('%PDF-1.7\nbyte fixture');
      expect(
        await client.upload(
          'fixture-token',
          '101',
          bytes,
          'application/pdf',
          'invoice.pdf',
        ),
      ).toEqual({ id: '700' });
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(body.includes(bytes)).toBe(true);
      expect(body.toString()).toContain('filename="invoice.pdf"');
      expect(body.toString()).toContain('Content-Type: application/pdf');
      expect(body.toString()).toContain('whatsapp');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
