import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../common/api-error';
import type { NormalizedMessage } from '../inbox/message-store';
import { webhookMessageSchema } from './zalo.schemas';
export function verifySignature(
  appId: string,
  raw: Buffer,
  timestamp: string,
  secret: string,
  signature: string | undefined,
) {
  // Zalo specifies SHA256(appId + exact JSON bytes + timestamp + OA secret), not HMAC.
  const supplied = signature?.replace(/^mac=/, '');
  if (!secret || !supplied || !/^[a-fA-F0-9]{64}$/.test(supplied))
    throw new ApiError(
      401,
      'INVALID_WEBHOOK_SIGNATURE',
      'Invalid Zalo webhook signature.',
    );
  const expected = createHash('sha256')
    .update(appId)
    .update(raw)
    .update(timestamp)
    .update(secret)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(supplied, 'hex')))
    throw new ApiError(
      401,
      'INVALID_WEBHOOK_SIGNATURE',
      'Invalid Zalo webhook signature.',
    );
}
export function eventDate(timestamp: string, now = Date.now()) {
  const millis = Number(timestamp);
  // Old, valid deliveries are accepted for Zalo retries. IDs make replays harmless.
  if (
    !Number.isSafeInteger(millis) ||
    millis < Date.UTC(2010, 0, 1) ||
    millis > now + 5 * 60 * 1000
  )
    throw new ApiError(
      422,
      'INVALID_EVENT_TIMESTAMP',
      'The event timestamp must be a valid millisecond timestamp and cannot be in the future.',
    );
  return new Date(millis);
}
export function normalizeWebhook(value: unknown): NormalizedMessage {
  const event = webhookMessageSchema.parse(value);
  const outgoing = event.event_name.startsWith('oa_send_');
  const type = event.event_name.replace(/^(user|oa)_send_/, '');
  if (type === 'text' && event.message.text === undefined)
    throw new ApiError(
      422,
      'INVALID_EVENT_MESSAGE',
      'Text events must include message.text.',
    );
  return {
    oaId: outgoing ? event.sender.id : event.recipient.id,
    userId: outgoing ? event.recipient.id : event.sender.id,
    externalMessageId: event.message.msg_id,
    direction: outgoing ? 'OUTGOING' : 'INCOMING',
    type: type === 'voice' ? 'audio' : type,
    content: event.message.text ?? '',
    sentAt: eventDate(event.timestamp),
    metadata: {
      eventName: event.event_name,
      attachments: (event.message.attachments ?? []).map((a) => ({
        ...a,
        type: a.type === 'voice' ? 'audio' : a.type,
      })) as NormalizedMessage['metadata'][string],
    },
    source: 'WEBHOOK',
  };
}
