import { z } from 'zod';
import { channelAccountSchema } from './facebook.js';
export const tiktokCapabilitiesSchema = z.object({
  receiveMessages: z.boolean(),
  sendMessages: z.boolean(),
  syncConversations: z.boolean(),
  readReceipts: z.boolean(),
});
export const tiktokStatusSchema = z.object({
  channelType: z.enum(['TIKTOK_BUSINESS', 'TIKTOK_SHOP']),
  enabled: z.boolean(),
  configured: z.boolean(),
  workerOnline: z.boolean(),
  status: z.enum(['NOT_CONNECTED', 'CONNECTED']),
  approvalStatus: z.enum(['VERIFIED', 'UNVERIFIED']),
  accounts: z.array(
    channelAccountSchema.extend({
      capabilities: tiktokCapabilitiesSchema,
      tokenExpiresAt: z.string().nullable(),
    }),
  ),
  selection: z
    .object({
      id: z.string(),
      expiresAt: z.string(),
      accounts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          avatarUrl: z.string().nullable(),
          region: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  restrictions: z.array(z.string()),
});
export type TikTokStatus = z.infer<typeof tiktokStatusSchema>;
