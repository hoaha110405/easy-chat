import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { ApiError } from '../../common/api-error';
import { PrismaService } from '../../database/prisma.service';
import { MessageStore } from '../inbox/message-store';
import { publishEvent } from '../realtime/publish';
import { channelSendPolicy } from '../messaging/channel-policy';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsAppService, WhatsAppSettings } from './whatsapp.service';
import { waReceiptSchema } from './whatsapp.webhook';
import {
  waMetadata,
  waMessageSchema,
  waStatusSchema,
  waFailure,
  WhatsAppError,
  waRecipient,
} from './whatsapp.types';
import { templateInputSchema, prepareTemplate } from './whatsapp.templates';
const record = (v: unknown) => z.record(z.unknown()).catch({}).parse(v);
@Injectable()
export class WhatsAppWorker {
  private lastPoll = 0;
  constructor(
    readonly db: PrismaService,
    readonly settings: WhatsAppSettings,
    readonly service: WhatsAppService,
    readonly client: WhatsAppClient,
    readonly store: MessageStore,
  ) {}
  async enqueue(ownerId: string, id: string, conversationId?: string) {
    const a = await this.service.owned(id, ownerId);
    if (conversationId)
      throw new ApiError(
        409,
        'WHATSAPP_HISTORY_UNAVAILABLE',
        'Cloud API không cung cấp API tải lịch sử inbox tùy ý.',
      );
    if (a.connectionStatus !== 'CONNECTED')
      throw new WhatsAppError('WHATSAPP_NOT_CONNECTED');
    const pending = await this.db.personalCommand.findFirst({
      where: {
        channelAccountId: id,
        kind: 'SYNC',
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });
    if (!pending)
      await this.db.personalCommand.create({
        data: {
          channelAccountId: id,
          generation: a.generation,
          kind: 'SYNC',
          deduplicationKey: 'whatsapp:refresh:' + randomUUID(),
        },
      });
    return { queued: true };
  }
  async poll() {
    if (!this.settings.enabled || Date.now() - this.lastPoll < 30000) return;
    this.lastPoll = Date.now();
    await this.db.channelAuthorization.deleteMany({
      where: {
        channelType: 'WHATSAPP_BUSINESS',
        expiresAt: { lt: new Date() },
      },
    });
    const accounts = await this.db.channelAccount.findMany({
      where: {
        channelType: 'WHATSAPP_BUSINESS',
        connectionStatus: 'CONNECTED',
        OR: [
          { lastSyncAt: null },
          { lastSyncAt: { lt: new Date(Date.now() - 300000) } },
        ],
      },
      take: 10,
    });
    for (const a of accounts) await this.enqueue(a.ownerId, a.id);
  }
  private async lock(tx: Prisma.TransactionClient, a: ChannelAccount) {
    return (
      await tx.$queryRaw<
        ChannelAccount[]
      >`SELECT * FROM "ChannelAccount" WHERE "id"=${a.id} AND "generation"=${a.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`
    )[0];
  }
  async process(
    command: PersonalCommand,
    account: ChannelAccount,
    active: () => boolean,
  ) {
    try {
      if (!active()) return;
      const a = await this.db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      });
      const current = await this.db.personalCommand.findUnique({
        where: { id: command.id },
      });
      if (current?.status !== 'PROCESSING') return;
      if (
        !this.settings.enabled ||
        a.generation !== command.generation ||
        a.connectionStatus !== 'CONNECTED'
      )
        throw new WhatsAppError('WHATSAPP_NOT_CONNECTED');
      if (command.kind === 'SEND') await this.send(command, a, active);
      else if (command.kind === 'SYNC') await this.refresh(command, a, active);
      else if (command.kind === 'SYNC_MESSAGES')
        await this.read(command, a, active);
      else throw new WhatsAppError('WHATSAPP_OPERATION_UNSUPPORTED');
    } catch (e) {
      if (active()) await this.recoverDispatch(command, account, e);
    }
  }
  async recoverDispatch(
    command: PersonalCommand,
    account: ChannelAccount,
    error?: unknown,
  ) {
    const e =
      error instanceof WhatsAppError
        ? error
        : new WhatsAppError('WHATSAPP_OPERATION_FAILED', true);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} FOR UPDATE`;
      const a = await tx.channelAccount.findUnique({
        where: { id: account.id },
      });
      const m = command.messageId
        ? await tx.message.findUnique({ where: { id: command.messageId } })
        : null;
      const ambiguous = m?.deliveryStatus === 'SENDING' && e.ambiguous;
      const retry =
        !ambiguous &&
        e.retryable &&
        command.attempts < 3 &&
        a?.generation === command.generation &&
        a.connectionStatus === 'CONNECTED';
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: retry ? 'PENDING' : 'FAILED',
          availableAt: new Date(
            Date.now() +
              (e.retryAfter ?? 2 ** Math.min(command.attempts, 6)) * 1000,
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
            deliveryError: ambiguous ? 'WHATSAPP_SEND_UNKNOWN' : e.code,
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
            lastError: e.code,
            ...(command.kind === 'SYNC' ? { lastSyncError: e.code } : {}),
            ...(e.retryAfter
              ? { rateLimitedUntil: new Date(Date.now() + e.retryAfter * 1000) }
              : {}),
            ...([
              'WHATSAPP_REAUTH_REQUIRED',
              'WHATSAPP_PERMISSION_REQUIRED',
              'WHATSAPP_REGISTRATION_REQUIRED',
              'WHATSAPP_PHONE_NOT_AUTHORIZED',
            ].includes(e.code)
              ? {
                  connectionStatus:
                    e.code === 'WHATSAPP_REAUTH_REQUIRED'
                      ? 'REAUTH_REQUIRED'
                      : 'PERMISSION_REQUIRED',
                  capabilities: {},
                }
              : {}),
          },
        });
        if (m && e.code === 'WHATSAPP_WINDOW_CLOSED') {
          const c = await tx.conversation.findUniqueOrThrow({
            where: { id: m.conversationId },
          });
          await tx.conversation.update({
            where: { id: c.id },
            data: {
              providerState: {
                ...record(c.providerState),
                replyBlockedUntilInbound: true,
              },
            },
          });
        }
        await publishEvent(tx, a.ownerId, {
          type:
            e.code === 'WHATSAPP_REAUTH_REQUIRED'
              ? 'channel.reauth_required'
              : 'channel.sync_failed',
          channelAccountId: a.id,
        });
      }
    });
  }
  private async refresh(
    command: PersonalCommand,
    a: ChannelAccount,
    active: () => boolean,
  ) {
    const c = this.service.credentials(a);
    await this.service.checkedToken(c.accessToken);
    await this.service.membership(c.accessToken, c.wabaId, c.phoneNumberId);
    const phone = await this.client.phone(c.accessToken, c.phoneNumberId);
    if (phone.status !== 'CONNECTED' || phone.platform_type !== 'CLOUD_API')
      throw new WhatsAppError('WHATSAPP_REGISTRATION_REQUIRED');
    await this.service.verifyAppWebhook();
    const subs = await this.client.subscriptions(c.accessToken, c.wabaId);
    if (!subs.data.some((x) => x.whatsapp_business_api_data.id === c.appId))
      throw new WhatsAppError('WHATSAPP_WEBHOOK_NOT_CONFIGURED');
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      if (!(await this.lock(tx, a))) return;
      await tx.channelAccount.update({
        where: { id: a.id },
        data: { lastSyncAt: new Date(), lastSyncError: null, lastError: null },
      });
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      await publishEvent(tx, a.ownerId, {
        type: 'channel.updated',
        channelAccountId: a.id,
      });
    });
  }
  private async read(
    command: PersonalCommand,
    a: ChannelAccount,
    active: () => boolean,
  ) {
    const payload = z
      .object({
        operation: z.literal('MARK_READ'),
        messageId: z.string().cuid(),
      })
      .parse(command.payload);
    const m = await this.db.message.findFirst({
      where: {
        id: payload.messageId,
        channelAccountId: a.id,
        direction: 'INCOMING',
        externalMessageId: { not: null },
      },
    });
    if (!m) throw new WhatsAppError('WHATSAPP_INVALID_REQUEST');
    const c = this.service.credentials(a);
    await this.client.markRead(
      c.accessToken,
      c.phoneNumberId,
      m.externalMessageId!,
    );
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      if (!(await this.lock(tx, a))) return;
      const current = await tx.message.findUniqueOrThrow({
        where: { id: m.id },
      });
      const metadata = record(current.metadata);
      await tx.message.update({
        where: { id: m.id },
        data: {
          metadata: {
            ...metadata,
            whatsapp: {
              ...record(metadata.whatsapp),
              providerMarkedReadAt: new Date().toISOString(),
            },
          } as Prisma.InputJsonObject,
        },
      });
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      await publishEvent(tx, a.ownerId, {
        type: 'message.updated',
        channelAccountId: a.id,
        conversationId: m.conversationId,
        messageId: m.id,
      });
    });
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
    const c = this.service.credentials(a);
    const wait = Math.max(
      (a.lastSendAt?.getTime() ?? 0) + 1000,
      a.rateLimitedUntil?.getTime() ?? 0,
    );
    if (wait > Date.now()) {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          attempts: { decrement: 1 },
          availableAt: new Date(wait),
        },
      });
      return;
    }
    let payload: Record<string, unknown>;
    if (m.type === 'template') {
      const input = templateInputSchema.parse(
        record(record(m.metadata).whatsapp).templateInput,
      );
      payload = prepareTemplate(
        await this.service.template(
          a,
          input.templateId,
          input.templateName,
          input.language,
        ),
        input,
      ).payload;
    } else if (m.type === 'file' || m.type === 'audio') {
      const media = z
        .object({ id: z.string().regex(/^\d{1,30}$/), filename: z.string() })
        .parse(record(record(m.metadata).whatsapp).media);
      payload =
        m.type === 'file'
          ? {
              type: 'document',
              document: {
                id: media.id,
                filename: media.filename,
                ...(m.content ? { caption: m.content } : {}),
              },
            }
          : { type: 'audio', audio: { id: media.id } };
    } else {
      if (m.type !== 'text' || !m.content.trim() || m.content.length > 2000)
        throw new WhatsAppError('WHATSAPP_INVALID_REQUEST');
      payload = { type: 'text', text: { body: m.content, preview_url: false } };
      const reply = record(record(m.metadata).whatsapp).replyTo;
      if (typeof reply === 'string') payload.context = { message_id: reply };
    }
    const callbackData = `${m.id}.${randomUUID()}`;
    const claimed = await this.db.$transaction(async (tx) => {
      const current = await this.lock(tx, a);
      if (!current) throw new WhatsAppError('WHATSAPP_NOT_CONNECTED');
      this.service.credentials(current);
      const thread = await tx.conversation.findUniqueOrThrow({
        where: { id: m.conversationId },
      });
      if (m.type !== 'template') {
        const policy = channelSendPolicy(current, thread, true);
        if (!policy.allowed)
          throw new WhatsAppError(policy.code ?? 'WHATSAPP_WINDOW_CLOSED');
      }
      const changed = await tx.message.updateMany({
        where: { id: m.id, deliveryStatus: 'PENDING' },
        data: {
          deliveryStatus: 'SENDING',
          sendingAt: new Date(),
          sendAttempts: { increment: 1 },
          deliveryError: null,
          metadata: {
            ...record(m.metadata),
            whatsapp: {
              ...record(record(m.metadata).whatsapp),
              callbackData,
            },
          } as Prisma.InputJsonObject,
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
    const result = await this.client.send(
      c.accessToken,
      c.phoneNumberId,
      c.wabaId,
      waRecipient.parse(m.conversation.externalContactId),
      payload,
      callbackData,
    );
    if (!active()) return;
    await this.db.$transaction(async (tx) => {
      if (!(await this.lock(tx, a))) return;
      const current = await tx.message.findUniqueOrThrow({
        where: { id: m.id },
      });
      if (current.externalMessageId && current.externalMessageId !== result.id)
        throw new WhatsAppError('WHATSAPP_SEND_UNKNOWN', true);
      if (['PENDING', 'SENDING', 'UNKNOWN'].includes(current.deliveryStatus))
        await tx.message.update({
          where: { id: m.id },
          data: {
            externalMessageId: result.id,
            deliveryStatus: 'SENT',
            deliveryError: null,
            metadata: {
              ...record(current.metadata),
              whatsapp: {
                ...record(record(current.metadata).whatsapp),
                acceptedAt: new Date().toISOString(),
                ...(result.message_status
                  ? { pacingStatus: result.message_status }
                  : {}),
              },
            } as Prisma.InputJsonObject,
          },
        });
      else if (!current.externalMessageId)
        await tx.message.update({
          where: { id: m.id },
          data: { externalMessageId: result.id },
        });
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      await tx.channelAccount.update({
        where: { id: a.id },
        data: { lastError: null },
      });
      const latest = await tx.message.findFirst({
        where: { conversationId: m.conversationId },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      });
      if (latest)
        await tx.conversation.update({
          where: { id: m.conversationId },
          data: {
            lastMessageAt: latest.sentAt,
            lastMessagePreview: (
              latest.content ||
              (latest.type === 'audio'
                ? 'Âm thanh'
                : latest.type === 'file'
                  ? 'Tài liệu'
                  : '')
            ).slice(0, 280),
          },
        });
      await publishEvent(tx, a.ownerId, {
        type: 'message.status_changed',
        channelAccountId: a.id,
        conversationId: m.conversationId,
        messageId: m.id,
      });
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
          const event = waReceiptSchema.parse(receipt.payload),
            meta = waMetadata.parse(a.providerMetadata);
          if (a.connectionStatus === 'CONNECTING') return;
          if (
            a.connectionStatus === 'DISCONNECTED' ||
            meta.wabaId !== event.wabaId ||
            meta.phoneNumberId !== event.phoneId ||
            (event.generation !== a.generation &&
              ['account', 'template'].includes(event.kind))
          ) {
            await tx.webhookEvent.update({
              where: { id },
              data: { status: 'IGNORED', processedAt: new Date() },
            });
            return;
          }
          let ignored = false;
          if (event.kind === 'message') {
            const m = waMessageSchema.parse(event.data);
            const at = new Date(Number(m.timestamp) * 1000);
            if (
              !Number.isFinite(at.getTime()) ||
              at.getTime() > Date.now() + 60000 ||
              at.getTime() < Date.UTC(2010, 0, 1)
            )
              throw new WhatsAppError('WHATSAPP_WEBHOOK_INVALID');
            if (!m.from || m.group_id) ignored = true;
            else {
              const media =
                m.image ?? m.document ?? m.audio ?? m.video ?? m.sticker;
              const type =
                (
                  {
                    image: 'image',
                    document: 'file',
                    audio: 'audio',
                    video: 'video',
                    sticker: 'sticker',
                    text: 'text',
                    button: 'text',
                    interactive: 'text',
                  } as Record<string, string>
                )[m.type] ?? 'unsupported';
              const text =
                m.text?.body ??
                media?.caption ??
                m.button?.text ??
                m.interactive?.button_reply?.title ??
                m.interactive?.list_reply?.title ??
                '';
              const saved = await this.store.persistChannel(
                tx,
                a.id,
                {
                  oaId: '',
                  userId: m.from,
                  externalConversationId: m.from,
                  externalContactId: m.from,
                  externalThreadType: 'WHATSAPP_BUSINESS',
                  externalMessageId: m.id,
                  direction: 'INCOMING',
                  source: 'WHATSAPP',
                  type,
                  content: text,
                  sentAt: at,
                  customerName: event.contactName,
                  metadata: {
                    attachments: media
                      ? [
                          {
                            type,
                            payload: {
                              ...(media.filename
                                ? { name: media.filename }
                                : {}),
                            },
                          },
                        ]
                      : [],
                    whatsapp: {
                      phoneNumberId: event.phoneId,
                      wabaId: event.wabaId,
                      ...(media ? { media } : {}),
                      ...(m.context ? { context: m.context } : {}),
                    },
                  },
                },
                m.from,
              );
              const qualifies = [
                'text',
                'image',
                'document',
                'audio',
                'video',
                'sticker',
                'button',
                'interactive',
                'contacts',
                'location',
              ].includes(m.type);
              if (!saved.duplicate && qualifies) {
                const thread = await tx.conversation.findUniqueOrThrow({
                  where: { id: saved.conversationId },
                });
                if (!thread.lastInboundAt || at > thread.lastInboundAt)
                  await tx.conversation.update({
                    where: { id: thread.id },
                    data: {
                      lastInboundAt: at,
                      providerState: {
                        ...record(thread.providerState),
                        replyBlockedUntilInbound: false,
                      },
                    },
                  });
              }
              if (!saved.duplicate)
                await publishEvent(tx, a.ownerId, {
                  type: 'message.created',
                  channelAccountId: a.id,
                  conversationId: saved.conversationId,
                  messageId: saved.messageId,
                });
            }
          } else if (event.kind === 'status') {
            const s = waStatusSchema.parse(event.data);
            if (
              s.group_id ||
              s.recipient_type === 'group' ||
              s.status === 'deleted'
            )
              ignored = true;
            else await this.status(tx, a, s);
          } else {
            await tx.personalCommand.createMany({
              data: [
                {
                  channelAccountId: a.id,
                  generation: a.generation,
                  kind: 'SYNC',
                  deduplicationKey: `whatsapp:event:${id}`,
                },
              ],
              skipDuplicates: true,
            });
            await publishEvent(tx, a.ownerId, {
              type: 'channel.updated',
              channelAccountId: a.id,
            });
          }
          await tx.channelAccount.update({
            where: { id: a.id },
            data: {
              providerMetadata: {
                ...meta,
                lastWebhookAt: new Date(
                  Math.max(
                    receipt.receivedAt.getTime(),
                    Date.parse(meta.lastWebhookAt ?? '') || 0,
                  ),
                ).toISOString(),
              },
            },
          });
          await tx.webhookEvent.update({
            where: { id },
            data: {
              status: ignored ? 'IGNORED' : 'PROCESSED',
              processedAt: new Date(),
              attempts: { increment: 1 },
              error: null,
            },
          });
        },
        { timeout: 20000 },
      );
    } catch (e) {
      await this.db.webhookEvent.updateMany({
        where: { id, status: { notIn: ['PROCESSED', 'IGNORED'] } },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          attempts: { increment: 1 },
          error:
            e instanceof WhatsAppError ? e.code : 'WHATSAPP_PERSISTENCE_FAILED',
        },
      });
    }
  }
  private async status(
    tx: Prisma.TransactionClient,
    a: ChannelAccount,
    s: z.infer<typeof waStatusSchema>,
  ) {
    const correlation = z
      .string()
      .cuid()
      .safeParse(s.biz_opaque_callback_data?.split('.')[0]);
    const m = await tx.message.findFirst({
      where: {
        channelAccountId: a.id,
        direction: 'OUTGOING',
        OR: [
          { externalMessageId: s.id },
          ...(correlation.success ? [{ id: correlation.data }] : []),
        ],
      },
      include: { conversation: true },
    });
    if (!m) throw new WhatsAppError('WHATSAPP_STATUS_UNMATCHED');
    const currentCallback = record(record(m.metadata).whatsapp).callbackData;
    if (
      typeof currentCallback === 'string' &&
      s.biz_opaque_callback_data !== currentCallback &&
      m.externalMessageId !== s.id
    )
      return;
    if (correlation.success && correlation.data !== m.id)
      throw new WhatsAppError('WHATSAPP_STATUS_MISMATCH');
    if (
      (s.recipient_id && s.recipient_id !== m.conversation.externalContactId) ||
      (m.externalMessageId && m.externalMessageId !== s.id)
    )
      throw new WhatsAppError('WHATSAPP_STATUS_MISMATCH');
    const at = new Date(Number(s.timestamp) * 1000);
    if (
      at.getTime() > Date.now() + 60000 ||
      at.getTime() < Date.UTC(2010, 0, 1)
    )
      throw new WhatsAppError('WHATSAPP_WEBHOOK_INVALID');
    const metadata = record(m.metadata),
      wa = record(metadata.whatsapp),
      rank: Record<string, number> = {
        PENDING: 0,
        SENDING: 0,
        UNKNOWN: 0,
        SENT: 1,
        FAILED: 1,
        DELIVERED: 2,
        READ: 3,
      };
    const target = (
      {
        sent: 'SENT',
        delivered: 'DELIVERED',
        read: 'READ',
        failed: 'FAILED',
      } as const
    )[s.status as 'sent' | 'delivered' | 'read' | 'failed'];
    const newer =
      typeof wa.statusTimestamp !== 'number' ||
      Number(s.timestamp) >= wa.statusTimestamp;
    let change = false;
    if (target === 'FAILED') change = rank[m.deliveryStatus] < 2 && newer;
    else if (target === 'SENT')
      change = m.deliveryStatus !== 'FAILED' && rank[m.deliveryStatus] < 1;
    else change = rank[target] > rank[m.deliveryStatus];
    const failure = s.errors?.[0]?.code;
    const recordStatus =
      change ||
      (m.deliveryStatus === target && typeof wa.providerStatus !== 'string');
    const data: Prisma.MessageUpdateInput = {
      externalMessageId: s.id,
      ...(s.status === 'delivered' && !m.deliveredAt
        ? { deliveredAt: at }
        : {}),
      ...(s.status === 'read' && !m.readAt ? { readAt: at } : {}),
      ...(change
        ? {
            deliveryStatus: target,
            deliveryError:
              target === 'FAILED'
                ? failure
                  ? waFailure(failure, 400, 'send').code
                  : 'WHATSAPP_SEND_FAILED'
                : null,
            metadata: {
              ...metadata,
              whatsapp: {
                ...wa,
                statusTimestamp: Math.max(
                  Number(wa.statusTimestamp) || 0,
                  Number(s.timestamp),
                ),
                ...(failure ? { providerErrorCode: failure } : {}),
              },
            } as Prisma.InputJsonObject,
          }
        : {}),
    };
    if (recordStatus)
      data.metadata = {
        ...metadata,
        whatsapp: {
          ...wa,
          providerStatus: s.status,
          statusTimestamp: Math.max(
            Number(wa.statusTimestamp) || 0,
            Number(s.timestamp),
          ),
          ...(failure ? { providerErrorCode: failure } : {}),
        },
      } as Prisma.InputJsonObject;
    await tx.message.update({ where: { id: m.id }, data });
    await publishEvent(tx, a.ownerId, {
      type: 'message.status_changed',
      channelAccountId: a.id,
      conversationId: m.conversationId,
      messageId: m.id,
    });
  }
}
