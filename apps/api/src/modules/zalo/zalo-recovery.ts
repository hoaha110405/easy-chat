import type { Prisma } from '@prisma/client';

export function recoverableWebhookWhere(
  now = Date.now(),
): Prisma.WebhookEventWhereInput {
  return {
    channelAccountId: null,
    OR: [
      { status: 'FAILED' },
      // A crash after receipt commit must remain recoverable without a queue.
      { status: 'RECEIVED', receivedAt: { lt: new Date(now - 60000) } },
    ],
  };
}
