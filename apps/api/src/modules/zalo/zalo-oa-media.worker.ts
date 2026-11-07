import { Injectable } from '@nestjs/common';
import type { ChannelAccount, PersonalCommand } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { MediaStore } from '../../common/media-store';
import { ZaloApiClient } from './zalo-api.client';
import { ZaloError } from './zalo-http.service';
import { channelSendPolicy } from '../messaging/channel-policy';
import { publishEvent } from '../realtime/publish';
@Injectable()
export class ZaloOaMediaWorker {
  constructor(
    readonly db: PrismaService,
    readonly api: ZaloApiClient,
    readonly media: MediaStore,
  ) {}
  async process(
    command: PersonalCommand,
    a: ChannelAccount,
    active: () => boolean,
  ) {
    let attempted = false;
    try {
      const m = await this.db.message.findUnique({
        where: { id: command.messageId ?? '' },
        include: { conversation: true, connection: true },
      });
      if (!m || m.deliveryStatus !== 'PENDING') {
        await this.db.personalCommand.update({
          where: { id: command.id },
          data: { status: 'DONE' },
        });
        return;
      }
      if (
        command.kind !== 'SEND' ||
        m.type !== 'file' ||
        !m.connectionId ||
        m.connection?.status !== 'CONNECTED'
      )
        throw Error('CHANNEL_NOT_CONNECTED');
      const wait = (a.lastSendAt?.getTime() ?? 0) + 1500;
      if (wait > Date.now()) {
        await this.db.personalCommand.update({
          where: { id: command.id },
          data: {
            status: 'PENDING',
            attempts: { decrement: 1 },
            availableAt: new Date(wait),
          },
        });
        return;
      }
      const policy = channelSendPolicy(a, m.conversation, true);
      if (!policy.allowed) throw Error(policy.code ?? 'CHANNEL_NOT_CONNECTED');
      const file = await this.media.read(m.id);
      const existing = z
        .object({ zaloOa: z.object({ fileToken: z.string() }) })
        .safeParse(m.metadata);
      const fileToken = existing.success
        ? existing.data.zaloOa.fileToken
        : await this.api.uploadFile(m.connectionId, file);
      await this.db.message.update({
        where: { id: m.id },
        data: {
          metadata: {
            ...z.record(z.unknown()).parse(m.metadata),
            zaloOa: { fileToken },
          } as import('@prisma/client').Prisma.InputJsonObject,
        },
      });
      const claimed = await this.db.$transaction(async (tx) => {
        const current = (
          await tx.$queryRaw<
            ChannelAccount[]
          >`SELECT * FROM "ChannelAccount" WHERE "id"=${a.id} FOR UPDATE`
        )[0];
        const c = await tx.conversation.findUniqueOrThrow({
            where: { id: m.conversationId },
          }),
          connection = await tx.zaloConnection.findUnique({
            where: { id: m.connectionId! },
          });
        if (
          !current ||
          current.generation !== command.generation ||
          connection?.status !== 'CONNECTED' ||
          !channelSendPolicy(current, c, true).allowed
        )
          throw Error('ZALO_OA_REPLY_WINDOW_CLOSED');
        const changed = await tx.message.updateMany({
          where: { id: m.id, deliveryStatus: 'PENDING' },
          data: {
            deliveryStatus: 'SENDING',
            sendingAt: new Date(),
            sendAttempts: { increment: 1 },
            deliveryError: null,
          },
        });
        if (changed.count)
          await tx.channelAccount.update({
            where: { id: a.id },
            data: { lastSendAt: new Date() },
          });
        return changed.count;
      });
      if (!claimed || !active()) return;
      attempted = true;
      const result = await this.api.sendFile(
        m.connectionId,
        m.conversation.externalUserId,
        fileToken,
      );
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "id"=${a.id} FOR UPDATE`;
        const current = await tx.channelAccount.findUnique({
          where: { id: a.id },
        });
        if (
          current?.generation !== command.generation ||
          current.connectionStatus !== 'CONNECTED'
        )
          return;
        const echo = await tx.message.findUnique({
          where: {
            connectionId_externalMessageId: {
              connectionId: m.connectionId!,
              externalMessageId: result.message_id,
            },
          },
        });
        if (echo && echo.id !== m.id) {
          if (
            echo.direction !== 'OUTGOING' ||
            echo.conversationId !== m.conversationId ||
            echo.idempotencyKey
          )
            throw Error('MESSAGE_ID_COLLISION');
          await tx.message.delete({ where: { id: echo.id } });
        }
        await tx.message.update({
          where: { id: m.id },
          data: {
            externalMessageId: result.message_id,
            deliveryStatus: 'SENT',
            deliveryError: null,
          },
        });
        await tx.personalCommand.update({
          where: { id: command.id },
          data: { status: 'DONE' },
        });
        await publishEvent(tx, a.ownerId, {
          type: 'message.status_changed',
          channelAccountId: a.id,
          conversationId: m.conversationId,
          messageId: m.id,
        });
      });
    } catch (e) {
      const unknown = attempted && !(e instanceof ZaloError);
      await this.db.$transaction(async (tx) => {
        await tx.personalCommand.updateMany({
          where: { id: command.id, status: 'PROCESSING' },
          data: { status: 'FAILED' },
        });
        if (command.messageId) {
          const m = await tx.message.findUnique({
            where: { id: command.messageId },
          });
          if (m && ['PENDING', 'SENDING'].includes(m.deliveryStatus)) {
            await tx.message.update({
              where: { id: m.id },
              data: {
                deliveryStatus: unknown ? 'UNKNOWN' : 'FAILED',
                deliveryError: unknown
                  ? 'MESSAGE_SEND_UNKNOWN'
                  : e instanceof ZaloError
                    ? e.code
                    : e instanceof Error &&
                        /^(?:CHANNEL|ZALO_OA|MEDIA)_[A-Z_]+$/.test(e.message)
                      ? e.message
                      : 'ZALO_MEDIA_FAILED',
              },
            });
            await publishEvent(tx, a.ownerId, {
              type: 'message.status_changed',
              channelAccountId: a.id,
              conversationId: m.conversationId,
              messageId: m.id,
            });
          }
        }
      });
    }
  }
}
