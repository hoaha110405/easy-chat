import { MediaStore } from '../../common/media-store';
import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { MessageStore, type NormalizedMessage } from '../inbox/message-store';
import { publishEvent } from '../realtime/publish';
import { channelSendPolicy } from '../messaging/channel-policy';
import {
  FacebookGraphClient,
  FacebookGraphError,
  type FacebookMessage,
} from './facebook-graph.client';
import type { FacebookWebhookPayload } from './facebook-webhook';

const credentialsSchema = z.object({
  pageId: z.string().min(1),
  accessToken: z.string().min(1),
});
const jobSchema = z.object({
  conversationId: z.string().cuid().optional(),
  after: z.string().max(4096).nullable().optional(),
  runId: z.string().max(80).optional(),
  page: z.number().int().min(0).max(200).optional(),
  profileOnly: z.boolean().optional(),
});
const MAX_SYNC_PAGES = 200;
@Injectable()
export class FacebookPageWorker {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly graph: FacebookGraphClient,
    private readonly messages: MessageStore,
    @Optional() private readonly media?: MediaStore,
  ) {}
  private token(account: ChannelAccount) {
    try {
      const credentials = credentialsSchema.parse(
        JSON.parse(this.crypto.decrypt(account.encryptedCredentials!)),
      );
      if (credentials.pageId !== account.externalAccountId) throw new Error();
      return credentials.accessToken;
    } catch {
      throw new FacebookGraphError(
        'FACEBOOK_REAUTH_REQUIRED',
        'The stored Page authorization cannot be restored. Connect the Page again.',
      );
    }
  }
  private async lock(tx: Prisma.TransactionClient, account: ChannelAccount) {
    const rows = await tx.$queryRaw<
      ChannelAccount[]
    >`SELECT * FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "channelType"='FACEBOOK_PAGE' AND "connectionStatus"='CONNECTED' FOR UPDATE`;
    return rows[0];
  }
  async enqueue(ownerId: string, accountId: string, conversationId?: string) {
    return this.db.$transaction(async (tx) => {
      const account = await tx.channelAccount.findFirst({
        where: { id: accountId, ownerId, channelType: 'FACEBOOK_PAGE' },
      });
      if (!account)
        throw new ApiError(
          404,
          'CHANNEL_NOT_FOUND',
          'Không tìm thấy Facebook Page.',
        );
      if (!(await this.lock(tx, account)))
        throw new ApiError(
          409,
          'CHANNEL_NOT_CONNECTED',
          'Kết nối lại Page trước khi đồng bộ.',
        );
      const conversation = conversationId
        ? await tx.conversation.findFirst({
            where: { id: conversationId, channelAccountId: account.id },
          })
        : null;
      if (conversationId && !conversation?.externalConversationId)
        throw new ApiError(
          409,
          'FACEBOOK_HISTORY_UNAVAILABLE',
          'Hội thoại chưa có mã lịch sử từ Meta. Hãy đồng bộ Page trước.',
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
            (!jobSchema.parse(c.payload).profileOnly &&
              jobSchema.parse(c.payload).conversationId === conversationId),
        )
      )
        return { queued: true };
      const runId = randomUUID();
      if (!conversationId) {
        // A failed/capped older thread may precede the saved Page-list cursor.
        // Resume those checkpoints too, without restarting completed threads or
        // duplicating jobs that another sync already queued. Bound API work.
        const resumable = await tx.$queryRaw<
          { id: string; syncCursor: string | null }[]
        >`
          SELECT c."id",c."syncCursor" FROM "Conversation" c
          WHERE c."channelAccountId"=${account.id} AND c."syncComplete"=false AND c."externalConversationId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "PersonalCommand" j WHERE j."channelAccountId"=${account.id}
            AND j."generation"=${account.generation} AND j."kind"='SYNC_MESSAGES' AND j."status" IN ('PENDING','PROCESSING')
            AND j."payload"->>'conversationId'=c."id" AND j."payload"->>'profileOnly' IS DISTINCT FROM 'true')
          ORDER BY c."id" LIMIT 100`;
        if (resumable.length)
          await tx.personalCommand.createMany({
            data: resumable.map((c) => ({
              channelAccountId: account.id,
              generation: account.generation,
              kind: 'SYNC_MESSAGES' as const,
              deduplicationKey: `facebook:resume:${account.id}:${runId}:${c.id}`,
              payload: {
                conversationId: c.id,
                after: c.syncCursor,
                runId,
                page: 0,
              },
            })),
          });
      }
      await tx.personalCommand.create({
        data: {
          channelAccountId: account.id,
          generation: account.generation,
          kind,
          deduplicationKey: `facebook:${kind}:${account.id}:${runId}`,
          payload: {
            runId,
            page: 0,
            after: conversationId
              ? conversation!.syncCursor
              : account.syncCursor,
            ...(conversationId ? { conversationId } : {}),
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
  async process(
    command: PersonalCommand,
    account: ChannelAccount,
    active: () => boolean,
  ) {
    if (account.channelType !== 'FACEBOOK_PAGE')
      throw new Error('CHANNEL_UNSUPPORTED');
    if (!active()) return;
    try {
      const persisted = await this.db.personalCommand.findUnique({
        where: { id: command.id },
      });
      if (persisted?.status !== 'PROCESSING') return;
      const current = await this.db.channelAccount.findUnique({
        where: { id: account.id },
      });
      if (
        !current ||
        current.generation !== command.generation ||
        current.connectionStatus !== 'CONNECTED'
      )
        throw new ApiError(409, 'CHANNEL_NOT_CONNECTED', 'Page disconnected.');
      account = current;
      if (command.kind === 'SEND') await this.send(command, account, active);
      else if (command.kind === 'SYNC' || command.kind === 'SYNC_MESSAGES')
        await this.sync(command, account, active);
      else
        await this.db.personalCommand.update({
          where: { id: command.id },
          data: { status: 'FAILED' },
        });
    } catch (error) {
      if (!active()) return;
      await this.recoverDispatch(command, account, error);
    }
  }
  async recoverDispatch(
    command: PersonalCommand,
    account: ChannelAccount,
    error?: unknown,
  ) {
    const code =
      error instanceof FacebookGraphError
        ? error.code
        : error instanceof ApiError
          ? error.code
          : 'FACEBOOK_OPERATION_FAILED';
    const reauth =
      error instanceof FacebookGraphError &&
      (error.reauthRequired || error.code === 'FACEBOOK_PERMISSION_DENIED');
    const profileOnly =
      jobSchema.safeParse(command.payload).data?.profileOnly === true;
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
        (!(error instanceof FacebookGraphError) || error.ambiguous);
      const retry =
        !ambiguous &&
        !reauth &&
        command.attempts < 3 &&
        current?.generation === command.generation &&
        current.connectionStatus === 'CONNECTED' &&
        (error === undefined ||
          (error instanceof FacebookGraphError && error.retryable));
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: retry ? 'PENDING' : 'FAILED',
          availableAt: new Date(
            Date.now() + 1000 * 2 ** Math.min(command.attempts, 5),
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
            deliveryError: ambiguous ? 'FACEBOOK_SEND_UNKNOWN' : code,
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
            ...(reauth
              ? { connectionStatus: 'REAUTH_REQUIRED', lastError: code }
              : {}),
            ...(command.kind !== 'SEND' && !profileOnly
              ? { lastSyncError: code, syncComplete: false }
              : {}),
          },
        });
        if (reauth || (command.kind !== 'SEND' && !profileOnly))
          await publishEvent(tx, account.ownerId, {
            type: reauth ? 'channel.reauth_required' : 'channel.sync_failed',
            channelAccountId: account.id,
          });
      }
    });
  }
  private async sync(
    command: PersonalCommand,
    account: ChannelAccount,
    active: () => boolean,
  ) {
    if (
      account.connectionStatus !== 'CONNECTED' ||
      !account.encryptedCredentials
    )
      throw new ApiError(409, 'CHANNEL_NOT_CONNECTED', 'Page disconnected.');
    const payload = jobSchema.parse(command.payload);
    if (command.kind === 'SYNC_MESSAGES' && !payload.conversationId)
      throw new ApiError(
        400,
        'FACEBOOK_INVALID_JOB',
        'A conversation reference is required.',
      );
    const token = this.token(account);
    const pageIndex = payload.page ?? 0;
    const runId = payload.runId ?? command.id;
    if (payload.profileOnly) {
      const conversation = await this.db.conversation.findFirst({
        where: { id: payload.conversationId, channelAccountId: account.id },
      });
      if (!conversation) throw new Error('CONVERSATION_NOT_FOUND');
      let profile:
        { name: string | null; avatarUrl: string | null } | undefined;
      try {
        profile = await this.graph.getUserProfile(
          conversation.externalUserId,
          token,
        );
      } catch (error) {
        // Profile privacy is optional; loss of the Page authorization is not.
        if (
          !(error instanceof FacebookGraphError) ||
          error.code !== 'FACEBOOK_PERMISSION_DENIED'
        )
          throw error;
      }
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, account))) return;
        if (profile) {
          await tx.conversation.update({
            where: { id: conversation.id },
            data: {
              ...(profile.name ? { customerName: profile.name } : {}),
              ...(profile.avatarUrl
                ? { customerAvatar: profile.avatarUrl }
                : {}),
            },
          });
          await publishEvent(tx, account.ownerId, {
            type: 'conversation.updated',
            channelAccountId: account.id,
            conversationId: conversation.id,
          });
        }
        await tx.personalCommand.updateMany({
          where: { id: command.id, status: 'PROCESSING' },
          data: { status: 'DONE' },
        });
      });
      return;
    }
    if (command.kind === 'SYNC') {
      const page = await this.graph.listConversations(
        account.externalAccountId!,
        token,
        { after: payload.after, limit: 25 },
      );
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, account))) return;
        for (const item of page.items) {
          const peers = item.participants.filter(
            (p) => p.id !== account.externalAccountId,
          );
          if (peers.length !== 1) continue;
          const peer = peers[0];
          const conversation = await tx.conversation.upsert({
            where: {
              channelAccountId_externalUserId_externalThreadType: {
                channelAccountId: account.id,
                externalUserId: peer.id,
                externalThreadType: 'PAGE_PSID',
              },
            },
            create: {
              channelAccountId: account.id,
              externalUserId: peer.id,
              externalThreadType: 'PAGE_PSID',
              externalConversationId: item.id,
              customerName: peer.name,
            },
            update: {
              externalConversationId: item.id,
              ...(peer.name ? { customerName: peer.name } : {}),
            },
          });
          const pending = await tx.personalCommand.findMany({
            where: {
              channelAccountId: account.id,
              kind: 'SYNC_MESSAGES',
              status: { in: ['PENDING', 'PROCESSING'] },
              payload: { path: ['conversationId'], equals: conversation.id },
            },
          });
          const already = pending.some(
            (job) => !jobSchema.parse(job.payload).profileOnly,
          );
          // Revisit changed threads, while keeping completed unchanged history intact.
          if (
            conversation.syncComplete &&
            conversation.lastSyncAt &&
            new Date(item.updatedAt) <= conversation.lastSyncAt
          )
            continue;
          if (!already)
            await tx.personalCommand.create({
              data: {
                channelAccountId: account.id,
                generation: account.generation,
                kind: 'SYNC_MESSAGES',
                deduplicationKey: `facebook:messages:${account.id}:${runId}:${conversation.id}`,
                payload: {
                  conversationId: conversation.id,
                  after: conversation.syncCursor,
                  runId,
                  page: 0,
                },
              },
            });
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { syncComplete: false },
          });
          await publishEvent(tx, account.ownerId, {
            type: 'conversation.updated',
            channelAccountId: account.id,
            conversationId: conversation.id,
          });
        }
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            syncCursor: page.after,
            lastSyncAt: new Date(),
            lastSyncError: null,
            syncComplete: false,
          },
        });
        await this.continueSync(
          tx,
          command,
          account,
          payload,
          page.after,
          runId,
          pageIndex,
        );
      });
    } else {
      const conversation = await this.db.conversation.findFirst({
        where: { id: payload.conversationId, channelAccountId: account.id },
      });
      if (!conversation?.externalConversationId)
        throw new Error('FACEBOOK_HISTORY_UNAVAILABLE');
      const page = await this.graph.listMessages(
        conversation.externalConversationId,
        token,
        { after: payload.after, limit: 25 },
      );
      let profile:
        { name: string | null; avatarUrl: string | null } | undefined;
      if (!conversation.customerAvatar) {
        try {
          profile = await this.graph.getUserProfile(
            conversation.externalUserId,
            token,
          );
        } catch (error) {
          if (error instanceof FacebookGraphError && error.reauthRequired)
            throw error;
        }
      }
      if (!active()) return;
      await this.db.$transaction(async (tx) => {
        if (!(await this.lock(tx, account))) return;
        for (const item of page.items) {
          const normalized = this.historyMessage(
            item,
            account,
            conversation.externalUserId,
            conversation.externalConversationId!,
          );
          if (!normalized) continue;
          const saved = await this.messages.persistChannel(
            tx,
            account.id,
            normalized,
            item.from.id,
          );
          if (!saved.duplicate)
            await publishEvent(tx, account.ownerId, {
              type: 'message.created',
              channelAccountId: account.id,
              conversationId: saved.conversationId,
              messageId: saved.messageId,
            });
        }
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastSyncAt: new Date(),
            syncCursor: page.after,
            syncComplete: !page.after,
            ...(profile?.name ? { customerName: profile.name } : {}),
            ...(profile?.avatarUrl
              ? { customerAvatar: profile.avatarUrl }
              : {}),
          },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'conversation.updated',
          channelAccountId: account.id,
          conversationId: conversation.id,
        });
        await this.continueSync(
          tx,
          command,
          account,
          payload,
          page.after,
          runId,
          pageIndex,
        );
      });
    }
  }
  private async continueSync(
    tx: Prisma.TransactionClient,
    command: PersonalCommand,
    account: ChannelAccount,
    payload: z.infer<typeof jobSchema>,
    after: string | null,
    runId: string,
    page: number,
  ) {
    await tx.personalCommand.updateMany({
      where: { id: command.id, status: 'PROCESSING' },
      data: { status: 'DONE' },
    });
    if (after && page + 1 < MAX_SYNC_PAGES) {
      if (after === payload.after) throw new Error('FACEBOOK_CURSOR_STALLED');
      await tx.personalCommand.create({
        data: {
          channelAccountId: account.id,
          generation: account.generation,
          kind: command.kind,
          deduplicationKey: `facebook:next:${command.id}`,
          payload: { ...payload, after, runId, page: page + 1 },
        },
      });
    } else if (after) {
      await tx.channelAccount.update({
        where: { id: account.id },
        data: {
          lastSyncError: 'FACEBOOK_SYNC_LIMIT_REACHED',
          syncComplete: false,
        },
      });
      await publishEvent(tx, account.ownerId, {
        type: 'channel.sync_failed',
        channelAccountId: account.id,
      });
    } else {
      const outstanding = await tx.personalCommand.count({
        where: {
          channelAccountId: account.id,
          generation: account.generation,
          kind: { in: ['SYNC', 'SYNC_MESSAGES'] },
          status: { in: ['PENDING', 'PROCESSING'] },
        },
      });
      const incomplete = await tx.conversation.count({
        where: { channelAccountId: account.id, syncComplete: false },
      });
      const checkpoint = await tx.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      if (
        !outstanding &&
        !incomplete &&
        !checkpoint.syncCursor &&
        !checkpoint.lastSyncError &&
        checkpoint.lastSyncAt
      )
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            syncComplete: true,
            lastSyncAt: new Date(),
            lastSyncError: null,
          },
        });
    }
  }
  private historyMessage(
    item: FacebookMessage,
    account: ChannelAccount,
    psid: string,
    externalConversationId: string,
  ): NormalizedMessage | null {
    const outgoing = item.from.id === account.externalAccountId;
    if (
      (!outgoing && item.from.id !== psid) ||
      (outgoing && !item.to.some((p) => p.id === psid))
    )
      return null;
    const type =
      item.attachments[0]?.type ?? (item.text ? 'text' : 'unsupported');
    return {
      oaId: '',
      userId: psid,
      externalMessageId: item.id,
      externalConversationId,
      direction: outgoing ? 'OUTGOING' : 'INCOMING',
      type,
      content: item.text,
      sentAt: new Date(item.createdAt),
      metadata: {
        attachments: item.attachments.map((a) => ({
          type: a.type,
          payload: {
            ...(a.url ? { url: a.url } : {}),
            ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
            ...(a.name ? { name: a.name } : {}),
          },
        })),
      },
      source: 'FACEBOOK',
      ...(!outgoing && item.from.name ? { customerName: item.from.name } : {}),
    };
  }
  private async send(
    command: PersonalCommand,
    account: ChannelAccount,
    active: () => boolean,
  ) {
    const token = this.token(account);
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
    // One Page can be linked by multiple owners; throttling follows the Page identity.
    const lastSend = await this.db.channelAccount.aggregate({
      where: {
        channelType: 'FACEBOOK_PAGE',
        externalAccountId: account.externalAccountId,
      },
      _max: { lastSendAt: true },
    });
    const nextAt = (lastSend._max.lastSendAt?.getTime() ?? 0) + 1500;
    if (nextAt > Date.now()) {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          attempts: { decrement: 1 },
          availableAt: new Date(nextAt),
        },
      });
      return;
    }
    let attachmentId: string | undefined;
    if (message.type === 'file' || message.type === 'audio') {
      const policy = channelSendPolicy(account, message.conversation, true);
      if (!policy.allowed)
        throw new ApiError(
          409,
          policy.code ?? 'CHANNEL_NOT_CONNECTED',
          policy.message ?? 'Reply blocked',
        );
      if (!this.media)
        throw new FacebookGraphError(
          'FACEBOOK_UNAVAILABLE',
          'Private file storage unavailable',
        );
      const file = await this.media.read(message.id);
      const old = z
        .object({ facebook: z.object({ attachmentId: z.string() }) })
        .safeParse(message.metadata);
      if (old.success) attachmentId = old.data.facebook.attachmentId;
      else {
        attachmentId = (
          await this.graph.uploadMedia(
            account.externalAccountId!,
            token,
            file,
            message.type === 'audio' ? 'audio' : 'document',
          )
        ).attachment_id;
        await this.db.message.update({
          where: { id: message.id },
          data: {
            metadata: {
              ...z.record(z.unknown()).parse(message.metadata),
              facebook: { attachmentId },
            } as Prisma.InputJsonObject,
          },
        });
      }
    }
    const claimed = await this.db.$transaction(async (tx) => {
      const current = await this.lock(tx, account);
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: message.conversationId },
      });
      const policy = current
        ? channelSendPolicy(current, conversation, true)
        : null;
      if (!policy?.allowed) {
        await tx.message.updateMany({
          where: { id: message.id, deliveryStatus: 'PENDING' },
          data: {
            deliveryStatus: 'FAILED',
            deliveryError: policy?.code ?? 'CHANNEL_NOT_CONNECTED',
          },
        });
        await tx.personalCommand.updateMany({
          where: { id: command.id, status: 'PROCESSING' },
          data: { status: 'FAILED' },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'message.status_changed',
          channelAccountId: account.id,
          conversationId: message.conversationId,
          messageId: message.id,
        });
        return false;
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
      if (!changed.count) return false;
      await tx.channelAccount.update({
        where: { id: account.id },
        data: { lastSendAt: new Date() },
      });
      return true;
    });
    if (!claimed || !active()) return;
    // No retry follows a timed-out/unconfirmed POST. Recovery preserves UNKNOWN.
    const result = attachmentId
      ? await this.graph.sendAttachment(
          account.externalAccountId!,
          token,
          message.conversation.externalUserId,
          attachmentId,
          message.type === 'audio' ? 'audio' : 'document',
        )
      : await this.graph.sendText(
          account.externalAccountId!,
          token,
          message.conversation.externalUserId,
          message.content,
        );
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      const current = await this.lock(tx, account);
      if (!current) return;
      const saved = await tx.message.findUniqueOrThrow({
        where: { id: message.id },
      });
      if (saved.deliveryStatus !== 'SENDING') return;
      const echo = await tx.message.findUnique({
        where: {
          channelAccountId_externalMessageId: {
            channelAccountId: account.id,
            externalMessageId: result.messageId,
          },
        },
      });
      if (echo && echo.id !== message.id) {
        if (
          echo.direction !== 'OUTGOING' ||
          echo.conversationId !== message.conversationId ||
          echo.idempotencyKey
        )
          throw new Error('EXTERNAL_MESSAGE_ID_COLLISION');
        await tx.message.delete({ where: { id: echo.id } });
      }
      await tx.message.update({
        where: { id: message.id },
        data: {
          externalMessageId: result.messageId,
          deliveryStatus: 'SENT',
          deliveryError: null,
          ...(echo
            ? {
                sentAt: echo.sentAt,
                deliveredAt: echo.deliveredAt,
                readAt: echo.readAt,
              }
            : {}),
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
          receipt.status === 'PROCESSED' ||
          receipt.status === 'IGNORED' ||
          !receipt.channelAccountId
        )
          return;
        const account = await tx.channelAccount.findUniqueOrThrow({
          where: { id: receipt.channelAccountId },
        });
        const payload = receipt.payload as unknown as FacebookWebhookPayload;
        if (
          account.channelType !== 'FACEBOOK_PAGE' ||
          receipt.eventName !== 'facebook.page' ||
          account.connectionStatus === 'DISCONNECTED' ||
          payload.pageId !== account.externalAccountId
        ) {
          await tx.webhookEvent.update({
            where: { id },
            data: { status: 'IGNORED', processedAt: new Date() },
          });
          return;
        }
        const event = payload.event;
        const outgoing = event.sender.id === payload.pageId;
        const psid = outgoing ? event.recipient.id : event.sender.id;
        if (event.message) {
          const message = event.message;
          const attachments = (message.attachments ?? []).map((a) => ({
            type: a.type,
            payload: a.payload,
          }));
          const saved = await this.messages.persistChannel(
            tx,
            account.id,
            {
              oaId: '',
              userId: psid,
              externalMessageId: message.mid,
              direction: outgoing ? 'OUTGOING' : 'INCOMING',
              type:
                attachments[0]?.type ?? (message.text ? 'text' : 'unsupported'),
              content: message.text ?? '',
              sentAt: new Date(event.timestamp),
              source: 'FACEBOOK',
              metadata: { attachments },
            },
            event.sender.id,
          );
          if (!outgoing && !saved.duplicate) {
            const contact = await tx.conversation.findUniqueOrThrow({
              where: { id: saved.conversationId },
            });
            if (!contact.customerName || !contact.customerAvatar)
              await tx.personalCommand.createMany({
                data: [
                  {
                    channelAccountId: account.id,
                    generation: account.generation,
                    kind: 'SYNC_MESSAGES',
                    deduplicationKey: `facebook:profile:${account.id}:${account.generation}:${contact.id}`,
                    payload: { conversationId: contact.id, profileOnly: true },
                  },
                ],
                skipDuplicates: true,
              });
          }
          if (!saved.duplicate)
            await publishEvent(tx, account.ownerId, {
              type: 'message.created',
              channelAccountId: account.id,
              conversationId: saved.conversationId,
              messageId: saved.messageId,
            });
        } else if (event.read || event.delivery) {
          const conversation = await tx.conversation.findUnique({
            where: {
              channelAccountId_externalUserId_externalThreadType: {
                channelAccountId: account.id,
                externalUserId: psid,
                externalThreadType: 'PAGE_PSID',
              },
            },
          });
          const watermark = event.read?.watermark ?? event.delivery?.watermark;
          if (conversation) {
            const filter: Prisma.MessageWhereInput = {
              channelAccountId: account.id,
              conversationId: conversation.id,
              direction: 'OUTGOING',
              deliveryStatus: 'SENT',
              ...(event.read ? { readAt: null } : { deliveredAt: null }),
            };
            if (event.delivery?.mids?.length)
              filter.externalMessageId = { in: event.delivery.mids };
            else if (watermark) filter.sentAt = { lte: new Date(watermark) };
            else filter.id = { in: [] };
            const changed = await tx.message.findMany({
              where: filter,
              select: { id: true },
              take: 201,
            });
            const batch = changed.slice(0, 200);
            const at = new Date(watermark ?? event.timestamp);
            await tx.message.updateMany({
              where: { ...filter, id: { in: batch.map((m) => m.id) } },
              data: event.read ? { readAt: at } : { deliveredAt: at },
            });
            for (const m of batch)
              await publishEvent(tx, account.ownerId, {
                type: 'message.status_changed',
                channelAccountId: account.id,
                conversationId: conversation.id,
                messageId: m.id,
              });
            // Continue large receipts on a later tick, keeping each transaction bounded.
            if (changed.length > 200) return;
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
      });
    } catch {
      await this.db.webhookEvent.updateMany({
        where: { id, status: { not: 'PROCESSED' } },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          error: 'FACEBOOK_PERSISTENCE_FAILED',
          attempts: { increment: 1 },
        },
      });
    }
  }
}
