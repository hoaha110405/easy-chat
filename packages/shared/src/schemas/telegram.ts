import { z } from 'zod';
import { channelAccountSchema } from './facebook.js';
export const telegramAuthorizationSchema = z.object({
  state: z.string(),
  tdlibState: z.string(),
  confirmationLink: z.string().optional(),
  passwordHint: z.string().optional(),
  codeDelivery: z.string().optional(),
});
export const telegramAccountSchema = channelAccountSchema.extend({
  capabilities: z.object({
    receiveMessages: z.boolean(),
    sendMessages: z.boolean(),
    syncConversations: z.boolean(),
    readReceipts: z.boolean(),
  }),
  authorization: telegramAuthorizationSchema.nullable(),
  rateLimitedUntil: z.string().nullable(),
});
export const telegramStatusSchema = z.object({
  channelType: z.enum(['TELEGRAM_BOT', 'TELEGRAM_PERSONAL']),
  enabled: z.boolean(),
  configured: z.boolean(),
  nativeAvailable: z.boolean(),
  workerOnline: z.boolean(),
  accounts: z.array(telegramAccountSchema),
  restrictions: z.array(z.string()),
});
export const telegramAuthInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('phone'),
    value: z.string().regex(/^\+[1-9]\d{5,18}$/),
  }),
  z.object({ action: z.literal('code'), value: z.string().min(1).max(128) }),
  z.object({
    action: z.literal('password'),
    value: z.string().min(1).max(256),
  }),
  z.object({ action: z.literal('email'), value: z.string().email().max(254) }),
  z.object({
    action: z.literal('email_code'),
    value: z.string().min(1).max(128),
  }),
  z.object({ action: z.literal('qr') }),
]);
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;
export type TelegramAuthInput = z.infer<typeof telegramAuthInputSchema>;
