import { ZaloOaMediaWorker } from '../zalo/zalo-oa-media.worker';
import { MediaStore } from '../../common/media-store';
import { WhatsAppWorker } from '../whatsapp/whatsapp.worker';
import {
  Injectable,
  Optional,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ChannelAccount, PersonalCommand, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConfigService } from '../../config/config.service';
import { CryptoService, hash } from '../../common/crypto.service';
import { MessageStore } from '../inbox/message-store';
import { publishEvent } from '../realtime/publish';
import {
  ZaloSessionManager,
  type ActiveSession,
} from './personal-session.manager';
import {
  PersonalAdapterError,
  type QrEvent,
  type PersonalLogin,
} from './personal-adapter';
import {
  normalizePersonalMessage,
  normalizedPersonalSchema,
} from './personal-normalize';
import { WORKER_ID } from './personal-runtime';
import { TelegramWorker } from '../telegram/telegram.worker';
import { TikTokWorker } from '../tiktok/tiktok.worker';
import { FacebookPageWorker } from '../facebook-page/facebook-page.worker';
import { personalAttachmentSchema } from './personal-media';

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PersonalAdapterError('ZALO_SEND_UNKNOWN')),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
@Injectable()
export class PersonalWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersonalWorker.name);
  private readonly instanceId = randomUUID();
  private client?: Client;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private busy = false;
  private lastMediaCleanup = 0;
  private heartbeatBusy = false;
  private failedDispatch?: PersonalCommand;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly reconnect = new Map<
    string,
    { at: number; attempts: number }
  >();
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly sessions: ZaloSessionManager,
    private readonly messages: MessageStore,
    @Optional() private readonly facebook?: FacebookPageWorker,
    @Optional() private readonly tiktok?: TikTokWorker,
    @Optional() private readonly telegram?: TelegramWorker,
    @Optional() private readonly whatsapp?: WhatsAppWorker,
    @Optional() private readonly media?: MediaStore,
    @Optional() private readonly zaloOa?: ZaloOaMediaWorker,
  ) {}
  async onModuleInit() {
    await this.start();
  }
  async start(schedule = true) {
    if (
      !this.config.env.ZALO_PERSONAL_ENABLED &&
      !this.config.env.ZALO_APP_ID &&
      !this.config.facebookConfigured &&
      !this.config.tiktokConfigured &&
      !this.config.telegramConfigured &&
      !this.config.whatsappConfigured
    ) {
      this.logger.log('Messaging worker has no enabled provider.');
      return;
    }
    if (this.running) return;
    const client = new Client({
      connectionString: this.config.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    this.client = client;
    client.on('error', () => this.loseLock());
    client.on('end', () => {
      if (this.running) this.loseLock();
    });
    await client.connect();
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(240005) AS locked',
    );
    if (!lock.rows[0]?.locked) {
      await client.end();
      throw Object.assign(
        new Error(
          'A messaging worker already owns this database. Start only one worker.',
        ),
        { code: 'WORKER_ALREADY_RUNNING' },
      );
    }
    this.running = true;
    try {
      await this.db.personalWorkerState.upsert({
        where: { id: WORKER_ID },
        create: {
          id: WORKER_ID,
          instanceId: this.instanceId,
          heartbeatAt: new Date(),
        },
        update: { instanceId: this.instanceId, heartbeatAt: new Date() },
      });
      await this.recoverAfterRestart();
      await this.telegram?.start();
      const accounts = await this.db.channelAccount.findMany({
        where: {
          channelType: 'ZALO_PERSONAL',
          encryptedCredentials: { not: null },
          connectionStatus: { not: 'DISCONNECTED' },
        },
      });
      if (this.config.env.ZALO_PERSONAL_ENABLED)
        for (const account of accounts) this.track(this.restore(account));
      if (schedule) {
        this.timer = setInterval(() => {
          void this.tick().catch(() =>
            this.logger.error(
              'Worker dispatch failed; pending work remains in PostgreSQL.',
            ),
          );
        }, 500);
        this.heartbeat = setInterval(() => {
          void this.beat();
        }, 5000);
      }
      this.logger.log('Messaging worker owns the database lock and is ready.');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private loseLock() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.sessions.disconnectAll();
    void this.telegram?.stop().catch(() => undefined);
    this.logger.error(
      'Worker database lock was lost. Listeners stopped; restart the worker.',
    );
    process.exitCode = 1;
    void this.client?.end().catch(() => undefined);
  }
  private async beat() {
    if (!this.running || this.heartbeatBusy) return;
    this.heartbeatBusy = true;
    try {
      await this.client!.query(
        'UPDATE "PersonalWorkerState" SET "heartbeatAt"=NOW() WHERE "id"=$1 AND "instanceId"=$2',
        [WORKER_ID, this.instanceId],
      );
    } catch {
      this.loseLock();
    } finally {
      this.heartbeatBusy = false;
    }
  }
  private track<T>(promise: Promise<T>) {
    this.tasks.add(promise);
    void promise
      .catch(() =>
        this.logger.error(
          'A personal-account task failed. Its state is retained in PostgreSQL.',
        ),
      )
      .finally(() => this.tasks.delete(promise));
  }
  async recoverAfterRestart() {
    await this.db.$transaction(async (tx) => {
      const ambiguous = await tx.message.findMany({
        where: {
          source: {
            in: [
              'PERSONAL',
              'FACEBOOK',
              'TIKTOK',
              'TELEGRAM',
              'WHATSAPP',
              'WEBHOOK',
            ],
          },
          deliveryStatus: 'SENDING',
        },
        select: {
          id: true,
          conversationId: true,
          channelAccount: { select: { id: true, ownerId: true } },
        },
      });
      await tx.message.updateMany({
        where: {
          source: {
            in: [
              'PERSONAL',
              'FACEBOOK',
              'TIKTOK',
              'TELEGRAM',
              'WHATSAPP',
              'WEBHOOK',
            ],
          },
          deliveryStatus: 'SENDING',
        },
        data: {
          deliveryStatus: 'UNKNOWN',
          deliveryError: 'MESSAGE_SEND_UNKNOWN',
        },
      });
      await tx.channelAccount.updateMany({
        where: {
          channelType: 'ZALO_PERSONAL',
          connectionStatus: { in: ['QR_PENDING', 'CONNECTING'] },
          commands: { some: { kind: 'LOGIN_QR', status: 'PROCESSING' } },
        },
        data: {
          connectionStatus: 'REAUTH_REQUIRED',
          lastError: 'ZALO_SESSION_EXPIRED',
          encryptedQr: null,
          qrExpiresAt: null,
          qrStatus: 'EXPIRED',
        },
      });
      // Claimed but not-yet-sent work is safe to resume; SENDING was marked UNKNOWN above.
      await tx.personalCommand.updateMany({
        where: {
          status: 'PROCESSING',
          kind: 'SEND',
          message: { deliveryStatus: 'PENDING' },
        },
        data: { status: 'PENDING', availableAt: new Date() },
      });
      await tx.personalCommand.updateMany({
        where: {
          status: 'PROCESSING',
          kind: { in: ['SYNC', 'SYNC_MESSAGES'] },
          attempts: { lt: 3 },
        },
        data: { status: 'PENDING', availableAt: new Date() },
      });
      await tx.personalCommand.updateMany({
        where: { status: 'PROCESSING' },
        data: { status: 'FAILED' },
      });
      await tx.channelAccount.updateMany({
        where: {
          channelType: 'ZALO_PERSONAL',
          encryptedCredentials: { not: null },
          connectionStatus: { not: 'DISCONNECTED' },
        },
        data: {
          connectionStatus: 'RECONNECTING',
          encryptedQr: null,
          qrExpiresAt: null,
        },
      });
      for (const item of ambiguous)
        if (item.channelAccount)
          await publishEvent(tx, item.channelAccount.ownerId, {
            type: 'message.status_changed',
            channelAccountId: item.channelAccount.id,
            conversationId: item.conversationId,
            messageId: item.id,
          });
    });
  }
  private async current(account: ChannelAccount) {
    return this.db.channelAccount.findFirst({
      where: { id: account.id, generation: account.generation },
    });
  }
  private async change(
    account: ChannelAccount,
    data: Prisma.ChannelAccountUpdateManyMutationInput,
    type:
      | 'channel.qr_ready'
      | 'channel.qr_scanned'
      | 'channel.qr_expired'
      | 'channel.qr_declined'
      | 'channel.connected'
      | 'channel.disconnected'
      | 'channel.reauth_required'
      | 'channel.error',
  ) {
    if (!this.running) return false;
    return this.db.$transaction(async (tx) => {
      const changed = await tx.channelAccount.updateMany({
        where: {
          id: account.id,
          generation: account.generation,
          connectionStatus: { not: 'DISCONNECTED' },
        },
        data,
      });
      if (changed.count)
        await publishEvent(tx, account.ownerId, {
          type,
          channelAccountId: account.id,
        });
      return changed.count > 0;
    });
  }
  private async qrEvent(account: ChannelAccount, event: QrEvent) {
    if (event.type === 'generated')
      await this.change(
        account,
        {
          connectionStatus: 'QR_PENDING',
          qrStatus: 'GENERATED',
          encryptedQr: this.crypto.encrypt(event.image),
          qrExpiresAt: event.expiresAt,
          lastError: null,
        },
        'channel.qr_ready',
      );
    else if (event.type === 'scanned')
      await this.change(
        account,
        {
          connectionStatus: 'CONNECTING',
          qrStatus: 'SCANNED',
          encryptedQr: null,
        },
        'channel.qr_scanned',
      );
    else
      await this.change(
        account,
        {
          connectionStatus: 'REAUTH_REQUIRED',
          qrStatus: event.type === 'expired' ? 'EXPIRED' : 'DECLINED',
          lastError:
            event.type === 'expired' ? 'ZALO_QR_EXPIRED' : 'ZALO_QR_DECLINED',
          encryptedQr: null,
          qrExpiresAt: null,
          encryptedCredentials: null,
        },
        event.type === 'expired' ? 'channel.qr_expired' : 'channel.qr_declined',
      );
  }
  private async establish(
    account: ChannelAccount,
    entry: ActiveSession,
    login: PersonalLogin,
  ) {
    if (!this.running || this.sessions.get(account.id) !== entry) return;
    const current = await this.current(account);
    if (!current || current.connectionStatus === 'DISCONNECTED') {
      this.sessions.disconnect(account.id);
      return;
    }
    if (
      account.externalAccountId &&
      account.externalAccountId !== login.externalAccountId
    )
      throw new PersonalAdapterError('ZALO_ACCOUNT_MISMATCH');
    // Store credentials only for this attempt and bound external identity.
    const stored = await this.change(
      account,
      {
        externalAccountId: login.externalAccountId,
        encryptedCredentials: this.crypto.encrypt(login.credentials),
        encryptedQr: null,
        qrExpiresAt: null,
        connectionStatus: 'CONNECTING',
        qrStatus: 'NONE',
        ...(login.name ? { name: login.name } : {}),
        ...(login.avatarUrl ? { avatarUrl: login.avatarUrl } : {}),
      },
      'channel.disconnected',
    );
    if (!stored) {
      this.sessions.disconnect(account.id);
      return;
    }
    let inbound = Promise.resolve();
    await entry.adapter.startListening(
      (value) => {
        inbound = inbound
          .then(() => this.receive(account, value, login.externalAccountId))
          .catch(async () => {
            this.logger.error(
              `Inbound persistence failed for channel ${account.id}; listener stopped to avoid silently losing events.`,
            );
            this.sessions.disconnect(account.id);
            await this.change(
              account,
              {
                connectionStatus: 'ERROR',
                lastError: 'ZALO_INBOUND_PERSISTENCE_FAILED',
              },
              'channel.error',
            );
          });
        this.track(inbound);
      },
      (code) => this.track(this.connectionLost(account, entry, code)),
    );
    if (!this.running || this.sessions.get(account.id) !== entry) return;
    const changed = await this.change(
      account,
      {
        connectionStatus: 'CONNECTED',
        lastConnectedAt: new Date(),
        lastError: null,
      },
      'channel.connected',
    );
    if (changed) {
      entry.ready = true;
      this.reconnect.delete(account.id);
      this.track(this.syncContactProfiles(account));
      this.track(this.repairRecentMedia(account, login.externalAccountId));
    } else this.sessions.disconnect(account.id);
  }
  private async login(command: PersonalCommand, account: ChannelAccount) {
    const entry = this.sessions.create(account.id, account.generation);
    let events = Promise.resolve();
    let success = false;
    try {
      const login = await withTimeout(
        entry.adapter.connectWithQR((event) => {
          events = events.then(() => this.qrEvent(account, event));
          events.catch(() => entry.adapter.disconnect());
        }),
        140000,
      );
      await events;
      await this.establish(account, entry, login);
      success = entry.ready;
    } catch (error) {
      await events.catch(() => undefined);
      const code =
        error instanceof PersonalAdapterError
          ? error.code
          : 'ZALO_LOGIN_FAILED';
      const current = await this.current(account);
      if (
        current &&
        ['QR_PENDING', 'CONNECTING'].includes(current.connectionStatus)
      )
        await this.change(
          account,
          {
            connectionStatus: 'REAUTH_REQUIRED',
            lastError:
              code === 'ZALO_SEND_UNKNOWN' ? 'ZALO_LOGIN_FAILED' : code,
            encryptedQr: null,
            qrExpiresAt: null,
            encryptedCredentials: null,
          },
          'channel.reauth_required',
        );
      if (this.sessions.get(account.id) === entry)
        this.sessions.disconnect(account.id);
    } finally {
      await this.db.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: success ? 'DONE' : 'FAILED' },
      });
    }
  }
  async restore(account: ChannelAccount) {
    if (!account.encryptedCredentials || !this.running) return;
    const entry = this.sessions.create(account.id, account.generation);
    try {
      const login = await withTimeout(
        entry.adapter.restoreSession(
          this.crypto.decrypt(account.encryptedCredentials),
        ),
        45000,
      );
      await this.establish(account, entry, login);
    } catch (error) {
      if (this.sessions.get(account.id) === entry)
        this.sessions.disconnect(account.id);
      await this.change(
        account,
        {
          connectionStatus: 'REAUTH_REQUIRED',
          lastError:
            error instanceof PersonalAdapterError
              ? error.code
              : 'ZALO_SESSION_EXPIRED',
          encryptedCredentials: null,
          encryptedQr: null,
        },
        'channel.reauth_required',
      );
    }
  }
  private async connectionLost(
    account: ChannelAccount,
    entry: ActiveSession,
    code: string,
  ) {
    if (!this.running || this.sessions.get(account.id) !== entry) return;
    this.sessions.disconnect(account.id);
    if (code === 'ZALO_SESSION_EXPIRED') {
      await this.change(
        account,
        {
          connectionStatus: 'REAUTH_REQUIRED',
          lastError: code,
          encryptedCredentials: null,
        },
        'channel.reauth_required',
      );
      return;
    }
    const retries = (this.reconnect.get(account.id)?.attempts ?? 0) + 1;
    this.reconnect.set(account.id, {
      at: Date.now() + Math.min(30000, 5000 * 2 ** (retries - 1)),
      attempts: retries,
    });
    await this.change(
      account,
      {
        connectionStatus: retries > 3 ? 'REAUTH_REQUIRED' : 'RECONNECTING',
        lastError: 'ZALO_CONNECTION_LOST',
        ...(retries > 3 ? { encryptedCredentials: null } : {}),
      },
      retries > 3 ? 'channel.reauth_required' : 'channel.disconnected',
    );
  }
  async receive(account: ChannelAccount, value: unknown, ownId: string) {
    let normalized;
    try {
      normalized = normalizePersonalMessage(value, ownId);
    } catch {
      this.logger.warn(
        `Unsupported or malformed personal message on channel ${account.id}.`,
      );
      return;
    }
    if (!normalized || !this.running) return;
    const current = await this.current(account);
    if (
      !current ||
      !['CONNECTED', 'CONNECTING'].includes(current.connectionStatus)
    )
      return;
    const digest = hash(
      `personal:${account.id}:${normalized.externalMessageId}`,
    );
    await this.db.webhookEvent.createMany({
      data: [
        {
          digest,
          eventName: 'personal.message',
          channelAccountId: account.id,
          payload: normalized,
        },
      ],
      skipDuplicates: true,
    });
    const receipt = await this.db.webhookEvent.findUniqueOrThrow({
      where: { digest },
    });
    await this.processInbound(receipt.id);
    if (normalized.type === 'sticker')
      this.track(
        this.resolveStickerMedia(account, normalized.externalMessageId),
      );
    const entry = this.sessions.get(account.id);
    if (entry?.generation === account.generation && entry.ready) {
      entry.profileSync.revision++;
      if (entry.profileSync.complete) {
        entry.profileSync.complete = false;
        entry.profileSync.cursor = undefined;
        entry.profileSync.nextAt = 0;
      }
      this.track(this.syncContactProfiles(account));
    }
  }
  async resolveStickerMedia(
    account: ChannelAccount,
    externalMessageId: string,
  ) {
    const entry = this.sessions.get(account.id);
    if (
      !this.running ||
      !entry?.ready ||
      entry.generation !== account.generation
    )
      return;
    try {
      const message = await this.db.message.findUnique({
        where: {
          channelAccountId_externalMessageId: {
            channelAccountId: account.id,
            externalMessageId,
          },
        },
      });
      if (!message || message.type !== 'sticker') return;
      const metadata = message.metadata as { attachments?: unknown } | null;
      const parsed = personalAttachmentSchema
        .array()
        .max(20)
        .safeParse(metadata?.attachments);
      if (!parsed.success) return;
      const ids = parsed.data.flatMap((a) =>
        a.type === 'sticker' && !a.payload.url && a.payload.stickerId
          ? [a.payload.stickerId]
          : [],
      );
      if (!ids.length) return;
      const assets = await withTimeout(
        entry.adapter.getStickerAssets(ids),
        20000,
      );
      if (
        !assets.length ||
        !this.running ||
        this.sessions.get(account.id) !== entry
      )
        return;
      const attachments = parsed.data.map((a) => {
        const asset = assets.find((s) => s.stickerId === a.payload.stickerId);
        return asset && !a.payload.url
          ? { ...a, payload: { ...a.payload, url: asset.url } }
          : a;
      });
      const validated = personalAttachmentSchema
        .array()
        .max(20)
        .parse(attachments);
      await this.db.$transaction(async (tx) => {
        const active = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`;
        if (!active.length) return;
        await tx.message.update({
          where: { id: message.id },
          data: { metadata: { attachments: validated } },
        });
        await publishEvent(tx, account.ownerId, {
          type: 'message.updated',
          channelAccountId: account.id,
          conversationId: message.conversationId,
          messageId: message.id,
        });
      });
    } catch {
      this.logger.warn(
        `Sticker preview unavailable for channel ${account.id}; the message is retained.`,
      );
    }
  }
  async repairRecentMedia(account: ChannelAccount, ownId: string) {
    const entry = this.sessions.get(account.id);
    if (
      !this.running ||
      !entry?.ready ||
      entry.generation !== account.generation
    )
      return;
    try {
      const stickers = await this.db.message.findMany({
        where: {
          channelAccountId: account.id,
          source: 'PERSONAL',
          type: 'sticker',
        },
        select: { externalMessageId: true },
        orderBy: { sentAt: 'desc' },
        take: 50,
      });
      for (const sticker of stickers)
        if (sticker.externalMessageId)
          await this.resolveStickerMedia(account, sticker.externalMessageId);
      const known = await this.db.message.findMany({
        where: {
          channelAccountId: account.id,
          type: 'unsupported',
          source: 'PERSONAL',
        },
        select: {
          id: true,
          externalMessageId: true,
          direction: true,
          sentAt: true,
          conversation: { select: { id: true, externalUserId: true } },
        },
        orderBy: { sentAt: 'desc' },
        take: 50,
      });
      if (!known.length) return;
      // One bounded recent page, only to repair known saved IDs. Never imports unrelated conversations.
      const recent = await entry.adapter.getRecentMessages();
      if (!this.running || this.sessions.get(account.id) !== entry) return;
      for (const value of recent) {
        let normalized;
        try {
          normalized = normalizePersonalMessage(value, ownId);
        } catch {
          continue;
        }
        if (
          !normalized ||
          !['image', 'gif', 'sticker'].includes(normalized.type)
        )
          continue;
        const saved = known.find(
          (m) =>
            m.externalMessageId === normalized.externalMessageId &&
            m.conversation.externalUserId === normalized.externalThreadId &&
            m.direction === normalized.direction,
        );
        if (!saved) continue;
        await this.db.$transaction(async (tx) => {
          const active = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`;
          if (!active.length) return;
          await tx.message.updateMany({
            where: {
              id: saved.id,
              type: 'unsupported',
              channelAccountId: account.id,
            },
            data: {
              type: normalized.type,
              content: normalized.content,
              metadata: { attachments: normalized.attachments },
            },
          });
          await tx.webhookEvent.updateMany({
            where: {
              digest: hash(
                `personal:${account.id}:${normalized.externalMessageId}`,
              ),
              channelAccountId: account.id,
            },
            data: { payload: normalized },
          });
          await tx.conversation.updateMany({
            where: {
              id: saved.conversation.id,
              lastMessageAt: saved.sentAt,
              lastMessagePreview: '[unsupported]',
            },
            data: {
              lastMessagePreview: normalized.content || `[${normalized.type}]`,
            },
          });
          await publishEvent(tx, account.ownerId, {
            type: 'message.updated',
            channelAccountId: account.id,
            conversationId: saved.conversation.id,
            messageId: saved.id,
          });
        });
        if (normalized.type === 'sticker')
          await this.resolveStickerMedia(account, normalized.externalMessageId);
      }
    } catch {
      this.logger.warn(
        `Recent media repair unavailable for channel ${account.id}; existing history is retained.`,
      );
    }
  }
  async syncContactProfiles(account: ChannelAccount) {
    const entry = this.sessions.get(account.id);
    if (
      !this.running ||
      !entry?.ready ||
      entry.generation !== account.generation
    )
      return;
    const state = entry.profileSync;
    if (state.busy || Date.now() < Math.max(state.nextAt, state.retryAt))
      return;
    state.busy = true;
    const revision = state.revision;
    // Profile requests run outside message ingestion and sending, at most one batch per second per session.
    state.retryAt = Date.now() + 1000;
    try {
      const conversations = await this.db.conversation.findMany({
        where: {
          channelAccountId: account.id,
          externalThreadType: 'USER',
          customerAvatar: null,
          ...(state.cursor ? { id: { gt: state.cursor } } : {}),
        },
        select: { id: true, externalUserId: true },
        orderBy: { id: 'asc' },
        take: 50,
      });
      if (conversations.length) {
        const profiles = await withTimeout(
          entry.adapter.getUserProfiles(
            conversations.map((c) => c.externalUserId),
          ),
          20000,
        );
        if (!this.running || this.sessions.get(account.id) !== entry) return;
        await this.db.$transaction(async (tx) => {
          // Disconnect/cancel uses this same lock; a late response must not revive or alter a newer session.
          const active = await tx.$queryRaw<
            { id: string }[]
          >`SELECT "id" FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`;
          if (!active.length) return;
          for (const conversation of conversations) {
            const profile = profiles.find(
              (p) => p.externalUserId === conversation.externalUserId,
            );
            if (!profile?.avatarUrl || !/^https?:\/\//.test(profile.avatarUrl))
              continue;
            const saved = await tx.conversation.updateMany({
              where: {
                id: conversation.id,
                channelAccountId: account.id,
                customerAvatar: null,
              },
              data: {
                customerAvatar: profile.avatarUrl,
                ...(profile.name ? { customerName: profile.name } : {}),
              },
            });
            if (saved.count)
              await publishEvent(tx, account.ownerId, {
                type: 'conversation.updated',
                channelAccountId: account.id,
                conversationId: conversation.id,
              });
          }
        });
      }
      state.complete = conversations.length < 50;
      state.cursor = state.complete ? undefined : conversations.at(-1)?.id;
      state.nextAt = Date.now() + (state.complete ? 300000 : 1000);
      if (state.complete && state.revision !== revision) {
        state.complete = false;
        state.nextAt = Date.now() + 1000;
      }
    } catch {
      state.retryAt = Date.now() + 60000;
      this.logger.warn(
        `Contact avatar lookup failed for channel ${account.id}; stored messages and the listener are unaffected.`,
      );
    } finally {
      state.busy = false;
    }
  }
  async processInbound(id: string) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "WebhookEvent" WHERE "id"=${id} FOR UPDATE`;
        const receipt = await tx.webhookEvent.findUniqueOrThrow({
          where: { id },
        });
        if (receipt.status === 'PROCESSED' || !receipt.channelAccountId) return;
        const account = await tx.channelAccount.findUniqueOrThrow({
          where: { id: receipt.channelAccountId },
        });
        if (account.connectionStatus === 'DISCONNECTED') return;
        const normalized = normalizedPersonalSchema.parse(receipt.payload);
        const result = await this.messages.persistPersonal(
          tx,
          account.id,
          normalized,
        );
        await tx.webhookEvent.update({
          where: { id },
          data: {
            status: 'PROCESSED',
            error: null,
            processedAt: new Date(),
            attempts: { increment: 1 },
          },
        });
        if (!result.duplicate)
          await publishEvent(tx, account.ownerId, {
            type: 'message.created',
            channelAccountId: account.id,
            conversationId: result.conversationId,
            messageId: result.messageId,
          });
      });
    } catch (error) {
      await this.db.webhookEvent.updateMany({
        where: { id, status: { not: 'PROCESSED' } },
        data: {
          status: 'FAILED',
          error: 'PERSONAL_PERSISTENCE_FAILED',
          processedAt: new Date(),
          attempts: { increment: 1 },
        },
      });
      throw error;
    }
  }
  private async claim(): Promise<PersonalCommand | null> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "PersonalCommand" WHERE "status"='PENDING' AND "availableAt"<=NOW() ORDER BY CASE WHEN "kind"='SEND' THEN 0 WHEN "kind"='LOGIN_QR' THEN 1 ELSE 2 END, "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!rows[0]) return null;
      return tx.personalCommand.update({
        where: { id: rows[0].id },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      });
    });
  }
  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      if (this.media && Date.now() - this.lastMediaCleanup > 60000) {
        this.lastMediaCleanup = Date.now();
        await this.media.cleanup();
      }
      if (this.failedDispatch) {
        const command = this.failedDispatch;
        const failedAccount = await this.db.channelAccount.findUnique({
          where: { id: command.channelAccountId },
        });
        if (
          failedAccount?.channelType === 'WHATSAPP_BUSINESS' &&
          this.whatsapp
        ) {
          await this.whatsapp.recoverDispatch(command, failedAccount);
          this.failedDispatch = undefined;
          return;
        }
        if (
          failedAccount?.channelType.startsWith('TELEGRAM_') &&
          this.telegram
        ) {
          await this.telegram.recoverDispatch(command, failedAccount);
          this.failedDispatch = undefined;
          return;
        }
        if (failedAccount?.channelType.startsWith('TIKTOK_') && this.tiktok) {
          await this.tiktok.recoverDispatch(command, failedAccount);
          this.failedDispatch = undefined;
          return;
        }
        if (failedAccount?.channelType === 'FACEBOOK_PAGE' && this.facebook) {
          await this.facebook.recoverDispatch(command, failedAccount);
          this.failedDispatch = undefined;
          return;
        }
        const message = command.messageId
          ? await this.db.message.findUnique({
              where: { id: command.messageId },
            })
          : null;
        if (message?.deliveryStatus === 'SENDING')
          await this.markUnknown(command);
        else if (message?.deliveryStatus === 'PENDING')
          await this.safeRetry(command, 'ZALO_SEND_FAILED');
        else
          await this.db.personalCommand.updateMany({
            where: { id: command.id, status: 'PROCESSING' },
            data: { status: 'FAILED' },
          });
        this.failedDispatch = undefined;
        return;
      }
      // API cancellation increments a durable generation; old callbacks can never restore it.
      const accounts = this.config.env.ZALO_PERSONAL_ENABLED
        ? await this.db.channelAccount.findMany({
            where: { channelType: 'ZALO_PERSONAL' },
          })
        : [];
      for (const [id, entry] of this.sessions.entries()) {
        const account = accounts.find((row) => row.id === id);
        if (
          !account ||
          account.generation !== entry.generation ||
          ['DISCONNECTED', 'REAUTH_REQUIRED', 'ERROR'].includes(
            account.connectionStatus,
          )
        )
          this.sessions.disconnect(id);
      }
      for (const account of accounts) {
        if (account.connectionStatus === 'CONNECTED')
          this.track(this.syncContactProfiles(account));
        if (
          account.connectionStatus === 'RECONNECTING' &&
          account.encryptedCredentials &&
          !this.sessions.get(account.id) &&
          (this.reconnect.get(account.id)?.at ?? 0) <= Date.now()
        )
          this.track(this.restore(account));
      }
      const receipt = await this.db.webhookEvent.findFirst({
        where: {
          channelAccountId: { not: null },
          attempts: { lt: 3 },
          OR: [
            { status: 'RECEIVED' },
            {
              status: 'FAILED',
              processedAt: { lt: new Date(Date.now() - 5000) },
            },
          ],
        },
        orderBy: { receivedAt: 'asc' },
      });
      if (receipt)
        await (
          receipt.eventName.startsWith('whatsapp.') && this.whatsapp
            ? this.whatsapp.processInbound(receipt.id)
            : receipt.eventName.startsWith('telegram.') && this.telegram
              ? this.telegram.processInbound(receipt.id)
              : receipt.eventName.startsWith('tiktok.') && this.tiktok
                ? this.tiktok.processInbound(receipt.id)
                : receipt.eventName === 'facebook.page' && this.facebook
                  ? this.facebook.processInbound(receipt.id)
                  : this.processInbound(receipt.id)
        ).catch(() =>
          this.logger.warn(
            `Personal receipt ${receipt.id} remains failed; attempts are bounded.`,
          ),
        );
      await this.whatsapp
        ?.poll()
        .catch(() =>
          this.logger.warn(
            'WhatsApp scheduling failed; durable jobs remain queued.',
          ),
        );
      await this.telegram
        ?.poll()
        .catch(() =>
          this.logger.warn(
            'Telegram scheduling failed; durable jobs remain queued.',
          ),
        );
      await this.tiktok
        ?.poll()
        .catch(() =>
          this.logger.warn(
            'TikTok scheduling failed; queued work remains durable.',
          ),
        );
      const command = await this.claim();
      if (!command) return;
      try {
        const account = await this.db.channelAccount.findUnique({
          where: { id: command.channelAccountId },
        });
        if (!account || account.generation !== command.generation) {
          await this.failBeforeSend(command, 'ZALO_NOT_CONNECTED');
          return;
        }
        if (account.channelType === 'ZALO_OA' && this.zaloOa) {
          await this.zaloOa.process(command, account, () => this.running);
          return;
        }
        if (account.channelType === 'WHATSAPP_BUSINESS' && this.whatsapp) {
          await this.whatsapp.process(command, account, () => this.running);
          return;
        } else if (
          account.channelType.startsWith('TELEGRAM_') &&
          this.telegram
        ) {
          await this.telegram.process(command, account, () => this.running);
          return;
        }
        if (account.channelType.startsWith('TIKTOK_') && this.tiktok) {
          await this.tiktok.process(command, account, () => this.running);
          return;
        }
        if (account.channelType === 'FACEBOOK_PAGE' && this.facebook) {
          await this.facebook.process(command, account, () => this.running);
          return;
        }
        if (account.channelType !== 'ZALO_PERSONAL') {
          await this.failBeforeSend(command, 'CHANNEL_UNSUPPORTED');
          return;
        }
        if (!this.config.env.ZALO_PERSONAL_ENABLED) {
          await this.failBeforeSend(command, 'ZALO_PERSONAL_DISABLED');
          return;
        }
        if (command.kind === 'LOGIN_QR')
          this.track(this.login(command, account));
        else await this.send(command, account);
      } catch {
        this.failedDispatch = command;
        this.logger.warn(
          `Dispatch ${command.id} was interrupted; recovery will use the persisted delivery marker.`,
        );
      }
    } finally {
      this.busy = false;
    }
  }
  private async failBeforeSend(command: PersonalCommand, code: string) {
    await this.db.$transaction(async (tx) => {
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'FAILED' },
      });
      if (command.messageId) {
        const message = await tx.message.findUnique({
          where: { id: command.messageId },
        });
        await tx.message.updateMany({
          where: {
            id: command.messageId,
            deliveryStatus: { in: ['PENDING', 'SENDING'] },
          },
          data: { deliveryStatus: 'FAILED', deliveryError: code },
        });
        if (message) {
          const account = await tx.channelAccount.findUnique({
            where: { id: command.channelAccountId },
          });
          if (account)
            await publishEvent(tx, account.ownerId, {
              type: 'message.status_changed',
              channelAccountId: account.id,
              conversationId: message.conversationId,
              messageId: message.id,
            });
        }
      }
    });
  }
  private async safeRetry(command: PersonalCommand, code: string) {
    if (command.attempts >= this.config.env.ZALO_PERSONAL_SEND_MAX_ATTEMPTS) {
      await this.failBeforeSend(command, code);
      return;
    }
    await this.db.$transaction(async (tx) => {
      const active = await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          availableAt: new Date(
            Date.now() + 1000 * 2 ** (command.attempts - 1),
          ),
        },
      });
      if (active.count && command.messageId) {
        await tx.message.updateMany({
          where: {
            id: command.messageId,
            deliveryStatus: { in: ['PENDING', 'SENDING'] },
          },
          data: { deliveryStatus: 'PENDING', deliveryError: code },
        });
        const message = await tx.message.findUnique({
          where: { id: command.messageId },
        });
        const account = await tx.channelAccount.findUnique({
          where: { id: command.channelAccountId },
          select: { ownerId: true },
        });
        if (message && account)
          await publishEvent(tx, account.ownerId, {
            type: 'message.status_changed',
            channelAccountId: command.channelAccountId,
            conversationId: message.conversationId,
            messageId: message.id,
          });
      }
    });
  }
  private async markUnknown(command: PersonalCommand) {
    await this.db.$transaction(async (tx) => {
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'FAILED' },
      });
      if (!command.messageId) return;
      const message = await tx.message.findUnique({
        where: { id: command.messageId },
        include: { channelAccount: true },
      });
      if (!message || message.deliveryStatus === 'SENT') return;
      await tx.message.updateMany({
        where: { id: message.id, deliveryStatus: 'SENDING' },
        data: { deliveryStatus: 'UNKNOWN', deliveryError: 'ZALO_SEND_UNKNOWN' },
      });
      if (message.channelAccount)
        await publishEvent(tx, message.channelAccount.ownerId, {
          type: 'message.status_changed',
          channelAccountId: message.channelAccount.id,
          conversationId: message.conversationId,
          messageId: message.id,
        });
    });
  }
  async finalizeSend(command: PersonalCommand, externalMessageId: string) {
    await this.db.$transaction(async (tx) => {
      const message = await tx.message.findUniqueOrThrow({
        where: { id: command.messageId! },
        include: { channelAccount: true },
      });
      if (message.deliveryStatus !== 'SENDING') return;
      const echo = await tx.message.findUnique({
        where: {
          channelAccountId_externalMessageId: {
            channelAccountId: command.channelAccountId,
            externalMessageId,
          },
        },
      });
      if (echo && echo.id !== message.id) {
        if (
          echo.conversationId !== message.conversationId ||
          echo.direction !== 'OUTGOING' ||
          echo.idempotencyKey !== null
        )
          throw new Error('EXTERNAL_MESSAGE_ID_COLLISION');
        await tx.message.delete({ where: { id: echo.id } });
      }
      await tx.message.update({
        where: { id: message.id },
        data: {
          externalMessageId,
          deliveryStatus: 'SENT',
          deliveryError: null,
          ...(echo ? { sentAt: echo.sentAt } : {}),
        },
      });
      await tx.personalCommand.updateMany({
        where: { id: command.id, status: 'PROCESSING' },
        data: { status: 'DONE' },
      });
      if (message.channelAccount)
        await publishEvent(tx, message.channelAccount.ownerId, {
          type: 'message.status_changed',
          channelAccountId: command.channelAccountId,
          conversationId: message.conversationId,
          messageId: message.id,
        });
    });
  }
  private async send(command: PersonalCommand, account: ChannelAccount) {
    const entry = this.sessions.get(account.id);
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
    if (
      !entry?.ready ||
      entry.generation !== account.generation ||
      entry.adapter.getConnectionStatus() !== 'CONNECTED'
    ) {
      await this.safeRetry(command, 'ZALO_NOT_CONNECTED');
      return;
    }
    let media: Awaited<ReturnType<MediaStore['read']>> | undefined;
    if (message.type === 'file' || message.type === 'audio') {
      if (!entry.adapter.sendMediaMessage || !this.media) {
        await this.failBeforeSend(command, 'MEDIA_CHANNEL_UNSUPPORTED');
        return;
      }
      try {
        media = await this.media.read(message.id);
      } catch {
        await this.failBeforeSend(command, 'MEDIA_EXPIRED');
        return;
      }
    }
    const nextAt =
      (account.lastSendAt?.getTime() ?? 0) +
      this.config.env.ZALO_PERSONAL_SEND_INTERVAL_MS;
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
    const claimed = await this.db.$transaction(async (tx) => {
      const current = (
        await tx.$queryRaw<
          ChannelAccount[]
        >`SELECT * FROM "ChannelAccount" WHERE "id"=${account.id} FOR UPDATE`
      )[0];
      if (
        !current ||
        current.generation !== command.generation ||
        current.connectionStatus !== 'CONNECTED'
      )
        return false;
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
      await publishEvent(tx, account.ownerId, {
        type: 'message.status_changed',
        channelAccountId: account.id,
        conversationId: message.conversationId,
        messageId: message.id,
      });
      return true;
    });
    if (!claimed || !this.running) {
      await this.failBeforeSend(command, 'ZALO_NOT_CONNECTED');
      return;
    }
    try {
      const result = await withTimeout(
        media
          ? entry.adapter.sendMediaMessage!(
              message.conversation.externalUserId,
              media,
              message.type === 'audio' ? 'audio' : 'document',
            )
          : entry.adapter.sendTextMessage(
              message.conversation.externalUserId,
              message.content,
            ),
        media ? 45000 : 15000,
      );
      if (!this.running) return; // Successor worker recovers the durable SENDING marker as UNKNOWN.
      await this.finalizeSend(command, result.externalMessageId);
    } catch (error) {
      if (error instanceof PersonalAdapterError && error.safeToRetry)
        await this.safeRetry(command, error.code);
      else {
        await this.markUnknown(command);
        this.logger.warn(
          `Send outcome is unknown for message ${message.id}; automatic resend is disabled.`,
        );
      }
    }
  }
  async stop() {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.sessions.disconnectAll();
    await this.telegram?.stop();
    await Promise.allSettled([...this.tasks]);
    if (wasRunning)
      await this.db
        .$transaction(async (tx) => {
          await tx.channelAccount.updateMany({
            where: {
              channelType: 'ZALO_PERSONAL',
              connectionStatus: 'CONNECTED',
            },
            data: {
              connectionStatus: 'RECONNECTING',
              lastError: 'ZALO_CONNECTION_LOST',
            },
          });
          await tx.personalWorkerState.deleteMany({
            where: { id: WORKER_ID, instanceId: this.instanceId },
          });
        })
        .catch(() => undefined);
    await this.client?.end().catch(() => undefined);
    this.client = undefined;
  }
  async onModuleDestroy() {
    await this.stop();
  }
}
