import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService, hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { publishEvent } from '../realtime/publish';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import { TikTokRegistry, validateAuthorizationUrl } from './tiktok.registry';
import {
  tokenSchema,
  capabilitiesSchema,
  noCapabilities,
  type TikTokType,
} from './tiktok.types';
import { TikTokError } from './tiktok-http';
const selectionSchema = z.object({
  token: tokenSchema,
  identities: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        avatarUrl: z.string().nullable(),
        region: z.string().nullable(),
        cipher: z.string().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export function publicTikTokAccount(account: ChannelAccount, online: boolean) {
  return {
    id: account.id,
    name: account.name,
    channelType: account.channelType,
    externalAccountId: account.externalAccountId,
    avatarUrl: account.avatarUrl,
    connectionStatus:
      !online && account.connectionStatus === 'CONNECTED'
        ? 'RECONNECTING'
        : account.connectionStatus,
    lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
    lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
    lastError: account.lastError,
    lastSyncError: account.lastSyncError,
    syncComplete: account.syncComplete,
    workerOnline: online,
    capabilities: capabilitiesSchema
      .catch(noCapabilities)
      .parse(account.capabilities),
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
  };
}
@Injectable()
export class TikTokAuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: TikTokRegistry,
  ) {}
  private enabled(type: TikTokType) {
    if (!this.registry.configured(type))
      throw new ApiError(
        503,
        'TIKTOK_NOT_CONFIGURED',
        'Bổ sung thông tin ứng dụng TikTok và URL cấp quyền ở backend trước khi kết nối.',
      );
  }
  async status(type: TikTokType, ownerId: string, sessionId: string) {
    const [accounts, online, authorization] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId, channelType: type },
        orderBy: { createdAt: 'asc' },
      }),
      personalWorkerOnline(this.db),
      this.db.channelAuthorization.findFirst({
        where: {
          ownerId,
          sessionId,
          channelType: type,
          expiresAt: { gt: new Date() },
          encryptedSelection: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    let selection: null | {
      id: string;
      expiresAt: string;
      accounts: {
        id: string;
        name: string;
        avatarUrl: string | null;
        region: string | null;
      }[];
    } = null;
    if (authorization?.encryptedSelection) {
      try {
        const parsed = selectionSchema.parse(
          JSON.parse(this.crypto.decrypt(authorization.encryptedSelection)),
        );
        if (parsed.token.appId === this.registry.settings(type).appId)
          selection = {
            id: authorization.id,
            expiresAt: authorization.expiresAt.toISOString(),
            accounts: parsed.identities.map(
              ({ id, name, avatarUrl, region }) => ({
                id,
                name,
                avatarUrl,
                region,
              }),
            ),
          };
      } catch {
        /* expired/invalid selections expose no credential information */
      }
    }
    return {
      channelType: type,
      enabled: Boolean(this.registry.settings(type).enabled),
      configured: this.registry.configured(type),
      workerOnline: online,
      status: accounts.some((a) => a.connectionStatus === 'CONNECTED')
        ? 'CONNECTED'
        : 'NOT_CONNECTED',
      approvalStatus: accounts.some((a) => a.connectionStatus === 'CONNECTED')
        ? 'VERIFIED'
        : 'UNVERIFIED',
      accounts: accounts.map((a) => publicTikTokAccount(a, online)),
      selection,
      restrictions:
        type === 'TIKTOK_BUSINESS'
          ? [
              'Lịch sử API: tối đa 20 tin gần nhất mỗi hội thoại, hội thoại trong 90 ngày.',
              'easyChat chỉ cho trả lời trong 48 giờ và tối đa 10 tin kể từ lần khách nhắn gần nhất; các ngoại lệ ngoài cửa sổ không được bật.',
            ]
          : [
              'Cần TikTok Shop duyệt Customer Service và seller.customer_service.',
              'Chỉ trả lời hội thoại hiện có, được TikTok cho phép; không tạo hội thoại hoặc gửi hàng loạt.',
            ],
    };
  }
  async connect(type: TikTokType, ownerId: string, sessionId: string) {
    this.enabled(type);
    const settings = this.registry.settings(type);
    const url = validateAuthorizationUrl(
      settings.authorizationUrl,
      type,
      settings.redirectUri,
    );
    const state = randomBytes(32).toString('base64url');
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AdminSession" WHERE "id"=${sessionId} FOR UPDATE`;
      const session = await tx.adminSession.findFirst({
        where: { id: sessionId, expiresAt: { gt: new Date() } },
      });
      if (!session)
        throw new ApiError(
          401,
          'OAUTH_SESSION_EXPIRED',
          'Đăng nhập và kết nối lại.',
        );
      await tx.channelAuthorization.updateMany({
        where: { sessionId, channelType: type },
        data: { expiresAt: new Date(), encryptedSelection: null },
      });
      await tx.channelAuthorization.create({
        data: {
          sessionId,
          ownerId,
          channelType: type,
          stateHash: hash(state),
          expiresAt: new Date(Date.now() + 600000),
        },
      });
    });
    url.searchParams.set('state', state);
    if (type === 'TIKTOK_BUSINESS')
      url.searchParams.set('disable_auto_auth', '1');
    return { authorizationUrl: url.href };
  }
  async callback(
    type: TikTokType,
    ownerId: string,
    sessionId: string,
    state: string,
    code?: string,
  ) {
    this.enabled(type);
    const consumed = await this.db.channelAuthorization.updateMany({
      where: {
        sessionId,
        ownerId,
        channelType: type,
        stateHash: hash(state),
        consumedAt: null,
        expiresAt: { gt: new Date() },
        session: { expiresAt: { gt: new Date() } },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1)
      throw new ApiError(
        400,
        'INVALID_OAUTH_STATE',
        'Yêu cầu cấp quyền đã hết hạn hoặc đã được sử dụng.',
      );
    if (!code || code === 'null')
      throw new ApiError(
        400,
        'OAUTH_DENIED',
        'Bạn chưa cấp quyền cho ứng dụng.',
      );
    const adapter = this.registry.adapter(type);
    const token = await adapter.exchange(code);
    if (token.expiresAt <= Date.now() || token.refreshExpiresAt <= Date.now())
      throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
    const identities = await adapter.identities(token);
    if (!identities.length)
      throw new TikTokError('TIKTOK_ACCOUNT_NOT_ELIGIBLE');
    const encrypted = this.crypto.encrypt(
      JSON.stringify(selectionSchema.parse({ token, identities })),
    );
    const saved = await this.db.channelAuthorization.updateMany({
      where: {
        sessionId,
        ownerId,
        channelType: type,
        stateHash: hash(state),
        expiresAt: { gt: new Date() },
        session: { expiresAt: { gt: new Date() } },
      },
      data: { encryptedSelection: encrypted },
    });
    if (saved.count !== 1)
      throw new ApiError(
        401,
        'OAUTH_SESSION_EXPIRED',
        'Phiên cấp quyền đã hết hạn.',
      );
  }
  async select(
    type: TikTokType,
    ownerId: string,
    sessionId: string,
    authorizationId: string,
    externalAccountId: string,
  ) {
    this.enabled(type);
    const auth = await this.db.channelAuthorization.findFirst({
      where: {
        id: authorizationId,
        ownerId,
        sessionId,
        channelType: type,
        expiresAt: { gt: new Date() },
        session: { expiresAt: { gt: new Date() } },
      },
    });
    if (!auth?.encryptedSelection)
      throw new ApiError(
        409,
        'TIKTOK_SELECTION_EXPIRED',
        'Bắt đầu kết nối lại để chọn tài khoản.',
      );
    const parsed = selectionSchema.parse(
      JSON.parse(this.crypto.decrypt(auth.encryptedSelection)),
    );
    if (
      parsed.token.expiresAt <= Date.now() + 30000 ||
      parsed.token.refreshExpiresAt <= Date.now()
    )
      throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
    const identity = parsed.identities.find((a) => a.id === externalAccountId);
    if (!identity || parsed.token.appId !== this.registry.settings(type).appId)
      throw new ApiError(
        403,
        'TIKTOK_ACCOUNT_MISMATCH',
        'Chỉ chọn tài khoản đã cấp quyền trong phiên này.',
      );
    const token = {
      ...parsed.token,
      ...(identity.cipher ? { shopCipher: identity.cipher } : {}),
    };
    const adapter = this.registry.adapter(type);
    const capabilities = await adapter.verify(token, identity);
    await adapter.subscribe(token, this.registry.webhookUrl(type));
    const account = await this.db.$transaction(async (tx) => {
      const consumed = await tx.channelAuthorization.updateMany({
        where: {
          id: auth.id,
          encryptedSelection: auth.encryptedSelection,
          expiresAt: { gt: new Date() },
          session: { expiresAt: { gt: new Date() } },
        },
        data: { encryptedSelection: null },
      });
      if (consumed.count !== 1)
        throw new ApiError(
          409,
          'TIKTOK_SELECTION_EXPIRED',
          'Lựa chọn đã hết hạn hoặc được sử dụng.',
        );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(240009)`;
      const data = {
        name: identity.name,
        avatarUrl: identity.avatarUrl,
        encryptedCredentials: this.crypto.encrypt(JSON.stringify(token)),
        capabilities: capabilities as Prisma.InputJsonObject,
        tokenExpiresAt: new Date(token.expiresAt),
        refreshExpiresAt: new Date(token.refreshExpiresAt),
        connectionStatus: 'CONNECTED' as const,
        lastConnectedAt: new Date(),
        lastError: null,
        lastSyncError: null,
        syncCursor: null,
        syncComplete: false,
      };
      const linked = await tx.channelAccount.upsert({
        where: {
          ownerId_channelType_externalAccountId: {
            ownerId,
            channelType: type,
            externalAccountId,
          },
        },
        create: {
          ownerId,
          channelType: type,
          externalAccountId,
          generation: 1,
          ...data,
        },
        update: { generation: { increment: 1 }, ...data },
      });
      await tx.personalCommand.updateMany({
        where: {
          channelAccountId: linked.id,
          status: { in: ['PENDING', 'PROCESSING'] },
          generation: { not: linked.generation },
        },
        data: { status: 'FAILED' },
      });
      await tx.message.updateMany({
        where: { channelAccountId: linked.id, deliveryStatus: 'PENDING' },
        data: {
          deliveryStatus: 'FAILED',
          deliveryError: 'CHANNEL_RECONNECTED',
        },
      });
      await tx.message.updateMany({
        where: { channelAccountId: linked.id, deliveryStatus: 'SENDING' },
        data: {
          deliveryStatus: 'UNKNOWN',
          deliveryError: 'TIKTOK_SEND_UNKNOWN',
        },
      });
      await tx.personalCommand.create({
        data: {
          channelAccountId: linked.id,
          generation: linked.generation,
          kind: 'SYNC',
          deduplicationKey: `tiktok:initial:${linked.id}:${randomUUID()}`,
          payload: { page: 0 },
        },
      });
      await publishEvent(tx, ownerId, {
        type: 'channel.connected',
        channelAccountId: linked.id,
      });
      return linked;
    });
    return publicTikTokAccount(account, await personalWorkerOnline(this.db));
  }
}
