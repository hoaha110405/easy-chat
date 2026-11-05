import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '../../config/config.service';
import { ApiError } from '../../common/api-error';
import { hash } from '../../common/crypto.service';
import { MessageStore } from '../inbox/message-store';
import { webhookEnvelopeSchema } from './zalo.schemas';
import { verifySignature, normalizeWebhook, eventDate } from './zalo-webhook';
import { recoverableWebhookWhere } from './zalo-recovery';
@Injectable()
export class ZaloWebhookService {
  private readonly logger = new Logger(ZaloWebhookService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly messages: MessageStore,
  ) {}
  async receive(raw: Buffer, value: unknown, signature?: string) {
    if (!this.config.webhookConfigured)
      throw new ApiError(
        503,
        'ZALO_NOT_CONFIGURED',
        'Webhook credentials are not configured.',
      );
    const envelope = webhookEnvelopeSchema.parse(value);
    if (envelope.app_id !== this.config.env.ZALO_APP_ID)
      throw new ApiError(
        401,
        'INVALID_WEBHOOK_APP',
        'Unexpected webhook application.',
      );
    verifySignature(
      envelope.app_id,
      raw,
      envelope.timestamp,
      this.config.env.ZALO_OA_SECRET_KEY,
      signature,
    );
    // Persist authenticated events before payload-specific validation or timestamp checks.
    const digest = hash(raw.toString('utf8'));
    // INSERT ON CONFLICT avoids the read/create race of an empty-update upsert.
    await this.db.webhookEvent.createMany({
      data: [
        {
          digest,
          eventName: envelope.event_name,
          payload: envelope as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    const receipt = await this.db.webhookEvent.findUniqueOrThrow({
      where: { digest },
    });
    return this.process(receipt.id);
  }
  async process(id: string) {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "WebhookEvent" WHERE "id" = ${id} FOR UPDATE`;
        const event = await tx.webhookEvent.findUnique({ where: { id } });
        if (!event)
          throw new ApiError(
            404,
            'EVENT_NOT_FOUND',
            'Webhook event not found.',
          );
        if (event.status === 'PROCESSED' || event.status === 'IGNORED')
          return { received: true, duplicate: true };
        if (event.channelAccountId)
          throw new ApiError(
            400,
            'INVALID_EVENT_CHANNEL',
            'Use the personal worker to process this event.',
          );
        const envelope = webhookEnvelopeSchema.parse(event.payload);
        eventDate(envelope.timestamp);
        if (!/^(user|oa)_send_/.test(envelope.event_name)) {
          await tx.webhookEvent.update({
            where: { id },
            data: {
              status: 'IGNORED',
              processedAt: new Date(),
              error: null,
              attempts: { increment: 1 },
            },
          });
          return { received: true, ignored: true };
        }
        const message = normalizeWebhook(event.payload);
        const connection = await tx.zaloConnection.findUnique({
          where: { oaId: message.oaId },
        });
        if (!connection || connection.status === 'DISCONNECTED')
          throw new ApiError(
            503,
            'OA_NOT_CONNECTED',
            'This OA is not connected. Connect it and retry this event.',
          );
        const result = await this.messages.persist(tx, connection.id, message);
        await tx.webhookEvent.update({
          where: { id },
          data: {
            oaId: message.oaId,
            status: 'PROCESSED',
            processedAt: new Date(),
            error: null,
            attempts: { increment: 1 },
          },
        });
        return { received: true, ...result };
      });
    } catch (error) {
      const normalized =
        error instanceof ZodError
          ? new ApiError(
              422,
              'INVALID_WEBHOOK_PAYLOAD',
              'The message event does not match the documented payload. Its receipt is saved for inspection.',
            )
          : error;
      const reason =
        normalized instanceof ApiError ? normalized.code : 'PERSISTENCE_FAILED';
      await this.db.webhookEvent.updateMany({
        where: { id, status: { notIn: ['PROCESSED', 'IGNORED'] } },
        data: { status: 'FAILED', error: reason, attempts: { increment: 1 } },
      });
      this.logger.warn(
        `Webhook receipt ${id} failed (${reason}); retry is available.`,
      );
      throw normalized;
    }
  }
  failures() {
    return this.db.webhookEvent.findMany({
      where: recoverableWebhookWhere(),
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        eventName: true,
        error: true,
        attempts: true,
        receivedAt: true,
      },
    });
  }
}
