import { z } from 'zod';
import { deliveryStatusSchema } from './personal.js';
import { channelTypeSchema } from './facebook.js';

export const paginationSchema = z.object({
  cursor: z.string().max(1000).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const conversationFilterSchema = paginationSchema.extend({
  channelType: channelTypeSchema.optional(),
  account: z
    .string()
    .max(160)
    .regex(/^(personal|oa|facebook-page|facebook-personal):[a-z0-9]+$/)
    .optional(),
});
export const inboxAccountSchema = z.object({
  key: z.string(),
  id: z.string(),
  channelType: channelTypeSchema,
  name: z.string(),
  externalAccountId: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.string(),
  conversationCount: z.number().int().nonnegative(),
});
export const inboxAccountsSchema = z.object({
  accounts: z.array(inboxAccountSchema),
});
export const loginSchema = z.object({ password: z.string().min(1).max(256) });
export const connectionSchema = z.object({
  id: z.string(),
  oaId: z.string(),
  oaName: z.string(),
  avatarUrl: z.string().nullable(),
  status: z.enum(['CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED']),
  tokenExpiresAt: z.string(),
});
export const statusSchema = z.object({
  configured: z.boolean(),
  webhookConfigured: z.boolean(),
  connection: connectionSchema.nullable(),
  failedWebhookCount: z.number().int().nonnegative(),
});
export const attachmentSchema = z.object({
  type: z.string(),
  url: z.string().nullable(),
  name: z.string().nullable(),
  previewUrl: z.string().nullable().optional(),
});
export const messageSchema = z.object({
  id: z.string(),
  externalMessageId: z.string().nullable(),
  deliveryStatus: deliveryStatusSchema.optional(),
  deliveryError: z.string().nullable().optional(),
  idempotencyKey: z.string().nullable().optional(),
  direction: z.enum(['INCOMING', 'OUTGOING']),
  type: z.string(),
  content: z.string(),
  sentAt: z.string(),
  deliveredAt: z.string().nullable().optional(),
  readAt: z.string().nullable().optional(),
  source: z.enum(['WEBHOOK', 'HISTORY', 'PERSONAL', 'FACEBOOK']),
  attachments: z.array(attachmentSchema),
});
export const conversationSchema = z.object({
  id: z.string(),
  connectionId: z.string().nullable(),
  channelAccountId: z.string().nullable().optional(),
  channelType: channelTypeSchema.optional(),
  sendBlockedReason: z.string().nullable().optional(),
  messagingWindowExpiresAt: z.string().nullable().optional(),
  accountName: z.string().optional(),
  accountAvatar: z.string().nullable().optional(),
  accountExternalId: z.string().nullable().optional(),
  canSend: z.boolean().optional(),
  externalUserId: z.string(),
  customerName: z.string().nullable(),
  customerAvatar: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
});
export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number(),
    limit: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable().optional(),
  });
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type Connection = z.infer<typeof connectionSchema>;
export type ConnectionStatus = z.infer<typeof statusSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type InboxMessage = z.infer<typeof messageSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export type ConversationFilter = z.infer<typeof conversationFilterSchema>;
export type InboxAccount = z.infer<typeof inboxAccountSchema>;
export type Paginated<T> = {
  items: T[];
  page: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string | null;
};
