import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { WhatsAppCleanup } from '../whatsapp/whatsapp.service';
import { TelegramCleanup } from '../telegram/telegram.service';
import { Injectable, Optional } from '@nestjs/common';
import type { ChannelAccount, Prisma } from '@prisma/client';
import type { SendText } from '@zalo/shared';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '../../config/config.service';
import { CryptoService } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { publishEvent } from '../realtime/publish';
import { serializeMessage } from '../inbox/inbox.service';
import { capabilitiesSchema, noCapabilities } from '../tiktok/tiktok.types';
import { assertTikTokBudget } from '../tiktok/tiktok.worker';
import { assertChannelSend } from '../messaging/channel-policy';
import { personalWorkerOnline } from './personal-runtime';
export { WORKER_ID } from './personal-runtime';
@Injectable()
export class PersonalService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    @Optional() private readonly telegram?: TelegramCleanup,
    @Optional() private readonly whatsapp?: WhatsAppCleanup,
  ) {}
  private enabled() {
    if (!this.config.env.ZALO_PERSONAL_ENABLED)
      throw new ApiError(
        503,
        'ZALO_PERSONAL_DISABLED',
        'Zalo Personal is disabled on this server.',
      );
  }
  async workerOnline(tx: Prisma.TransactionClient = this.db) {
    return personalWorkerOnline(tx);
  }

  async owned(
    id: string,
    ownerId: string,
    tx: Prisma.TransactionClient = this.db,
    lock = false,
  ) {
    const account = lock
      ? (
          await tx.$queryRaw<
            ChannelAccount[]
          >`SELECT * FROM "ChannelAccount" WHERE "id"=${id} AND "ownerId"=${ownerId} FOR UPDATE`
        )[0]
      : await tx.channelAccount.findFirst({ where: { id, ownerId } });
    if (!account)
      throw new ApiError(
        404,
        'CHANNEL_NOT_FOUND',
        'Channel account not found.',
      );
    return account;
  }
  publicAccount(account: ChannelAccount, workerOnline: boolean) {
    const freshQr =
      account.qrStatus === 'GENERATED' &&
      account.qrExpiresAt &&
      account.qrExpiresAt > new Date();
    return {
      id: account.id,
      name: account.name,
      channelType: account.channelType,
      lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
      lastSyncError: account.lastSyncError,
      syncComplete: account.syncComplete,
      avatarUrl: account.avatarUrl,
      externalAccountId: account.externalAccountId,
      connectionStatus:
        !workerOnline && account.connectionStatus === 'CONNECTED'
          ? 'RECONNECTING'
          : account.connectionStatus,
      qrStatus: account.qrStatus,
      qrImage:
        freshQr && account.encryptedQr
          ? this.crypto.decrypt(account.encryptedQr)
          : null,
      qrExpiresAt: account.qrExpiresAt?.toISOString() ?? null,
      lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
      lastError:
        !workerOnline && account.connectionStatus === 'CONNECTED'
          ? account.channelType === 'ZALO_PERSONAL'
            ? 'ZALO_CONNECTION_LOST'
            : 'CHANNEL_WORKER_UNAVAILABLE'
          : account.lastError,
      workerOnline,
      ...(account.channelType.startsWith('TIKTOK_') ||
      account.channelType.startsWith('TELEGRAM_')
        ? {
            capabilities: capabilitiesSchema
              .catch(noCapabilities)
              .parse(account.capabilities),
            tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
          }
        : {}),
    };
  }
  async list(ownerId: string) {
    const [accounts, workerOnline] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId, channelType: 'ZALO_PERSONAL' },
        orderBy: { createdAt: 'asc' },
      }),
      this.workerOnline(),
    ]);
    return {
      enabled: this.config.env.ZALO_PERSONAL_ENABLED,
      workerOnline,
      accounts: accounts.map((a) => this.publicAccount(a, workerOnline)),
    };
  }
  async status(id: string, ownerId: string) {
    return this.publicAccount(
      await this.owned(id, ownerId),
      await this.workerOnline(),
    );
  }
  async create(ownerId: string, name: string) {
    this.enabled();
    const account = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(240006)`;
      if (
        (await tx.channelAccount.count({
          where: { ownerId, channelType: 'ZALO_PERSONAL' },
        })) >= 5
      )
        throw new ApiError(
          409,
          'CHANNEL_LIMIT',
          'This MVP supports up to five personal accounts per administrator. Reuse an existing disconnected account.',
        );
      return tx.channelAccount.create({ data: { ownerId, name } });
    });
    return this.publicAccount(account, await this.workerOnline());
  }
  async startQr(id: string, ownerId: string) {
    this.enabled();
    const online = await this.workerOnline();
    if (!online)
      throw new ApiError(
        503,
        'ZALO_WORKER_UNAVAILABLE',
        'Start the Zalo Personal worker before requesting a QR code.',
      );
    const account = await this.db.$transaction(async (tx) => {
      const current = await this.owned(id, ownerId, tx, true);
      if (current.channelType !== 'ZALO_PERSONAL')
        throw new ApiError(
          409,
          'CHANNEL_UNSUPPORTED',
          'Kênh này không hỗ trợ đăng nhập bằng mã QR Zalo.',
        );
      if (
        current.connectionStatus === 'CONNECTED' ||
        (['QR_PENDING', 'CONNECTING'].includes(current.connectionStatus) &&
          current.qrExpiresAt &&
          current.qrExpiresAt > new Date())
      )
        return current;
      const updated = await tx.channelAccount.update({
        where: { id },
        data: {
          generation: { increment: 1 },
          connectionStatus: 'QR_PENDING',
          qrStatus: 'NONE',
          qrExpiresAt: new Date(Date.now() + 140000),
          encryptedQr: null,
          encryptedCredentials: null,
          lastError: null,
        },
      });
      await tx.personalCommand.create({
        data: {
          channelAccountId: id,
          kind: 'LOGIN_QR',
          generation: updated.generation,
          deduplicationKey: `login:${id}:${updated.generation}`,
        },
      });
      await publishEvent(tx, ownerId, {
        type: 'channel.disconnected',
        channelAccountId: id,
      });
      return updated;
    });
    return this.publicAccount(account, online);
  }
  async disconnect(id: string, ownerId: string, cancelOnly = false) {
    const account = await this.db.$transaction(
      async (tx) => {
        const current = await this.owned(id, ownerId, tx, true);
        if (
          cancelOnly &&
          !['QR_PENDING', 'CONNECTING'].includes(current.connectionStatus)
        )
          return current;
        const cleanupError =
          this.whatsapp && current.channelType === 'WHATSAPP_BUSINESS'
            ? await this.whatsapp.disconnect(current, tx)
            : this.telegram && current.channelType.startsWith('TELEGRAM_')
              ? await this.telegram.disconnect(current)
              : null;
        const updated = await tx.channelAccount.update({
          where: { id },
          data: {
            generation: { increment: 1 },
            connectionStatus: 'DISCONNECTED',
            encryptedCredentials: null,
            capabilities: {},
            encryptedQr: null,
            qrExpiresAt: null,
            qrStatus: 'CANCELLED',
            lastError: cleanupError,
          },
        });
        await tx.personalCommand.updateMany({
          where: {
            channelAccountId: id,
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: { status: 'FAILED' },
        });
        await tx.message.updateMany({
          where: { channelAccountId: id, deliveryStatus: 'PENDING' },
          data: {
            deliveryStatus: 'FAILED',
            deliveryError:
              current.channelType === 'ZALO_PERSONAL'
                ? 'ZALO_NOT_CONNECTED'
                : 'CHANNEL_NOT_CONNECTED',
          },
        });
        await tx.message.updateMany({
          where: { channelAccountId: id, deliveryStatus: 'SENDING' },
          data: {
            deliveryStatus: 'UNKNOWN',
            deliveryError:
              current.channelType === 'ZALO_PERSONAL'
                ? 'ZALO_SEND_UNKNOWN'
                : 'MESSAGE_SEND_UNKNOWN',
          },
        });
        await publishEvent(tx, ownerId, {
          type: 'channel.disconnected',
          channelAccountId: id,
        });
        return updated;
      },
      { timeout: 20000 },
    );
    return {
      disconnected: true,
      ...this.publicAccount(account, await this.workerOnline()),
    };
  }
  async send(conversationId: string, ownerId: string, input: SendText) {
    return this.db.$transaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { id: conversationId, channelAccount: { ownerId } },
      });
      if (!conversation?.channelAccountId)
        throw new ApiError(
          404,
          'CONVERSATION_NOT_FOUND',
          'Personal conversation not found. OA conversations remain read-only.',
        );
      const account = await this.owned(
        conversation.channelAccountId,
        ownerId,
        tx,
        true,
      );
      if (account.channelType === 'ZALO_OA')
        throw new ApiError(
          409,
          'MEDIA_ONLY_CHANNEL',
          'Zalo OA hiện hỗ trợ gửi tài liệu qua nút đính kèm.',
        );
      const existing = await tx.message.findUnique({
        where: {
          channelAccountId_idempotencyKey: {
            channelAccountId: account.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (
          existing.conversationId !== conversationId ||
          existing.content !== input.content ||
          (account.channelType === 'WHATSAPP_BUSINESS' &&
            existing.type !== 'text') ||
          (account.channelType === 'WHATSAPP_BUSINESS' &&
            z
              .object({
                whatsapp: z
                  .object({ replyToMessageId: z.string().optional() })
                  .optional(),
              })
              .catch({})
              .parse(existing.metadata).whatsapp?.replyToMessageId !==
              input.replyToMessageId)
        )
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This idempotency key was used for a different message.',
          );
        return serializeMessage(existing);
      }
      if (account.channelType === 'ZALO_PERSONAL') this.enabled();
      await assertTikTokBudget(
        tx,
        account,
        conversation.id,
        conversation.lastInboundAt,
      );
      if (account.channelType !== 'ZALO_PERSONAL')
        assertChannelSend(account, conversation, await this.workerOnline(tx));
      if (
        account.connectionStatus !== 'CONNECTED' ||
        !(await this.workerOnline(tx))
      )
        throw new ApiError(
          409,
          'ZALO_NOT_CONNECTED',
          'Connect this Zalo Personal account before sending.',
        );
      if (
        (await tx.message.count({
          where: {
            channelAccountId: account.id,
            deliveryStatus: { in: ['PENDING', 'SENDING'] },
          },
        })) >= 20
      ) {
        throw new ApiError(
          429,
          account.channelType === 'ZALO_PERSONAL'
            ? 'ZALO_RATE_LIMITED'
            : 'CHANNEL_RATE_LIMITED',
          'This account already has 20 queued messages. Wait for delivery before sending more.',
        );
      }
      let replyMetadata: Prisma.InputJsonObject = {};
      if (input.replyToMessageId) {
        if (account.channelType !== 'WHATSAPP_BUSINESS')
          throw new ApiError(
            400,
            'REPLY_CONTEXT_UNSUPPORTED',
            'Kênh này chưa hỗ trợ trích dẫn tin nhắn.',
          );
        const reply = await tx.message.findFirst({
          where: {
            id: input.replyToMessageId,
            conversationId,
            channelAccountId: account.id,
            externalMessageId: { not: null },
          },
        });
        if (!reply)
          throw new ApiError(
            404,
            'MESSAGE_NOT_FOUND',
            'Không tìm thấy tin nhắn được trả lời.',
          );
        replyMetadata = {
          whatsapp: {
            replyTo: reply.externalMessageId,
            replyToMessageId: reply.id,
          },
        };
      }
      const message = await tx.message.create({
        data: {
          conversationId,
          channelAccountId: account.id,
          externalSenderId: account.externalAccountId,
          direction: 'OUTGOING',
          type: 'text',
          content: input.content,
          metadata: replyMetadata,
          source:
            account.channelType === 'WHATSAPP_BUSINESS'
              ? 'WHATSAPP'
              : account.channelType.startsWith('TELEGRAM_')
                ? 'TELEGRAM'
                : account.channelType.startsWith('TIKTOK_')
                  ? 'TIKTOK'
                  : account.channelType === 'FACEBOOK_PAGE'
                    ? 'FACEBOOK'
                    : 'PERSONAL',
          deliveryStatus: 'PENDING',
          idempotencyKey: input.idempotencyKey,
          sentAt: new Date(),
        },
      });
      await tx.personalCommand.create({
        data: {
          channelAccountId: account.id,
          messageId: message.id,
          kind: 'SEND',
          generation: account.generation,
          deduplicationKey: `send:${message.id}`,
        },
      });
      await tx.conversation.updateMany({
        where: {
          id: conversationId,
          OR: [
            { lastMessageAt: null },
            { lastMessageAt: { lt: message.sentAt } },
          ],
        },
        data: {
          lastMessageAt: message.sentAt,
          lastMessagePreview: message.content.slice(0, 280),
        },
      });
      await publishEvent(tx, ownerId, {
        type: 'message.created',
        channelAccountId: account.id,
        conversationId,
        messageId: message.id,
      });
      return serializeMessage(message);
    });
  }
  async retry(conversationId: string, messageId: string, ownerId: string) {
    return this.db.$transaction(async (tx) => {
      const message = await tx.message.findFirst({
        where: {
          id: messageId,
          conversationId,
          OR: [
            { channelAccount: { ownerId } },
            ...(ownerId === 'administrator'
              ? [
                  {
                    connectionId: { not: null },
                    outboundCommand: { isNot: null },
                  },
                ]
              : []),
          ],
        },
        include: { outboundCommand: { select: { channelAccountId: true } } },
      });
      if (!message || (!message.channelAccountId && !message.outboundCommand))
        throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
      const account = await this.owned(
        message.channelAccountId ?? message.outboundCommand!.channelAccountId,
        ownerId,
        tx,
        true,
      );
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      if (account.channelType === 'ZALO_PERSONAL') this.enabled();
      if (message.deliveryStatus !== 'FAILED')
        throw new ApiError(
          409,
          account.channelType === 'ZALO_PERSONAL'
            ? 'ZALO_SEND_UNKNOWN'
            : 'MESSAGE_NOT_RETRYABLE',
          'Only messages known to have failed before sending can be retried. Unknown deliveries must be checked on the phone.',
        );
      if (
        account.connectionStatus !== 'CONNECTED' ||
        !(await this.workerOnline(tx))
      )
        throw new ApiError(
          409,
          account.channelType === 'ZALO_PERSONAL'
            ? 'ZALO_NOT_CONNECTED'
            : 'CHANNEL_NOT_CONNECTED',
          'Reconnect the account before retrying.',
        );
      if (
        account.channelType !== 'ZALO_PERSONAL' &&
        !(
          account.channelType === 'WHATSAPP_BUSINESS' &&
          message.type === 'template'
        )
      )
        assertChannelSend(account, conversation, await this.workerOnline(tx));
      await assertTikTokBudget(
        tx,
        account,
        conversationId,
        conversation.lastInboundAt,
      );
      const changed = await tx.message.updateMany({
        where: { id: messageId, deliveryStatus: 'FAILED' },
        data: {
          deliveryStatus: 'PENDING',
          deliveryError: null,
          sendAttempts: 0,
          sendingAt: null,
          ...(account.channelType === 'WHATSAPP_BUSINESS'
            ? {
                externalMessageId: null,
                deliveredAt: null,
                readAt: null,
                metadata: (() => {
                  const metadata = z
                    .record(z.unknown())
                    .catch({})
                    .parse(message.metadata);
                  const wa = z
                    .record(z.unknown())
                    .catch({})
                    .parse(metadata.whatsapp);
                  return {
                    ...metadata,
                    whatsapp: {
                      ...wa,
                      previousMessageId: message.externalMessageId,
                      providerStatus: null,
                      statusTimestamp: 0,
                      callbackData: `${message.id}.${randomUUID()}`,
                    },
                  } as Prisma.InputJsonObject;
                })(),
              }
            : {}),
        },
      });
      if (changed.count)
        await tx.personalCommand.update({
          where: { messageId },
          data: {
            status: 'PENDING',
            attempts: 0,
            generation: account.generation,
            availableAt: new Date(),
          },
        });
      await publishEvent(tx, ownerId, {
        type: 'message.status_changed',
        channelAccountId: account.id,
        conversationId,
        messageId,
      });
      return serializeMessage(
        await tx.message.findUniqueOrThrow({ where: { id: messageId } }),
      );
    });
  }
}
