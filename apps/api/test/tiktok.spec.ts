import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { config } from './helpers';
import type { ConfigService } from '../src/config/config.service';
import {
  TikTokHttp,
  mediaUrl,
  nextCursor,
} from '../src/modules/tiktok/tiktok-http';
import {
  TikTokBusinessClient,
  BUSINESS_SCOPES,
  mapBusinessMessage,
} from '../src/modules/tiktok-business/tiktok-business.client';
import {
  TikTokShopClient,
  shopSign,
  mapShopMessage,
} from '../src/modules/tiktok-shop/tiktok-shop.client';
import {
  normalizeTikTokWebhook,
  verifyTikTokSignature,
} from '../src/modules/tiktok/tiktok-webhook.service';
import { validateAuthorizationUrl } from '../src/modules/tiktok/tiktok.registry';
import { channelSendPolicy } from '../src/modules/messaging/channel-policy';
import type { TikTokToken } from '../src/modules/tiktok/tiktok.types';

const settings = {
  ...config,
  env: {
    ...config.env,
    TIKTOK_BUSINESS_APP_ID: 'fixture-business-app',
    TIKTOK_BUSINESS_APP_SECRET: 'business-secret',
    TIKTOK_BUSINESS_REDIRECT_URI:
      'https://easy.example/api/channels/tiktok-business/oauth/callback',
    TIKTOK_SHOP_APP_KEY: 'fixture-shop-key',
    TIKTOK_SHOP_APP_SECRET: 'shop-secret',
  },
} as ConfigService;
const ownId = '9223372036854775807';
const peerId = '9223372036854775806';
function token(): TikTokToken {
  return {
    accessToken: 'private-fixture-access',
    refreshToken: 'private-fixture-refresh',
    openId: ownId,
    expiresAt: Date.now() + 86400000,
    refreshExpiresAt: Date.now() + 31536000000,
    scopes: [...BUSINESS_SCOPES],
    appId: 'fixture-business-app',
  };
}
function http(data: unknown, status = 200) {
  return {
    request: vi.fn().mockResolvedValue({ data: { code: 0, data }, status }),
  };
}
function businessMessage(extra = {}) {
  return {
    message_id: 'message-1',
    conversation_id: 'conversation-1',
    timestamp: Date.now() - 1000,
    message_type: 'TEXT',
    text: { body: 'Xin chào' },
    from_user: { id: peerId, role: 'PERSONAL_ACCOUNT' },
    to_user: { id: ownId, role: 'BUSINESS_ACCOUNT' },
    ...extra,
  };
}
function businessWebhook(event: string, content: unknown) {
  return Buffer.from(
    JSON.stringify({
      client_key: 'fixture-business-app',
      user_openid: ownId,
      event,
      create_time: Math.floor(Date.now() / 1000),
      content: JSON.stringify(content),
    }),
  );
}
function shopMessage(extra = {}) {
  return {
    id: 'shop-message-1',
    type: 'TEXT',
    content: JSON.stringify({ content: 'Cần hỗ trợ đơn hàng' }),
    create_time: Math.floor(Date.now() / 1000) - 100,
    sender: {
      im_user_id: peerId,
      role: 'BUYER',
      nickname: 'Khách hàng',
      avatar: 'https://cdn.example/avatar.jpg',
    },
    ...extra,
  };
}
afterEach(() => vi.useRealTimers());

describe('verified TikTok Business v1.3 contracts', () => {
  it('exchanges/refreshes account tokens with JSON credentials and relative expiry seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
    const transport = http({
      access_token: 'access',
      refresh_token: 'refresh',
      open_id: ownId,
      expires_in: 86400,
      refresh_token_expires_in: 31536000,
      scope: BUSINESS_SCOPES.join(', '),
    });
    const client = new TikTokBusinessClient(settings, transport);
    const fresh = await client.exchange('one-time-code');
    expect(fresh).toMatchObject({
      openId: ownId,
      expiresAt: Date.now() + 86400000,
      scopes: BUSINESS_SCOPES,
    });
    expect(transport.request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/',
      maxRedirects: 0,
      data: {
        client_id: 'fixture-business-app',
        client_secret: 'business-secret',
        auth_code: 'one-time-code',
        grant_type: 'authorization_code',
        redirect_uri: settings.env.TIKTOK_BUSINESS_REDIRECT_URI,
      },
    });
    await client.refresh(fresh);
    expect(transport.request.mock.calls[1][0]).toMatchObject({
      url: 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/',
      data: { grant_type: 'refresh_token', refresh_token: 'refresh' },
    });
  });
  it('checks app/account identity, actual scopes and advanced access before exposing an eligible identity', async () => {
    const transport = http({});
    transport.request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            app_id: 'fixture-business-app',
            creator_id: ownId,
            scope: BUSINESS_SCOPES.join(','),
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            has_advanced_access: true,
            display_name: 'Business fixture',
            profile_image: 'https://cdn.example/business.jpg',
          },
        },
      });
    const client = new TikTokBusinessClient(settings, transport);
    expect(await client.identities(token())).toEqual([
      {
        id: ownId,
        name: 'Business fixture',
        avatarUrl: 'https://cdn.example/business.jpg',
        region: null,
      },
    ]);
    expect(transport.request.mock.calls[1][0]).toMatchObject({
      headers: { 'Access-Token': 'private-fixture-access' },
      params: { business_id: ownId },
    });
    transport.request.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: {
          app_id: 'different-app',
          creator_id: ownId,
          scope: BUSINESS_SCOPES.join(','),
        },
      },
    });
    await expect(client.identities(token())).rejects.toMatchObject({
      code: 'TIKTOK_ACCOUNT_MISMATCH',
    });
    transport.request.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: {
          app_id: 'fixture-business-app',
          creator_id: ownId,
          scope: 'user.info.basic',
        },
      },
    });
    await expect(client.identities(token())).rejects.toMatchObject({
      code: 'TIKTOK_PERMISSION_DENIED',
    });
    transport.request
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            app_id: 'fixture-business-app',
            creator_id: ownId,
            scope: BUSINESS_SCOPES.join(','),
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { code: 0, data: { has_advanced_access: false } },
      });
    await expect(client.identities(token())).rejects.toMatchObject({
      code: 'TIKTOK_ACCOUNT_NOT_ELIGIBLE',
    });
  });
  it('probes actual conversation access and rejects missing send scope', async () => {
    const transport = http({ conversations: [], has_more: false });
    const client = new TikTokBusinessClient(settings, transport);
    const identity = {
      id: ownId,
      name: 'Business',
      avatarUrl: null,
      region: null,
    };
    await expect(
      client.verify({ ...token(), scopes: ['message.list.read'] }, identity),
    ).rejects.toMatchObject({ code: 'TIKTOK_PERMISSION_DENIED' });
    expect(transport.request).not.toHaveBeenCalled();
    expect(await client.verify(token(), identity)).toMatchObject({
      sendMessages: true,
      syncConversations: true,
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it('paginates SINGLE then STRANGER with integer cursors, without following provider URLs', async () => {
    const transport = http({
      conversations: [{ conversation_id: 'c1', update_time: Date.now() }],
      has_more: true,
      cursor: 25,
    });
    const client = new TikTokBusinessClient(settings, transport);
    const first = await client.conversations(token());
    expect(first.cursor).toBe('{"type":"SINGLE","cursor":25}');
    transport.request.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, data: { conversations: [], has_more: false } },
    });
    const second = await client.conversations(token(), first.cursor);
    expect(second.cursor).toBe('{"type":"STRANGER","cursor":0}');
    transport.request.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, data: { conversations: [], has_more: false } },
    });
    expect(
      (await client.conversations(token(), second.cursor)).cursor,
    ).toBeNull();
    expect(
      transport.request.mock.calls.map((c) => c[0].params.conversation_type),
    ).toEqual(['SINGLE', 'SINGLE', 'STRANGER']);
    await expect(
      client.conversations(token(), 'https://evil.example/credentials'),
    ).rejects.toThrow();
    expect(transport.request).toHaveBeenCalledTimes(3);
  });
  it('retrieves only the documented latest 20 messages, keeps contact identity and rejects foreign conversation data', async () => {
    const transport = http({
      messages: [businessMessage()],
      participants: [
        {
          id: peerId,
          role: 'PERSONAL_ACCOUNT',
          display_name: 'Khách Business',
          profile_image: 'https://cdn.example/peer.jpg',
        },
      ],
    });
    const client = new TikTokBusinessClient(settings, transport);
    expect(await client.messages(token(), 'conversation-1')).toMatchObject({
      cursor: null,
      items: [
        {
          id: 'message-1',
          name: 'Khách Business',
          contactId: peerId,
          direction: 'INCOMING',
          content: 'Xin chào',
        },
      ],
    });
    expect(transport.request.mock.calls[0][0].params).toEqual({
      business_id: ownId,
      conversation_id: 'conversation-1',
    });
    transport.request.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: { messages: [businessMessage({ conversation_id: 'foreign' })] },
      },
    });
    await expect(
      client.messages(token(), 'conversation-1'),
    ).rejects.toMatchObject({ code: 'TIKTOK_ACCOUNT_MISMATCH' });
  });
  it('sends text to a verified conversation, without user-id addressing or automatic HTTP retries', async () => {
    const transport = http({ message_id: 'outbound-id' });
    expect(
      await new TikTokBusinessClient(settings, transport).sendText(
        token(),
        'conversation-1',
        'Trả lời',
      ),
    ).toBe('outbound-id');
    expect(transport.request.mock.calls[0][0]).toMatchObject({
      data: {
        business_id: ownId,
        recipient_type: 'CONVERSATION',
        recipient: 'conversation-1',
        message_type: 'TEXT',
        text: { body: 'Trả lời' },
      },
    });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it('subscribes app-level DIRECT_MESSAGE using app credentials and verifies the returned callback', async () => {
    const callback =
      'https://easy.example/api/channels/tiktok-business/webhook';
    const transport = http({
      app_id: 'fixture-business-app',
      event_type: 'DIRECT_MESSAGE',
      callback_url: callback,
    });
    await new TikTokBusinessClient(settings, transport).subscribe(
      token(),
      callback,
    );
    expect(transport.request.mock.calls[0][0]).toMatchObject({
      url: 'https://business-api.tiktok.com/open_api/v1.3/business/webhook/update/',
      data: {
        app_id: 'fixture-business-app',
        secret: 'business-secret',
        callback_url: callback,
      },
    });
    expect(transport.request.mock.calls[0][0].headers).not.toHaveProperty(
      'Access-Token',
    );
  });
});

describe('TikTok Shop seller and Customer Service contracts', () => {
  it('uses seller authorization grant and absolute UNIX expiry, not Business expiry durations', async () => {
    const expire = Math.floor(Date.now() / 1000) + 86400;
    const transport = http({
      access_token: 'shop-access',
      refresh_token: 'shop-refresh',
      open_id: 'seller-open-id',
      user_type: 0,
      access_token_expire_in: expire,
      refresh_token_expire_in: expire + 86400,
      granted_scopes: ['seller.customer_service', 'seller.authorization.info'],
    });
    const client = new TikTokShopClient(settings, transport);
    const result = await client.exchange('seller-code');
    expect(result.expiresAt).toBe(expire * 1000);
    expect(transport.request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://auth.tiktok-shops.com/api/v2/token/get',
      params: {
        app_key: 'fixture-shop-key',
        app_secret: 'shop-secret',
        grant_type: 'authorized_code',
        auth_code: 'seller-code',
      },
    });
    await client.refresh(result);
    expect(transport.request.mock.calls[1][0]).toMatchObject({
      url: 'https://auth.tiktok-shops.com/api/v2/token/refresh',
      params: { refresh_token: 'shop-refresh', grant_type: 'refresh_token' },
    });
  });
  it('rejects non-seller tokens and missing Customer Service permission without claiming connection success', async () => {
    const transport = http({
      access_token: 'a',
      refresh_token: 'r',
      open_id: 'creator',
      user_type: 1,
      access_token_expire_in: 2000000000,
      refresh_token_expire_in: 2100000000,
      granted_scopes: [],
    });
    const client = new TikTokShopClient(settings, transport);
    await expect(client.exchange('creator-code')).rejects.toMatchObject({
      code: 'TIKTOK_TOKEN_REFRESH_UNKNOWN',
    });
    await expect(
      client.verify(token(), {
        id: 'shop',
        name: 'Shop',
        cipher: 'cipher',
        region: 'VN',
        avatarUrl: null,
      }),
    ).rejects.toMatchObject({ code: 'TIKTOK_SHOP_APPROVAL_REQUIRED' });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it('signs sorted query values, excludes access_token/sign, and binds the exact UTF-8 request body', () => {
    const path = '/customer_service/202606/conversations/c-1/messages';
    const body =
      '{"type":"TEXT","content":"{\\"content\\":\\"Xin chào\\"}","sender_role":"CUSTOMER_SERVICE"}';
    const query = {
      timestamp: 1793923200,
      shop_cipher: 'cipher-1',
      app_key: 'key-1',
      sign: 'ignored',
      access_token: 'not-signed',
    };
    const literal =
      'secret' +
      path +
      'app_keykey-1shop_ciphercipher-1timestamp1793923200' +
      body +
      'secret';
    const expected = createHmac('sha256', 'secret')
      .update(literal)
      .digest('hex');
    expect(shopSign(path, query, body, 'secret')).toBe(expected);
    expect(shopSign(path, query, body + ' ', 'secret')).not.toBe(expected);
  });
  it('loads authorized shops and keeps distinct IDs and ciphers for selecting a shop', async () => {
    const transport = http({
      shops: [
        { id: 'shop-1', name: 'Shop 1', region: 'VN', cipher: 'cipher-1' },
        { id: 'shop-2', name: 'Shop 2', region: 'US', cipher: 'cipher-2' },
      ],
    });
    const list = await new TikTokShopClient(settings, transport).identities(
      token(),
    );
    expect(list.map((s) => [s.id, s.cipher, s.region])).toEqual([
      ['shop-1', 'cipher-1', 'VN'],
      ['shop-2', 'cipher-2', 'US'],
    ]);
    const req = transport.request.mock.calls[0][0];
    expect(req.url).toBe(
      'https://open-api.tiktokglobalshop.com/authorization/202309/shops',
    );
    expect(req.headers['x-tts-access-token']).toBe(token().accessToken);
    expect(req.params).not.toHaveProperty('access_token');
  });
  it('normalizes actual buyer/unread/reply state and opaque page tokens', async () => {
    const transport = http({
      conversations: [
        {
          id: 'c-1',
          can_send_message: false,
          unread_count: 3,
          participants: [shopMessage().sender],
          latest_message: shopMessage(),
        },
      ],
      next_page_token: 'opaque-next-token',
    });
    const result = await new TikTokShopClient(
      settings,
      transport,
    ).conversations({ ...token(), shopCipher: 'cipher-1' }, 'opaque-first');
    expect(result).toMatchObject({
      cursor: 'opaque-next-token',
      items: [
        {
          id: 'c-1',
          contactId: peerId,
          unreadCount: 3,
          canSend: false,
          latest: { direction: 'INCOMING', content: 'Cần hỗ trợ đơn hàng' },
        },
      ],
    });
    expect(transport.request.mock.calls[0][0].params).toMatchObject({
      shop_cipher: 'cipher-1',
      page_token: 'opaque-first',
      page_size: 20,
    });
  });
  it('uses 202606 send with nested JSON content and exactly the signed wire bytes', async () => {
    const transport = http({ message_id: 'shop-outgoing' });
    const own = { ...token(), shopCipher: 'cipher-1' };
    expect(
      await new TikTokShopClient(settings, transport).sendText(
        own,
        'c/1',
        'Xin chào',
      ),
    ).toBe('shop-outgoing');
    const req = transport.request.mock.calls[0][0];
    expect(req.url).toBe(
      'https://open-api.tiktokglobalshop.com/customer_service/202606/conversations/c%2F1/messages',
    );
    expect(JSON.parse(req.data)).toEqual({
      type: 'TEXT',
      content: JSON.stringify({ content: 'Xin chào' }),
      sender_role: 'CUSTOMER_SERVICE',
    });
    expect(req.params.sign).toBe(
      shopSign(
        '/customer_service/202606/conversations/c%2F1/messages',
        req.params,
        req.data,
        'shop-secret',
      ),
    );
    expect(req.transformRequest[0](req.data)).toBe(req.data);
  });
  it('registers and reads back all required Shop webhook topics', async () => {
    const callback = 'https://easy.example/api/channels/tiktok-shop/webhook';
    const transport = http({});
    transport.request
      .mockResolvedValueOnce({ status: 200, data: { code: 0, data: {} } })
      .mockResolvedValueOnce({ status: 200, data: { code: 0, data: {} } })
      .mockResolvedValueOnce({ status: 200, data: { code: 0, data: {} } })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          data: {
            webhooks: [
              'NEW_MESSAGE',
              'NEW_CONVERSATION',
              'SELLER_DEAUTHORIZATION',
            ].map((event_type) => ({ event_type, address: callback })),
          },
        },
      });
    await new TikTokShopClient(settings, transport).subscribe(
      { ...token(), shopCipher: 'cipher' },
      callback,
    );
    expect(transport.request.mock.calls.map((c) => c[0].method)).toEqual([
      'PUT',
      'PUT',
      'PUT',
      'GET',
    ]);
    expect(
      transport.request.mock.calls
        .slice(0, 3)
        .map((c) => JSON.parse(c[0].data).event_type),
    ).toEqual(['NEW_MESSAGE', 'NEW_CONVERSATION', 'SELLER_DEAUTHORIZATION']);
  });
});

describe('webhook authenticity, mapping and policy boundaries', () => {
  it('verifies Business timestamp + exact raw body, accepts rotation signatures and rejects stale/tampered delivery', () => {
    const raw = Buffer.from('{ "event": "fixture" }');
    const t = String(Math.floor(Date.now() / 1000));
    const sign = createHmac('sha256', 'secret')
      .update(t + '.')
      .update(raw)
      .digest('hex');
    const header = `t=${t},s=${'0'.repeat(64)},s=${sign}`;
    expect(() =>
      verifyTikTokSignature('TIKTOK_BUSINESS', raw, header, 'app', 'secret'),
    ).not.toThrow();
    expect(() =>
      verifyTikTokSignature(
        'TIKTOK_BUSINESS',
        Buffer.from('{"event":"fixture"}'),
        header,
        'app',
        'secret',
      ),
    ).toThrow();
    expect(() =>
      verifyTikTokSignature(
        'TIKTOK_BUSINESS',
        raw,
        header,
        'app',
        'secret',
        Date.now() + 301000,
      ),
    ).toThrow();
  });
  it('uses a distinct app-key + raw-body Shop HMAC, allowing delayed legitimate retries', () => {
    const raw = Buffer.from('{"timestamp":1600000000,"data":{}}');
    const sign = createHmac('sha256', 'secret')
      .update('shop-key')
      .update(raw)
      .digest('hex');
    expect(() =>
      verifyTikTokSignature('TIKTOK_SHOP', raw, sign, 'shop-key', 'secret'),
    ).not.toThrow();
    expect(() =>
      verifyTikTokSignature(
        'TIKTOK_SHOP',
        raw,
        sign,
        'different-key',
        'secret',
      ),
    ).toThrow();
    expect(() =>
      verifyTikTokSignature(
        'TIKTOK_SHOP',
        raw,
        `Bearer ${sign}`,
        'shop-key',
        'secret',
      ),
    ).toThrow();
  });
  it('preserves original message time, string IDs and directions; refuses mismatched Business recipients', () => {
    const at = Date.now() - 3600000;
    const content = {
      ...businessMessage({ timestamp: at }),
      type: 'text',
      from_user: { id: peerId, role: 'personal_account' },
      to_user: { id: ownId, role: 'business_account' },
    };
    const result = normalizeTikTokWebhook(
      'TIKTOK_BUSINESS',
      businessWebhook('im_receive_msg', content),
      'fixture-business-app',
    );
    expect(result).toMatchObject({
      key: 'im_receive_msg:message-1',
      event: {
        accountId: ownId,
        kind: 'message',
        message: { at, senderId: peerId, direction: 'INCOMING' },
      },
    });
    expect(() =>
      mapBusinessMessage(
        businessMessage({ to_user: { id: peerId, role: 'PERSONAL_ACCOUNT' } }),
        ownId,
      ),
    ).toThrow();
    expect(() =>
      mapBusinessMessage(
        businessMessage({
          from_user: { id: peerId, role: 'BUSINESS_ACCOUNT' },
        }),
        ownId,
      ),
    ).toThrow();
  });
  it('queues EU privacy events for official sync and maps read watermarks without inventing message bodies', () => {
    expect(
      normalizeTikTokWebhook(
        'TIKTOK_BUSINESS',
        businessWebhook('im_receive_msg_eu', { conversation_id: 'c-eu' }),
        'fixture-business-app',
      ).event,
    ).toMatchObject({ kind: 'sync', conversationId: 'c-eu' });
    const timestamp = Date.now() - 1000;
    const result = normalizeTikTokWebhook(
      'TIKTOK_BUSINESS',
      businessWebhook('im_mark_read_msg', {
        conversation_id: 'c-1',
        timestamp,
        from_user: { id: peerId, role: 'personal_account' },
        to_user: { id: ownId, role: 'business_account' },
        read: { last_read_timestamp: timestamp - 1000 },
      }),
      'fixture-business-app',
    );
    expect(result.event).toMatchObject({
      kind: 'read',
      at: timestamp,
      watermark: timestamp - 1000,
    });
  });
  it('maps Shop type 14 messages, type 13 conversation changes and type 6 seller deauthorization', () => {
    const envelope = {
      shop_id: 'shop-1',
      tts_notification_id: 'notification-1',
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        ...shopMessage(),
        message_id: 'shop-message-1',
        conversation_id: 'c-1',
      },
    };
    const event = (type: number) =>
      normalizeTikTokWebhook(
        'TIKTOK_SHOP',
        Buffer.from(JSON.stringify({ ...envelope, type })),
        'shop-key',
      );
    expect(event(14)).toMatchObject({
      key: 'notification-1',
      event: {
        kind: 'message',
        accountId: 'shop-1',
        message: { content: 'Cần hỗ trợ đơn hàng', senderId: peerId },
      },
    });
    expect(event(13).event).toMatchObject({
      kind: 'sync',
      conversationId: 'c-1',
    });
    expect(event(6).event).toMatchObject({
      kind: 'revoked',
      accountId: 'shop-1',
    });
    expect(event(5).event).toBeNull();
    expect(
      mapShopMessage(shopMessage({ is_visible: false }), 'c-1'),
    ).toBeNull();
  });
  it('never opens a reply window based on the sync time, read time or outbound message', () => {
    const now = Date.now();
    const account = {
      channelType: 'TIKTOK_BUSINESS' as const,
      connectionStatus: 'CONNECTED' as const,
      capabilities: { sendMessages: true },
    };
    const conversation = {
      externalConversationId: 'c-1',
      lastInboundAt: new Date(now - 48 * 3600000),
    };
    expect(channelSendPolicy(account, conversation, true, now).code).toBe(
      'TIKTOK_REPLY_WINDOW_CLOSED',
    );
    expect(
      channelSendPolicy(
        account,
        { ...conversation, lastInboundAt: new Date(now - 1000) },
        true,
        now,
      ).allowed,
    ).toBe(true);
    expect(
      channelSendPolicy(
        { ...account, capabilities: {} },
        conversation,
        true,
        now,
      ).code,
    ).toBe('TIKTOK_PERMISSION_DENIED');
  });
  it('requires a fresh, real Shop can_send_message flag even with Customer Service access', () => {
    const now = Date.now();
    const account = {
      channelType: 'TIKTOK_SHOP' as const,
      connectionStatus: 'CONNECTED' as const,
      capabilities: { sendMessages: true },
    };
    const conversation = {
      externalConversationId: 'c-1',
      lastInboundAt: new Date(now - 1000),
      providerState: { canSend: true, checkedAt: now },
    };
    expect(channelSendPolicy(account, conversation, true, now).allowed).toBe(
      true,
    );
    expect(
      channelSendPolicy(
        account,
        { ...conversation, providerState: { canSend: false, checkedAt: now } },
        true,
        now,
      ).code,
    ).toBe('TIKTOK_REPLY_NOT_ALLOWED');
    expect(
      channelSendPolicy(
        account,
        {
          ...conversation,
          providerState: { canSend: true, checkedAt: now - 600001 },
        },
        true,
        now,
      ).code,
    ).toBe('TIKTOK_SYNC_REQUIRED');
  });
  it('accepts only dashboard OAuth URLs and prevents callback/host replacement', () => {
    const redirect = settings.env.TIKTOK_BUSINESS_REDIRECT_URI;
    expect(
      validateAuthorizationUrl(
        'https://www.tiktok.com/v2/auth/authorize?client_key=app',
        'TIKTOK_BUSINESS',
        redirect,
      ).hostname,
    ).toBe('www.tiktok.com');
    expect(() =>
      validateAuthorizationUrl(
        'https://www.tiktok.com.evil.example/v2/auth/authorize',
        'TIKTOK_BUSINESS',
        redirect,
      ),
    ).toThrow();
    expect(() =>
      validateAuthorizationUrl(
        'https://www.tiktok.com/v2/auth/authorize?redirect_uri=https://evil.example',
        'TIKTOK_BUSINESS',
        redirect,
      ),
    ).toThrow();
    expect(
      validateAuthorizationUrl(
        'https://services.us.tiktokshop.com/open/authorize?service_id=fixture',
        'TIKTOK_SHOP',
        redirect,
      ).hostname,
    ).toBe('services.us.tiktokshop.com');
  });
  it('rejects stalled cursors and private/credential-bearing media URLs', () => {
    expect(() => nextCursor(true, 'same', 'same')).toThrow();
    expect(nextCursor(false, undefined)).toBeNull();
    for (const url of [
      'http://cdn.example/a',
      'https://127.0.0.1/a',
      'https://localhost/a',
      'https://user:password@cdn.example/a',
      'https://cdn.example/a?access_token=secret',
    ])
      expect(mediaUrl(url)).toBeUndefined();
    expect(
      mediaUrl('https://cdn.example/a.jpg?x-signature=temporary'),
    ).toContain('cdn.example');
  });
});

describe('delivery certainty and sanitized provider errors', () => {
  it.each([
    [40100, 'TIKTOK_RATE_LIMITED', false, true],
    [40105, 'TIKTOK_TOKEN_EXPIRED', false, false],
    [105005, 'TIKTOK_PERMISSION_DENIED', false, false],
    [45109001, 'TIKTOK_REPLY_NOT_ALLOWED', false, false],
    [51065, 'TIKTOK_SEND_UNKNOWN', true, false],
  ])(
    'classifies provider code %s without exposing its raw message',
    async (code, expected, ambiguous, retryable) => {
      const transport = {
        request: vi.fn().mockResolvedValue({
          status: 200,
          data: {
            code,
            message: 'private-token-in-error customer message content',
          },
        }),
      };
      await expect(
        new TikTokHttp(transport).request({}, z.object({}), 'send'),
      ).rejects.toMatchObject({
        code: expected,
        message: expected,
        ambiguous,
        retryable,
      });
    },
  );
  it('keeps network timeouts, malformed success and unknown HTTP 500 sends ambiguous with no retry', async () => {
    for (const transport of [
      { request: vi.fn().mockRejectedValue(new Error('axios secret request')) },
      http({ unexpected: 'response' }),
      {
        request: vi.fn().mockResolvedValue({
          status: 500,
          data: { code: 999999, message: 'internal' },
        }),
      },
    ]) {
      await expect(
        new TikTokHttp(transport).request(
          {},
          z.object({ message_id: z.string() }),
          'send',
        ),
      ).rejects.toMatchObject({
        code: 'TIKTOK_SEND_UNKNOWN',
        ambiguous: true,
        retryable: false,
      });
      expect(transport.request).toHaveBeenCalledTimes(1);
    }
  });
  it('does not silently retry a rotating refresh token after a malformed response', async () => {
    await expect(
      new TikTokHttp(http({})).request(
        {},
        z.object({ refresh_token: z.string() }),
        'token',
      ),
    ).rejects.toMatchObject({
      code: 'TIKTOK_TOKEN_REFRESH_UNKNOWN',
      ambiguous: true,
    });
  });
});
