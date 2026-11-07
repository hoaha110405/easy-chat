import { MediaStore } from '../../common/media-store';
import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { MessageStore } from '../inbox/message-store';
import { publishEvent } from '../realtime/publish';
import { channelSendPolicy } from '../messaging/channel-policy';
import {
  TelegramBotClient,
  mapBotMessage,
} from '../telegram-bot/telegram-bot.client';
import { TdLibManager } from '../telegram-personal/tdlib.manager';
import { mapTdMessage, tdChatSchema } from '../telegram-personal/tdlib.mapper';
import { TelegramSettings } from './telegram.config';
import { TelegramRpcServer } from './telegram.rpc';
import {
  TelegramReceipts,
  telegramReceiptSchema,
} from './telegram-receipts.service';
import { TelegramService } from './telegram.service';
import {
  TelegramError,
  botCredentialsSchema,
  telegramId,
  telegramMessageKey,
  type TelegramMessage,
} from './telegram.types';
const jobSchema = z.object({
  conversationId: z.string().cuid().optional(),
  cursor: telegramId.nullable().optional(),
  list: z.enum(['main', 'archive']).default('main'),
  page: z.number().int().min(0).max(100).default(0),
  drain: z.boolean().default(false),
  loadComplete: z.boolean().default(false),
});
@Injectable()
export class TelegramWorker {
  private active = false;
  private lastPoll = 0;
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: TelegramSettings,
    private readonly bot: TelegramBotClient,
    private readonly native: TdLibManager,
    private readonly rpc: TelegramRpcServer,
    private readonly receipts: TelegramReceipts,
    private readonly service: TelegramService,
    private readonly messages: MessageStore,
    @Optional() private readonly media?: MediaStore,
  ) {}
  async start() {
    this.active = true;
    this.receipts.setProcessor((id) =>
      this.active ? this.processInbound(id) : Promise.resolve(),
    );
    if (this.settings.personalEnabled)
      await this.rpc.start((request) =>
        request.action === 'download'
          ? this.downloadMedia(
              request.ownerId,
              request.accountId!,
              request.value!,
            )
          : this.native.rpc(request),
      );
    await this.native.poll();
  }
  async stop() {
    this.active = false;
    this.receipts.setProcessor(undefined);
    await this.native.stop();
    await this.rpc.close();
  }
  private async downloadMedia(
    ownerId: string,
    accountId: string,
    messageId: string,
  ) {
    const m = await this.db.message.findFirst({
      where: {
        id: z.string().cuid().parse(messageId),
        channelAccountId: accountId,
        deletedAt: null,
        channelAccount: {
          ownerId,
          channelType: 'TELEGRAM_PERSONAL',
          connectionStatus: 'CONNECTED',
        },
      },
      include: { channelAccount: true },
    });
    if (!m?.channelAccount || !this.media)
      throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
    const value = z
      .object({
        telegram: z.object({
          media: z.object({
            fileId: z.string(),
            name: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        }),
      })
      .parse(m.metadata);
    const bytes = await this.native.downloadMedia(
      m.channelAccount,
      value.telegram.media.fileId,
    );
    await this.db.$transaction(async (tx) => {
      if (
        !(await this.lock(tx, m.channelAccount!)) ||
        (
          await tx.message.findUnique({
            where: { id: m.id },
            select: { deletedAt: true },
          })
        )?.deletedAt
      )
        throw new TelegramError('TELEGRAM_NOT_CONNECTED');
      await this.media!.put(tx, m.id, {
        bytes,
        size: bytes.length,
        name:
          value.telegram.media.name ??
          (m.type === 'audio' ? 'telegram-audio.ogg' : 'telegram-document'),
        mime: value.telegram.media.mimeType ?? 'application/octet-stream',
      });
    });
    return { ready: true };
  }
  private async lock(tx: Prisma.TransactionClient, account: ChannelAccount) {
    return (
      await tx.$queryRaw<
        ChannelAccount[]
      >`SELECT * FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`
    )[0];
  }
  async enqueue(ownerId: string, accountId: string, conversationId?: string) {
    return this.db.$transaction(async (tx) => {
      const a = await tx.channelAccount.findFirst({
        where: {
          id: accountId,
          ownerId,
          channelType: { in: ['TELEGRAM_BOT', 'TELEGRAM_PERSONAL'] },
        },
      });
      if (!a)
        throw new ApiError(
          404,
          'CHANNEL_NOT_FOUND',
          'Không tìm thấy tài khoản Telegram.',
        );
      if (!(await this.lock(tx, a)))
        throw new ApiError(
          409,
          'CHANNEL_NOT_CONNECTED',
          'Kết nối lại tài khoản trước khi đồng bộ.',
        );
      if (conversationId && a.channelType === 'TELEGRAM_BOT')
        throw new ApiError(
          409,
          'TELEGRAM_BOT_HISTORY_UNAVAILABLE',
          'Bot API không cung cấp lịch sử chat tùy ý.',
        );
      const c = conversationId
        ? await tx.conversation.findFirst({
            where: { id: conversationId, channelAccountId: a.id },
          })
        : null;
      if (conversationId && !c)
        throw new ApiError(
          404,
          'CONVERSATION_NOT_FOUND',
          'Không tìm thấy hội thoại.',
        );
      const kind = conversationId ? 'SYNC_MESSAGES' : 'SYNC';
      const pending = await tx.personalCommand.findMany({
        where: {
          channelAccountId: a.id,
          generation: a.generation,
          kind,
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      });
      if (
        pending.some(
          (j) =>
            !conversationId ||
            jobSchema.parse(j.payload).conversationId === conversationId,
        )
      )
        return { queued: true };
      let checkpoint: unknown = { list: 'main', page: 0 };
      if (!conversationId && a.syncCursor) {
        try {
          checkpoint = {
            ...jobSchema.parse(JSON.parse(a.syncCursor)),
            page: 0,
          };
        } catch {
          checkpoint = { list: 'main', page: 0 };
        }
      }
      await tx.personalCommand.create({
        data: {
          channelAccountId: a.id,
          generation: a.generation,
          kind,
          deduplicationKey: `telegram:sync:${randomUUID()}`,
          payload: conversationId
            ? { conversationId, cursor: c!.syncCursor, page: 0 }
            : (checkpoint as Prisma.InputJsonObject),
        },
      });
      await tx.channelAccount.update({
        where: { id: a.id },
        data: { syncComplete: false, lastSyncError: null },
      });
      return { queued: true };
    });
  }
  async poll() {
    if (!this.active || Date.now() - this.lastPoll < 10000) return;
    this.lastPoll = Date.now();
    await this.native.poll();
    const stale = await this.db.message.findMany({
      where: {
        source: 'TELEGRAM',
        deliveryStatus: 'SENDING',
        sendingAt: { lt: new Date(Date.now() - 120000) },
      },
      take: 100,
    });
    for (const m of stale)
      await this.db.$transaction(async (tx) => {
        await tx.message.updateMany({
          where: { id: m.id, deliveryStatus: 'SENDING' },
          data: {
            deliveryStatus: 'UNKNOWN',
            deliveryError: 'TELEGRAM_SEND_UNKNOWN',
          },
        });
        const a = m.channelAccountId
          ? await tx.channelAccount.findUnique({
              where: { id: m.channelAccountId },
            })
          : null;
        if (a)
          await publishEvent(tx, a.ownerId, {
            type: 'message.status_changed',
            conversationId: m.conversationId,
            messageId: m.id,
            channelAccountId: a.id,
          });
      });
    const accounts = await this.db.channelAccount.findMany({
      where: {
        channelType: 'TELEGRAM_PERSONAL',
        connectionStatus: 'CONNECTED',
        syncComplete: false,
        syncCursor: null,
        lastSyncError: null,
      },
    });
    for (const a of accounts) {
      const unfinished = await this.db.personalCommand.count({
        where: {
          channelAccountId: a.id,
          generation: a.generation,
          kind: { in: ['SYNC', 'SYNC_MESSAGES'] },
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      });
      const receipts = await this.db.webhookEvent.count({
        where: {
          channelAccountId: a.id,
          status: { in: ['RECEIVED', 'FAILED'] },
        },
      });
      const chats = await this.db.conversation.count({
        where: { channelAccountId: a.id, syncComplete: false },
      });
      if (!unfinished && !receipts && !chats && a.lastSyncAt)
        await this.db.channelAccount.update({
          where: { id: a.id },
          data: { syncComplete: true },
        });
    }
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
      const job = await this.db.personalCommand.findUnique({
        where: { id: command.id },
      });
      if (job?.status !== 'PROCESSING') return;
      if (
        current.generation === command.generation &&
        current.connectionStatus === 'RECONNECTING'
      ) {
        await this.db.personalCommand.updateMany({
          where: { id: command.id, status: 'PROCESSING' },
          data: {
            status: 'PENDING',
            attempts: { decrement: 1 },
            availableAt: new Date(Date.now() + 5000),
          },
        });
        return;
      }
      if (
        (current.channelType === 'TELEGRAM_BOT' && !this.settings.botEnabled) ||
        (current.channelType === 'TELEGRAM_PERSONAL' &&
          !this.settings.personalConfigured)
      )
        throw new TelegramError('TELEGRAM_DISABLED');
      if (
        current.generation !== command.generation ||
        current.connectionStatus !== 'CONNECTED'
      )
        throw new TelegramError('TELEGRAM_NOT_CONNECTED');
      if (command.kind === 'SEND') await this.send(command, current, active);
      else if (command.kind === 'SYNC' || command.kind === 'SYNC_MESSAGES')
        await this.sync(command, current, active);
      else throw new TelegramError('TELEGRAM_OPERATION_UNSUPPORTED');
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
      error instanceof TelegramError ? error.code : 'TELEGRAM_OPERATION_FAILED';
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} FOR UPDATE`;
      const a = await tx.channelAccount.findUnique({
        where: { id: account.id },
      });
      const m = command.messageId
        ? await tx.message.findUnique({ where: { id: command.messageId } })
        : null;
      const ambiguous =
        m?.deliveryStatus === 'SENDING' &&
        (!(error instanceof TelegramError) || error.ambiguous);
      const retry =
        !ambiguous &&
        command.attempts < 3 &&
        a?.generation === command.generation &&
        a.connectionStatus === 'CONNECTED' &&
        error instanceof TelegramError &&
        error.retryable;
      const after = error instanceof TelegramError ? error.retryAfter : null;
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: retry ? 'PENDING' : 'FAILED',
          availableAt: new Date(
            Date.now() +
              (after
                ? after * 1000
                : 2000 * 2 ** Math.min(command.attempts, 5)),
          ),
        },
      });
      if (m && ['PENDING', 'SENDING'].includes(m.deliveryStatus)) {
        await tx.message.update({
          where: { id: m.id },
          data: {
            deliveryStatus: ambiguous
              ? 'UNKNOWN'
              : retry
                ? 'PENDING'
                : 'FAILED',
            deliveryError: ambiguous ? 'TELEGRAM_SEND_UNKNOWN' : code,
          },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'message.status_changed',
          channelAccountId: account.id,
          conversationId: m.conversationId,
          messageId: m.id,
        });
      }
      if (
        a?.generation === command.generation &&
        a.connectionStatus !== 'DISCONNECTED'
      ) {
        await tx.channelAccount.update({
          where: { id: a.id },
          data: {
            ...(code === 'TELEGRAM_REAUTH_REQUIRED'
              ? {
                  connectionStatus: 'REAUTH_REQUIRED',
                  capabilities: {},
                  lastError: code,
                }
              : {}),
            ...(after
              ? { rateLimitedUntil: new Date(Date.now() + after * 1000) }
              : {}),
            ...(command.kind !== 'SEND'
              ? { lastSyncError: code, syncComplete: false }
              : {}),
          },
        });
        if (m && code === 'TELEGRAM_PERMISSION_DENIED') {
          const c = await tx.conversation.findUniqueOrThrow({
            where: { id: m.conversationId },
          });
          const state = z.record(z.unknown()).catch({}).parse(c.providerState);
          await tx.conversation.update({
            where: { id: c.id },
            data: {
              providerState: {
                ...state,
                canSend: false,
              } as Prisma.InputJsonObject,
            },
          });
        }
        await publishEvent(tx, a.ownerId, {
          type:
            code === 'TELEGRAM_REAUTH_REQUIRED'
              ? 'channel.reauth_required'
              : 'channel.sync_failed',
          channelAccountId: a.id,
        });
      }
    });
  }
  private async upsertChat(
    tx: Prisma.TransactionClient,
    a: ChannelAccount,
    input: unknown,
  ) {
    const chat = tdChatSchema.parse(input);
    const privateChat = chat.type['@type'] === 'chatTypePrivate';
    const existing = await tx.conversation.findUnique({
      where: {
        channelAccountId_externalUserId_externalThreadType: {
          channelAccountId: a.id,
          externalUserId: chat.id,
          externalThreadType: a.channelType,
        },
      },
    });
    const previous = z
      .record(z.unknown())
      .catch({})
      .parse(existing?.providerState ?? {});
    const state = {
      ...previous,
      chatType: chat.type['@type'],
      canSend:
        chat.easychat_can_send ??
        (privateChat
          ? chat.permissions?.can_send_basic_messages !== false
          : chat.permissions?.can_send_basic_messages === true),
      topicUnsupported: chat.easychat_topic_unsupported ?? false,
      readInboxId: chat.last_read_inbox_message_id ?? '0',
      readOutboxId: chat.last_read_outbox_message_id ?? '0',
      positions: chat.positions ?? [],
      checkedAt: Date.now(),
    };
    const c = await tx.conversation.upsert({
      where: {
        channelAccountId_externalUserId_externalThreadType: {
          channelAccountId: a.id,
          externalUserId: chat.id,
          externalThreadType: a.channelType,
        },
      },
      create: {
        channelAccountId: a.id,
        externalUserId: chat.id,
        externalConversationId: chat.id,
        externalThreadType: a.channelType,
        externalContactId:
          privateChat && chat.type.user_id !== undefined
            ? telegramId.parse(chat.type.user_id)
            : undefined,
        customerName: chat.title,
        unreadCount: chat.unread_count,
        providerState: state as Prisma.InputJsonObject,
      },
      update: {
        customerName: chat.title,
        unreadCount: chat.unread_count,
        providerState: state as Prisma.InputJsonObject,
      },
    });
    const pending = await tx.personalCommand.findFirst({
      where: {
        channelAccountId: a.id,
        generation: a.generation,
        kind: 'SYNC_MESSAGES',
        status: { in: ['PENDING', 'PROCESSING'] },
        payload: { path: ['conversationId'], equals: c.id },
      },
    });
    if (
      !pending &&
      (!c.syncComplete ||
        !c.lastSyncAt ||
        (chat.last_message &&
          new Date(chat.last_message.date * 1000) > c.lastSyncAt))
    ) {
      await tx.personalCommand.create({
        data: {
          channelAccountId: a.id,
          generation: a.generation,
          kind: 'SYNC_MESSAGES',
          deduplicationKey: `telegram:history:${randomUUID()}`,
          payload: { conversationId: c.id, cursor: c.syncCursor, page: 0 },
        },
      });
      await tx.conversation.update({
        where: { id: c.id },
        data: { syncComplete: false },
      });
    }
    await publishEvent(tx, a.ownerId, {
      type: 'conversation.updated',
      channelAccountId: a.id,
      conversationId: c.id,
    });
    return c;
  }
  private async persist(
    tx: Prisma.TransactionClient,
    a: ChannelAccount,
    m: TelegramMessage,
    currentSnapshot = false,
  ) {
    if (
      m.at.getTime() > Date.now() + 60000 ||
      m.at.getTime() < Date.UTC(2010, 0, 1)
    )
      throw new TelegramError('TELEGRAM_INVALID_RESPONSE');
    // Durable delete receipts also act as tombstones for history pages in flight.
    if (
      a.channelType === 'TELEGRAM_PERSONAL' &&
      (await tx.webhookEvent.findFirst({
        where: {
          channelAccountId: a.id,
          eventName: 'telegram.personal',
          status: { not: 'IGNORED' },
          AND: [
            { payload: { path: ['kind'], equals: 'delete' } },
            { payload: { path: ['data', 'chatId'], equals: m.chatId } },
            {
              payload: { path: ['data', 'messageIds'], array_contains: [m.id] },
            },
          ],
        },
        select: { id: true },
      }))
    )
      return null;
    const saved = await this.messages.persistChannel(
      tx,
      a.id,
      {
        oaId: '',
        userId: m.chatId,
        externalConversationId: m.chatId,
        externalThreadType: a.channelType,
        externalContactId: m.chatType === 'private' ? m.chatId : undefined,
        externalMessageId: telegramMessageKey(m.chatId, m.id),
        direction: m.direction,
        type: m.type,
        content: m.content,
        sentAt: m.at,
        source: 'TELEGRAM',
        customerName: m.title,
        metadata: {
          attachments: m.media
            ? [
                {
                  type: m.type,
                  payload: {
                    name:
                      m.media.name ??
                      (m.type === 'audio' ? 'Âm thanh' : 'Tài liệu'),
                  },
                },
              ]
            : [],
          telegram: {
            chatId: m.chatId,
            messageId: m.id,
            senderName: m.senderName ?? null,
            ...(m.media ? { media: m.media } : {}),
          },
        },
      },
      m.senderId,
    );
    const c = await tx.conversation.findUniqueOrThrow({
      where: { id: saved.conversationId },
    });
    const state = z.record(z.unknown()).catch({}).parse(c.providerState);
    if (a.channelType === 'TELEGRAM_BOT' || m.topic)
      await tx.conversation.update({
        where: { id: c.id },
        data: {
          providerState: {
            ...state,
            chatType: m.chatType ?? state.chatType ?? 'unknown',
            ...(a.channelType === 'TELEGRAM_BOT'
              ? {
                  canSend:
                    m.chatType !== 'channel' &&
                    !m.topic &&
                    state.canSend !== false,
                }
              : {}),
            ...(m.topic ? { canSend: false, topicUnsupported: true } : {}),
          } as Prisma.InputJsonObject,
        },
      });
    const stored = await tx.message.findUniqueOrThrow({
      where: { id: saved.messageId },
    });
    const previousMedia = z
      .object({
        telegram: z.object({
          media: z.object({ fileId: z.string() }).optional(),
        }),
      })
      .safeParse(stored.metadata).data?.telegram.media?.fileId;
    if (
      !stored.deletedAt &&
      (currentSnapshot || m.editedAt) &&
      previousMedia !== m.media?.fileId
    )
      await tx.messageMedia.deleteMany({ where: { messageId: stored.id } });
    if (
      !stored.deletedAt &&
      (currentSnapshot ||
        (m.editedAt && (!stored.editedAt || m.editedAt > stored.editedAt)))
    )
      await tx.message.update({
        where: { id: stored.id },
        data: {
          content: m.content,
          type: m.type,
          ...(m.editedAt ? { editedAt: m.editedAt } : {}),
          metadata: {
            ...z.record(z.unknown()).parse(stored.metadata),
            telegram: {
              chatId: m.chatId,
              messageId: m.id,
              senderName: m.senderName ?? null,
              ...(m.media ? { media: m.media } : {}),
            },
            attachments: m.media
              ? [
                  {
                    type: m.type,
                    payload: {
                      name:
                        m.media.name ??
                        (m.type === 'audio' ? 'Âm thanh' : 'Tài liệu'),
                    },
                  },
                ]
              : [],
          } as Prisma.InputJsonObject,
        },
      });
    if (!saved.duplicate || m.editedAt || currentSnapshot) {
      await this.preview(tx, c.id);
      await publishEvent(tx, a.ownerId, {
        type: saved.duplicate ? 'message.updated' : 'message.created',
        channelAccountId: a.id,
        conversationId: c.id,
        messageId: saved.messageId,
      });
    }
    return saved;
  }
  private async preview(tx: Prisma.TransactionClient, id: string) {
    const latest = await tx.message.findFirst({
      where: { conversationId: id },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    });
    if (latest)
      await tx.conversation.update({
        where: { id },
        data: {
          lastMessageAt: latest.sentAt,
          lastMessagePreview: latest.deletedAt
            ? '[deleted]'
            : (latest.content || `[${latest.type}]`).slice(0, 280),
        },
      });
  }
  private async sync(
    command: PersonalCommand,
    a: ChannelAccount,
    active: () => boolean,
  ) {
    const job = jobSchema.parse(command.payload);
    if (a.channelType === 'TELEGRAM_BOT') {
      if (command.kind === 'SYNC_MESSAGES')
        throw new TelegramError('TELEGRAM_BOT_HISTORY_UNAVAILABLE');
      await this.service.verifyBot(a);
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      return;
    }
    if (command.kind === 'SYNC') {
      const page = await this.native.chats(a, job.list, !job.drain);
      if (!active()) return;
      const known = await this.db.conversation.findMany({
        where: { channelAccountId: a.id },
        select: { externalConversationId: true },
      });
      const ids = new Set(known.map((c) => c.externalConversationId));
      const missing = page.chats.filter((c) => !ids.has(c.id));
      for (const chat of missing.slice(0, 100)) {
        if (!active()) return;
        await this.db.$transaction(async (tx) => {
          if (await this.lock(tx, a)) await this.upsertChat(tx, a, chat);
        });
      }
      const complete = job.drain ? job.loadComplete : page.complete;
      const next =
        missing.length > 100
          ? { ...job, drain: true, loadComplete: complete }
          : complete
            ? job.list === 'main'
              ? { ...job, list: 'archive' as const, drain: false, page: 0 }
              : null
            : { ...job, drain: false, page: job.page + 1 };
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, a))) return;
        await this.finish(tx, command, a, next);
        await tx.channelAccount.update({
          where: { id: a.id },
          data: {
            syncCursor: next ? JSON.stringify(next) : null,
            lastSyncAt: new Date(),
            lastSyncError:
              next && next.page >= 100 ? 'TELEGRAM_SYNC_LIMIT_REACHED' : null,
            syncComplete: false,
          },
        });
      });
    } else {
      const c = job.conversationId
        ? await this.db.conversation.findFirst({
            where: { id: job.conversationId, channelAccountId: a.id },
          })
        : null;
      if (!c?.externalConversationId)
        throw new TelegramError('TELEGRAM_CHAT_UNAVAILABLE');
      const result = await this.native.history(
        a,
        c.externalConversationId,
        job.cursor,
      );
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, a))) return;
        for (const raw of result.items) {
          if (raw.chat_id !== c.externalConversationId)
            throw new TelegramError('TELEGRAM_ACCOUNT_MISMATCH');
          await this.persist(tx, a, {
            ...mapTdMessage(raw),
            title: result.chat.title,
            chatType: result.chat.type['@type'],
          });
        }
        await tx.conversation.update({
          where: { id: c.id },
          data: {
            syncCursor: result.cursor,
            syncComplete: !result.cursor,
            lastSyncAt: new Date(),
          },
        });
        await this.finish(
          tx,
          command,
          a,
          result.cursor
            ? { ...job, cursor: result.cursor, page: job.page + 1 }
            : null,
        );
      });
    }
  }
  private async finish(
    tx: Prisma.TransactionClient,
    command: PersonalCommand,
    a: ChannelAccount,
    next: z.infer<typeof jobSchema> | null,
  ) {
    await tx.personalCommand.updateMany({
      where: { id: command.id, status: 'PROCESSING' },
      data: { status: 'DONE' },
    });
    if (next) {
      if (next.page >= 100) {
        await tx.channelAccount.update({
          where: { id: a.id },
          data: {
            lastSyncError: 'TELEGRAM_SYNC_LIMIT_REACHED',
            syncComplete: false,
          },
        });
        return;
      }
      await tx.personalCommand.create({
        data: {
          channelAccountId: a.id,
          generation: a.generation,
          kind: command.kind,
          deduplicationKey: `telegram:next:${command.id}`,
          payload: next,
        },
      });
    }
  }
  private async send(
    command: PersonalCommand,
    a: ChannelAccount,
    active: () => boolean,
  ) {
    const m = command.messageId
      ? await this.db.message.findUnique({
          where: { id: command.messageId },
          include: { conversation: true },
        })
      : null;
    if (!m || m.deliveryStatus !== 'PENDING') {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      return;
    }
    const last = await this.db.channelAccount.aggregate({
      where: {
        channelType: a.channelType,
        externalAccountId: a.externalAccountId,
      },
      _max: { lastSendAt: true, rateLimitedUntil: true },
    });
    const state = z
      .record(z.unknown())
      .catch({})
      .parse(m.conversation.providerState);
    const wait = Math.max(
      (last._max.lastSendAt?.getTime() ?? 0) +
        (state.chatType === 'group' ||
        state.chatType === 'supergroup' ||
        state.chatType === 'chatTypeBasicGroup' ||
        state.chatType === 'chatTypeSupergroup'
          ? 3100
          : 1100),
      last._max.rateLimitedUntil?.getTime() ?? 0,
    );
    if (wait > Date.now()) {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          availableAt: new Date(wait),
          attempts: { decrement: 1 },
        },
      });
      return;
    }
    let file: Awaited<ReturnType<MediaStore['read']>> | undefined;
    if (m.type === 'file' || m.type === 'audio') {
      if (!this.media) throw new TelegramError('TELEGRAM_MEDIA_UNAVAILABLE');
      file = await this.media.read(m.id);
    }
    const claimed = await this.db.$transaction(async (tx) => {
      const current = await this.lock(tx, a);
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: m.conversationId },
      });
      const policy = current
        ? channelSendPolicy(current, conversation, true)
        : null;
      if (!policy?.allowed)
        throw new TelegramError(policy?.code ?? 'TELEGRAM_NOT_CONNECTED');
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
      return changed.count > 0;
    });
    if (!claimed || !active()) return;
    let result: TelegramMessage;
    if (a.channelType === 'TELEGRAM_BOT') {
      const credentials = botCredentialsSchema.parse(
        JSON.parse(this.crypto.decrypt(a.encryptedCredentials!)),
      );
      result = mapBotMessage(
        file
          ? await this.bot.sendMedia(
              credentials.token,
              m.conversation.externalConversationId!,
              file,
              m.type === 'audio' ? 'audio' : 'document',
              m.content,
            )
          : await this.bot.sendText(
              credentials.token,
              m.conversation.externalConversationId!,
              m.content,
            ),
        a.externalAccountId!,
      );
    } else
      result = mapTdMessage(
        await (
          file
            ? this.native.sendMedia.bind(
                this.native,
                a,
                m.conversation.externalConversationId!,
                file,
                m.type === 'audio' ? 'audio' : 'document',
              )
            : this.native.send.bind(
                this.native,
                a,
                m.conversation.externalConversationId!,
              )
        )(m.content, async (temporary) => {
          await this.db.message.updateMany({
            where: { id: m.id, deliveryStatus: 'SENDING' },
            data: {
              metadata: {
                ...z.record(z.unknown()).parse(m.metadata),
                telegram: {
                  chatId: m.conversation.externalConversationId!,
                  temporaryMessageId: temporary,
                },
              },
            },
          });
        }),
      );
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      if (!(await this.lock(tx, a))) return;
      await this.finalize(tx, a, m.id, result);
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
    });
  }
  private async finalize(
    tx: Prisma.TransactionClient,
    a: ChannelAccount,
    id: string,
    message: TelegramMessage,
  ) {
    const m = await tx.message.findUniqueOrThrow({ where: { id } });
    if (!['SENDING', 'UNKNOWN'].includes(m.deliveryStatus)) return;
    const key = telegramMessageKey(message.chatId, message.id);
    const echo = await tx.message.findUnique({
      where: {
        channelAccountId_externalMessageId: {
          channelAccountId: a.id,
          externalMessageId: key,
        },
      },
    });
    if (echo && echo.id !== id) {
      if (
        echo.conversationId !== m.conversationId ||
        echo.direction !== 'OUTGOING' ||
        echo.idempotencyKey
      )
        throw new TelegramError('TELEGRAM_ACCOUNT_MISMATCH');
      await tx.message.delete({ where: { id: echo.id } });
    }
    await tx.message.update({
      where: { id },
      data: {
        externalMessageId: key,
        sentAt: message.at,
        deliveryStatus: 'SENT',
        deliveryError: null,
        ...(echo ? { readAt: echo.readAt } : {}),
        metadata: {
          ...z.record(z.unknown()).parse(m.metadata),
          telegram: {
            chatId: message.chatId,
            messageId: message.id,
            ...(message.media ? { media: message.media } : {}),
          },
          attachments:
            z
              .object({ attachments: z.array(z.unknown()) })
              .safeParse(m.metadata).data?.attachments ?? [],
        } as Prisma.InputJsonObject,
      },
    });
    await this.preview(tx, m.conversationId);
    await publishEvent(tx, a.ownerId, {
      type: 'message.status_changed',
      channelAccountId: a.id,
      conversationId: m.conversationId,
      messageId: id,
    });
  }
  async processInbound(id: string) {
    try {
      await this.db.$transaction(
        async (tx) => {
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
          const a = await tx.channelAccount.findUniqueOrThrow({
            where: { id: receipt.channelAccountId },
          });
          const event = telegramReceiptSchema.parse(receipt.payload);
          if (a.connectionStatus === 'CONNECTING') return;
          if (
            a.connectionStatus === 'DISCONNECTED' ||
            (event.generation !== a.generation &&
              ['chat', 'member', 'send_failed'].includes(event.kind))
          ) {
            await tx.webhookEvent.update({
              where: { id },
              data: { status: 'IGNORED', processedAt: new Date() },
            });
            return;
          }
          if (event.kind === 'chat') await this.upsertChat(tx, a, event.data);
          else if (event.kind === 'message' || event.kind === 'edit') {
            let normalized: TelegramMessage;
            if (a.channelType === 'TELEGRAM_BOT')
              normalized = mapBotMessage(event.data, a.externalAccountId!);
            else if (event.kind === 'edit') {
              const data = z
                .object({ chatId: telegramId, messageId: telegramId })
                .parse(event.data);
              normalized = mapTdMessage(
                await this.native.getMessage(a, data.chatId, data.messageId),
              );
            } else {
              normalized = {
                ...mapTdMessage(event.data.message),
                title:
                  typeof event.data.title === 'string'
                    ? event.data.title
                    : undefined,
                chatType:
                  typeof event.data.chatType === 'string'
                    ? event.data.chatType
                    : undefined,
                senderName:
                  typeof event.data.senderName === 'string'
                    ? event.data.senderName
                    : undefined,
              };
            }
            await this.persist(
              tx,
              a,
              normalized,
              a.channelType === 'TELEGRAM_PERSONAL' && event.kind === 'edit',
            );
          } else if (
            event.kind === 'send_succeeded' ||
            event.kind === 'send_failed'
          ) {
            const m = mapTdMessage(event.data.message);
            const temporary = telegramId.parse(event.data.oldMessageId);
            const pending = await tx.message.findFirst({
              where: {
                channelAccountId: a.id,
                direction: 'OUTGOING',
                deliveryStatus: { in: ['SENDING', 'UNKNOWN'] },
                conversation: { externalConversationId: m.chatId },
                metadata: {
                  path: ['telegram', 'temporaryMessageId'],
                  equals: temporary,
                },
              },
            });
            if (event.kind === 'send_succeeded') {
              if (pending) await this.finalize(tx, a, pending.id, m);
              else await this.persist(tx, a, m);
            } else if (pending?.deliveryStatus === 'UNKNOWN')
              await tx.message.update({
                where: { id: pending.id },
                data: {
                  deliveryStatus: 'FAILED',
                  deliveryError: 'TELEGRAM_SEND_FAILED',
                },
              });
          } else if (event.kind === 'delete') {
            const data = z
              .object({
                chatId: telegramId,
                messageIds: z.array(telegramId).max(10000),
              })
              .parse(event.data);
            const affected = await tx.message.findMany({
              where: {
                channelAccountId: a.id,
                externalMessageId: {
                  in: data.messageIds.map((mid) =>
                    telegramMessageKey(data.chatId, mid),
                  ),
                },
              },
              select: { id: true, conversationId: true },
            });
            await tx.message.updateMany({
              where: { id: { in: affected.map((m) => m.id) } },
              data: {
                content: '',
                metadata: { attachments: [] },
                deletedAt: new Date(event.at),
                inboxUnread: false,
              },
            });
            for (const c of new Set(affected.map((m) => m.conversationId))) {
              await this.preview(tx, c);
              await publishEvent(tx, a.ownerId, {
                type: 'conversation.updated',
                channelAccountId: a.id,
                conversationId: c,
              });
            }
          } else if (event.kind === 'member') {
            const update = z
              .object({
                chat: z.object({
                  id: telegramId,
                  type: z.string(),
                  title: z.string().optional(),
                }),
                date: z.number().int().optional(),
                new_chat_member: z.object({
                  status: z.string(),
                  can_send_messages: z.boolean().optional(),
                  is_member: z.boolean().optional(),
                }),
              })
              .parse(event.data);
            const c = await tx.conversation.findFirst({
              where: {
                channelAccountId: a.id,
                externalConversationId: update.chat.id,
              },
            });
            if (c) {
              const previous = z
                .record(z.unknown())
                .catch({})
                .parse(c.providerState);
              if (
                typeof previous.membershipAt === 'number' &&
                update.date &&
                update.date < previous.membershipAt
              ) {
                await tx.webhookEvent.update({
                  where: { id },
                  data: { status: 'IGNORED', processedAt: new Date() },
                });
                return;
              }
              await tx.conversation.update({
                where: { id: c.id },
                data: {
                  providerState: {
                    ...previous,
                    membershipAt: update.date ?? 0,
                    canSend:
                      !['kicked', 'left'].includes(
                        update.new_chat_member.status,
                      ) &&
                      update.new_chat_member.can_send_messages !== false &&
                      update.new_chat_member.is_member !== false,
                  } as Prisma.InputJsonObject,
                },
              });
              await publishEvent(tx, a.ownerId, {
                type: 'conversation.updated',
                conversationId: c.id,
                channelAccountId: a.id,
              });
            }
          } else {
            const data = z
              .object({
                chatId: telegramId,
                watermark: telegramId,
                unreadCount: z.number().int().nonnegative().optional(),
                privateChat: z.boolean(),
              })
              .parse(event.data);
            const c = await tx.conversation.findFirst({
              where: {
                channelAccountId: a.id,
                externalConversationId: data.chatId,
              },
            });
            if (c) {
              const state = z
                .record(z.unknown())
                .catch({})
                .parse(c.providerState);
              const field =
                event.kind === 'read_inbox' ? 'readInboxId' : 'readOutboxId';
              const before =
                typeof state[field] === 'string'
                  ? (state[field] as string)
                  : '0';
              if (BigInt(data.watermark) >= BigInt(before))
                await tx.conversation.update({
                  where: { id: c.id },
                  data: {
                    ...(event.kind === 'read_inbox'
                      ? { unreadCount: data.unreadCount }
                      : {}),
                    providerState: {
                      ...state,
                      [field]: data.watermark,
                    } as Prisma.InputJsonObject,
                  },
                });
              if (event.kind === 'read_outbox' && data.privateChat) {
                const changed = await tx.$queryRaw<
                  { id: string }[]
                >`SELECT "id" FROM "Message" WHERE "conversationId"=${c.id} AND "direction"='OUTGOING' AND "deliveryStatus"='SENT' AND "readAt" IS NULL AND "externalMessageId" IS NOT NULL AND split_part("externalMessageId",':',2)::numeric <= ${data.watermark}::numeric LIMIT 201`;
                await tx.message.updateMany({
                  where: { id: { in: changed.slice(0, 200).map((m) => m.id) } },
                  data: { readAt: new Date(event.at) },
                });
                if (changed.length > 200) return;
              }
              await publishEvent(tx, a.ownerId, {
                type: 'conversation.updated',
                conversationId: c.id,
                channelAccountId: a.id,
              });
            }
          }
          await tx.webhookEvent.update({
            where: { id },
            data: {
              status: 'PROCESSED',
              processedAt: new Date(),
              error: null,
              attempts: { increment: 1 },
            },
          });
        },
        { timeout: 20000 },
      );
    } catch {
      await this.db.webhookEvent.updateMany({
        where: { id, status: { not: 'PROCESSED' } },
        data: {
          status: 'FAILED',
          error: 'TELEGRAM_PERSISTENCE_FAILED',
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    }
  }
}
