import { z } from 'zod';
export const personalConnectionStateSchema = z.enum([
  'DISCONNECTED',
  'QR_PENDING',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'REAUTH_REQUIRED',
  'ERROR',
]);
export const deliveryStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'UNKNOWN',
]);
export const personalAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable().optional(),
  externalAccountId: z.string().nullable(),
  connectionStatus: personalConnectionStateSchema,
  qrStatus: z.enum([
    'NONE',
    'GENERATED',
    'SCANNED',
    'EXPIRED',
    'DECLINED',
    'CANCELLED',
  ]),
  qrImage: z.string().nullable(),
  qrExpiresAt: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  workerOnline: z.boolean(),
});
export const personalAccountsSchema = z.object({
  enabled: z.boolean(),
  workerOnline: z.boolean(),
  accounts: z.array(personalAccountSchema),
});
export const createPersonalAccountSchema = z.object({
  name: z.string().trim().min(1).max(80).default('Zalo Personal'),
});
export const sendTextSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().uuid(),
});
export const realtimeEventSchema = z.object({
  type: z.enum([
    'ready',
    'channel.qr_ready',
    'channel.qr_scanned',
    'channel.qr_expired',
    'channel.qr_declined',
    'channel.connected',
    'channel.disconnected',
    'channel.reauth_required',
    'channel.error',
    'message.created',
    'message.status_changed',
    'message.updated',
    'conversation.updated',
    'channel.sync_failed',
  ]),
  channelAccountId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
});
export type PersonalAccount = z.infer<typeof personalAccountSchema>;
export type SendText = z.infer<typeof sendTextSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
