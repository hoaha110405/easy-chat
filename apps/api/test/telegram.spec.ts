import 'reflect-metadata';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import {
  TelegramBotClient,
  mapBotMessage,
} from '../src/modules/telegram-bot/telegram-bot.client';
import {
  authPresentation,
  authRequest,
  mapTdMessage,
  tdChatAllowed,
  validTdVersion,
} from '../src/modules/telegram-personal/tdlib.mapper';
import { TdJsonClient } from '../src/modules/telegram-personal/tdjson.client';
import {
  telegramId,
  telegramJson,
  telegramMessageKey,
  tdError,
  tdNumber,
} from '../src/modules/telegram/telegram.types';
import { TelegramSettings } from '../src/modules/telegram/telegram.config';
import {
  TelegramRpcClient,
  TelegramRpcServer,
} from '../src/modules/telegram/telegram.rpc';
import type { ConfigService } from '../src/config/config.service';
import { config } from './helpers';

const token = `1234567890:${'A'.repeat(35)}`;
const date = 1794000000;
const botMessage = {
  message_id: 9,
  date,
  chat: { id: -100123, type: 'supergroup', title: 'Group' },
  from: { id: 42, first_name: 'Peer' },
  text: 'Hello',
};
describe('official Bot API HTTPS contracts', () => {
  it('uses the fixed official host, bounded requests and precision-safe response parser', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        result: { id: 1234567890, is_bot: true, first_name: 'Bot' },
      },
    });
    const client = new TelegramBotClient({ request });
    expect(await client.getMe(token)).toMatchObject({
      id: '1234567890',
      is_bot: true,
    });
    const options = request.mock.calls[0][0];
    expect(options).toMatchObject({
      method: 'POST',
      url: `https://api.telegram.org/bot${token}/getMe`,
      maxRedirects: 0,
      timeout: 8000,
      proxy: false,
    });
    expect(options.transformResponse[0]('{"id":9223372036854775807}')).toEqual({
      id: '9223372036854775807',
    });
  });
  it('rejects invalid tokens before any network request', async () => {
    const request = vi.fn();
    await expect(
      new TelegramBotClient({ request }).getMe('not-a-token'),
    ).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });
  it('registers only supported webhook updates and preserves queued updates', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { ok: true, result: true } });
    const client = new TelegramBotClient({ request });
    await client.setWebhook(token, 'https://easy.example/api/hook', 'secret');
    expect(request.mock.calls[0][0].data).toEqual({
      url: 'https://easy.example/api/hook',
      secret_token: 'secret',
      allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      drop_pending_updates: false,
      max_connections: 10,
    });
    await client.deleteWebhook(token);
    expect(request.mock.calls[1][0].data).toEqual({
      drop_pending_updates: false,
    });
  });
  it.each([
    [429, { retry_after: 23 }, 'TELEGRAM_RATE_LIMITED', false, 23],
    [401, {}, 'TELEGRAM_REAUTH_REQUIRED', false, null],
    [403, {}, 'TELEGRAM_PERMISSION_DENIED', false, null],
    [
      400,
      { migrate_to_chat_id: -100456 },
      'TELEGRAM_CHAT_MIGRATED',
      false,
      null,
    ],
    [500, {}, 'TELEGRAM_SEND_UNKNOWN', true, null],
  ])(
    'classifies provider error %s without leaking descriptions',
    async (code, parameters, error, ambiguous, delay) => {
      const request = vi.fn().mockResolvedValue({
        status: code,
        data: {
          ok: false,
          error_code: code,
          description: 'private diagnostic',
          parameters,
        },
      });
      await expect(
        new TelegramBotClient({ request }).sendText(token, '-100123', 'Hello'),
      ).rejects.toMatchObject({
        code: error,
        ambiguous,
        retryAfter: delay,
        message: error,
      });
    },
  );
  it('does not assume a successful send after timeout, malformed ACK or wrong chat/bot', async () => {
    for (const response of [
      null,
      { ok: true, result: {} },
      {
        ok: true,
        result: {
          ...botMessage,
          from: { id: 1234567890 },
          chat: { id: -5, type: 'group' },
        },
      },
      { ok: true, result: botMessage },
    ]) {
      const request =
        response === null
          ? vi.fn().mockRejectedValue(new Error('contains-token'))
          : vi.fn().mockResolvedValue({ status: 200, data: response });
      await expect(
        new TelegramBotClient({ request }).sendText(token, '-100123', 'Hello'),
      ).rejects.toMatchObject({
        code: 'TELEGRAM_SEND_UNKNOWN',
        ambiguous: true,
      });
    }
  });
  it('accepts a definite matching provider ACK and uses plain text, not parse_mode', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { ok: true, result: { ...botMessage, from: { id: 1234567890 } } },
    });
    expect(
      await new TelegramBotClient({ request }).sendText(
        token,
        '-100123',
        '<Hello>',
      ),
    ).toMatchObject({ message_id: '9' });
    expect(request.mock.calls[0][0].data).toEqual({
      chat_id: '-100123',
      text: '<Hello>',
    });
  });
});

describe('Telegram IDs, mapping and official authentication states', () => {
  it('preserves signed IDs and compound per-chat message IDs without rounding', () => {
    const raw = telegramJson.parse(
      '{"id":9223372036854775807,"chat":-1001234567890}',
    );
    expect(telegramId.parse(raw.id)).toBe('9223372036854775807');
    expect(telegramJson.stringify({ chat_id: tdNumber(raw.id) })).toBe(
      '{"chat_id":9223372036854775807}',
    );
    expect(() => telegramId.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(telegramMessageKey('-1001', '9')).not.toBe(
      telegramMessageKey('-1002', '9'),
    );
  });
  it('normalizes Bot media as file IDs without exposing token URLs', () => {
    expect(
      mapBotMessage(
        {
          ...botMessage,
          text: undefined,
          photo: [{ file_id: 'f1', width: 20, height: 20 }],
          caption: 'Photo',
        },
        '1234567890',
      ),
    ).toMatchObject({
      chatId: '-100123',
      id: '9',
      direction: 'INCOMING',
      type: 'image',
      content: 'Photo',
      media: { fileId: 'f1' },
    });
    expect(
      mapBotMessage({ ...botMessage, from: { id: 1234567890 } }, '1234567890')
        .direction,
    ).toBe('OUTGOING');
  });
  it('normalizes TDLib Cloud messages, device outgoing messages and verified edits', () => {
    expect(
      mapTdMessage({
        id: 1048576,
        chat_id: -100123,
        sender_id: { '@type': 'messageSenderUser', user_id: 42 },
        is_outgoing: true,
        date,
        edit_date: date + 10,
        content: {
          '@type': 'messageText',
          text: { '@type': 'formattedText', text: 'Edited' },
        },
      }),
    ).toMatchObject({
      id: '1048576',
      chatId: '-100123',
      senderId: '42',
      direction: 'OUTGOING',
      content: 'Edited',
      editedAt: new Date((date + 10) * 1000),
    });
  });
  it.each([
    ['chatTypePrivate', true],
    ['chatTypeBasicGroup', true],
    ['chatTypeSupergroup', true],
    ['chatTypeSecret', false],
  ])('filters %s to Cloud chats only', async (kind, allowed) => {
    expect(
      tdChatAllowed({ id: 1, title: 'Chat', type: { '@type': kind } }),
    ).toBe(allowed);
    expect(
      tdChatAllowed({
        id: -100,
        title: 'Channel',
        type: { '@type': 'chatTypeSupergroup', is_channel: true },
      }),
    ).toBe(false);
  });
  it.each([
    [
      'authorizationStateWaitPhoneNumber',
      'phone',
      '+84123456789',
      'setAuthenticationPhoneNumber',
    ],
    ['authorizationStateWaitCode', 'code', '12345', 'checkAuthenticationCode'],
    [
      'authorizationStateWaitPassword',
      'password',
      'test-2fa',
      'checkAuthenticationPassword',
    ],
    [
      'authorizationStateWaitEmailAddress',
      'email',
      'test@example.com',
      'setAuthenticationEmailAddress',
    ],
    [
      'authorizationStateWaitEmailCode',
      'email_code',
      '98765',
      'checkAuthenticationEmailCode',
    ],
  ])(
    'uses the actual %s request only in the matching state',
    (state, action, value, method) => {
      const result = authRequest(state, action, value);
      expect(result['@type']).toBe(method);
      if (action === 'email_code')
        expect(result.code).toEqual({
          '@type': 'emailAddressAuthenticationCode',
          code: value,
        });
      expect(() =>
        authRequest('authorizationStateReady', action, value),
      ).toThrow('TELEGRAM_AUTH_STATE_CHANGED');
    },
  );
  it('does not serialize phone/code/password from authorization payloads; sanitizes confirmation links', () => {
    const p = authPresentation({
      '@type': 'authorizationStateWaitCode',
      code_info: {
        type: { '@type': 'authenticationCodeTypeTelegramMessage' },
        phone_number: '+84123456789',
      },
      code: 'private-otp',
      password: 'private-2fa',
    });
    expect(JSON.stringify(p)).not.toMatch(
      /private-otp|private-2fa|84123456789/,
    );
    expect(
      authPresentation({
        '@type': 'authorizationStateWaitOtherDeviceConfirmation',
        link: 'https://evil.example',
      }),
    ).not.toHaveProperty('confirmationLink');
    expect(
      authPresentation({
        '@type': 'authorizationStateWaitOtherDeviceConfirmation',
        link: 'tg://login?token=Ab_cd-123=',
      }),
    ).toMatchObject({
      state: 'DEVICE_CONFIRMATION_REQUIRED',
      confirmationLink: 'tg://login?token=Ab_cd-123=',
    });
    expect(
      authPresentation({ '@type': 'authorizationStateFuture' }).state,
    ).toBe('ADDITIONAL_ACTION_REQUIRED');
  });
  it('uses official QR requests and reports premium/registration without invented APIs', () => {
    expect(authRequest('authorizationStateWaitPhoneNumber', 'qr')).toEqual({
      '@type': 'requestQrCodeAuthentication',
      other_user_ids: [],
    });
    expect(
      authPresentation({ '@type': 'authorizationStateWaitPremiumPurchase' })
        .state,
    ).toBe('PREMIUM_REQUIRED');
    expect(
      authPresentation({ '@type': 'authorizationStateWaitRegistration' }).state,
    ).toBe('REGISTRATION_REQUIRED');
  });
  it('rejects unverified TDLib versions instead of sending incompatible native fields', () => {
    expect(
      validTdVersion({ '@type': 'optionValueString', value: '1.8.69' }),
    ).toBe(true);
    expect(
      validTdVersion({ '@type': 'optionValueString', value: '1.8.40' }),
    ).toBe(false);
    expect(
      validTdVersion({ '@type': 'optionValueString', value: '2.0.0' }),
    ).toBe(false);
  });
  it('never even reads TDLib 406 message text, and bounds FLOOD_WAIT', () => {
    const value = {
      code: 406,
      get message() {
        throw Error('must not read');
      },
    };
    expect(tdError(value).code).toBe('TELEGRAM_REQUEST_REJECTED');
    expect(
      tdError({ code: 429, message: 'FLOOD_WAIT_9999999' }, 'send'),
    ).toMatchObject({ retryAfter: 86400, retryable: true, ambiguous: false });
    expect(tdError({ code: 500, message: 'private' }, 'send')).toMatchObject({
      ambiguous: true,
      code: 'TELEGRAM_SEND_UNKNOWN',
    });
  });
});

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('native JSON/C process transport and authenticated worker IPC', () => {
  it('correlates fragmented UTF-8 JSON, classifies crashes/timeouts and closes isolated processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easychat-td-'));
    directories.push(dir);
    const path = join(dir, 'fake-json-boundary.mjs');
    await writeFile(
      path,
      `import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const q=JSON.parse(line);if(q['@type']==='crash'){process.exit(2);}if(q['@type']==='timeout')return;
if(q['@type']==='close'){process.stdout.write(JSON.stringify({'@type':'ok','@extra':q['@extra']})+'\\n',()=>process.exit(0));return;}
const bytes=Buffer.from(JSON.stringify({'@type':'optionValueString',value:'Tiếng Việt','@extra':q['@extra']})+'\\n');const i=bytes.indexOf(Buffer.from('ế'))+1;process.stdout.write(bytes.subarray(0,i));setTimeout(()=>process.stdout.write(bytes.subarray(i)),5);});`,
    );
    const client = new TdJsonClient().start(process.execPath, path);
    try {
      expect(await client.request({ '@type': 'getOption' })).toMatchObject({
        value: 'Tiếng Việt',
      });
      await expect(
        client.request({ '@type': 'timeout' }, 'send', 15),
      ).rejects.toMatchObject({
        code: 'TELEGRAM_SEND_UNKNOWN',
        ambiguous: true,
      });
      await expect(
        client.request({ '@type': 'crash' }, 'send'),
      ).rejects.toMatchObject({
        code: 'TELEGRAM_SEND_UNKNOWN',
        ambiguous: true,
      });
    } finally {
      await client.close();
    }
  });
  it('uses a private Unix socket, validates signatures/freshness and rejects replayed OTP envelopes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'easychat-rpc-'));
    directories.push(dir);
    const cfg = {
      ...config,
      env: { ...config.env, TELEGRAM_RPC_SOCKET: join(dir, 'worker.sock') },
    } as ConfigService;
    const settings = new TelegramSettings(cfg),
      server = new TelegramRpcServer(settings, cfg),
      client = new TelegramRpcClient(settings, cfg);
    const handler = vi.fn(async () => ({ state: 'CODE_REQUIRED' }));
    await server.start(handler);
    const wire = async (body: string, sig: string) =>
      new Promise<string>((resolve, reject) => {
        const s = createConnection(settings.paths().socket);
        let result = '';
        s.on('connect', () =>
          s.write(JSON.stringify({ body, signature: sig }) + '\n'),
        );
        s.on('data', (chunk) => (result += chunk.toString()));
        s.on('end', () => resolve(result));
        s.on('error', reject);
      });
    try {
      expect((await stat(settings.paths().socket)).mode & 0o777).toBe(0o600);
      expect(
        await client.request({
          action: 'health',
          ownerId: 'administrator',
          sessionId: 'test',
        }),
      ).toEqual({ state: 'CODE_REQUIRED' });
      const body = JSON.stringify({
        nonce: randomUUID(),
        at: Date.now(),
        ownerId: 'administrator',
        sessionId: 'test',
        action: 'auth',
        authAction: 'code',
        value: 'test-otp',
      });
      const sign = createHmac('sha256', cfg.env.SESSION_SECRET)
        .update(body)
        .digest('hex');
      expect(JSON.parse(await wire(body, '0'.repeat(64))).error.code).toBe(
        'TELEGRAM_RPC_REJECTED',
      );
      expect(JSON.parse(await wire(body, sign)).data).toEqual({
        state: 'CODE_REQUIRED',
      });
      expect(JSON.parse(await wire(body, sign)).error.code).toBe(
        'TELEGRAM_RPC_REJECTED',
      );
      const stale = JSON.stringify({
        ...JSON.parse(body),
        nonce: randomUUID(),
        at: Date.now() - 60000,
      });
      expect(
        JSON.parse(
          await wire(
            stale,
            createHmac('sha256', cfg.env.SESSION_SECRET)
              .update(stale)
              .digest('hex'),
          ),
        ).error.code,
      ).toBe('TELEGRAM_RPC_REJECTED');
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });
  it('requires an official-compatible HTTPS webhook URL and safe ports', () => {
    for (const url of [
      'http://easy.example',
      'https://easy.example:3000',
      'https://user:pass@easy.example',
      'https://easy.example?token=secret',
      'https://localhost',
    ]) {
      const settings = new TelegramSettings({
        ...config,
        env: { ...config.env, TELEGRAM_BOT_WEBHOOK_BASE_URL: url },
      } as ConfigService);
      expect(() => settings.webhookBase()).toThrow();
    }
    expect(
      new TelegramSettings({
        ...config,
        env: {
          ...config.env,
          TELEGRAM_BOT_WEBHOOK_BASE_URL: 'https://easy.example:8443',
        },
      } as ConfigService).webhookUrl('c123'),
    ).toBe('https://easy.example:8443/api/channels/telegram-bot/c123/webhook');
  });
});
