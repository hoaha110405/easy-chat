import { z } from 'zod';
import { channelAccountSchema } from './facebook.js';
export const whatsappMetadataSchema = z.object({
  wabaId: z.string(),
  phoneNumberId: z.string(),
  displayPhoneNumber: z.string(),
  verifiedName: z.string(),
  businessName: z.string(),
  onboardingMode: z.enum(['DIRECT', 'EMBEDDED']),
  webhookVerifiedAt: z.string(),
  lastWebhookAt: z.string().optional(),
  isOnBizApp: z.boolean(),
});
export const whatsappAccountSchema = channelAccountSchema.extend({
  tokenExpiresAt: z.string().nullable(),
  metadata: whatsappMetadataSchema.nullable(),
  capabilities: z.object({
    receiveMessages: z.boolean(),
    sendMessages: z.boolean(),
    syncConversations: z.boolean(),
    readReceipts: z.boolean(),
    templates: z.boolean(),
    providerMarkRead: z.boolean(),
    coexistence: z.boolean(),
  }),
});
export const whatsappStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  embeddedAvailable: z.boolean(),
  embeddedStatus: z.string(),
  workerOnline: z.boolean(),
  accounts: z.array(whatsappAccountSchema),
  selection: z
    .object({
      id: z.string(),
      wabaIds: z.array(z.string()),
      expiresAt: z.string(),
    })
    .nullable(),
  restrictions: z.array(z.string()),
});
export const whatsappTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  supported: z.boolean(),
  reason: z.string().nullable(),
  variables: z.array(
    z.object({ component: z.enum(['header', 'body']), name: z.string() }),
  ),
  components: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      format: z.string().optional(),
    }),
  ),
});
export const whatsappTemplatesSchema = z.object({
  items: z.array(whatsappTemplateSchema),
  nextCursor: z.string().nullable(),
});
export const whatsappTemplateInputSchema = z.object({
  templateId: z.string().regex(/^\d{1,30}$/),
  templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(1).max(30),
  parameters: z
    .array(
      z.object({
        component: z.enum(['header', 'body']),
        name: z.string().max(100),
        value: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .refine((v) => !/[\r\n\t]/.test(v)),
      }),
    )
    .max(40),
  optInConfirmed: z.literal(true),
  idempotencyKey: z.string().uuid(),
});
export const whatsappMediaInputSchema = z.object({
  kind: z.enum(['document', 'audio']),
  caption: z.string().trim().max(1024).default(''),
  idempotencyKey: z.string().uuid(),
});
export const whatsappBeginSchema = z.object({
  authorizationId: z.string(),
  state: z.string(),
  appId: z.string(),
  configId: z.string(),
  graphVersion: z.string(),
});
export const whatsappPhonesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      displayPhoneNumber: z.string(),
      verifiedName: z.string(),
      status: z.string(),
      platformType: z.string(),
      coexistence: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type WhatsAppStatus = z.infer<typeof whatsappStatusSchema>;
export type WhatsAppTemplate = z.infer<typeof whatsappTemplateSchema>;
