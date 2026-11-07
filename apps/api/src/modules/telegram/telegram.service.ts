import { MediaStore } from '../../common/media-store';
import { Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ChannelAccount, Prisma } from '@prisma/client';
import type { TelegramAuthInput } from '@zalo/shared';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import { publishEvent } from '../realtime/publish';
import { TelegramBotClient } from '../telegram-bot/telegram-bot.client';
import { TelegramSettings } from './telegram.config';
import { TelegramRpcClient } from './telegram.rpc';
import {
  botCredentialsSchema,
  botTokenSchema,
  TelegramError,
  type TelegramType,
} from './telegram.types';
export function telegramPublicAccount(
  account: ChannelAccount,
  online: boolean,
  authorization: unknown = null,
) {
  const capabilities = z
    .object({
      receiveMessages: z.boolean().default(false),
      sendMessages: z.boolean().default(false),
      syncConversations: z.boolean().default(false),
      readReceipts: z.boolean().default(false),
    })
    .catch({
      receiveMessages: false,
      sendMessages: false,
      syncConversations: false,
      readReceipts: false,
    })
    .parse(account.capabilities);
  return {
    id: account.id,
    name: account.name,
    channelType: account.channelType,
    avatarUrl: account.avatarUrl,
    externalAccountId: account.externalAccountId,
    connectionStatus:
      !online && account.connectionStatus === 'CONNECTED'
        ? 'RECONNECTING'
        : account.connectionStatus,
    workerOnline: online,
    lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    lastError: account.lastError,
    lastSyncError: account.lastSyncError,
    syncComplete: account.syncComplete,
    capabilities,
    authorization,
    rateLimitedUntil: account.rateLimitedUntil?.toISOString() ?? null,
  };
}
@Injectable()
export class TelegramService {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: TelegramSettings,
    private readonly bot: TelegramBotClient,
    private readonly rpc: TelegramRpcClient,
    @Optional() private readonly media?: MediaStore,
  ) {}
  async downloadMedia(ownerId: string, sessionId: string, messageId: string) {
    const m = await this.db.message.findFirst({
      where: {
        id: messageId,
        deletedAt: null,
        source: 'TELEGRAM',
        channelAccount: { ownerId, connectionStatus: 'CONNECTED' },
      },
      include: { channelAccount: true },
    });
    if (!m?.channelAccount || !this.media)
      throw new ApiError(
        404,
        'MEDIA_NOT_FOUND',
        'Không tìm thấy tệp Telegram.',
      );
    if (m.channelAccount.channelType === 'TELEGRAM_PERSONAL') {
      try {
        await this.rpc.request({
          ownerId,
          sessionId,
          accountId: m.channelAccount.id,
          action: 'download',
          value: messageId,
        });
      } catch {
        throw new ApiError(
          503,
          'MEDIA_NOT_READY',
          'Chưa tải xong tệp Telegram. Thử mở lại sau ít giây.',
        );
      }
      return;
    }
    const data = z
      .object({
        telegram: z.object({
          media: z.object({
            fileId: z.string(),
            name: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        }),
      })
      .safeParse(m.metadata);
    if (!data.success)
      throw new ApiError(
        404,
        'MEDIA_NOT_FOUND',
        'Tin nhắn không có tệp để tải.',
      );
    const credentials = botCredentialsSchema.parse(
      JSON.parse(this.crypto.decrypt(m.channelAccount.encryptedCredentials!)),
    );
    let bytes: Buffer;
    try {
      bytes = await this.bot.download(
        credentials.token,
        data.data.telegram.media.fileId,
      );
    } catch {
      throw new ApiError(
        503,
        'MEDIA_UNAVAILABLE',
        'Tệp Telegram chưa tải được hoặc vượt giới hạn 20 MB.',
      );
    }
    await this.db.$transaction(async (tx) => {
      const a = (
        await tx.$queryRaw<
          ChannelAccount[]
        >`SELECT * FROM "ChannelAccount" WHERE "id"=${m.channelAccountId} FOR UPDATE`
      )[0];
      if (
        !a ||
        a.generation !== m.channelAccount!.generation ||
        a.connectionStatus !== 'CONNECTED' ||
        (
          await tx.message.findUnique({
            where: { id: messageId },
            select: { deletedAt: true },
          })
        )?.deletedAt
      )
        throw new ApiError(
          409,
          'CHANNEL_NOT_CONNECTED',
          'Kết nối đã thay đổi.',
        );
      await this.media!.put(tx, messageId, {
        bytes,
        size: bytes.length,
        name:
          data.data.telegram.media.name ??
          (m.type === 'audio' ? 'telegram-audio.ogg' : 'telegram-document'),
        mime: data.data.telegram.media.mimeType ?? 'application/octet-stream',
      });
    });
  }
  async owned(id: string, ownerId: string, type?: TelegramType) {
    const account = await this.db.channelAccount.findFirst({
      where: {
        id,
        ownerId,
        channelType: type ?? { in: ['TELEGRAM_BOT', 'TELEGRAM_PERSONAL'] },
      },
    });
    if (!account)
      throw new ApiError(
        404,
        'CHANNEL_NOT_FOUND',
        'Không tìm thấy tài khoản Telegram.',
      );
    return account;
  }
  async status(type: TelegramType, ownerId: string, sessionId: string) {
    const [accounts, online, nativeAvailable] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId, channelType: type },
        orderBy: { createdAt: 'asc' },
      }),
      personalWorkerOnline(this.db),
      this.settings.nativeAvailable(),
    ]);
    const output = [];
    for (const account of accounts) {
      let authorization: unknown = null;
      if (
        type === 'TELEGRAM_PERSONAL' &&
        online &&
        ['CONNECTING', 'CONNECTED', 'RECONNECTING'].includes(
          account.connectionStatus,
        )
      ) {
        try {
          authorization = await this.rpc.request({
            action: 'status',
            accountId: account.id,
            ownerId,
            sessionId,
          });
        } catch {
          /* account's durable connection status remains visible */
        }
      }
      output.push(telegramPublicAccount(account, online, authorization));
    }
    return {
      channelType: type,
      enabled:
        type === 'TELEGRAM_BOT'
          ? this.settings.botEnabled
          : this.settings.personalEnabled,
      configured:
        type === 'TELEGRAM_BOT'
          ? this.settings.botConfigured
          : this.settings.personalConfigured,
      nativeAvailable,
      workerOnline: online,
      accounts: output,
      restrictions:
        type === 'TELEGRAM_BOT'
          ? [
              'Bot chỉ nhận các cuộc chat được Telegram cho phép; không đọc hộp thư cá nhân và không lấy lịch sử cũ tùy ý.',
              'Webhook được dùng riêng, không chạy getUpdates đồng thời. Chỉ gửi trả lời văn bản; nhóm forum/topic chưa hỗ trợ gửi.',
            ]
          : [
              'Dùng TDLib chính thức, chỉ Cloud Chats riêng tư/nhóm/supergroup; không đồng bộ Secret Chats hay kênh phát sóng.',
              'Không tự đánh dấu đã đọc trên Telegram khi đồng bộ hoặc khi xem trong easyChat.',
              'Email, OTP, 2FA và xác nhận thiết bị theo trạng thái TDLib. Đăng ký mới/Premium cần hoàn tất trong ứng dụng Telegram chính thức.',
            ],
    };
  }
  async connectBot(ownerId: string, inputToken: string) {
    if (!this.settings.botEnabled) throw new TelegramError('TELEGRAM_DISABLED');
    this.settings.webhookBase();
    const token = botTokenSchema.parse(inputToken.trim());
    const me = await this.bot.getMe(token);
    if (token.split(':')[0] !== me.id)
      throw new TelegramError('TELEGRAM_ACCOUNT_MISMATCH');
    const secret = randomBytes(32).toString('base64url');
    const account = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(240011)`;
      const duplicate = await tx.channelAccount.findFirst({
        where: {
          channelType: 'TELEGRAM_BOT',
          externalAccountId: me.id,
          ownerId: { not: ownerId },
          connectionStatus: { not: 'DISCONNECTED' },
        },
      });
      if (duplicate) throw new TelegramError('TELEGRAM_BOT_ALREADY_CONNECTED');
      const current = await tx.channelAccount.upsert({
        where: {
          ownerId_channelType_externalAccountId: {
            ownerId,
            channelType: 'TELEGRAM_BOT',
            externalAccountId: me.id,
          },
        },
        create: {
          ownerId,
          channelType: 'TELEGRAM_BOT',
          externalAccountId: me.id,
          name: me.first_name + (me.username ? ` @${me.username}` : ''),
          generation: 1,
          connectionStatus: 'CONNECTING',
          encryptedCredentials: this.crypto.encrypt(
            JSON.stringify({ token, webhookSecret: secret }),
          ),
        },
        update: {
          generation: { increment: 1 },
          name: me.first_name + (me.username ? ` @${me.username}` : ''),
          connectionStatus: 'CONNECTING',
          encryptedCredentials: this.crypto.encrypt(
            JSON.stringify({ token, webhookSecret: secret }),
          ),
          capabilities: {},
          lastError: null,
        },
      });
      await this.cancelOld(tx, current);
      return current;
    });
    try {
      await this.bot.setWebhook(
        token,
        this.settings.webhookUrl(account.id),
        secret,
      );
      await this.verifyBot(account);
    } catch (error) {
      await this.db.channelAccount.updateMany({
        where: {
          id: account.id,
          generation: account.generation,
          connectionStatus: 'CONNECTING',
        },
        data: {
          connectionStatus: 'ERROR',
          lastError:
            error instanceof TelegramError
              ? error.code
              : 'TELEGRAM_OPERATION_FAILED',
        },
      });
      throw error;
    }
    return telegramPublicAccount(
      await this.db.channelAccount.findUniqueOrThrow({
        where: { id: account.id },
      }),
      await personalWorkerOnline(this.db),
    );
  }
  async verifyBot(account: ChannelAccount) {
    const credentials = botCredentialsSchema.parse(
      JSON.parse(this.crypto.decrypt(account.encryptedCredentials!)),
    );
    const [me, info] = await Promise.all([
      this.bot.getMe(credentials.token),
      this.bot.webhookInfo(credentials.token),
    ]);
    if (me.id !== account.externalAccountId)
      throw new TelegramError('TELEGRAM_ACCOUNT_MISMATCH');
    if (info.url !== this.settings.webhookUrl(account.id))
      throw new TelegramError('TELEGRAM_WEBHOOK_MISMATCH');
    await this.db.$transaction(async (tx) => {
      const updated = await tx.channelAccount.updateMany({
        where: {
          id: account.id,
          generation: account.generation,
          connectionStatus: { not: 'DISCONNECTED' },
        },
        data: {
          connectionStatus: 'CONNECTED',
          capabilities: {
            receiveMessages: true,
            sendMessages: true,
            syncConversations: false,
            readReceipts: false,
          },
          lastError: info.last_error_date
            ? 'TELEGRAM_WEBHOOK_DELIVERY_ERROR'
            : null,
          lastConnectedAt: account.lastConnectedAt ?? new Date(),
          lastSyncAt: new Date(),
          lastSyncError: null,
        },
      });
      if (updated.count)
        await publishEvent(tx, account.ownerId, {
          type: 'channel.connected',
          channelAccountId: account.id,
        });
    });
    return {
      verified: true,
      pendingUpdateCount: info.pending_update_count,
      deliveryError: info.last_error_date !== undefined,
    };
  }
  async startPersonal(
    ownerId: string,
    sessionId: string,
    name: string,
    id?: string,
  ) {
    if (!this.settings.personalConfigured)
      throw new TelegramError('TELEGRAM_NOT_CONFIGURED');
    if (!(await this.settings.nativeAvailable()))
      throw new TelegramError('TELEGRAM_NATIVE_UNAVAILABLE');
    if (!(await personalWorkerOnline(this.db)))
      throw new TelegramError('TELEGRAM_WORKER_UNAVAILABLE');
    const health = z
      .object({ nativeAvailable: z.boolean() })
      .parse(await this.rpc.request({ action: 'health', ownerId, sessionId }));
    if (!health.nativeAvailable)
      throw new TelegramError('TELEGRAM_NATIVE_UNAVAILABLE');
    const session = await this.db.adminSession.findFirst({
      where: { id: sessionId, expiresAt: { gt: new Date() } },
    });
    if (!session) throw new TelegramError('TELEGRAM_AUTH_SESSION_EXPIRED');
    const account = await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(240012)`;
        let current: ChannelAccount | null = null;
        if (id) {
          current =
            (
              await tx.$queryRaw<
                ChannelAccount[]
              >`SELECT * FROM "ChannelAccount" WHERE "id"=${id} AND "ownerId"=${ownerId} AND "channelType"='TELEGRAM_PERSONAL' FOR UPDATE`
            )[0] ?? null;
          if (!current)
            throw new ApiError(
              404,
              'CHANNEL_NOT_FOUND',
              'Không tìm thấy tài khoản Telegram.',
            );
          await this.rpc.request({
            action: 'disconnect',
            ownerId,
            sessionId,
            accountId: current.id,
          });
        } else if (
          (await tx.channelAccount.count({
            where: { ownerId, channelType: 'TELEGRAM_PERSONAL' },
          })) >= 5
        )
          throw new TelegramError('TELEGRAM_ACCOUNT_LIMIT');
        const data = {
          connectionStatus: 'CONNECTING' as const,
          encryptedCredentials: this.crypto.encrypt(
            JSON.stringify({
              databaseKey: randomBytes(32).toString('base64'),
              apiId: this.settings.config.env.TELEGRAM_API_ID,
              loginSessionId: sessionId,
              loginExpiresAt: Math.min(
                session.expiresAt.getTime(),
                Date.now() + 600000,
              ),
            }),
          ),
          capabilities: {},
          lastError: null,
          rateLimitedUntil: null,
        };
        const linked = current
          ? await tx.channelAccount.update({
              where: { id: current.id },
              data: { ...data, generation: { increment: 1 } },
            })
          : await tx.channelAccount.create({
              data: {
                ownerId,
                channelType: 'TELEGRAM_PERSONAL',
                name,
                generation: 1,
                ...data,
              },
            });
        await this.cancelOld(tx, linked);
        await publishEvent(tx, ownerId, {
          type: 'channel.disconnected',
          channelAccountId: linked.id,
        });
        return linked;
      },
      { timeout: 20000 },
    );
    try {
      await this.rpc.request({
        action: 'start',
        accountId: account.id,
        ownerId,
        sessionId,
      });
    } catch (error) {
      await this.db.channelAccount.updateMany({
        where: {
          id: account.id,
          generation: account.generation,
          connectionStatus: 'CONNECTING',
        },
        data: {
          lastError:
            error instanceof TelegramError
              ? error.code
              : 'TELEGRAM_NATIVE_UNAVAILABLE',
        },
      });
      throw error;
    }
    return telegramPublicAccount(account, true);
  }
  async authenticate(
    id: string,
    ownerId: string,
    sessionId: string,
    input: TelegramAuthInput,
  ) {
    await this.owned(id, ownerId, 'TELEGRAM_PERSONAL');
    return this.rpc.request({
      action: 'auth',
      accountId: id,
      ownerId,
      sessionId,
      authAction: input.action,
      ...('value' in input ? { value: input.value } : {}),
    });
  }
  private async cancelOld(
    tx: Prisma.TransactionClient,
    account: ChannelAccount,
  ) {
    await tx.personalCommand.updateMany({
      where: {
        channelAccountId: account.id,
        generation: { not: account.generation },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: { status: 'FAILED' },
    });
    await tx.message.updateMany({
      where: { channelAccountId: account.id, deliveryStatus: 'PENDING' },
      data: { deliveryStatus: 'FAILED', deliveryError: 'CHANNEL_RECONNECTED' },
    });
    await tx.message.updateMany({
      where: { channelAccountId: account.id, deliveryStatus: 'SENDING' },
      data: {
        deliveryStatus: 'UNKNOWN',
        deliveryError: 'TELEGRAM_SEND_UNKNOWN',
      },
    });
  }
}
@Injectable()
export class TelegramCleanup {
  constructor(
    private readonly crypto: CryptoService,
    private readonly bot: TelegramBotClient,
    private readonly rpc: TelegramRpcClient,
  ) {}
  async disconnect(account: ChannelAccount) {
    if (account.channelType === 'TELEGRAM_BOT') {
      try {
        const credentials = botCredentialsSchema.parse(
          JSON.parse(this.crypto.decrypt(account.encryptedCredentials!)),
        );
        await this.bot.deleteWebhook(credentials.token);
        return null;
      } catch {
        return 'TELEGRAM_WEBHOOK_CLEANUP_UNCONFIRMED';
      }
    }
    if (account.channelType === 'TELEGRAM_PERSONAL') {
      try {
        const result = z
          .object({ closed: z.literal(true), logoutConfirmed: z.boolean() })
          .parse(
            await this.rpc.request({
              action: 'disconnect',
              ownerId: account.ownerId,
              sessionId: '',
              accountId: account.id,
            }),
          );
        return result.logoutConfirmed
          ? null
          : 'TELEGRAM_SESSION_CLEANUP_UNCONFIRMED';
      } catch {
        return 'TELEGRAM_SESSION_CLEANUP_UNCONFIRMED';
      }
    }
    return null;
  }
}
