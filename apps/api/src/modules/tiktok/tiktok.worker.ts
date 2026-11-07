import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ApiError } from '../../common/api-error';
import { MessageStore } from '../inbox/message-store';
import { publishEvent } from '../realtime/publish';
import { channelSendPolicy } from '../messaging/channel-policy';
import { TikTokRegistry } from './tiktok.registry';
import { TikTokTokenService } from './tiktok-token.service';
import { TikTokError } from './tiktok-http';
import {
  capabilitiesSchema,
  type TikTokType,
  type TikTokMessage,
} from './tiktok.types';
import { inboundSchema } from './tiktok-webhook.service';
const jobSchema = z.object({
  conversationId: z.string().cuid().optional(),
  cursor: z.string().max(4096).nullable().optional(),
  page: z.number().int().min(0).max(100).default(0),
  runId: z.string().max(100).optional(),
});
export async function assertTikTokBudget(
  tx: Prisma.TransactionClient,
  account: ChannelAccount,
  conversationId: string,
  lastInboundAt: Date | null,
) {
  if (account.channelType !== 'TIKTOK_BUSINESS' || !lastInboundAt) return;
  const count = await tx.message.count({
    where: {
      conversationId,
      channelAccountId: account.id,
      direction: 'OUTGOING',
      sentAt: { gte: lastInboundAt },
      deliveryStatus: { in: ['PENDING', 'SENDING', 'SENT', 'UNKNOWN'] },
    },
  });
  if (count >= 10)
    throw new ApiError(
      409,
      'TIKTOK_REPLY_LIMIT_REACHED',
      'Đã đạt giới hạn 10 tin trả lời kể từ lần khách nhắn gần nhất. Chờ tin mới từ khách.',
    );
}
@Injectable()
export class TikTokWorker {
  private lastPoll = 0;
  constructor(
    private readonly db: PrismaService,
    private readonly registry: TikTokRegistry,
    private readonly tokens: TikTokTokenService,
    private readonly messages: MessageStore,
  ) {}
  private async lock(tx: Prisma.TransactionClient, account: ChannelAccount) {
    return (
      await tx.$queryRaw<
        ChannelAccount[]
      >`SELECT * FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`
    )[0];
  }
  async enqueue(ownerId: string, accountId: string, conversationId?: string) {
    return this.db.$transaction(async (tx) => {
      const account = await tx.channelAccount.findFirst({
        where: {
          id: accountId,
          ownerId,
          channelType: { in: ['TIKTOK_BUSINESS', 'TIKTOK_SHOP'] },
        },
      });
      if (!account)
        throw new ApiError(
          404,
          'CHANNEL_NOT_FOUND',
          'Không tìm thấy tài khoản TikTok.',
        );
      const current = await this.lock(tx, account);
      if (
        !current ||
        !capabilitiesSchema.parse(current.capabilities).syncConversations
      )
        throw new ApiError(
          409,
          'TIKTOK_PERMISSION_DENIED',
          'Kết nối và cấp đủ quyền trước khi đồng bộ.',
        );
      const conversation = conversationId
        ? await tx.conversation.findFirst({
            where: { id: conversationId, channelAccountId: account.id },
          })
        : null;
      if (conversationId && !conversation?.externalConversationId)
        throw new ApiError(
          404,
          'CONVERSATION_NOT_FOUND',
          'Không tìm thấy hội thoại.',
        );
      const kind = conversationId ? 'SYNC_MESSAGES' : 'SYNC';
      const pending = await tx.personalCommand.findMany({
        where: {
          channelAccountId: account.id,
          generation: account.generation,
          kind,
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      });
      if (
        pending.some(
          (c) =>
            !conversationId ||
            jobSchema.parse(c.payload).conversationId === conversationId,
        )
      )
        return { queued: true };
      const runId = randomUUID();
      if (!conversationId) {
        const incomplete = await tx.$queryRaw<
          { id: string; syncCursor: string | null }[]
        >`SELECT c."id",c."syncCursor" FROM "Conversation" c WHERE c."channelAccountId"=${account.id} AND c."syncComplete"=false AND c."externalConversationId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "PersonalCommand" j WHERE j."channelAccountId"=${account.id} AND j."generation"=${account.generation} AND j."kind"='SYNC_MESSAGES' AND j."status" IN ('PENDING','PROCESSING') AND j."payload"->>'conversationId'=c."id") ORDER BY c."id" LIMIT 100`;
        if (incomplete.length)
          await tx.personalCommand.createMany({
            data: incomplete.map((c) => ({
              channelAccountId: account.id,
              generation: account.generation,
              kind: 'SYNC_MESSAGES' as const,
              deduplicationKey: `tiktok:resume:${runId}:${c.id}`,
              payload: {
                conversationId: c.id,
                cursor: c.syncCursor,
                page: 0,
                runId,
              },
            })),
          });
      }
      await tx.personalCommand.create({
        data: {
          channelAccountId: account.id,
          generation: account.generation,
          kind,
          deduplicationKey: `tiktok:sync:${account.id}:${runId}`,
          payload: {
            ...(conversationId ? { conversationId } : {}),
            cursor: conversationId
              ? conversation!.syncCursor
              : account.syncCursor,
            page: 0,
            runId,
          },
        },
      });
      await tx.channelAccount.update({
        where: { id: account.id },
        data: { syncComplete: false, lastSyncError: null },
      });
      return { queued: true };
    });
  }
  async poll() {
    if (Date.now() - this.lastPoll < 60000) return;
    this.lastPoll = Date.now();
    const accounts = await this.db.channelAccount.findMany({
      where: {
        channelType: { in: ['TIKTOK_BUSINESS', 'TIKTOK_SHOP'] },
        connectionStatus: 'CONNECTED',
        OR: [
          { lastSyncAt: null },
          { lastSyncAt: { lt: new Date(Date.now() - 300000) } },
        ],
      },
      take: 50,
    });
    for (const a of accounts)
      if (this.registry.configured(a.channelType as TikTokType))
        await this.enqueue(a.ownerId, a.id);
  }
  async process(
    command: PersonalCommand,
    account: ChannelAccount,
    active: () => boolean,
  ) {
    try {
      if (!active()) return;
      const current = await this.db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (
        current.generation !== command.generation ||
        current.connectionStatus !== 'CONNECTED'
      )
        throw new TikTokError('CHANNEL_NOT_CONNECTED');
      if (
        (
          await this.db.personalCommand.findUnique({
            where: { id: command.id },
          })
        )?.status !== 'PROCESSING'
      )
        return;
      const token = await this.tokens.get(current, active);
      if (!active()) return;
      if (command.kind === 'SEND')
        await this.send(command, current, token, active);
      else if (command.kind === 'SYNC' || command.kind === 'SYNC_MESSAGES')
        await this.sync(command, current, token, active);
      else throw new TikTokError('CHANNEL_UNSUPPORTED');
    } catch (error) {
      if (active()) await this.recoverDispatch(command, account, error);
    }
  }
  async recoverDispatch(
    command: PersonalCommand,
    account: ChannelAccount,
    error?: unknown,
  ) {
    const code =
      error instanceof TikTokError || error instanceof ApiError
        ? error.code
        : 'TIKTOK_OPERATION_FAILED';
    const permission = [
      'TIKTOK_PERMISSION_DENIED',
      'TIKTOK_SHOP_APPROVAL_REQUIRED',
      'TIKTOK_ACCOUNT_NOT_ELIGIBLE',
      'TIKTOK_NOT_CONFIGURED',
    ].includes(code);
    const reauth = [
      'TIKTOK_TOKEN_EXPIRED',
      'TIKTOK_TOKEN_REFRESH_UNKNOWN',
      'TIKTOK_ACCOUNT_MISMATCH',
    ].includes(code);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} FOR UPDATE`;
      const current = await tx.channelAccount.findUnique({
        where: { id: account.id },
      });
      const message = command.messageId
        ? await tx.message.findUnique({ where: { id: command.messageId } })
        : null;
      const ambiguous =
        message?.deliveryStatus === 'SENDING' &&
        (!(error instanceof TikTokError) || error.ambiguous);
      const retry =
        !ambiguous &&
        !permission &&
        !reauth &&
        command.attempts < 3 &&
        current?.generation === command.generation &&
        current.connectionStatus === 'CONNECTED' &&
        (error === undefined ||
          (error instanceof TikTokError && error.retryable));
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: retry ? 'PENDING' : 'FAILED',
          availableAt: new Date(
            Date.now() + 2000 * 2 ** Math.min(command.attempts, 5),
          ),
        },
      });
      if (message && ['PENDING', 'SENDING'].includes(message.deliveryStatus)) {
        await tx.message.update({
          where: { id: message.id },
          data: {
            deliveryStatus: ambiguous
              ? 'UNKNOWN'
              : retry
                ? 'PENDING'
                : 'FAILED',
            deliveryError: ambiguous ? 'TIKTOK_SEND_UNKNOWN' : code,
          },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'message.status_changed',
          channelAccountId: account.id,
          conversationId: message.conversationId,
          messageId: message.id,
        });
      }
      if (
        current?.generation === command.generation &&
        current.connectionStatus !== 'DISCONNECTED'
      ) {
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            ...(permission || reauth
              ? {
                  connectionStatus: permission
                    ? 'PERMISSION_REQUIRED'
                    : 'REAUTH_REQUIRED',
                  capabilities: {},
                  lastError: code,
                }
              : {}),
            ...(command.kind !== 'SEND'
              ? { syncComplete: false, lastSyncError: code }
              : {}),
          },
        });
        await publishEvent(tx, account.ownerId, {
          type:
            permission || reauth
              ? 'channel.reauth_required'
              : 'channel.sync_failed',
          channelAccountId: account.id,
        });
      }
    });
  }
  private async persist(
    tx: Prisma.TransactionClient,
    account: ChannelAccount,
    message: TikTokMessage,
  ) {
    if (message.at.getTime() > Date.now() + 60000)
      throw new TikTokError('TIKTOK_INVALID_RESPONSE');
    const result = await this.messages.persistChannel(
      tx,
      account.id,
      {
        oaId: '',
        userId: message.conversationId,
        externalConversationId: message.conversationId,
        externalContactId: message.contactId,
        externalThreadType: account.channelType,
        externalMessageId: message.id,
        direction: message.direction,
        type: message.type,
        content: message.content,
        sentAt: message.at,
        metadata: { attachments: message.attachments },
        source: 'TIKTOK',
        customerName: message.name,
        customerAvatar: message.avatar,
      },
      message.senderId,
    );
    if (!result.duplicate)
      await publishEvent(tx, account.ownerId, {
        type: 'message.created',
        channelAccountId: account.id,
        conversationId: result.conversationId,
        messageId: result.messageId,
      });
    return result;
  }
  private async sync(
    command: PersonalCommand,
    account: ChannelAccount,
    token: Awaited<ReturnType<TikTokTokenService['get']>>,
    active: () => boolean,
  ) {
    const job = jobSchema.parse(command.payload);
    const adapter = this.registry.adapter(account.channelType as TikTokType);
    let cursor: string | null;
    if (command.kind === 'SYNC') {
      const page = await adapter.conversations(token, job.cursor);
      cursor = page.cursor;
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, account))) return;
        for (const remote of page.items) {
          const c = await tx.conversation.upsert({
            where: {
              channelAccountId_externalUserId_externalThreadType: {
                channelAccountId: account.id,
                externalUserId: remote.id,
                externalThreadType: account.channelType,
              },
            },
            create: {
              channelAccountId: account.id,
              externalUserId: remote.id,
              externalThreadType: account.channelType,
              externalConversationId: remote.id,
              externalContactId: remote.contactId,
              customerName: remote.name,
              customerAvatar: remote.avatar,
              unreadCount: remote.unreadCount,
              providerState:
                remote.canSend === undefined
                  ? {}
                  : { canSend: remote.canSend, checkedAt: Date.now() },
            },
            update: {
              customerName: remote.name,
              customerAvatar: remote.avatar,
              externalContactId: remote.contactId,
              unreadCount: remote.unreadCount,
              ...(remote.canSend === undefined
                ? {}
                : {
                    providerState: {
                      canSend: remote.canSend,
                      checkedAt: Date.now(),
                    },
                  }),
            },
          });
          if (remote.latest) await this.persist(tx, account, remote.latest);
          if (
            !c.syncComplete ||
            !c.lastSyncAt ||
            !remote.updatedAt ||
            remote.updatedAt > c.lastSyncAt
          ) {
            const pending = await tx.personalCommand.findFirst({
              where: {
                channelAccountId: account.id,
                generation: account.generation,
                kind: 'SYNC_MESSAGES',
                status: { in: ['PENDING', 'PROCESSING'] },
                payload: { path: ['conversationId'], equals: c.id },
              },
            });
            if (!pending)
              await tx.personalCommand.create({
                data: {
                  channelAccountId: account.id,
                  generation: account.generation,
                  kind: 'SYNC_MESSAGES',
                  deduplicationKey: `tiktok:messages:${command.id}:${c.id}`,
                  payload: {
                    conversationId: c.id,
                    cursor: c.syncCursor,
                    page: 0,
                    runId: job.runId ?? command.id,
                  },
                },
              });
            await tx.conversation.update({
              where: { id: c.id },
              data: { syncComplete: false },
            });
          }
          await publishEvent(tx, account.ownerId, {
            type: 'conversation.updated',
            channelAccountId: account.id,
            conversationId: c.id,
          });
        }
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            syncCursor: cursor,
            lastSyncAt: new Date(),
            lastSyncError: null,
            syncComplete: false,
          },
        });
        await this.next(tx, command, account, job, cursor);
      });
    } else {
      if (!job.conversationId) throw new TikTokError('CONVERSATION_NOT_FOUND');
      const c = await this.db.conversation.findFirst({
        where: { id: job.conversationId, channelAccountId: account.id },
      });
      if (!c?.externalConversationId)
        throw new TikTokError('CONVERSATION_NOT_FOUND');
      const page = await adapter.messages(
        token,
        c.externalConversationId,
        job.cursor,
      );
      cursor = page.cursor;
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, account))) return;
        for (const message of page.items) {
          if (message.conversationId !== c.externalConversationId)
            throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
          await this.persist(tx, account, message);
        }
        await tx.conversation.update({
          where: { id: c.id },
          data: {
            syncCursor: cursor,
            syncComplete: !cursor,
            lastSyncAt: new Date(),
          },
        });
        await this.next(tx, command, account, job, cursor);
      });
    }
  }
  private async next(
    tx: Prisma.TransactionClient,
    command: PersonalCommand,
    account: ChannelAccount,
    job: z.infer<typeof jobSchema>,
    cursor: string | null,
  ) {
    await tx.personalCommand.update({
      where: { id: command.id },
      data: { status: 'DONE' },
    });
    if (cursor) {
      if (cursor === job.cursor) throw new TikTokError('TIKTOK_CURSOR_INVALID');
      if (job.page >= 99) {
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            syncComplete: false,
            lastSyncError: 'TIKTOK_SYNC_LIMIT_REACHED',
          },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'channel.sync_failed',
          channelAccountId: account.id,
        });
      } else
        await tx.personalCommand.create({
          data: {
            channelAccountId: account.id,
            generation: account.generation,
            kind: command.kind,
            deduplicationKey: `tiktok:next:${command.id}`,
            payload: { ...job, cursor, page: job.page + 1 },
          },
        });
    } else {
      const incomplete = await tx.conversation.count({
        where: { channelAccountId: account.id, syncComplete: false },
      });
      const pending = await tx.personalCommand.count({
        where: {
          channelAccountId: account.id,
          generation: account.generation,
          kind: { in: ['SYNC', 'SYNC_MESSAGES'] },
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      });
      const current = await tx.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (
        !incomplete &&
        !pending &&
        !current.syncCursor &&
        !current.lastSyncError
      )
        await tx.channelAccount.update({
          where: { id: account.id },
          data: { syncComplete: true, lastSyncAt: new Date() },
        });
    }
  }
  private async send(
    command: PersonalCommand,
    account: ChannelAccount,
    token: Awaited<ReturnType<TikTokTokenService['get']>>,
    active: () => boolean,
  ) {
    const message = command.messageId
      ? await this.db.message.findUnique({
          where: { id: command.messageId },
          include: { conversation: true },
        })
      : null;
    if (!message || message.deliveryStatus !== 'PENDING') {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      return;
    }
    const last = await this.db.channelAccount.aggregate({
      where: {
        channelType: account.channelType,
        externalAccountId: account.externalAccountId,
      },
      _max: { lastSendAt: true },
    });
    const nextAt = (last._max.lastSendAt?.getTime() ?? 0) + 2000;
    if (nextAt > Date.now()) {
      await this.db.personalCommand.update({
        where: { id: command.id },
        data: {
          status: 'PENDING',
          attempts: { decrement: 1 },
          availableAt: new Date(nextAt),
        },
      });
      return;
    }
    const claimed = await this.db.$transaction(async (tx) => {
      const current = await this.lock(tx, account);
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: message.conversationId },
      });
      const policy = current
        ? channelSendPolicy(current, conversation, true)
        : null;
      if (!policy?.allowed)
        throw new TikTokError(policy?.code ?? 'CHANNEL_NOT_CONNECTED');
      if (account.channelType === 'TIKTOK_BUSINESS') {
        const count = await tx.message.count({
          where: {
            conversationId: conversation.id,
            direction: 'OUTGOING',
            sentAt: { gte: conversation.lastInboundAt! },
            deliveryStatus: { in: ['SENDING', 'SENT', 'UNKNOWN'] },
          },
        });
        if (count >= 10) throw new TikTokError('TIKTOK_REPLY_LIMIT_REACHED');
      }
      const changed = await tx.message.updateMany({
        where: { id: message.id, deliveryStatus: 'PENDING' },
        data: {
          deliveryStatus: 'SENDING',
          sendingAt: new Date(),
          sendAttempts: { increment: 1 },
          deliveryError: null,
        },
      });
      if (changed.count)
        await tx.channelAccount.update({
          where: { id: account.id },
          data: { lastSendAt: new Date() },
        });
      return changed.count > 0;
    });
    if (!claimed || !active()) return;
    const externalMessageId = await this.registry
      .adapter(account.channelType as TikTokType)
      .sendText(
        token,
        message.conversation.externalConversationId!,
        message.content,
      );
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      if (!(await this.lock(tx, account))) return;
      const saved = await tx.message.findUniqueOrThrow({
        where: { id: message.id },
      });
      if (saved.deliveryStatus !== 'SENDING') return;
      const echo = await tx.message.findUnique({
        where: {
          channelAccountId_externalMessageId: {
            channelAccountId: account.id,
            externalMessageId,
          },
        },
      });
      if (echo && echo.id !== message.id) {
        if (
          echo.conversationId !== message.conversationId ||
          echo.direction !== 'OUTGOING' ||
          echo.idempotencyKey
        )
          throw new TikTokError('TIKTOK_ACCOUNT_MISMATCH');
        await tx.message.delete({ where: { id: echo.id } });
      }
      await tx.message.update({
        where: { id: message.id },
        data: {
          externalMessageId,
          deliveryStatus: 'SENT',
          deliveryError: null,
          ...(echo ? { sentAt: echo.sentAt, readAt: echo.readAt } : {}),
        },
      });
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      await publishEvent(tx, account.ownerId, {
        type: 'message.status_changed',
        channelAccountId: account.id,
        conversationId: message.conversationId,
        messageId: message.id,
      });
    });
  }
  async processInbound(id: string) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "WebhookEvent" WHERE "id"=${id} FOR UPDATE`;
        const receipt = await tx.webhookEvent.findUniqueOrThrow({
          where: { id },
        });
        if (
          ['PROCESSED', 'IGNORED'].includes(receipt.status) ||
          !receipt.channelAccountId
        )
          return;
        await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "id"=${receipt.channelAccountId} FOR UPDATE`;
        const account = await tx.channelAccount.findUniqueOrThrow({
          where: { id: receipt.channelAccountId },
        });
        const event = inboundSchema.parse(receipt.payload);
        if (
          account.connectionStatus === 'DISCONNECTED' ||
          (event.kind === 'revoked' &&
            event.generation !== undefined &&
            event.generation !== account.generation) ||
          (event.kind === 'revoked' &&
            event.at !== undefined &&
            account.lastConnectedAt &&
            event.at <
              Math.floor(account.lastConnectedAt.getTime() / 1000) * 1000) ||
          account.externalAccountId !== event.accountId ||
          account.channelType !== event.channelType
        ) {
          await tx.webhookEvent.update({
            where: { id },
            data: { status: 'IGNORED', processedAt: new Date() },
          });
          return;
        }
        if (event.kind === 'message')
          await this.persist(tx, account, {
            ...event.message,
            at: new Date(event.message.at),
          });
        else if (event.kind === 'read') {
          const c = await tx.conversation.findFirst({
            where: {
              channelAccountId: account.id,
              externalConversationId: event.conversationId,
            },
          });
          if (c) {
            const changed = await tx.message.findMany({
              where: {
                channelAccountId: account.id,
                conversationId: c.id,
                direction: 'OUTGOING',
                deliveryStatus: 'SENT',
                readAt: null,
                sentAt: { lte: new Date(event.watermark) },
              },
              select: { id: true },
              take: 201,
            });
            const batch = changed.slice(0, 200);
            await tx.message.updateMany({
              where: { id: { in: batch.map((m) => m.id) } },
              data: { readAt: new Date(event.at) },
            });
            for (const m of batch)
              await publishEvent(tx, account.ownerId, {
                type: 'message.status_changed',
                channelAccountId: account.id,
                conversationId: c.id,
                messageId: m.id,
              });
            if (changed.length > 200) return;
          }
        } else if (event.kind === 'sync') {
          const conversation = await tx.conversation.upsert({
            where: {
              channelAccountId_externalUserId_externalThreadType: {
                channelAccountId: account.id,
                externalUserId: event.conversationId,
                externalThreadType: account.channelType,
              },
            },
            create: {
              channelAccountId: account.id,
              externalUserId: event.conversationId,
              externalThreadType: account.channelType,
              externalConversationId: event.conversationId,
            },
            update: {},
          });
          const pending = await tx.personalCommand.findFirst({
            where: {
              channelAccountId: account.id,
              generation: account.generation,
              kind: 'SYNC_MESSAGES',
              status: { in: ['PENDING', 'PROCESSING'] },
              payload: { path: ['conversationId'], equals: conversation.id },
            },
          });
          if (!pending)
            await tx.personalCommand.create({
              data: {
                channelAccountId: account.id,
                generation: account.generation,
                kind: 'SYNC_MESSAGES',
                deduplicationKey: `tiktok:webhook:${receipt.id}`,
                payload: { conversationId: conversation.id, page: 0 },
              },
            });
        } else if (event.kind === 'revoked') {
          await tx.channelAccount.update({
            where: { id: account.id },
            data: {
              generation: { increment: 1 },
              connectionStatus: 'REAUTH_REQUIRED',
              encryptedCredentials: null,
              capabilities: {},
              lastError: 'TIKTOK_TOKEN_EXPIRED',
            },
          });
          await tx.personalCommand.updateMany({
            where: {
              channelAccountId: account.id,
              status: { in: ['PENDING', 'PROCESSING'] },
            },
            data: { status: 'FAILED' },
          });
          await tx.message.updateMany({
            where: { channelAccountId: account.id, deliveryStatus: 'PENDING' },
            data: {
              deliveryStatus: 'FAILED',
              deliveryError: 'TIKTOK_TOKEN_EXPIRED',
            },
          });
          await tx.message.updateMany({
            where: { channelAccountId: account.id, deliveryStatus: 'SENDING' },
            data: {
              deliveryStatus: 'UNKNOWN',
              deliveryError: 'TIKTOK_SEND_UNKNOWN',
            },
          });
          await publishEvent(tx, account.ownerId, {
            type: 'channel.reauth_required',
            channelAccountId: account.id,
          });
        }
        await tx.webhookEvent.update({
          where: { id },
          data: {
            status: 'PROCESSED',
            error: null,
            processedAt: new Date(),
            attempts: { increment: 1 },
          },
        });
      });
    } catch {
      await this.db.webhookEvent.updateMany({
        where: { id, status: { not: 'PROCESSED' } },
        data: {
          status: 'FAILED',
          error: 'TIKTOK_PERSISTENCE_FAILED',
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    }
  }
}
