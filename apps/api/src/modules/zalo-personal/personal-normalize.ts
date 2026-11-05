import { z } from 'zod';
import {
  normalizePersonalContent,
  personalAttachmentSchema,
} from './personal-media';
// zca-js can return BigNumber objects for large numeric IDs. Never round via Number.
export const personalExternalId = z.preprocess(
  (value) => {
    if (typeof value === 'number')
      return Number.isSafeInteger(value) ? String(value) : value;
    if (typeof value === 'bigint') return value.toString();
    if (
      value &&
      typeof value === 'object' &&
      'toFixed' in value &&
      typeof value.toFixed === 'function'
    )
      return value.toFixed();
    return value;
  },
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[0-9]+$/),
);
const eventSchema = z.object({
  type: z.union([z.literal(0), z.literal(1)]),
  threadId: personalExternalId,
  isSelf: z.boolean(),
  data: z.object({
    msgId: personalExternalId,
    uidFrom: personalExternalId,
    idTo: personalExternalId,
    dName: z.string().max(500).optional(),
    ts: z.coerce.number().int().positive(),
    msgType: z.string().max(100),
    content: z.union([z.string(), z.record(z.unknown())]),
  }),
});
export const normalizedPersonalSchema = z.object({
  externalThreadId: personalExternalId,
  externalMessageId: personalExternalId,
  externalSenderId: personalExternalId,
  direction: z.enum(['INCOMING', 'OUTGOING']),
  type: z.string(),
  content: z.string(),
  sentAt: z.string().datetime(),
  customerName: z.string().optional(),
  attachments: z.array(personalAttachmentSchema).max(20).default([]),
});
export type NormalizedPersonalMessage = z.infer<
  typeof normalizedPersonalSchema
>;
export function normalizePersonalMessage(
  value: unknown,
  ownId: string,
): NormalizedPersonalMessage | null {
  const event = eventSchema.parse(value);
  if (event.type !== 0) return null; // One-to-one only; group events are explicitly out of scope.
  const sentAt = new Date(event.data.ts);
  if (
    !Number.isFinite(sentAt.getTime()) ||
    event.data.ts < Date.UTC(2010, 0, 1) ||
    event.data.ts > Date.now() + 300000
  )
    throw new Error('INVALID_PERSONAL_TIMESTAMP');
  const outgoing = event.isSelf || event.data.uidFrom === ownId;
  if (outgoing ? event.data.uidFrom !== ownId : event.data.idTo !== ownId)
    throw new Error('INVALID_PERSONAL_ACCOUNT');
  if (
    outgoing
      ? event.threadId !== event.data.idTo
      : event.threadId !== event.data.uidFrom
  )
    throw new Error('INVALID_PERSONAL_PARTICIPANTS');
  return {
    externalThreadId: event.threadId,
    externalMessageId: event.data.msgId,
    externalSenderId: outgoing ? ownId : event.data.uidFrom,
    direction: outgoing ? 'OUTGOING' : 'INCOMING',
    ...normalizePersonalContent(event.data.msgType, event.data.content),
    sentAt: sentAt.toISOString(),
    customerName: outgoing ? undefined : event.data.dName,
  };
}
