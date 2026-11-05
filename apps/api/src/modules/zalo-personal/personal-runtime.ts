import type { Prisma } from '@prisma/client';
export const WORKER_ID = 'zalo-personal';
export const WORKER_HEARTBEAT_MS = 20000;
export async function personalWorkerOnline(db: Prisma.TransactionClient) {
  const row = await db.personalWorkerState.findUnique({
    where: { id: WORKER_ID },
  });
  return Boolean(
    row && row.heartbeatAt.getTime() > Date.now() - WORKER_HEARTBEAT_MS,
  );
}
