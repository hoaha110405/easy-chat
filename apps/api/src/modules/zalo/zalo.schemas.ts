import { z } from 'zod';
// IDs must be strings. The HTTP transport preserves unsafe JSON integers as strings.
export const externalId = z.string().min(1).max(128);
export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});
// Official getoa example uses oaid; the field table also documents oa_id.
export const oaProfileSchema = z
  .object({
    oaid: externalId.optional(),
    oa_id: externalId.optional(),
    name: z.string().min(1),
    avatar: z.string().optional(),
  })
  .refine((v) => Boolean(v.oaid || v.oa_id), 'Missing OA ID');
export const webhookEnvelopeSchema = z
  .object({
    app_id: externalId,
    event_name: z.string().min(1),
    timestamp: z.string().regex(/^\d{1,16}$/),
  })
  .passthrough();
export const webhookMessageSchema = webhookEnvelopeSchema.extend({
  sender: z.object({ id: externalId }).passthrough(),
  recipient: z.object({ id: externalId }).passthrough(),
  message: z
    .object({
      msg_id: externalId,
      text: z.string().optional(),
      attachments: z
        .array(
          z
            .object({ type: z.string(), payload: z.record(z.unknown()) })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
});
export const historyItemSchema = z
  .object({
    message_id: externalId,
    src: z.union([z.literal(0), z.literal(1)]),
    time: z.number().int().positive(),
    type: z.string(),
    message: z.string().optional(),
    from_id: externalId,
    to_id: externalId,
    from_display_name: z.string().optional(),
    from_avatar: z.string().optional(),
    to_display_name: z.string().optional(),
    to_avatar: z.string().optional(),
    url: z.string().optional(),
    thumb: z.string().optional(),
  })
  .passthrough();
export type TokenResult = z.infer<typeof tokenSchema>;
