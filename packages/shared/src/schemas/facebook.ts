import { z } from 'zod';
export const channelTypeSchema = z.enum([
  'ZALO_OA',
  'ZALO_PERSONAL',
  'FACEBOOK_PAGE',
  'FACEBOOK_PERSONAL',
  'TIKTOK_BUSINESS',
  'TIKTOK_SHOP',
  'TELEGRAM_BOT',
  'TELEGRAM_PERSONAL',
  'WHATSAPP_BUSINESS',
]);
export const channelAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  channelType: channelTypeSchema,
  connectionStatus: z.enum([
    'DISCONNECTED',
    'QR_PENDING',
    'CONNECTING',
    'CONNECTED',
    'RECONNECTING',
    'REAUTH_REQUIRED',
    'UNSUPPORTED',
    'PERMISSION_REQUIRED',
    'ERROR',
  ]),
  lastConnectedAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  syncComplete: z.boolean(),
  workerOnline: z.boolean(),
});
export const facebookAvailablePageSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
export const facebookPageStatusSchema = z.object({
  configured: z.boolean(),
  webhookConfigured: z.boolean(),
  workerOnline: z.boolean(),
  accounts: z.array(channelAccountSchema),
  availablePages: z.array(facebookAvailablePageSchema),
  selectionExpiresAt: z.string().nullable(),
});
export const facebookPersonalStatusSchema = z.object({
  enabled: z.boolean(),
  status: z.literal('UNSUPPORTED'),
  experimental: z.literal(true),
  reasonCode: z.literal('FACEBOOK_PERSONAL_UNSUPPORTED'),
  message: z.string(),
  capabilities: z.object({
    connect: z.literal(false),
    listConversations: z.literal(false),
    history: z.literal(false),
    receive: z.literal(false),
    sendText: z.literal(false),
    e2ee: z.literal(false),
  }),
  library: z.null(),
});
export const channelSyncResultSchema = z.object({ queued: z.boolean() });
export const facebookSelectPageSchema = z.object({
  pageId: z.string().regex(/^\d{1,128}$/),
});
export type ChannelAccountStatus = z.infer<typeof channelAccountSchema>;
export type FacebookPageStatus = z.infer<typeof facebookPageStatusSchema>;
