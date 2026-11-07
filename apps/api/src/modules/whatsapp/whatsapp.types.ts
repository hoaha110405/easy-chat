import { z } from 'zod';
import JSONbig from 'json-bigint';
export const waJson = JSONbig({ storeAsString: true, useNativeBigInt: true });
export const waId = z.string().regex(/^\d{1,30}$/);
export const waRecipient = z.string().regex(/^[1-9]\d{5,19}$/);
export const waMid = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.:+/=-]+$/);
export const waCredentials = z.object({
  accessToken: z.string().min(10).max(16384),
  appId: waId,
  wabaId: waId,
  phoneNumberId: waId,
  scopes: z.array(z.string()),
  expiresAt: z.number().nullable(),
});
export type WaCredentials = z.infer<typeof waCredentials>;
export const waMetadata = z.object({
  wabaId: waId,
  phoneNumberId: waId,
  displayPhoneNumber: z.string(),
  verifiedName: z.string(),
  businessName: z.string(),
  onboardingMode: z.enum(['DIRECT', 'EMBEDDED']),
  webhookVerifiedAt: z.string(),
  isOnBizApp: z.boolean().default(false),
  lastWebhookAt: z.string().optional(),
});
export class WhatsAppError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous = false,
    readonly retryAfter: number | null = null,
    readonly retryable = false,
    readonly providerCode: number | null = null,
    readonly traceId: string | null = null,
  ) {
    super(code);
    this.name = 'WhatsAppError';
  }
}
export function waFailure(
  code: number,
  httpStatus: number,
  effect: 'read' | 'send' | 'write',
  after = 30,
  traceId: string | null = null,
) {
  if (code === 190 || code === 102)
    return new WhatsAppError(
      'WHATSAPP_REAUTH_REQUIRED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if ([10, 200, 131005].includes(code))
    return new WhatsAppError(
      'WHATSAPP_PERMISSION_REQUIRED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if (code === 131047)
    return new WhatsAppError(
      'WHATSAPP_WINDOW_CLOSED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if (
    [130429, 131048, 131056, 4, 17, 32, 613, 80007].includes(code) ||
    httpStatus === 429
  )
    return new WhatsAppError(
      'WHATSAPP_RATE_LIMITED',
      false,
      Math.min(86400, Math.max(1, after)),
      effect !== 'write' && code !== 131048,
      code,
      traceId,
    );
  if ([131026, 131049, 131050, 131051].includes(code))
    return new WhatsAppError(
      'WHATSAPP_RECIPIENT_RESTRICTED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if (code === 133010)
    return new WhatsAppError(
      'WHATSAPP_REGISTRATION_REQUIRED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if (code >= 132000 && code < 133000)
    return new WhatsAppError(
      'WHATSAPP_TEMPLATE_REJECTED',
      false,
      null,
      false,
      code,
      traceId,
    );
  if (httpStatus >= 500 || [1, 2, 131000, 131016].includes(code))
    return new WhatsAppError(
      effect === 'send' ? 'WHATSAPP_SEND_UNKNOWN' : 'WHATSAPP_UNAVAILABLE',
      effect === 'send',
      null,
      effect === 'read',
      code,
      traceId,
    );
  return new WhatsAppError(
    'WHATSAPP_REQUEST_REJECTED',
    false,
    null,
    false,
    code,
    traceId,
  );
}
export const waMediaSchema = z.object({
  id: waId,
  mime_type: z.string().max(200),
  sha256: z.string().max(128).optional(),
  caption: z.string().max(100000).optional(),
  filename: z.string().max(500).optional(),
});
export const waMessageSchema = z.object({
  id: waMid,
  from: waRecipient.optional(),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().max(100),
  text: z.object({ body: z.string().max(100000) }).optional(),
  image: waMediaSchema.optional(),
  document: waMediaSchema.optional(),
  audio: waMediaSchema.optional(),
  video: waMediaSchema.optional(),
  sticker: waMediaSchema.optional(),
  context: z
    .object({ id: waMid.optional(), from: z.string().optional() })
    .optional(),
  button: z.object({ text: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string() }).optional(),
      list_reply: z.object({ title: z.string() }).optional(),
    })
    .optional(),
  group_id: z.string().optional(),
});
export const waStatusSchema = z.object({
  id: waMid,
  status: z.enum(['sent', 'delivered', 'read', 'failed', 'deleted']),
  timestamp: z.string().regex(/^\d{1,12}$/),
  recipient_id: z.string().min(1).max(512).optional(),
  recipient_type: z.string().optional(),
  biz_opaque_callback_data: z.string().max(512).optional(),
  errors: z
    .array(z.object({ code: z.number().int() }))
    .max(20)
    .optional(),
  group_id: z.string().optional(),
});
export const waTemplateSchema = z.object({
  id: waId,
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().max(30),
  category: z.string().max(100),
  status: z.string().max(100),
  parameter_format: z.enum(['POSITIONAL', 'NAMED']).optional(),
  components: z
    .array(
      z
        .object({
          type: z.string(),
          format: z.string().optional(),
          text: z.string().max(100000).optional(),
        })
        .passthrough(),
    )
    .max(20),
});
export type WaTemplate = z.infer<typeof waTemplateSchema>;
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
export function waWindow(last: Date | null | undefined, now = Date.now()) {
  const expiresAt = last ? new Date(last.getTime() + WA_WINDOW_MS) : null;
  return {
    open: Boolean(
      last && last.getTime() <= now + 60000 && expiresAt!.getTime() > now,
    ),
    expiresAt,
  };
}
