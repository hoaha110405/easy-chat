import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { channelAccountSchema, facebookPageStatusSchema } from '@zalo/shared';
import { z } from 'zod';
import { ApiError } from '../../common/api-error';
import { CryptoService, hash } from '../../common/crypto.service';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { publishEvent } from '../realtime/publish';
import { personalWorkerOnline } from '../zalo-personal/personal-runtime';
import {
  FacebookGraphClient,
  FacebookGraphError,
} from './facebook-graph.client';
import type {
  FacebookPageSummary,
  FacebookTokenInspection,
} from './facebook-graph.types';

export const FACEBOOK_PAGE_PERMISSIONS = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
] as const;
const PAGE_PERMISSIONS = FACEBOOK_PAGE_PERMISSIONS.filter(
  (v) => v !== 'pages_show_list',
);
const MESSAGING_TASKS = new Set([
  'MESSAGING',
  'PROFILE_PLUS_MESSAGING',
  'MANAGE',
  'PROFILE_PLUS_MANAGE',
  'PROFILE_PLUS_FULL_CONTROL',
]);
const OAUTH_LIFETIME_MS = 10 * 60 * 1000;
const MAX_PAGE_BATCHES = 10;
const selectionSchema = z.object({
  version: z.literal(1),
  ownerId: z.string().min(1),
  appId: z.string().min(1),
  pages: z
    .array(
      z.object({
        id: z.string().regex(/^\d{1,64}$/),
        name: z.string().min(1).max(1000),
        avatarUrl: z.string().nullable(),
        accessToken: z.string().min(1).max(16384),
        tasks: z.array(z.string().max(100)).max(100),
      }),
    )
    .min(1)
    .max(1000),
});

function invalidSelection(): never {
  throw new ApiError(
    409,
    'FACEBOOK_SELECTION_EXPIRED',
    'The Page selection expired or was already used. Connect Facebook again.',
  );
}

@Injectable()
export class FacebookPageService {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly graph: FacebookGraphClient,
  ) {}

  private configured() {
    if (!this.config.facebookConfigured)
      throw new ApiError(
        503,
        'FACEBOOK_NOT_CONFIGURED',
        'Configure the backend Facebook App ID and App Secret before connecting a Page.',
      );
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FacebookGraphError)
        throw new ApiError(error.status, error.code, error.message);
      throw new ApiError(
        502,
        'FACEBOOK_UNAVAILABLE',
        'Facebook is temporarily unavailable. Start the connection again.',
      );
    }
  }

  private publicAccount(account: ChannelAccount, workerOnline: boolean) {
    return channelAccountSchema.parse({
      id: account.id,
      name: account.name,
      channelType: account.channelType,
      avatarUrl: account.avatarUrl,
      externalAccountId: account.externalAccountId,
      connectionStatus:
        !workerOnline && account.connectionStatus === 'CONNECTED'
          ? 'RECONNECTING'
          : account.connectionStatus,
      lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
      lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
      lastError:
        !workerOnline && account.connectionStatus === 'CONNECTED'
          ? 'CHANNEL_WORKER_UNAVAILABLE'
          : account.lastError,
      lastSyncError: account.lastSyncError,
      syncComplete: account.syncComplete,
      workerOnline,
    });
  }

  private async selection(
    sessionId: string,
    ownerId: string,
    required: boolean,
  ) {
    const session = await this.db.adminSession.findUnique({
      where: { id: sessionId },
    });
    if (!session || session.expiresAt <= new Date()) {
      if (required) invalidSelection();
      return null;
    }
    if (
      !session.encryptedFacebookSelection ||
      !session.facebookSelectionExpiresAt ||
      session.facebookSelectionExpiresAt <= new Date()
    ) {
      if (required) invalidSelection();
      return null;
    }
    try {
      const selection = selectionSchema.parse(
        JSON.parse(this.crypto.decrypt(session.encryptedFacebookSelection)),
      );
      if (
        selection.ownerId !== ownerId ||
        selection.appId !== this.config.env.FACEBOOK_APP_ID
      )
        invalidSelection();
      return {
        selection,
        encryptedSelection: session.encryptedFacebookSelection,
        expiresAt: session.facebookSelectionExpiresAt,
      };
    } catch {
      if (required) invalidSelection();
      return null;
    }
  }

  async status(ownerId: string, sessionId: string) {
    const [accounts, online, pending] = await Promise.all([
      this.db.channelAccount.findMany({
        where: { ownerId, channelType: 'FACEBOOK_PAGE' },
        orderBy: { createdAt: 'asc' },
      }),
      personalWorkerOnline(this.db),
      this.selection(sessionId, ownerId, false),
    ]);
    return facebookPageStatusSchema.parse({
      configured: this.config.facebookConfigured,
      webhookConfigured: this.config.facebookWebhookConfigured,
      workerOnline: online,
      accounts: accounts.map((account) => this.publicAccount(account, online)),
      availablePages:
        pending?.selection.pages.map(({ id, name, avatarUrl }) => ({
          id,
          name,
          avatarUrl,
        })) ?? [],
      selectionExpiresAt: pending?.expiresAt.toISOString() ?? null,
    });
  }

  async connect(sessionId: string) {
    this.configured();
    const state = randomBytes(32).toString('base64url');
    const stored = await this.db.adminSession.updateMany({
      where: { id: sessionId, expiresAt: { gt: new Date() } },
      data: {
        facebookStateHash: hash(state),
        facebookStateExpiresAt: new Date(Date.now() + OAUTH_LIFETIME_MS),
        encryptedFacebookSelection: null,
        facebookSelectionExpiresAt: null,
      },
    });
    if (stored.count !== 1)
      throw new ApiError(
        401,
        'OAUTH_SESSION_EXPIRED',
        'Sign in and start the connection again.',
      );
    const url = new URL(
      `https://www.facebook.com/${this.config.env.FACEBOOK_GRAPH_API_VERSION}/dialog/oauth`,
    );
    url.search = new URLSearchParams({
      client_id: this.config.env.FACEBOOK_APP_ID,
      redirect_uri: this.config.env.FACEBOOK_OAUTH_REDIRECT_URI,
      state,
      response_type: 'code',
      scope: FACEBOOK_PAGE_PERMISSIONS.join(','),
      auth_type: 'rerequest',
    }).toString();
    return url.toString();
  }

  private assertToken(
    inspection: FacebookTokenInspection,
    permissions: readonly string[],
    pageId?: string,
  ) {
    const now = Math.floor(Date.now() / 1000);
    if (
      !inspection.valid ||
      inspection.appId !== this.config.env.FACEBOOK_APP_ID ||
      (inspection.expiresAt !== null &&
        inspection.expiresAt !== 0 &&
        inspection.expiresAt <= now) ||
      (inspection.dataAccessExpiresAt !== null &&
        inspection.dataAccessExpiresAt !== 0 &&
        inspection.dataAccessExpiresAt <= now)
    ) {
      throw new ApiError(
        409,
        'FACEBOOK_REAUTH_REQUIRED',
        'Facebook authorization is invalid or expired. Connect the Page again.',
      );
    }
    if (
      pageId &&
      (inspection.type !== 'PAGE' ||
        (inspection.profileId !== null && inspection.profileId !== pageId))
    )
      throw new ApiError(
        403,
        'FACEBOOK_PAGE_MISMATCH',
        'Facebook authorization does not belong to the selected Page.',
      );
    if (
      permissions.some((permission) => !inspection.scopes.includes(permission))
    )
      throw new ApiError(
        403,
        'FACEBOOK_PERMISSION_DENIED',
        'Grant the required Page messaging, metadata and engagement permissions.',
      );
    if (
      pageId &&
      inspection.granularScopes.some(
        (grant) =>
          permissions.includes(grant.scope) &&
          grant.targetIds.length > 0 &&
          !grant.targetIds.includes(pageId),
      )
    )
      throw new ApiError(
        403,
        'FACEBOOK_PERMISSION_DENIED',
        'Grant messaging permissions for the selected Page.',
      );
  }

  async callback(
    sessionId: string,
    ownerId: string,
    state: string,
    code?: string,
  ) {
    this.configured();
    if (!state || state.length > 256)
      throw new ApiError(
        400,
        'INVALID_OAUTH_STATE',
        'The Facebook connection state is invalid.',
      );
    // The replacement marker cannot match hash(state). It also identifies this
    // callback through slow HTTP calls, preventing stale callbacks replacing a
    // selection created by a newer connect request in the same browser session.
    const consumedMarker = hash(`consumed:${state}`);
    const consumed = await this.db.adminSession.updateMany({
      where: {
        id: sessionId,
        facebookStateHash: hash(state),
        facebookStateExpiresAt: { gt: new Date() },
        expiresAt: { gt: new Date() },
      },
      data: { facebookStateHash: consumedMarker },
    });
    if (consumed.count !== 1)
      throw new ApiError(
        400,
        'INVALID_OAUTH_STATE',
        'The Facebook connection state expired or was already used.',
      );
    if (!code || code.length > 8192)
      throw new ApiError(
        400,
        'OAUTH_DENIED',
        'Facebook authorization was cancelled.',
      );
    const short = await this.provider(() =>
      this.graph.exchangeCode(
        code,
        this.config.env.FACEBOOK_OAUTH_REDIRECT_URI,
      ),
    );
    const token = await this.provider(() =>
      this.graph.exchangeLongLivedToken(short.accessToken),
    );
    const inspection = await this.provider(() =>
      this.graph.inspectToken(token.accessToken),
    );
    this.assertToken(inspection, FACEBOOK_PAGE_PERMISSIONS);
    const permissions = await this.provider(() =>
      this.graph.grantedPermissions(token.accessToken),
    );
    if (
      FACEBOOK_PAGE_PERMISSIONS.some(
        (permission) =>
          !permissions.some(
            (grant) =>
              grant.permission === permission && grant.status === 'granted',
          ),
      )
    )
      throw new ApiError(
        403,
        'FACEBOOK_PERMISSION_DENIED',
        'Grant all required Page permissions before connecting.',
      );
    const pages: FacebookPageSummary[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    for (let batch = 0; batch < MAX_PAGE_BATCHES; batch += 1) {
      const result = await this.provider(() =>
        this.graph.listPages(token.accessToken, { after, limit: 100 }),
      );
      pages.push(
        ...result.items.filter((page) =>
          page.tasks.some((task) => MESSAGING_TASKS.has(task)),
        ),
      );
      after = result.after;
      if (!after) break;
      if (seenCursors.has(after))
        throw new ApiError(
          502,
          'FACEBOOK_INVALID_RESPONSE',
          'Facebook returned a repeated Page cursor. Connect again.',
        );
      seenCursors.add(after);
      if (batch === MAX_PAGE_BATCHES - 1)
        throw new ApiError(
          422,
          'FACEBOOK_PAGE_LIST_LIMIT',
          'This connection can list up to 1,000 Pages. Limit the Pages granted to this app and connect again.',
        );
    }
    const uniquePages = [
      ...new Map(pages.map((page) => [page.id, page])).values(),
    ];
    if (uniquePages.length === 0)
      throw new ApiError(
        409,
        'FACEBOOK_NO_PAGES',
        'No permitted Facebook Pages were found. Use a Facebook account with a Page messaging task.',
      );
    const encrypted = this.crypto.encrypt(
      JSON.stringify(
        selectionSchema.parse({
          version: 1,
          ownerId,
          appId: this.config.env.FACEBOOK_APP_ID,
          pages: uniquePages,
        }),
      ),
    );
    const stored = await this.db.adminSession.updateMany({
      where: {
        id: sessionId,
        facebookStateHash: consumedMarker,
        facebookStateExpiresAt: { gt: new Date() },
        expiresAt: { gt: new Date() },
      },
      data: {
        facebookStateHash: null,
        facebookStateExpiresAt: null,
        encryptedFacebookSelection: encrypted,
        facebookSelectionExpiresAt: new Date(Date.now() + OAUTH_LIFETIME_MS),
      },
    });
    if (stored.count !== 1)
      throw new ApiError(
        401,
        'OAUTH_SESSION_EXPIRED',
        'This connection was replaced or the administrator session expired. Connect again.',
      );
  }

  async selectPage(ownerId: string, sessionId: string, pageId: string) {
    this.configured();
    const pending = await this.selection(sessionId, ownerId, true);
    if (!pending) invalidSelection();
    const selected = pending.selection.pages.find((page) => page.id === pageId);
    if (!selected || !selected.tasks.some((task) => MESSAGING_TASKS.has(task)))
      throw new ApiError(
        403,
        'FACEBOOK_PAGE_NOT_AVAILABLE',
        'Select a Page offered by this Facebook authorization.',
      );
    const inspection = await this.provider(() =>
      this.graph.inspectToken(selected.accessToken),
    );
    this.assertToken(inspection, PAGE_PERMISSIONS, pageId);
    const profile = await this.provider(() =>
      this.graph.getPage(pageId, selected.accessToken),
    );
    await this.provider(() =>
      this.graph.subscribePage(pageId, selected.accessToken),
    );
    const account = await this.db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // No provider HTTP is performed inside this transaction. The condition
        // consumes the exact encrypted selection and revalidates session lifetime.
        const consumed = await tx.adminSession.updateMany({
          where: {
            id: sessionId,
            expiresAt: { gt: new Date() },
            encryptedFacebookSelection: pending.encryptedSelection,
            facebookSelectionExpiresAt: { gt: new Date() },
          },
          data: {
            encryptedFacebookSelection: null,
            facebookSelectionExpiresAt: null,
          },
        });
        if (consumed.count !== 1) invalidSelection();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(240008)`;
        const data = {
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          encryptedCredentials: this.crypto.encrypt(
            JSON.stringify({ pageId, accessToken: selected.accessToken }),
          ),
          connectionStatus: 'CONNECTED' as const,
          lastConnectedAt: new Date(),
          lastError: null,
          lastSyncError: null,
          syncCursor: null,
          syncComplete: false,
          encryptedQr: null,
          qrExpiresAt: null,
          qrStatus: 'NONE',
        };
        const linked = await tx.channelAccount.upsert({
          where: {
            ownerId_channelType_externalAccountId: {
              ownerId,
              channelType: 'FACEBOOK_PAGE',
              externalAccountId: pageId,
            },
          },
          create: {
            ownerId,
            channelType: 'FACEBOOK_PAGE',
            externalAccountId: pageId,
            generation: 1,
            ...data,
          },
          update: { ...data, generation: { increment: 1 } },
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
            deliveryError: 'MESSAGE_SEND_UNKNOWN',
          },
        });
        await tx.personalCommand.create({
          data: {
            channelAccountId: linked.id,
            kind: 'SYNC',
            generation: linked.generation,
            deduplicationKey: `facebook:sync:${linked.id}:${linked.generation}:initial`,
            payload: {},
          },
        });
        await publishEvent(tx, ownerId, {
          type: 'channel.connected',
          channelAccountId: linked.id,
        });
        return linked;
      },
    );
    return this.publicAccount(account, await personalWorkerOnline(this.db));
  }
}
