import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { TikTokRegistry } from './tiktok.registry';
import { tiktokTypeSchema, type TikTokType } from './tiktok.types';
import { mapBusinessMessage } from '../tiktok-business/tiktok-business.client';
import { mapShopMessage } from '../tiktok-shop/tiktok-shop.client';
const id = z.string().min(1).max(512);
const time = z
  .number()
  .int()
  .min(1262304000000)
  .refine((n) => n <= Date.now() + 300000);
const normalizedMessage = z.object({
  id,
  conversationId: id,
  senderId: id,
  direction: z.enum(['INCOMING', 'OUTGOING']),
  type: z.string().max(64),
  content: z.string().max(100000),
  at: time,
  name: z.string().max(1000).optional(),
  avatar: z.string().max(8192).optional(),
  contactId: id.optional(),
  attachments: z
    .array(
      z.object({
        type: z.string(),
        payload: z.object({
          url: z.string().max(8192).optional(),
          previewUrl: z.string().max(8192).optional(),
        }),
      }),
    )
    .max(100),
});
const base = z.object({
  channelType: tiktokTypeSchema,
  accountId: id,
  generation: z.number().int().nonnegative().optional(),
});
export const inboundSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('message'), message: normalizedMessage }),
  base.extend({ kind: z.literal('sync'), conversationId: id }),
  base.extend({
    kind: z.literal('read'),
    conversationId: id,
    at: time,
    watermark: time,
  }),
  base.extend({ kind: z.literal('revoked'), at: time.optional() }),
]);
export function verifyTikTokSignature(
  type: TikTokType,
  raw: Buffer,
  header: string | undefined,
  appId: string,
  secret: string,
  now = Date.now(),
) {
  const invalid = () =>
    new ApiError(
      401,
      'TIKTOK_WEBHOOK_INVALID',
      'Chữ ký webhook TikTok không hợp lệ.',
    );
  if (!header || !secret || !appId) throw invalid();
  let actual: string, expected: Buffer;
  if (type === 'TIKTOK_BUSINESS') {
    const parts = header.split(',').map((x) => x.trim());
    const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
    const signatures = parts
      .filter((p) => p.startsWith('s='))
      .map((p) => p.slice(2));
    if (
      !timestamp ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300
    )
      throw invalid();
    expected = createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(raw)
      .digest();
    if (
      !signatures.some(
        (s) =>
          /^[a-fA-F0-9]{64}$/.test(s) &&
          timingSafeEqual(expected, Buffer.from(s, 'hex')),
      )
    )
      throw invalid();
  } else {
    actual = header;
    if (!/^[a-fA-F0-9]{64}$/.test(actual)) throw invalid();
    expected = createHmac('sha256', secret).update(appId).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(actual, 'hex'))) throw invalid();
  }
}
export function normalizeTikTokWebhook(
  type: TikTokType,
  raw: Buffer,
  appId: string,
): { event: z.infer<typeof inboundSchema> | null; key: string } {
  const body: unknown = JSON.parse(raw.toString('utf8'));
  if (type === 'TIKTOK_BUSINESS') {
    const envelope = z
      .object({
        client_key: id,
        user_openid: id,
        event: z.string().max(100),
        content: z.string().max(900000),
        create_time: z.number().int(),
      })
      .parse(body);
    if (envelope.client_key !== appId)
      throw new ApiError(
        401,
        'TIKTOK_WEBHOOK_INVALID',
        'Webhook không thuộc ứng dụng đã cấu hình.',
      );
    const rawContent: unknown = JSON.parse(envelope.content);
    const base = { channelType: type, accountId: envelope.user_openid };
    if (envelope.event === 'im_receive_msg_eu') {
      const content = z.object({ conversation_id: id }).parse(rawContent);
      return {
        event: {
          ...base,
          kind: 'sync',
          conversationId: content.conversation_id,
        },
        key: hash(envelope.event + envelope.content),
      };
    }
    if (envelope.event === 'im_mark_read_msg') {
      const c = z
        .object({
          conversation_id: id,
          timestamp: time,
          from_user: z.object({ id, role: z.literal('personal_account') }),
          to_user: z.object({ id, role: z.literal('business_account') }),
          read: z.object({ last_read_timestamp: time }),
        })
        .parse(rawContent);
      if (c.to_user.id !== envelope.user_openid)
        throw new ApiError(
          401,
          'TIKTOK_WEBHOOK_INVALID',
          'Sai tài khoản nhận sự kiện.',
        );
      return {
        event: {
          ...base,
          kind: 'read',
          conversationId: c.conversation_id,
          at: c.timestamp,
          watermark: c.read.last_read_timestamp,
        },
        key: hash(envelope.event + envelope.content),
      };
    }
    if (!['im_receive_msg', 'im_send_msg'].includes(envelope.event))
      return { event: null, key: '' };
    const c = z
      .object({
        from_user: z.object({
          id,
          role: z.enum(['personal_account', 'business_account']),
        }),
        to_user: z.object({
          id,
          role: z.enum(['personal_account', 'business_account']),
        }),
        type: z.string(),
        conversation_id: id,
        message_id: id,
        timestamp: time,
        text: z.object({ body: z.string() }).optional(),
        sticker: z.object({ url: z.string() }).optional(),
        emoji: z.object({ url: z.string() }).optional(),
      })
      .parse(rawContent);
    if (
      (envelope.event === 'im_receive_msg' &&
        c.from_user.role !== 'personal_account') ||
      (envelope.event === 'im_send_msg' &&
        c.from_user.role !== 'business_account')
    )
      throw new ApiError(
        400,
        'TIKTOK_WEBHOOK_INVALID',
        'Vai trò người gửi không hợp lệ.',
      );
    const message = mapBusinessMessage(
      {
        ...c,
        message_type: c.type.toUpperCase(),
        from_user: { ...c.from_user, role: c.from_user.role.toUpperCase() },
        to_user: { ...c.to_user, role: c.to_user.role.toUpperCase() },
      },
      envelope.user_openid,
    );
    return {
      event: inboundSchema.parse({
        ...base,
        kind: 'message',
        message: { ...message, at: message.at.getTime() },
      }),
      key: envelope.event + ':' + message.id,
    };
  }
  const envelope = z
    .object({
      type: z.number().int(),
      shop_id: id,
      tts_notification_id: id.optional(),
      timestamp: z.number().int(),
      data: z.unknown(),
    })
    .parse(body);
  const base = { channelType: type, accountId: envelope.shop_id };
  if (envelope.type === 6)
    return {
      event: inboundSchema.parse({
        ...base,
        kind: 'revoked',
        at: envelope.timestamp * 1000,
      }),
      key: envelope.tts_notification_id ?? hash(raw.toString()),
    };
  if (envelope.type === 13) {
    const c = z.object({ conversation_id: id }).parse(envelope.data);
    return {
      event: { ...base, kind: 'sync', conversationId: c.conversation_id },
      key: envelope.tts_notification_id ?? hash(raw.toString()),
    };
  }
  if (envelope.type !== 14) return { event: null, key: '' };
  const conversation = z.object({ conversation_id: id }).parse(envelope.data);
  const m = mapShopMessage(envelope.data, conversation.conversation_id);
  return {
    event: m
      ? inboundSchema.parse({
          ...base,
          kind: 'message',
          message: { ...m, at: m.at.getTime() },
        })
      : null,
    key: envelope.tts_notification_id ?? 'message:' + m?.id,
  };
}
@Injectable()
export class TikTokWebhookService {
  constructor(
    private readonly db: PrismaService,
    private readonly registry: TikTokRegistry,
  ) {}
  async receive(type: TikTokType, raw: Buffer | undefined, signature?: string) {
    if (!this.registry.configured(type))
      throw new ApiError(
        503,
        'TIKTOK_NOT_CONFIGURED',
        'TikTok chưa được cấu hình.',
      );
    if (!raw?.length || raw.length > 1024 * 1024)
      throw new ApiError(
        400,
        'TIKTOK_WEBHOOK_INVALID',
        'Webhook vượt giới hạn hoặc không có raw body.',
      );
    const settings = this.registry.settings(type);
    verifyTikTokSignature(
      type,
      raw,
      signature,
      settings.appId,
      settings.secret,
    );
    let normalized: ReturnType<typeof normalizeTikTokWebhook>;
    try {
      normalized = normalizeTikTokWebhook(type, raw, settings.appId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        400,
        'TIKTOK_WEBHOOK_INVALID',
        'Payload webhook không hợp lệ.',
      );
    }
    if (!normalized.event) return { accepted: 0 };
    const payload = normalized.event;
    const accounts = await this.db.channelAccount.findMany({
      where: {
        channelType: type,
        externalAccountId: payload.accountId,
        connectionStatus: {
          in: ['CONNECTED', 'REAUTH_REQUIRED', 'PERMISSION_REQUIRED'],
        },
      },
      select: { id: true, generation: true },
    });
    return this.db.$transaction(async (tx) => {
      const inserted = await tx.webhookEvent.createMany({
        data: accounts.map((a) => ({
          channelAccountId: a.id,
          eventName: 'tiktok.' + type,
          digest: hash(type + ':' + a.id + ':' + normalized.key),
          payload: {
            ...payload,
            generation: a.generation,
          } as Prisma.InputJsonObject,
        })),
        skipDuplicates: true,
      });
      return { accepted: inserted.count };
    });
  }
}
