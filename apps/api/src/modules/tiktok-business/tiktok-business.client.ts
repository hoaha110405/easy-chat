import { Injectable } from '@nestjs/common';
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
export const BUSINESS_SCOPES = [
  'message.list.read',
  'message.list.send',
  'message.list.manage',
  'user.account.type',
  'user.info.basic',
];
const id = z.string().min(1).max(512);
const remoteToken = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384),
  open_id: id,
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive(),
  scope: z.string(),
});
const user = z.object({
  id,
  role: z.enum(['BUSINESS_ACCOUNT', 'PERSONAL_ACCOUNT']),
});
export const businessMessageSchema = z.object({
  message_id: id,
  conversation_id: id,
  timestamp: z.number().int().min(1262304000000).max(8640000000000000),
  message_type: z.string(),
  from_user: user,
  to_user: user.optional(),
  text: z.object({ body: z.string().max(100000) }).optional(),
  sticker: z.object({ url: z.string() }).optional(),
  emoji: z.object({ url: z.string() }).optional(),
  participants: z.array(z.unknown()).optional(),
});
export function mapBusinessMessage(
  value: unknown,
  ownId: string,
): TikTokMessage {
  const m = businessMessageSchema.parse(value);
  const outgoing = m.from_user.role === 'BUSINESS_ACCOUNT';
  if (outgoing && m.from_user.id !== ownId)
    throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
  if (
    m.to_user &&
    ((outgoing && m.to_user.role !== 'PERSONAL_ACCOUNT') ||
      (!outgoing &&
        (m.to_user.role !== 'BUSINESS_ACCOUNT' || m.to_user.id !== ownId)))
  )
    throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
  const url = mediaUrl(m.sticker?.url ?? m.emoji?.url);
  return {
    id: m.message_id,
    conversationId: m.conversation_id,
    senderId: m.from_user.id,
    direction: outgoing ? 'OUTGOING' : 'INCOMING',
    type: m.message_type.toLowerCase(),
    content: m.text?.body ?? '',
    at: new Date(m.timestamp),
    contactId: outgoing ? m.to_user?.id : m.from_user.id,
    attachments: url
      ? [{ type: m.message_type.toLowerCase(), payload: { url } }]
      : [],
  };
}
@Injectable()
export class TikTokBusinessClient implements TikTokAdapter {
  readonly type = 'TIKTOK_BUSINESS' as const;
  private readonly http: TikTokHttp;
  constructor(
    private readonly config: ConfigService,
    transport?: TikTokTransport,
  ) {
    this.http = new TikTokHttp(transport);
  }
  private request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    token?: string,
    body?: unknown,
    effect: 'read' | 'send' | 'token' | 'subscription' = 'read',
    params?: Record<string, unknown>,
  ) {
    if (
      !this.config.env.TIKTOK_BUSINESS_APP_ID ||
      !this.config.env.TIKTOK_BUSINESS_APP_SECRET
    )
      throw new TikTokError('TIKTOK_NOT_CONFIGURED');
    return this.http.request(
      {
        method: body === undefined ? 'GET' : 'POST',
        url: 'https://business-api.tiktok.com/open_api/v1.3/' + path,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Access-Token': token } : {}),
        },
        params,
        data: body,
      },
      schema,
      effect,
    );
  }
  private token(raw: z.infer<typeof remoteToken>): TikTokToken {
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      openId: raw.open_id,
      expiresAt: Date.now() + raw.expires_in * 1000,
      refreshExpiresAt: Date.now() + raw.refresh_token_expires_in * 1000,
      scopes: raw.scope.split(',').map((s) => s.trim()),
      appId: this.config.env.TIKTOK_BUSINESS_APP_ID,
    };
  }
  async exchange(code: string) {
    return this.token(
      await this.request(
        'tt_user/oauth2/token/',
        remoteToken,
        undefined,
        {
          client_id: this.config.env.TIKTOK_BUSINESS_APP_ID,
          client_secret: this.config.env.TIKTOK_BUSINESS_APP_SECRET,
          grant_type: 'authorization_code',
          auth_code: code,
          redirect_uri: this.config.env.TIKTOK_BUSINESS_REDIRECT_URI,
        },
        'token',
      ),
    );
  }
  async refresh(token: TikTokToken) {
    return this.token(
      await this.request(
        'tt_user/oauth2/refresh_token/',
        remoteToken,
        undefined,
        {
          client_id: this.config.env.TIKTOK_BUSINESS_APP_ID,
          client_secret: this.config.env.TIKTOK_BUSINESS_APP_SECRET,
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        },
        'token',
      ),
    );
  }
  async identities(token: TikTokToken): Promise<TikTokIdentity[]> {
    const info = await this.request(
      'tt_user/token_info/get/',
      z.object({ app_id: id, creator_id: id, scope: z.string() }),
      undefined,
      {
        app_id: this.config.env.TIKTOK_BUSINESS_APP_ID,
        access_token: token.accessToken,
      },
    );
    if (
      info.app_id !== this.config.env.TIKTOK_BUSINESS_APP_ID ||
      info.creator_id !== token.openId
    )
      throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
    if (
      BUSINESS_SCOPES.some(
        (scope) =>
          !info.scope
            .split(',')
            .map((s) => s.trim())
            .includes(scope),
      )
    )
      throw new TikTokError('TIKTOK_PERMISSION_DENIED');
    const profile = await this.request(
      'business/get/',
      z.object({
        has_advanced_access: z.boolean(),
        is_business_account: z.boolean().optional(),
        display_name: z.string().optional(),
        profile_image: z.string().optional(),
      }),
      token.accessToken,
      undefined,
      'read',
      {
        business_id: token.openId,
        fields: JSON.stringify([
          'has_advanced_access',
          'is_business_account',
          'display_name',
          'profile_image',
        ]),
      },
    );
    if (!profile.has_advanced_access)
      throw new TikTokError('TIKTOK_ACCOUNT_NOT_ELIGIBLE');
    return [
      {
        id: token.openId,
        name: profile.display_name || token.openId,
        avatarUrl: mediaUrl(profile.profile_image) ?? null,
        region: null,
      },
    ];
  }
  async verify(token: TikTokToken, identity: TikTokIdentity) {
    if (
      token.openId !== identity.id ||
      BUSINESS_SCOPES.some((s) => !token.scopes.includes(s))
    )
      throw new TikTokError('TIKTOK_PERMISSION_DENIED');
    await this.conversations(token, null);
    return {
      receiveMessages: true,
      sendMessages: true,
      syncConversations: true,
      readReceipts: true,
    };
  }
  async subscribe(_token: TikTokToken, callback: string) {
    const result = await this.request(
      'business/webhook/update/',
      z.object({
        app_id: id,
        event_type: z.literal('DIRECT_MESSAGE'),
        callback_url: z.string(),
      }),
      undefined,
      {
        app_id: this.config.env.TIKTOK_BUSINESS_APP_ID,
        secret: this.config.env.TIKTOK_BUSINESS_APP_SECRET,
        event_type: 'DIRECT_MESSAGE',
        callback_url: callback,
      },
      'subscription',
    );
    if (
      result.app_id !== this.config.env.TIKTOK_BUSINESS_APP_ID ||
      result.callback_url !== callback
    )
      throw new TikTokError('TIKTOK_WEBHOOK_INVALID');
  }
  async conversations(token: TikTokToken, cursor?: string | null) {
    const position = cursor
      ? z
          .object({
            type: z.enum(['SINGLE', 'STRANGER']),
            cursor: z.number().int().nonnegative(),
          })
          .parse(JSON.parse(cursor))
      : { type: 'SINGLE' as const, cursor: 0 };
    const result = await this.request(
      'business/message/conversation/list/',
      z.object({
        conversations: z
          .array(
            z.object({ conversation_id: id, update_time: z.number().int() }),
          )
          .max(100),
        has_more: z.boolean(),
        cursor: z.number().int().nonnegative().optional(),
      }),
      token.accessToken,
      undefined,
      'read',
      {
        business_id: requiredId(token.openId),
        conversation_type: position.type,
        limit: 25,
        cursor: position.cursor,
      },
    );
    const after = result.has_more
      ? nextCursor(true, result.cursor, String(position.cursor))
      : null;
    return {
      items: result.conversations.map((c) => ({
        id: c.conversation_id,
        updatedAt: new Date(c.update_time),
      })),
      cursor: after
        ? JSON.stringify({ type: position.type, cursor: Number(after) })
        : position.type === 'SINGLE'
          ? JSON.stringify({ type: 'STRANGER', cursor: 0 })
          : null,
    };
  }
  async messages(token: TikTokToken, conversationId: string) {
    const result = await this.request(
      'business/message/content/list/',
      z.object({
        messages: z.array(businessMessageSchema).max(20),
        participants: z
          .array(
            z.object({
              id,
              role: z.string(),
              display_name: z.string().optional(),
              profile_image: z.string().optional(),
            }),
          )
          .optional(),
      }),
      token.accessToken,
      undefined,
      'read',
      {
        business_id: token.openId,
        conversation_id: requiredId(conversationId),
      },
    );
    return {
      items: result.messages.map((m) => {
        if (m.conversation_id !== conversationId)
          throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
        const normalized = mapBusinessMessage(m, token.openId);
        const contact = result.participants?.find(
          (p) => p.role === 'PERSONAL_ACCOUNT',
        );
        return {
          ...normalized,
          ...(contact
            ? {
                name: contact.display_name,
                avatar: mediaUrl(contact.profile_image),
                contactId: contact.id,
              }
            : {}),
        };
      }),
      cursor: null,
    };
  }
  async sendText(token: TikTokToken, conversationId: string, text: string) {
    if (!text.trim() || text.length > 2000)
      throw new TikTokError('TIKTOK_INVALID_REQUEST');
    const result = await this.request(
      'business/message/send/',
      z.object({ message_id: id }),
      token.accessToken,
      {
        business_id: token.openId,
        recipient_type: 'CONVERSATION',
        recipient: requiredId(conversationId),
        message_type: 'TEXT',
        text: { body: text },
      },
      'send',
    );
    return result.message_id;
  }
}
