import { z } from 'zod';
import JSONbig from 'json-bigint';
export const telegramJson = JSONbig({
  storeAsString: true,
  useNativeBigInt: true,
});
export const telegramTypeSchema = z.enum(['TELEGRAM_BOT', 'TELEGRAM_PERSONAL']);
export type TelegramType = z.infer<typeof telegramTypeSchema>;
export const telegramId = z.preprocess(
  (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v),
  z.string().regex(/^-?\d{1,20}$/),
);
export const unsignedId = telegramId.refine((v) => BigInt(v) > 0n);
export const botTokenSchema = z
  .string()
  .regex(/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/);
export const botCredentialsSchema = z.object({
  token: botTokenSchema,
  webhookSecret: z.string().min(32).max(256),
});
export const personalCredentialsSchema = z.object({
  databaseKey: z.string().min(40).max(100),
  apiId: z.number().int().positive(),
  loginSessionId: z.string().optional(),
  loginExpiresAt: z.number().optional(),
});
export type TelegramMessage = {
  chatId: string;
  id: string;
  senderId: string;
  senderName?: string;
  direction: 'INCOMING' | 'OUTGOING';
  type: string;
  content: string;
  at: Date;
  editedAt?: Date;
  title?: string;
  chatType?: string;
  topic?: boolean;
  media?: { fileId: string; name?: string; mimeType?: string };
};
export const telegramMessageKey = (chatId: string, messageId: string) =>
  `${telegramId.parse(chatId)}:${telegramId.parse(messageId)}`;
export function tdNumber(id: string) {
  return BigInt(telegramId.parse(id));
}
export class TelegramError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous = false,
    readonly retryAfter: number | null = null,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'TelegramError';
  }
}
export function tdError(
  error: { code?: unknown; message?: unknown },
  effect: 'read' | 'send' | 'auth' = 'read',
) {
  const number = Number(error.code);
  if (number === 406) return new TelegramError('TELEGRAM_REQUEST_REJECTED');
  if (number === 404) return new TelegramError('TELEGRAM_NOT_FOUND');
  const text = typeof error.message === 'string' ? error.message : '';
  const flood =
    /(?:FLOOD_WAIT_|retry after |Too Many Requests: retry after )(\d+)/i.exec(
      text,
    );
  if (number === 429 || flood)
    return new TelegramError(
      'TELEGRAM_RATE_LIMITED',
      false,
      Math.min(86400, Math.max(1, Number(flood?.[1] ?? 30))),
      effect !== 'auth',
    );
  if (number === 401) return new TelegramError('TELEGRAM_REAUTH_REQUIRED');
  if (number === 403) return new TelegramError('TELEGRAM_PERMISSION_DENIED');
  if (/PHONE_CODE_INVALID|EMAIL_CODE_INVALID|PASSWORD_HASH_INVALID/.test(text))
    return new TelegramError('TELEGRAM_AUTH_INPUT_INVALID');
  if (/PHONE_CODE_EXPIRED/.test(text))
    return new TelegramError('TELEGRAM_AUTH_CODE_EXPIRED');
  return new TelegramError(
    effect === 'send' && number >= 500
      ? 'TELEGRAM_SEND_UNKNOWN'
      : 'TELEGRAM_REQUEST_REJECTED',
    effect === 'send' && number >= 500,
    null,
    effect === 'read' && number >= 500,
  );
}
