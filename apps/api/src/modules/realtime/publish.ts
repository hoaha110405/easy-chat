import type { Prisma } from '@prisma/client';
import type { RealtimeEvent } from '@zalo/shared';
export const REALTIME_CHANNEL = 'zalo_inbox_events';
export async function publishEvent(
  tx: Prisma.TransactionClient,
  ownerId: string,
  event: RealtimeEvent,
) {
  // PostgreSQL delivers NOTIFY only after this transaction commits. No QR or credentials.
  await tx.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify({ ownerId, event })})`;
}
