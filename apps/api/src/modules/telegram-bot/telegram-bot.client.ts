import { Injectable } from '@nestjs/common';
import axios, { type AxiosRequestConfig } from 'axios';
import { z } from 'zod';
import {
  botTokenSchema,
  telegramId,
  unsignedId,
  telegramJson,
  TelegramError,
  type TelegramMessage,
} from '../telegram/telegram.types';
export interface BotTransport {
  request(
    config: AxiosRequestConfig,
  ): Promise<{ status: number; data: unknown }>;
}
export const botUserSchema = z.object({
  id: unsignedId,
  is_bot: z.literal(true),
  first_name: z.string(),
  username: z.string().optional(),
  can_read_all_group_messages: z.boolean().optional(),
});
const person = z.object({
  id: telegramId,
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
export const botMessageSchema = z.object({
  message_id: unsignedId,
  date: z.number().int().positive(),
  chat: z.object({
    id: telegramId,
    type: z.enum(['private', 'group', 'supergroup', 'channel']),
    title: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  }),
  from: person.optional(),
  sender_chat: z
    .object({ id: telegramId, title: z.string().optional() })
    .optional(),
  text: z.string().max(100000).optional(),
  caption: z.string().max(100000).optional(),
  edit_date: z.number().int().optional(),
  message_thread_id: telegramId.optional(),
  is_topic_message: z.boolean().optional(),
  photo: z
    .array(
      z.object({ file_id: z.string(), width: z.number(), height: z.number() }),
    )
    .max(20)
    .optional(),
  document: z
    .object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
    })
    .optional(),
  audio: z
    .object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().optional(),
    })
    .optional(),
  voice: z
    .object({
      file_id: z.string(),
      mime_type: z.string().optional(),
      file_size: z.number().optional(),
    })
    .optional(),
  sticker: z
    .object({ file_id: z.string(), emoji: z.string().optional() })
    .optional(),
});
export function mapBotMessage(value: unknown, ownId: string): TelegramMessage {
  const m = botMessageSchema.parse(value);
  const photo = m.photo?.at(-1);
  const audio = m.audio ?? m.voice;
  const fullName = (p: {
    first_name?: string;
    last_name?: string;
    username?: string;
  }) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username;
  return {
    chatId: m.chat.id,
    id: m.message_id,
    senderId: m.from?.id ?? m.sender_chat?.id ?? m.chat.id,
    senderName: m.sender_chat?.title ?? (m.from ? fullName(m.from) : undefined),
    direction: m.from?.id === ownId ? 'OUTGOING' : 'INCOMING',
    type:
      m.text !== undefined
        ? 'text'
        : photo
          ? 'image'
          : audio
            ? 'audio'
            : m.document
              ? 'file'
              : m.sticker
                ? 'sticker'
                : 'unsupported',
    content: m.text ?? m.caption ?? m.sticker?.emoji ?? '',
    at: new Date(m.date * 1000),
    ...(m.edit_date ? { editedAt: new Date(m.edit_date * 1000) } : {}),
    title: m.chat.title ?? fullName(m.chat),
    chatType: m.chat.type,
    topic: m.is_topic_message === true || m.message_thread_id !== undefined,
    ...(audio
      ? {
          media: {
            fileId: audio.file_id,
            name: m.audio?.file_name,
            mimeType: audio.mime_type,
          },
        }
      : photo
        ? { media: { fileId: photo.file_id } }
        : m.document
          ? {
              media: {
                fileId: m.document.file_id,
                name: m.document.file_name,
                mimeType: m.document.mime_type,
              },
            }
          : m.sticker
            ? { media: { fileId: m.sticker.file_id } }
            : {}),
  };
}
@Injectable()
export class TelegramBotClient {
  constructor(private readonly transport: BotTransport = axios) {}
  async call<T extends z.ZodTypeAny>(
    token: string,
    method:
      | 'getMe'
      | 'setWebhook'
      | 'getWebhookInfo'
      | 'deleteWebhook'
      | 'sendMessage'
      | 'sendDocument'
      | 'sendAudio'
      | 'getFile',
    schema: T,
    body: unknown = {},
    send = false,
  ): Promise<z.output<T>> {
    botTokenSchema.parse(token);
    let response: { status: number; data: unknown };
    try {
      response = await this.transport.request({
        method: 'POST',
        url: `https://api.telegram.org/bot${token}/${method}`,
        data: body,
        headers:
          body instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' },
        timeout: body instanceof FormData ? 30000 : 8000,
        signal: AbortSignal.timeout(body instanceof FormData ? 30000 : 8000),
        maxBodyLength: 20_000_000 + 65536,
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        proxy: false,
        responseType: 'text',
        transformResponse: [
          (value: unknown) =>
            typeof value === 'string' ? telegramJson.parse(value) : value,
        ],
        validateStatus: () => true,
      });
    } catch {
      throw new TelegramError(
        send ? 'TELEGRAM_SEND_UNKNOWN' : 'TELEGRAM_UNAVAILABLE',
        send,
        null,
        !send,
      );
    }
    const envelope = z
      .object({
        ok: z.boolean(),
        result: z.unknown().optional(),
        error_code: z.number().optional(),
        parameters: z
          .object({
            retry_after: z.number().int().positive().optional(),
            migrate_to_chat_id: telegramId.optional(),
          })
          .optional(),
      })
      .safeParse(response.data);
    if (envelope.success && !envelope.data.ok) {
      const code = envelope.data.error_code;
      if (code === 429)
        throw new TelegramError(
          'TELEGRAM_RATE_LIMITED',
          false,
          Math.min(envelope.data.parameters?.retry_after ?? 30, 86400),
          true,
        );
      if (code === 401) throw new TelegramError('TELEGRAM_REAUTH_REQUIRED');
      if (code === 403) throw new TelegramError('TELEGRAM_PERMISSION_DENIED');
      if (envelope.data.parameters?.migrate_to_chat_id)
        throw new TelegramError('TELEGRAM_CHAT_MIGRATED');
      throw new TelegramError(
        send && (response.status >= 500 || (code ?? 0) >= 500)
          ? 'TELEGRAM_SEND_UNKNOWN'
          : 'TELEGRAM_REQUEST_REJECTED',
        send && (response.status >= 500 || (code ?? 0) >= 500),
        null,
        !send && response.status >= 500,
      );
    }
    if (!envelope.success || response.status < 200 || response.status >= 300)
      throw new TelegramError(
        send ? 'TELEGRAM_SEND_UNKNOWN' : 'TELEGRAM_UNAVAILABLE',
        send,
        null,
        !send && response.status >= 500,
      );
    const parsed = schema.safeParse(envelope.data.result);
    if (!parsed.success)
      throw new TelegramError(
        send ? 'TELEGRAM_SEND_UNKNOWN' : 'TELEGRAM_INVALID_RESPONSE',
        send,
      );
    return parsed.data;
  }
  getMe(token: string) {
    return this.call(token, 'getMe', botUserSchema);
  }
  setWebhook(token: string, url: string, secret: string) {
    return this.call(token, 'setWebhook', z.literal(true), {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      drop_pending_updates: false,
      max_connections: 10,
    });
  }
  webhookInfo(token: string) {
    return this.call(
      token,
      'getWebhookInfo',
      z.object({
        url: z.string(),
        pending_update_count: z.number().int().nonnegative(),
        last_error_date: z.number().optional(),
        allowed_updates: z.array(z.string()).optional(),
      }),
    );
  }
  deleteWebhook(token: string) {
    return this.call(token, 'deleteWebhook', z.literal(true), {
      drop_pending_updates: false,
    });
  }
  async sendMedia(
    token: string,
    chatId: string,
    file: { bytes: Buffer; name: string; mime: string },
    kind: 'document' | 'audio',
    caption: string,
  ) {
    const data = new FormData();
    data.set('chat_id', telegramId.parse(chatId));
    if (caption) data.set('caption', caption);
    data.set(
      kind,
      new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
      file.name,
    );
    const result = await this.call(
      token,
      kind === 'document' ? 'sendDocument' : 'sendAudio',
      botMessageSchema,
      data,
      true,
    );
    if (result.chat.id !== chatId || result.from?.id !== token.split(':')[0])
      throw new TelegramError('TELEGRAM_SEND_UNKNOWN', true);
    return result;
  }
  async download(token: string, fileId: string) {
    const file = await this.call(
      token,
      'getFile',
      z.object({
        file_id: z.string(),
        file_path: z.string(),
        file_size: z.number().int().nonnegative(),
      }),
      { file_id: z.string().min(1).max(4096).parse(fileId) },
    );
    if (
      file.file_id !== fileId ||
      file.file_size > 20_000_000 ||
      !/^[A-Za-z0-9_./-]{1,512}$/.test(file.file_path) ||
      file.file_path.split('/').some((v) => !v || v === '.' || v === '..')
    )
      throw new TelegramError('TELEGRAM_MEDIA_UNSUPPORTED');
    try {
      const r = await this.transport.request({
        method: 'GET',
        url: `https://api.telegram.org/file/bot${token}/${file.file_path}`,
        responseType: 'arraybuffer',
        timeout: 15000,
        signal: AbortSignal.timeout(15000),
        maxRedirects: 0,
        maxContentLength: 20_000_000,
        proxy: false,
        validateStatus: () => true,
      });
      if (
        r.status !== 200 ||
        !Buffer.isBuffer(r.data) ||
        r.data.length !== file.file_size ||
        r.data.length > 20_000_000
      )
        throw Error();
      return r.data;
    } catch {
      throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
    }
  }
  async sendText(token: string, chatId: string, content: string) {
    if (!content.trim() || content.length > 2000)
      throw new TelegramError('TELEGRAM_INVALID_REQUEST');
    const result = await this.call(
      token,
      'sendMessage',
      botMessageSchema,
      { chat_id: telegramId.parse(chatId), text: content },
      true,
    );
    if (result.chat.id !== chatId || result.from?.id !== token.split(':')[0])
      throw new TelegramError('TELEGRAM_SEND_UNKNOWN', true);
    return result;
  }
}
