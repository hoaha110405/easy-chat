import { z } from 'zod';
export const tiktokTypeSchema = z.enum(['TIKTOK_BUSINESS', 'TIKTOK_SHOP']);
export type TikTokType = z.infer<typeof tiktokTypeSchema>;
export const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  openId: z.string().min(1),
  expiresAt: z.number().finite(),
  refreshExpiresAt: z.number().finite(),
  scopes: z.array(z.string()),
  appId: z.string(),
  shopCipher: z.string().optional(),
});
export type TikTokToken = z.infer<typeof tokenSchema>;
export type TikTokIdentity = {
  id: string;
  name: string;
  avatarUrl: string | null;
  region: string | null;
  cipher?: string;
};
export type TikTokMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  direction: 'INCOMING' | 'OUTGOING';
  type: string;
  content: string;
  at: Date;
  name?: string;
  avatar?: string;
  contactId?: string;
  attachments: {
    type: string;
    payload: { url?: string; previewUrl?: string };
  }[];
};
export type TikTokConversation = {
  id: string;
  name?: string;
  avatar?: string;
  contactId?: string;
  unreadCount?: number;
  canSend?: boolean;
  updatedAt?: Date;
  latest?: TikTokMessage;
};
export type TikTokPage<T> = { items: T[]; cursor: string | null };
export const capabilitiesSchema = z.object({
  receiveMessages: z.boolean().default(false),
  sendMessages: z.boolean().default(false),
  syncConversations: z.boolean().default(false),
  readReceipts: z.boolean().default(false),
});
export type TikTokCapabilities = z.infer<typeof capabilitiesSchema>;
export const noCapabilities: TikTokCapabilities = {
  receiveMessages: false,
  sendMessages: false,
  syncConversations: false,
  readReceipts: false,
};
export interface TikTokAdapter {
  type: TikTokType;
  exchange(code: string): Promise<TikTokToken>;
  refresh(token: TikTokToken): Promise<TikTokToken>;
  identities(token: TikTokToken): Promise<TikTokIdentity[]>;
  verify(
    token: TikTokToken,
    identity: TikTokIdentity,
  ): Promise<TikTokCapabilities>;
  subscribe(token: TikTokToken, callback: string): Promise<void>;
  conversations(
    token: TikTokToken,
    cursor?: string | null,
  ): Promise<TikTokPage<TikTokConversation>>;
  messages(
    token: TikTokToken,
    conversationId: string,
    cursor?: string | null,
  ): Promise<TikTokPage<TikTokMessage>>;
  sendText(
    token: TikTokToken,
    conversationId: string,
    text: string,
  ): Promise<string>;
}
