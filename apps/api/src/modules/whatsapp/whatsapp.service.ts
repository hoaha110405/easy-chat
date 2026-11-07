import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { whatsappMediaInputSchema } from '@zalo/shared';
import { channelSendPolicy } from '../messaging/channel-policy';
import { validateWhatsAppUpload, type WhatsAppUpload } from './whatsapp.media';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService, hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import { publishEvent } from '../realtime/publish';
import { serializeMessage } from '../inbox/inbox.service';
import { WhatsAppClient } from './whatsapp.client';
import {
  waCredentials,
  waMetadata,
  waId,
  waRecipient,
  WhatsAppError,
  type WaCredentials,
} from './whatsapp.types';
import {
  templatePresentation,
  templateInputSchema,
  prepareTemplate,
} from './whatsapp.templates';
@Injectable()
export class WhatsAppSettings {
  constructor(readonly config: ConfigService) {}
  get enabled() {
    return this.config.env.WHATSAPP_ENABLED ?? false;
  }
  get configured() {
    const e = this.config.env;
    return Boolean(
      this.enabled &&
      e.WHATSAPP_META_APP_ID &&
      e.WHATSAPP_META_APP_SECRET &&
      e.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
      this.callback(),
    );
  }
  callback() {
    try {
      const u = new URL(this.config.env.WHATSAPP_WEBHOOK_CALLBACK_URL);
      if (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/api/webhooks/whatsapp'
      )
        return u.href;
    } catch {
      /* invalid configuration */
    }
    return null;
  }
  get embedded() {
    const e = this.config.env;
    return Boolean(
      this.configured &&
      e.WHATSAPP_EMBEDDED_SIGNUP_ENABLED &&
      e.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID &&
      e.FRONTEND_URL.startsWith('https://'),
    );
  }
}
export function publicWhatsAppAccount(a: ChannelAccount, online: boolean) {
  const m = waMetadata.safeParse(a.providerMetadata);
  return {
    id: a.id,
    name: a.name,
    avatarUrl: a.avatarUrl,
    externalAccountId: a.externalAccountId,
    channelType: 'WHATSAPP_BUSINESS' as const,
    connectionStatus: a.connectionStatus,
    lastConnectedAt: a.lastConnectedAt?.toISOString() ?? null,
    lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
    lastError: a.lastError,
    lastSyncError: a.lastSyncError,
    syncComplete: a.syncComplete,
    workerOnline: online,
    tokenExpiresAt: a.tokenExpiresAt?.toISOString() ?? null,
    metadata: m.success ? m.data : null,
    capabilities: z
      .object({
        receiveMessages: z.boolean().default(false),
        sendMessages: z.boolean().default(false),
        syncConversations: z.boolean().default(false),
        readReceipts: z.boolean().default(false),
        templates: z.boolean().default(false),
        providerMarkRead: z.boolean().default(false),
        coexistence: z.boolean().default(false),
      })
      .parse(a.capabilities),
  };
}
@Injectable()
export class WhatsAppService {
  constructor(
    readonly db: PrismaService,
    readonly config: ConfigService,
    readonly crypto: CryptoService,
    readonly settings: WhatsAppSettings,
    readonly client: WhatsAppClient,
  ) {}
  async owned(id: string, ownerId: string) {
    const a = await this.db.channelAccount.findFirst({
      where: { id, ownerId, channelType: 'WHATSAPP_BUSINESS' },
    });
    if (!a)
      throw new ApiError(
        404,
        'CHANNEL_NOT_FOUND',
        'Không tìm thấy tài khoản WhatsApp.',
      );
    return a;
  }
  credentials(a: ChannelAccount): WaCredentials {
    let c: WaCredentials;
    try {
      c = waCredentials.parse(
        JSON.parse(this.crypto.decrypt(a.encryptedCredentials!)),
      );
    } catch {
      throw new WhatsAppError('WHATSAPP_REAUTH_REQUIRED');
    }
    if (
      c.appId !== this.config.env.WHATSAPP_META_APP_ID ||
      (c.expiresAt && c.expiresAt <= Date.now())
    )
      throw new WhatsAppError('WHATSAPP_REAUTH_REQUIRED');
    return c;
  }
  private requireConfig() {
    if (!this.settings.configured)
      throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED');
  }
  async checkedToken(token: string) {
    const { data } = await this.client.inspect(token);
    if (
      !data.is_valid ||
      data.app_id !== this.config.env.WHATSAPP_META_APP_ID ||
      data.type === 'PAGE'
    )
      throw new WhatsAppError('WHATSAPP_REAUTH_REQUIRED');
    if (
      !['whatsapp_business_management', 'whatsapp_business_messaging'].every(
        (s) => data.scopes.includes(s),
      )
    )
      throw new WhatsAppError('WHATSAPP_PERMISSION_REQUIRED');
    const times = [data.expires_at, data.data_access_expires_at].filter(
      (x): x is number => typeof x === 'number' && x > 0,
    );
    const expiresAt = times.length ? Math.min(...times) * 1000 : null;
    if (expiresAt && expiresAt <= Date.now() + 30000)
      throw new WhatsAppError('WHATSAPP_REAUTH_REQUIRED');
    return {
      scopes: data.scopes,
      expiresAt,
      wabaIds: [
        ...new Set(
          (data.granular_scopes ?? [])
            .filter((g) =>
              [
                'whatsapp_business_management',
                'whatsapp_business_messaging',
              ].includes(g.scope),
            )
            .flatMap((g) => g.target_ids ?? []),
        ),
      ],
    };
  }
  async verifyAppWebhook(embedded = false) {
    const { data } = await this.client.appSubscriptions();
    const required = embedded ? ['messages', 'account_update'] : ['messages'];
    const ok = data.some(
      (s) =>
        s.object === 'whatsapp_business_account' &&
        s.active === true &&
        s.callback_url === this.settings.callback() &&
        required.every((f) =>
          s.fields?.some((x) => (typeof x === 'string' ? x : x.name) === f),
        ),
    );
    if (!ok) throw new WhatsAppError('WHATSAPP_WEBHOOK_NOT_CONFIGURED');
  }
  async membership(token: string, wabaId: string, phoneId: string) {
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.client.phones(token, wabaId, after);
      const found = r.data.find((p) => p.id === phoneId);
      if (found) return found;
      if (!r.paging?.next || !r.paging.cursors?.after) break;
      if (r.paging.cursors.after === after) break;
      after = r.paging.cursors.after;
    }
    throw new WhatsAppError('WHATSAPP_PHONE_NOT_AUTHORIZED');
  }
  async connect(
    ownerId: string,
    token: string,
    wabaId: string,
    phoneId: string,
    mode: 'DIRECT' | 'EMBEDDED' = 'DIRECT',
    pin?: string,
  ) {
    this.requireConfig();
    waId.parse(wabaId);
    waId.parse(phoneId);
    if (pin)
      z.string()
        .regex(/^\d{6}$/)
        .parse(pin);
    const auth = await this.checkedToken(token),
      business = await this.client.business(token, wabaId),
      phone = await this.membership(token, wabaId, phoneId);
    if (business.id !== wabaId)
      throw new WhatsAppError('WHATSAPP_PHONE_NOT_AUTHORIZED');
    if (phone.is_on_biz_app === true)
      throw new WhatsAppError('WHATSAPP_COEXISTENCE_APPROVAL_REQUIRED');
    if (
      (phone.status !== 'CONNECTED' || phone.platform_type !== 'CLOUD_API') &&
      !pin
    )
      throw new WhatsAppError('WHATSAPP_REGISTRATION_REQUIRED');
    await this.verifyAppWebhook(mode === 'EMBEDDED');
    const metadata = {
      wabaId,
      phoneNumberId: phoneId,
      displayPhoneNumber: phone.display_phone_number,
      verifiedName: phone.verified_name,
      businessName: business.name,
      onboardingMode: mode,
      webhookVerifiedAt: new Date().toISOString(),
      isOnBizApp: false,
    };
    const a = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChannelAccount" WHERE "ownerId"=${ownerId} AND "channelType"='WHATSAPP_BUSINESS' AND "externalAccountId"=${phoneId} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(240013)`;
      const other = await tx.channelAccount.findFirst({
        where: {
          channelType: 'WHATSAPP_BUSINESS',
          externalAccountId: phoneId,
          ownerId: { not: ownerId },
          connectionStatus: { not: 'DISCONNECTED' },
        },
      });
      if (other) throw new WhatsAppError('WHATSAPP_PHONE_ALREADY_CONNECTED');
      const data = {
        name: phone.verified_name + ' · ' + phone.display_phone_number,
        encryptedCredentials: this.crypto.encrypt(
          JSON.stringify({
            accessToken: token,
            appId: this.config.env.WHATSAPP_META_APP_ID,
            wabaId,
            phoneNumberId: phoneId,
            scopes: auth.scopes,
            expiresAt: auth.expiresAt,
          }),
        ),
        providerMetadata: metadata,
        connectionStatus: 'CONNECTING' as const,
        tokenExpiresAt: auth.expiresAt ? new Date(auth.expiresAt) : null,
        capabilities: {},
        lastError: null,
        rateLimitedUntil: null,
      };
      const account = await tx.channelAccount.upsert({
        where: {
          ownerId_channelType_externalAccountId: {
            ownerId,
            channelType: 'WHATSAPP_BUSINESS',
            externalAccountId: phoneId,
          },
        },
        create: {
          ownerId,
          channelType: 'WHATSAPP_BUSINESS',
          externalAccountId: phoneId,
          generation: 1,
          ...data,
        },
        update: { ...data, generation: { increment: 1 } },
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
          deliveryError: 'CHANNEL_RECONNECTED',
        },
      });
      await tx.message.updateMany({
        where: { channelAccountId: account.id, deliveryStatus: 'SENDING' },
        data: {
          deliveryStatus: 'UNKNOWN',
          deliveryError: 'WHATSAPP_SEND_UNKNOWN',
        },
      });
      return account;
    });
    try {
      return await this.db.$transaction(
        async (tx) => {
          const current = (
            await tx.$queryRaw<
              ChannelAccount[]
            >`SELECT * FROM "ChannelAccount" WHERE "id"=${a.id} AND "generation"=${a.generation} AND "connectionStatus"='CONNECTING' FOR UPDATE`
          )[0];
          if (!current) throw new WhatsAppError('WHATSAPP_CONNECTION_CHANGED');
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(240013)`;
          if (
            phone.status !== 'CONNECTED' ||
            phone.platform_type !== 'CLOUD_API'
          ) {
            await this.client.register(token, phoneId, pin!);
          }
          const actual = await this.client.phone(token, phoneId);
          if (
            actual.id !== phoneId ||
            actual.is_on_biz_app === true ||
            actual.platform_type !== 'CLOUD_API' ||
            actual.status !== 'CONNECTED'
          )
            throw new WhatsAppError('WHATSAPP_REGISTRATION_REQUIRED');
          await this.client.subscribe(token, wabaId);
          const subs = await this.client.subscriptions(token, wabaId);
          if (
            !subs.data.some(
              (s) =>
                s.whatsapp_business_api_data.id ===
                this.config.env.WHATSAPP_META_APP_ID,
            )
          )
            throw new WhatsAppError('WHATSAPP_WEBHOOK_NOT_CONFIGURED');
          const saved = await tx.channelAccount.update({
            where: { id: a.id },
            data: {
              connectionStatus: 'CONNECTED',
              capabilities: {
                receiveMessages: true,
                sendMessages: true,
                syncConversations: false,
                readReceipts: true,
                templates: true,
                providerMarkRead: true,
                coexistence: false,
              },
              lastConnectedAt: new Date(),
              lastSyncAt: new Date(),
              syncComplete: true,
              lastError: null,
            },
          });
          await publishEvent(tx, ownerId, {
            type: 'channel.connected',
            channelAccountId: a.id,
          });
          return publicWhatsAppAccount(saved, await personalWorkerOnline(tx));
        },
        { timeout: 45000 },
      );
    } catch (error) {
      await this.db.channelAccount.updateMany({
        where: {
          id: a.id,
          generation: a.generation,
          connectionStatus: 'CONNECTING',
        },
        data: {
          connectionStatus:
            error instanceof WhatsAppError &&
            error.code === 'WHATSAPP_REAUTH_REQUIRED'
              ? 'REAUTH_REQUIRED'
              : 'ERROR',
          lastError:
            error instanceof WhatsAppError
              ? error.code
              : 'WHATSAPP_CONNECTION_FAILED',
        },
      });
      throw error;
    }
  }
  async status(ownerId: string, sessionId: string) {
    const [accounts, online, authorization] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId, channelType: 'WHATSAPP_BUSINESS' },
        orderBy: { createdAt: 'asc' },
      }),
      personalWorkerOnline(this.db),
      this.db.channelAuthorization.findFirst({
        where: {
          ownerId,
          sessionId,
          channelType: 'WHATSAPP_BUSINESS',
          expiresAt: { gt: new Date() },
          encryptedSelection: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    let selection: unknown = null;
    if (authorization) {
      try {
        const value = z
          .object({ wabaIds: z.array(waId) })
          .parse(
            JSON.parse(this.crypto.decrypt(authorization.encryptedSelection!)),
          );
        selection = {
          id: authorization.id,
          wabaIds: value.wabaIds,
          expiresAt: authorization.expiresAt.toISOString(),
        };
      } catch {
        /* expired/corrupt selection */
      }
    }
    return {
      enabled: this.settings.enabled,
      configured: this.settings.configured,
      embeddedAvailable: this.settings.embedded,
      embeddedStatus: this.settings.embedded
        ? 'CONFIGURED_UNVERIFIED'
        : 'CONFIGURATION_OR_APPROVAL_REQUIRED',
      workerOnline: online,
      accounts: accounts.map((a) => publicWhatsAppAccount(a, online)),
      selection,
      restrictions: [
        'Chỉ WhatsApp Business Cloud API chính thức; không kết nối WhatsApp cá nhân.',
        'Trả lời tự do trong cửa sổ 24 giờ từ tin khách hàng; ngoài cửa sổ cần mẫu đã duyệt và sự đồng ý phù hợp.',
        'Lịch sử được lưu từ khi tích hợp. Coexistence và tải lịch sử Business App chưa bật.',
      ],
    };
  }
  async begin(ownerId: string, sessionId: string) {
    if (!this.settings.embedded)
      throw new WhatsAppError('WHATSAPP_EMBEDDED_APPROVAL_REQUIRED');
    const state = randomBytes(32).toString('base64url');
    const row = await this.db.channelAuthorization.create({
      data: {
        ownerId,
        sessionId,
        channelType: 'WHATSAPP_BUSINESS',
        stateHash: hash(state),
        expiresAt: new Date(Date.now() + 300000),
      },
    });
    return {
      authorizationId: row.id,
      state,
      appId: this.config.env.WHATSAPP_META_APP_ID,
      configId: this.config.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
      graphVersion: this.config.env.WHATSAPP_GRAPH_API_VERSION,
    };
  }
  async complete(
    ownerId: string,
    sessionId: string,
    id: string,
    state: string,
    code: string,
  ) {
    if (!this.settings.embedded)
      throw new WhatsAppError('WHATSAPP_EMBEDDED_APPROVAL_REQUIRED');
    const changed = await this.db.channelAuthorization.updateMany({
      where: {
        id,
        ownerId,
        sessionId,
        channelType: 'WHATSAPP_BUSINESS',
        stateHash: hash(state),
        expiresAt: { gt: new Date() },
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
    if (changed.count !== 1)
      throw new WhatsAppError('WHATSAPP_OAUTH_STATE_INVALID');
    const { access_token } = await this.client.exchange(code);
    const checked = await this.checkedToken(access_token);
    await this.db.channelAuthorization.update({
      where: { id },
      data: {
        encryptedSelection: this.crypto.encrypt(
          JSON.stringify({ accessToken: access_token, ...checked }),
        ),
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    return { authorizationId: id };
  }
  async selectionPhones(
    ownerId: string,
    sessionId: string,
    id: string,
    wabaId: string,
    after?: string,
  ) {
    const row = await this.db.channelAuthorization.findFirst({
      where: {
        id,
        ownerId,
        sessionId,
        channelType: 'WHATSAPP_BUSINESS',
        expiresAt: { gt: new Date() },
        encryptedSelection: { not: null },
      },
    });
    if (!row) throw new WhatsAppError('WHATSAPP_OAUTH_STATE_INVALID');
    const { accessToken } = z
      .object({ accessToken: z.string() })
      .parse(JSON.parse(this.crypto.decrypt(row.encryptedSelection!)));
    await this.client.business(accessToken, wabaId);
    const result = await this.client.phones(accessToken, wabaId, after);
    return {
      items: result.data.map((p) => ({
        id: p.id,
        displayPhoneNumber: p.display_phone_number,
        verifiedName: p.verified_name,
        status: p.status,
        platformType: p.platform_type,
        coexistence: p.is_on_biz_app ?? false,
      })),
      nextCursor: result.paging?.next
        ? (result.paging.cursors?.after ?? null)
        : null,
    };
  }
  async select(
    ownerId: string,
    sessionId: string,
    id: string,
    wabaId: string,
    phoneId: string,
    pin?: string,
  ) {
    const data = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChannelAuthorization" WHERE "id"=${id} FOR UPDATE`;
      const row = await tx.channelAuthorization.findFirst({
        where: {
          id,
          ownerId,
          sessionId,
          channelType: 'WHATSAPP_BUSINESS',
          expiresAt: { gt: new Date() },
          encryptedSelection: { not: null },
        },
      });
      if (!row) throw new WhatsAppError('WHATSAPP_OAUTH_STATE_INVALID');
      const value = z
        .object({ accessToken: z.string() })
        .parse(JSON.parse(this.crypto.decrypt(row.encryptedSelection!)));
      await tx.channelAuthorization.update({
        where: { id },
        data: { encryptedSelection: null },
      });
      return value;
    });
    return this.connect(
      ownerId,
      data.accessToken,
      wabaId,
      phoneId,
      'EMBEDDED',
      pin,
    );
  }
  async templates(a: ChannelAccount, after?: string) {
    const c = this.credentials(a);
    try {
      const r = await this.client.templates(c.accessToken, c.wabaId, after);
      return {
        items: r.data.map(templatePresentation),
        nextCursor: r.paging?.next ? (r.paging.cursors?.after ?? null) : null,
      };
    } catch (e) {
      if (
        e instanceof WhatsAppError &&
        e.code === 'WHATSAPP_PERMISSION_REQUIRED'
      )
        throw new WhatsAppError('WHATSAPP_TEMPLATE_PERMISSION_REQUIRED');
      throw e;
    }
  }
  async template(
    a: ChannelAccount,
    id: string,
    name: string,
    language: string,
  ) {
    const c = this.credentials(a);
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await this.client.templates(
        c.accessToken,
        c.wabaId,
        after,
        name,
      );
      const found = r.data.find(
        (t) => t.id === id && t.name === name && t.language === language,
      );
      if (found) return found;
      const next = r.paging?.next ? r.paging.cursors?.after : null;
      if (!next || next === after) break;
      after = next;
    }
    throw new WhatsAppError('WHATSAPP_TEMPLATE_NOT_FOUND');
  }
  async sendTemplate(
    ownerId: string,
    conversationId: string,
    input: z.infer<typeof templateInputSchema>,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: {
        id: conversationId,
        channelAccount: { ownerId, channelType: 'WHATSAPP_BUSINESS' },
      },
      include: { channelAccount: true },
    });
    if (!conversation?.channelAccount)
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Không tìm thấy hội thoại.',
      );
    const existing = await this.db.message.findFirst({
      where: {
        channelAccountId: conversation.channelAccountId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (existing) {
      const old = z
        .object({ whatsapp: z.object({ templateInput: templateInputSchema }) })
        .safeParse(existing.metadata);
      if (
        existing.conversationId !== conversationId ||
        !old.success ||
        JSON.stringify(old.data.whatsapp.templateInput) !==
          JSON.stringify(input)
      )
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Khóa gửi đã được dùng cho nội dung khác.',
        );
      return serializeMessage(existing);
    }
    const prepared = prepareTemplate(
      await this.template(
        conversation.channelAccount,
        input.templateId,
        input.templateName,
        input.language,
      ),
      input,
    );
    return this.db.$transaction(async (tx) => {
      const a = (
        await tx.$queryRaw<
          ChannelAccount[]
        >`SELECT * FROM "ChannelAccount" WHERE "id"=${conversation.channelAccountId} FOR UPDATE`
      )[0];
      if (
        a.connectionStatus !== 'CONNECTED' ||
        !(await personalWorkerOnline(tx))
      )
        throw new WhatsAppError('WHATSAPP_NOT_CONNECTED');
      this.credentials(a);
      if (a.rateLimitedUntil && a.rateLimitedUntil > new Date())
        throw new WhatsAppError('WHATSAPP_RATE_LIMITED');
      if (
        (await tx.message.count({
          where: {
            channelAccountId: a.id,
            deliveryStatus: { in: ['PENDING', 'SENDING'] },
          },
        })) >= 20
      )
        throw new WhatsAppError('WHATSAPP_RATE_LIMITED');
      const duplicate = await tx.message.findUnique({
        where: {
          channelAccountId_idempotencyKey: {
            channelAccountId: a.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (duplicate) {
        if (
          duplicate.conversationId !== conversationId ||
          duplicate.content !== prepared.content ||
          JSON.stringify(
            z
              .object({
                whatsapp: z.object({ templateInput: templateInputSchema }),
              })
              .parse(duplicate.metadata).whatsapp.templateInput,
          ) !== JSON.stringify(templateInputSchema.parse(input))
        )
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Khóa gửi đã được dùng cho nội dung khác.',
          );
        return serializeMessage(duplicate);
      }
      waRecipient.parse(conversation.externalContactId);
      const m = await tx.message.create({
        data: {
          channelAccountId: a.id,
          conversationId,
          source: 'WHATSAPP',
          direction: 'OUTGOING',
          type: 'template',
          content: prepared.content,
          externalSenderId: a.externalAccountId,
          idempotencyKey: input.idempotencyKey,
          deliveryStatus: 'PENDING',
          sentAt: new Date(),
          metadata: {
            whatsapp: {
              templateInput: input,
              optInConfirmedAt: new Date().toISOString(),
              authorizedBy: ownerId,
            },
          },
        },
      });
      await tx.personalCommand.create({
        data: {
          channelAccountId: a.id,
          messageId: m.id,
          kind: 'SEND',
          generation: a.generation,
          deduplicationKey: 'send:' + m.id,
        },
      });
      await publishEvent(tx, ownerId, {
        type: 'message.created',
        channelAccountId: a.id,
        conversationId,
        messageId: m.id,
      });
      return serializeMessage(m);
    });
  }
  async sendMedia(
    ownerId: string,
    conversationId: string,
    input: z.infer<typeof whatsappMediaInputSchema>,
    file: WhatsAppUpload | undefined,
  ) {
    this.requireConfig();
    const upload = validateWhatsAppUpload(file, input.kind);
    if (input.kind === 'audio' && input.caption)
      throw new WhatsAppError('WHATSAPP_AUDIO_CAPTION_UNSUPPORTED');
    return this.db.$transaction(
      async (tx) => {
        const conversation = await tx.conversation.findFirst({
          where: {
            id: conversationId,
            channelAccount: { ownerId, channelType: 'WHATSAPP_BUSINESS' },
          },
        });
        if (!conversation?.channelAccountId)
          throw new ApiError(
            404,
            'CONVERSATION_NOT_FOUND',
            'Không tìm thấy hội thoại WhatsApp.',
          );
        const a = (
          await tx.$queryRaw<
            ChannelAccount[]
          >`SELECT * FROM "ChannelAccount" WHERE "id"=${conversation.channelAccountId} FOR UPDATE`
        )[0];
        const existing = await tx.message.findUnique({
          where: {
            channelAccountId_idempotencyKey: {
              channelAccountId: a.id,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          const old = z
            .object({
              whatsapp: z.object({
                upload: z.object({
                  kind: z.string(),
                  sha256: z.string(),
                  name: z.string(),
                  caption: z.string(),
                }),
              }),
            })
            .safeParse(existing.metadata);
          if (
            existing.conversationId !== conversationId ||
            !old.success ||
            old.data.whatsapp.upload.kind !== upload.kind ||
            old.data.whatsapp.upload.sha256 !== upload.sha256 ||
            old.data.whatsapp.upload.name !== upload.name ||
            old.data.whatsapp.upload.caption !== input.caption
          )
            throw new ApiError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'Khóa gửi đã được dùng cho tệp hoặc nội dung khác.',
            );
          return serializeMessage(existing);
        }
        const policy = channelSendPolicy(
          a,
          conversation,
          await personalWorkerOnline(tx),
        );
        if (!policy.allowed)
          throw new WhatsAppError(policy.code ?? 'WHATSAPP_WINDOW_CLOSED');
        if (
          (await tx.message.count({
            where: {
              channelAccountId: a.id,
              deliveryStatus: { in: ['PENDING', 'SENDING'] },
            },
          })) >= 20
        )
          throw new WhatsAppError('WHATSAPP_RATE_LIMITED');
        const credentials = this.credentials(a);
        waRecipient.parse(conversation.externalContactId);
        // Uploading creates a provider asset, never a delivered message. Only the durable outbox sends it.
        // Holding the account lock serializes duplicate requests and disconnect while this bounded upload runs.
        const result = await this.client.upload(
          credentials.accessToken,
          credentials.phoneNumberId,
          file!.buffer,
          upload.mime,
          upload.name,
        );
        const m = await tx.message.create({
          data: {
            channelAccountId: a.id,
            conversationId,
            source: 'WHATSAPP',
            direction: 'OUTGOING',
            type: input.kind === 'document' ? 'file' : 'audio',
            content: input.caption,
            externalSenderId: a.externalAccountId,
            idempotencyKey: input.idempotencyKey,
            deliveryStatus: 'PENDING',
            sentAt: new Date(),
            metadata: {
              attachments: [
                {
                  type: input.kind === 'document' ? 'file' : 'audio',
                  payload: { name: upload.name },
                },
              ],
              whatsapp: {
                media: {
                  id: result.id,
                  mime_type: upload.mime,
                  filename: upload.name,
                },
                upload: {
                  ...upload,
                  caption: input.caption,
                  uploadedAt: new Date().toISOString(),
                },
              },
            },
          },
        });
        await tx.personalCommand.create({
          data: {
            channelAccountId: a.id,
            messageId: m.id,
            kind: 'SEND',
            generation: a.generation,
            deduplicationKey: 'send:' + m.id,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: m.sentAt,
            lastMessagePreview: (
              input.caption ||
              `${input.kind === 'document' ? 'Tài liệu' : 'Âm thanh'}: ${upload.name}`
            ).slice(0, 280),
          },
        });
        await publishEvent(tx, ownerId, {
          type: 'message.created',
          channelAccountId: a.id,
          conversationId,
          messageId: m.id,
        });
        return serializeMessage(m);
      },
      { timeout: 45000, maxWait: 10000 },
    );
  }
  async media(ownerId: string, messageId: string) {
    const m = await this.db.message.findFirst({
      where: {
        id: messageId,
        channelAccount: { ownerId, channelType: 'WHATSAPP_BUSINESS' },
      },
      include: { channelAccount: true },
    });
    if (!m?.channelAccount || m.deletedAt)
      throw new ApiError(
        404,
        'WHATSAPP_MEDIA_UNAVAILABLE',
        'Tệp không còn khả dụng.',
      );
    const meta = z
      .object({
        whatsapp: z.object({
          media: z.object({
            id: waId,
            mime_type: z.string(),
            filename: z.string().optional(),
          }),
        }),
      })
      .parse(m.metadata);
    const c = this.credentials(m.channelAccount);
    const info = await this.client.media(
      c.accessToken,
      meta.whatsapp.media.id,
      c.phoneNumberId,
    );
    const limits: Record<string, number> = {
      'image/jpeg': 5e6,
      'image/png': 5e6,
      'image/webp': 500000,
      'audio/aac': 16e6,
      'audio/amr': 16e6,
      'audio/mpeg': 16e6,
      'audio/mp4': 16e6,
      'audio/ogg': 16e6,
      'video/mp4': 16e6,
      'video/3gpp': 16e6,
      'application/pdf': 20e6,
      'text/plain': 20e6,
      'application/msword': 20e6,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 20e6,
      'application/vnd.ms-excel': 20e6,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 20e6,
      'application/vnd.ms-powerpoint': 20e6,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 20e6,
    };
    const mime = info.mime_type.split(';')[0].toLowerCase();
    if (
      info.id !== meta.whatsapp.media.id ||
      !limits[mime] ||
      info.file_size > limits[mime] ||
      mime !== meta.whatsapp.media.mime_type.split(';')[0].toLowerCase()
    )
      throw new WhatsAppError('WHATSAPP_MEDIA_UNSUPPORTED');
    const bytes = await this.client.download(
      c.accessToken,
      info.url,
      limits[mime],
    );
    if (
      bytes.length !== info.file_size ||
      ![
        createHash('sha256').update(bytes).digest('base64'),
        createHash('sha256').update(bytes).digest('hex'),
      ].includes(info.sha256)
    )
      throw new WhatsAppError('WHATSAPP_MEDIA_UNAVAILABLE');
    return {
      bytes,
      mime,
      name: (meta.whatsapp.media.filename ?? `whatsapp-${m.id}`)
        .replace(/[^\p{L}\p{N}_. -]/gu, '_')
        .slice(0, 150),
      inline: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'audio/aac',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
      ].includes(mime),
    };
  }
  async enqueueRead(
    ownerId: string,
    conversationId: string,
    messageIds: string[],
  ) {
    return this.db.$transaction(async (tx) => {
      const c = await tx.conversation.findFirst({
        where: {
          id: conversationId,
          channelAccount: { ownerId, channelType: 'WHATSAPP_BUSINESS' },
        },
        include: { channelAccount: true },
      });
      if (
        !c?.channelAccount ||
        c.channelAccount.connectionStatus !== 'CONNECTED'
      )
        throw new WhatsAppError('WHATSAPP_NOT_CONNECTED');
      const found = await tx.message.findMany({
        where: {
          id: { in: messageIds },
          conversationId,
          direction: 'INCOMING',
          externalMessageId: { not: null },
        },
      });
      if (found.length !== new Set(messageIds).size)
        throw new ApiError(
          404,
          'MESSAGE_NOT_FOUND',
          'Không tìm thấy tin nhận trong hội thoại này.',
        );
      for (const m of found)
        await tx.personalCommand.createMany({
          data: [
            {
              channelAccountId: c.channelAccount.id,
              generation: c.channelAccount.generation,
              kind: 'SYNC_MESSAGES',
              deduplicationKey: `whatsapp:read:${c.channelAccount.generation}:${m.id}`,
              payload: { operation: 'MARK_READ', messageId: m.id },
            },
          ],
          skipDuplicates: true,
        });
      return { queued: true };
    });
  }
}
@Injectable()
export class WhatsAppCleanup {
  constructor(
    readonly db: PrismaService,
    readonly service: WhatsAppService,
    readonly client: WhatsAppClient,
  ) {}
  async disconnect(a: ChannelAccount, tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(240013)`;
    try {
      const c = this.service.credentials(a);
      const others = await tx.channelAccount.count({
        where: {
          id: { not: a.id },
          channelType: 'WHATSAPP_BUSINESS',
          connectionStatus: { not: 'DISCONNECTED' },
          providerMetadata: { path: ['wabaId'], equals: c.wabaId },
        },
      });
      if (!others) await this.client.unsubscribe(c.accessToken, c.wabaId);
      return null;
    } catch {
      return 'WHATSAPP_CLEANUP_UNCONFIRMED';
    }
  }
}
