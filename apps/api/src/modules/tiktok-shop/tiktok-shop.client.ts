import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { ConfigService } from '../../config/config.service';
import {
  TikTokHttp,
  TikTokError,
  requiredId,
  nextCursor,
  mediaUrl,
  type TikTokTransport,
} from '../tiktok/tiktok-http';
import type {
  TikTokAdapter,
  TikTokToken,
  TikTokMessage,
  TikTokIdentity,
} from '../tiktok/tiktok.types';
const id = z.string().min(1).max(512);
const remoteToken = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384),
  access_token_expire_in: z.number().int().positive(),
  refresh_token_expire_in: z.number().int().positive(),
  open_id: id,
  user_type: z.literal(0),
  granted_scopes: z.array(z.string()),
});
const participant = z.object({
  im_user_id: id,
  role: z.string(),
  nickname: z.string().optional(),
  avatar: z.string().optional(),
  user_id: id.optional(),
});
export const shopMessageSchema = z
  .object({
    id: id.optional(),
    message_id: id.optional(),
    type: z.string(),
    content: z.string().max(100000),
    create_time: z.number().int().min(1262304000),
    sender: participant,
    is_visible: z.boolean().optional(),
  })
  .refine((m) => Boolean(m.id || m.message_id));
const conversationSchema = z.object({
  id,
  can_send_message: z.boolean().optional(),
  unread_count: z.number().int().nonnegative().optional(),
  participants: z.array(participant).optional(),
  latest_message: shopMessageSchema.optional(),
});
export function shopSign(
  path: string,
  query: Record<string, string | number>,
  body: string,
  secret: string,
) {
  const pairs = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => k + String(query[k]))
    .join('');
  return createHmac('sha256', secret)
    .update(secret + path + pairs + body + secret)
    .digest('hex');
}
export function mapShopMessage(
  value: unknown,
  conversationId: string,
): TikTokMessage | null {
  const m = shopMessageSchema.parse(value);
  if (m.is_visible === false) return null;
  if (
    !['BUYER', 'SHOP', 'CUSTOMER_SERVICE', 'SYSTEM', 'ROBOT'].includes(
      m.sender.role,
    )
  )
    throw new TikTokError('TIKTOK_INVALID_RESPONSE');
  let content: Record<string, unknown> = {};
  try {
    content = z.record(z.unknown()).parse(JSON.parse(m.content));
  } catch {
    if (m.type === 'TEXT') throw new TikTokError('TIKTOK_INVALID_RESPONSE');
  }
  const incoming = m.sender.role === 'BUYER';
  const url = mediaUrl(content.url);
  const previewUrl = mediaUrl(content.cover);
  return {
    id: m.id ?? m.message_id!,
    conversationId,
    senderId: m.sender.im_user_id,
    direction: incoming ? 'INCOMING' : 'OUTGOING',
    type: m.type.toLowerCase(),
    content: typeof content.content === 'string' ? content.content : '',
    at: new Date(m.create_time * 1000),
    ...(incoming
      ? {
          name: m.sender.nickname,
          avatar: mediaUrl(m.sender.avatar),
          contactId: m.sender.im_user_id,
        }
      : {}),
    attachments: url
      ? [
          {
            type: m.type.toLowerCase(),
            payload: { url, ...(previewUrl ? { previewUrl } : {}) },
          },
        ]
      : [],
  };
}
@Injectable()
export class TikTokShopClient implements TikTokAdapter {
  readonly type = 'TIKTOK_SHOP' as const;
  private readonly http: TikTokHttp;
  constructor(
    private readonly config: ConfigService,
    transport?: TikTokTransport,
  ) {
    this.http = new TikTokHttp(transport);
  }
  private async request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    token: TikTokToken,
    query: Record<string, string | number> = {},
    body?: unknown,
    method?: 'GET' | 'POST' | 'PUT',
    effect: 'read' | 'send' | 'subscription' = 'read',
  ) {
    if (
      !this.config.env.TIKTOK_SHOP_APP_KEY ||
      !this.config.env.TIKTOK_SHOP_APP_SECRET
    )
      throw new TikTokError('TIKTOK_NOT_CONFIGURED');
    const params = {
      ...query,
      app_key: this.config.env.TIKTOK_SHOP_APP_KEY,
      timestamp: Math.floor(Date.now() / 1000),
      ...(token.shopCipher ? { shop_cipher: token.shopCipher } : {}),
    };
    const raw = body === undefined ? '' : JSON.stringify(body);
    const sign = shopSign(
      path,
      params,
      raw,
      this.config.env.TIKTOK_SHOP_APP_SECRET,
    );
    return this.http.request(
      {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        url: 'https://open-api.tiktokglobalshop.com' + path,
        params: { ...params, sign },
        headers: {
          'content-type': 'application/json',
          'x-tts-access-token': token.accessToken,
        },
        ...(body === undefined
          ? {}
          : { data: raw, transformRequest: [(data: unknown) => data] }),
      },
      schema,
      effect,
    );
  }
  private async token(path: 'get' | 'refresh', query: Record<string, string>) {
    const data = await this.http.request(
      {
        method: 'GET',
        url: 'https://auth.tiktok-shops.com/api/v2/token/' + path,
        params: {
          app_key: this.config.env.TIKTOK_SHOP_APP_KEY,
          app_secret: this.config.env.TIKTOK_SHOP_APP_SECRET,
          ...query,
        },
      },
      remoteToken,
      'token',
    );
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      openId: data.open_id,
      expiresAt: data.access_token_expire_in * 1000,
      refreshExpiresAt: data.refresh_token_expire_in * 1000,
      scopes: data.granted_scopes,
      appId: this.config.env.TIKTOK_SHOP_APP_KEY,
    };
  }
  exchange(code: string) {
    return this.token('get', {
      auth_code: code,
      grant_type: 'authorized_code',
    });
  }
  refresh(token: TikTokToken) {
    return this.token('refresh', {
      refresh_token: token.refreshToken,
      grant_type: 'refresh_token',
    });
  }
  async identities(token: TikTokToken): Promise<TikTokIdentity[]> {
    const data = await this.request(
      '/authorization/202309/shops',
      z.object({
        shops: z
          .array(
            z.object({ id, name: z.string(), region: z.string(), cipher: id }),
          )
          .max(1000),
      }),
      token,
    );
    return data.shops.map((s) => ({
      id: s.id,
      name: s.name,
      region: s.region,
      cipher: s.cipher,
      avatarUrl: null,
    }));
  }
  async verify(token: TikTokToken, identity: TikTokIdentity) {
    if (
      !identity.cipher ||
      !token.scopes.includes('seller.customer_service') ||
      !token.scopes.includes('seller.authorization.info')
    )
      throw new TikTokError('TIKTOK_SHOP_APPROVAL_REQUIRED');
    await this.conversations({ ...token, shopCipher: identity.cipher });
    return {
      receiveMessages: true,
      sendMessages: true,
      syncConversations: true,
      readReceipts: false,
    };
  }
  async subscribe(token: TikTokToken, callback: string) {
    const events = [
      'NEW_MESSAGE',
      'NEW_CONVERSATION',
      'SELLER_DEAUTHORIZATION',
    ];
    for (const event_type of events)
      await this.request(
        '/event/202309/webhooks',
        z.record(z.unknown()),
        token,
        {},
        { event_type, address: callback },
        'PUT',
        'subscription',
      );
    const result = await this.request(
      '/event/202309/webhooks',
      z.object({
        webhooks: z.array(
          z.object({ event_type: z.string(), address: z.string() }),
        ),
      }),
      token,
    );
    if (
      events.some(
        (e) =>
          !result.webhooks.some(
            (w) => w.event_type === e && w.address === callback,
          ),
      )
    )
      throw new TikTokError('TIKTOK_WEBHOOK_INVALID');
  }
  async conversations(token: TikTokToken, cursor?: string | null) {
    const data = await this.request(
      '/customer_service/202309/conversations',
      z.object({
        conversations: z.array(conversationSchema).max(20),
        next_page_token: z.string().optional(),
      }),
      token,
      { page_size: 20, ...(cursor ? { page_token: cursor } : {}) },
    );
    return {
      items: data.conversations.map((c) => {
        const buyer = c.participants?.find((p) => p.role === 'BUYER');
        const latest = c.latest_message
          ? mapShopMessage(c.latest_message, c.id)
          : null;
        return {
          id: c.id,
          name: buyer?.nickname,
          avatar: mediaUrl(buyer?.avatar),
          contactId: buyer?.im_user_id,
          unreadCount: c.unread_count,
          canSend: c.can_send_message,
          ...(latest ? { updatedAt: latest.at, latest } : {}),
        };
      }),
      cursor: nextCursor(
        Boolean(data.next_page_token),
        data.next_page_token,
        cursor,
      ),
    };
  }
  async messages(
    token: TikTokToken,
    conversationId: string,
    cursor?: string | null,
  ) {
    const data = await this.request(
      '/customer_service/202309/conversations/' +
        encodeURIComponent(requiredId(conversationId)) +
        '/messages',
      z.object({
        messages: z.array(shopMessageSchema).max(50),
        next_page_token: z.string().optional(),
      }),
      token,
      {
        page_size: 20,
        sort_order: 'DESC',
        ...(cursor ? { page_token: cursor } : {}),
      },
    );
    return {
      items: data.messages
        .map((m) => mapShopMessage(m, conversationId))
        .filter((m): m is TikTokMessage => m !== null),
      cursor: nextCursor(
        Boolean(data.next_page_token),
        data.next_page_token,
        cursor,
      ),
    };
  }
  async sendText(token: TikTokToken, conversationId: string, text: string) {
    if (!text.trim() || text.length > 2000)
      throw new TikTokError('TIKTOK_INVALID_REQUEST');
    const data = await this.request(
      '/customer_service/202606/conversations/' +
        encodeURIComponent(requiredId(conversationId)) +
        '/messages',
      z.object({ message_id: id }),
      token,
      {},
      {
        type: 'TEXT',
        content: JSON.stringify({ content: text }),
        sender_role: 'CUSTOMER_SERVICE',
      },
      'POST',
      'send',
    );
    return data.message_id;
  }
}
