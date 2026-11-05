import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../common/api-error';
import { facebookMediaUrl } from './facebook-graph.client';

export const FACEBOOK_WEBHOOK_MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
const idSchema = z.string().regex(/^\d{1,40}$/);
const messageIdSchema = z.string().min(1).max(512);
const millisSchema = z
  .union([z.number(), z.string().regex(/^\d{1,16}$/)])
  .transform(Number)
  .refine(
    (value) =>
      Number.isSafeInteger(value) &&
      value >= Date.UTC(2010, 0, 1) &&
      value <= Date.now() + 5 * 60 * 1000,
  );

const attachmentSchema = z.object({
  type: z.string().min(1).max(64),
  payload: z
    .object({ url: z.string().max(4096).optional() })
    .optional()
    .default({}),
});
const eventSchema = z.object({
  sender: z.object({ id: idSchema }),
  recipient: z.object({ id: idSchema }),
  timestamp: millisSchema.optional(),
  message: z
    .object({
      mid: messageIdSchema,
      text: z.string().max(20000).optional(),
      is_echo: z.boolean().optional(),
      attachments: z.array(attachmentSchema).max(100).optional(),
    })
    .optional(),
  delivery: z
    .object({
      mids: z.array(messageIdSchema).max(MAX_EVENTS).optional(),
      watermark: millisSchema.optional(),
    })
    .optional(),
  read: z.object({ watermark: millisSchema }).optional(),
  postback: z
    .object({
      mid: messageIdSchema.optional(),
      title: z.string().max(2000).optional(),
      payload: z.string().max(8192).optional(),
    })
    .optional(),
});

export type FacebookWebhookEvent = Omit<
  z.infer<typeof eventSchema>,
  'timestamp'
> & { timestamp: number };
export type FacebookWebhookPayload = {
  pageId: string;
  event: FacebookWebhookEvent;
};

export function verifyFacebookWebhookSignature(
  raw: Buffer,
  secret: string,
  signature: string | undefined,
) {
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature))
    throw invalidSignature();
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, supplied)) throw invalidSignature();
}

function invalidSignature() {
  return new ApiError(
    401,
    'INVALID_FACEBOOK_WEBHOOK_SIGNATURE',
    'Invalid Facebook webhook signature.',
  );
}

export function sameFacebookVerifyToken(actual: string, expected: string) {
  // Hash both tokens to equal length before constant-time comparison.
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

export function parseFacebookWebhook(raw: Buffer): {
  events: FacebookWebhookPayload[];
  ignored: number;
} {
  try {
    const envelope = z
      .object({
        object: z.literal('page'),
        entry: z
          .array(
            z.object({
              id: idSchema,
              messaging: z.array(z.unknown()).max(MAX_EVENTS).default([]),
            }),
          )
          .max(MAX_EVENTS),
      })
      .parse(JSON.parse(raw.toString('utf8')));
    const events: FacebookWebhookPayload[] = [];
    let ignored = 0;
    let total = 0;
    for (const entry of envelope.entry) {
      for (const value of entry.messaging) {
        if (++total > MAX_EVENTS) throw new Error('Batch limit exceeded');
        if (
          !value ||
          typeof value !== 'object' ||
          !['message', 'delivery', 'read', 'postback'].some((key) =>
            Object.hasOwn(value, key),
          )
        ) {
          ignored++;
          continue;
        }
        const parsed = eventSchema.parse(value);
        if (
          [
            parsed.message,
            parsed.delivery,
            parsed.read,
            parsed.postback,
          ].filter(Boolean).length !== 1
        )
          throw new Error('Ambiguous event');
        const timestamp =
          parsed.timestamp ??
          parsed.read?.watermark ??
          parsed.delivery?.watermark;
        if (timestamp === undefined) throw new Error('Missing event time');
        // Entry delivery time is intentionally never substituted for message time:
        // an old retried webhook must not reopen the messaging policy window.
        const outgoing = parsed.message?.is_echo === true;
        if (
          (outgoing ? parsed.sender.id : parsed.recipient.id) !== entry.id ||
          (outgoing ? parsed.recipient.id : parsed.sender.id) === entry.id
        )
          throw new Error('Event does not belong to this page');
        if (
          parsed.delivery &&
          !parsed.delivery.watermark &&
          !parsed.delivery.mids?.length
        )
          throw new Error('Empty delivery');
        const event: FacebookWebhookEvent = { ...parsed, timestamp };
        if (event.message?.attachments) {
          event.message.attachments = event.message.attachments.map(
            (attachment) => {
              const url = facebookMediaUrl(attachment.payload.url);
              return { type: attachment.type, payload: url ? { url } : {} };
            },
          );
        }
        events.push({ pageId: entry.id, event });
      }
    }
    return { events, ignored };
  } catch {
    // Never send parser values, message content, URLs or upstream secrets to logs/UI.
    throw new ApiError(
      400,
      'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
      'The Facebook Page webhook payload is invalid or exceeds supported limits.',
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function facebookWebhookDigest(
  channelAccountId: string,
  payload: FacebookWebhookPayload,
) {
  return createHash('sha256')
    .update('facebook.page:')
    .update(channelAccountId)
    .update(':')
    .update(canonicalJson(payload))
    .digest('hex');
}
