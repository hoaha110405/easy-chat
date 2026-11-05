import type { ChannelAccount } from '@prisma/client';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/common/api-error';
import { hash } from '../src/common/crypto.service';
import type { ConfigService } from '../src/config/config.service';
import type { PrismaService } from '../src/database/prisma.service';
import {
  ADMIN_OWNER_ID,
  type AdminRequest,
  type AuthService,
} from '../src/modules/auth/auth.service';
import {
  FacebookGraphClient,
  FacebookGraphError,
} from '../src/modules/facebook-page/facebook-graph.client';
import { FacebookPageController } from '../src/modules/facebook-page/facebook-page.controller';
import {
  FACEBOOK_PAGE_PERMISSIONS,
  FacebookPageService,
} from '../src/modules/facebook-page/facebook-page.service';
import { config as baseConfig, crypto } from './helpers';

const config = {
  ...baseConfig,
  facebookConfigured: true,
  facebookWebhookConfigured: true,
  env: {
    ...baseConfig.env,
    FACEBOOK_APP_ID: '123456',
    FACEBOOK_APP_SECRET: 'app-secret',
    FACEBOOK_GRAPH_API_VERSION: 'v26.0',
    FACEBOOK_VERIFY_TOKEN: 'verify-token',
    FACEBOOK_OAUTH_REDIRECT_URI:
      'https://api.easychat.example/api/channels/facebook-page/oauth/callback',
  },
} as ConfigService;
const pageId = '9007199254740993123';
const pageToken = 'backend-only-page-token';
const sessionId = 'test-session';

function setup() {
  const session = {
    id: sessionId,
    expiresAt: new Date(Date.now() + 3600000),
    facebookStateHash: hash('state'),
    facebookStateExpiresAt: new Date(Date.now() + 60000),
    encryptedFacebookSelection: null as string | null,
    facebookSelectionExpiresAt: null as Date | null,
  };
  let account: ChannelAccount | null = null;
  const adminSession = {
    findUnique: vi.fn().mockImplementation(async () => ({ ...session })),
    updateMany: vi
      .fn()
      .mockImplementation(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: object;
        }) => {
          if (where.id !== session.id) return { count: 0 };
          for (const field of [
            'facebookStateHash',
            'encryptedFacebookSelection',
          ]) {
            if (
              field in where &&
              where[field] !==
                session[
                  field as 'facebookStateHash' | 'encryptedFacebookSelection'
                ]
            )
              return { count: 0 };
          }
          for (const field of [
            'expiresAt',
            'facebookStateExpiresAt',
            'facebookSelectionExpiresAt',
          ]) {
            const condition = where[field] as { gt: Date } | undefined;
            const value =
              session[
                field as
                  | 'expiresAt'
                  | 'facebookStateExpiresAt'
                  | 'facebookSelectionExpiresAt'
              ];
            if (condition && (!value || value <= condition.gt))
              return { count: 0 };
          }
          Object.assign(session, data);
          return { count: 1 };
        },
      ),
  };
  const tx = {
    adminSession,
    $executeRaw: vi.fn(),
    personalWorkerState: {
      findUnique: vi.fn().mockResolvedValue({ heartbeatAt: new Date() }),
    },
    channelAccount: {
      findMany: vi
        .fn()
        .mockImplementation(async () => (account ? [account] : [])),
      upsert: vi
        .fn()
        .mockImplementation(
          async ({
            create,
            update,
          }: {
            create: object;
            update: { generation: { increment: number } };
          }) => {
            account = {
              id: 'cmexamplefacebookpage00001',
              ownerId: ADMIN_OWNER_ID,
              channelType: 'FACEBOOK_PAGE',
              name: 'Support',
              avatarUrl: null,
              externalAccountId: pageId,
              connectionStatus: 'CONNECTED',
              encryptedCredentials: null,
              encryptedQr: null,
              qrStatus: 'NONE',
              qrExpiresAt: null,
              generation: 1,
              lastConnectedAt: null,
              lastSendAt: null,
              lastError: null,
              lastSyncAt: null,
              lastSyncError: null,
              syncCursor: null,
              syncComplete: false,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...(account
                ? {
                    ...update,
                    generation:
                      account.generation + update.generation.increment,
                  }
                : create),
            } as ChannelAccount;
            return account;
          },
        ),
    },
    personalCommand: { create: vi.fn(), updateMany: vi.fn() },
    message: { updateMany: vi.fn() },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const inspection = {
    appId: config.env.FACEBOOK_APP_ID,
    valid: true,
    type: 'USER',
    userId: '123',
    profileId: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    dataAccessExpiresAt: null,
    scopes: [...FACEBOOK_PAGE_PERMISSIONS],
    granularScopes: [],
  };
  const graph = {
    exchangeCode: vi.fn().mockResolvedValue({
      accessToken: 'short-user-token',
      expiresIn: 3600,
      tokenType: 'bearer',
    }),
    exchangeLongLivedToken: vi.fn().mockResolvedValue({
      accessToken: 'long-user-token',
      expiresIn: 3600,
      tokenType: 'bearer',
    }),
    inspectToken: vi.fn().mockImplementation(async (token: string) => ({
      ...inspection,
      type: token === pageToken ? 'PAGE' : 'USER',
      profileId: token === pageToken ? pageId : null,
    })),
    grantedPermissions: vi.fn().mockResolvedValue(
      FACEBOOK_PAGE_PERMISSIONS.map((permission) => ({
        permission,
        status: 'granted',
      })),
    ),
    listPages: vi.fn().mockResolvedValue({
      items: [
        {
          id: pageId,
          name: 'Support',
          avatarUrl: 'https://scontent.xx.fbcdn.net/page.jpg',
          accessToken: pageToken,
          tasks: ['MESSAGING'],
        },
      ],
      after: null,
    }),
    getPage: vi.fn().mockResolvedValue({
      id: pageId,
      name: 'Verified Support',
      avatarUrl: 'https://scontent.xx.fbcdn.net/page.jpg',
    }),
    subscribePage: vi.fn().mockResolvedValue(undefined),
  };
  const service = new FacebookPageService(
    db as unknown as PrismaService,
    crypto,
    config,
    graph as unknown as FacebookGraphClient,
  );
  return { session, tx, db, graph, inspection, service };
}

describe('Facebook Page OAuth and selection', () => {
  it('stores a random state hash bound to a live administrator session and requests real Page permissions', async () => {
    const { service, session } = setup();
    const first = new URL(await service.connect(sessionId));
    expect(first.origin + first.pathname).toBe(
      'https://www.facebook.com/v26.0/dialog/oauth',
    );
    expect(first.searchParams.get('redirect_uri')).toBe(
      config.env.FACEBOOK_OAUTH_REDIRECT_URI,
    );
    expect(first.searchParams.get('scope')?.split(',')).toEqual(
      FACEBOOK_PAGE_PERMISSIONS,
    );
    expect(first.searchParams.get('response_type')).toBe('code');
    expect(session.facebookStateHash).toBe(
      hash(first.searchParams.get('state')!),
    );
    expect(first.toString()).not.toContain(config.env.FACEBOOK_APP_SECRET);
    expect(
      new URL(await service.connect(sessionId)).searchParams.get('state'),
    ).not.toBe(first.searchParams.get('state'));
    session.expiresAt = new Date(0);
    await expect(service.connect(sessionId)).rejects.toMatchObject({
      code: 'OAUTH_SESSION_EXPIRED',
    });
  });

  it('rejects wrong, expired, reused and cancelled callback states before replaying a code', async () => {
    const { service, graph, session } = setup();
    await expect(
      service.callback(sessionId, ADMIN_OWNER_ID, 'wrong', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    session.facebookStateExpiresAt = new Date(0);
    await expect(
      service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    session.facebookStateExpiresAt = new Date(Date.now() + 60000);
    await expect(
      service.callback(sessionId, ADMIN_OWNER_ID, 'state'),
    ).rejects.toMatchObject({ code: 'OAUTH_DENIED' });
    await expect(
      service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('encrypts selection credentials and returns only safe Page information to the browser', async () => {
    const { service, graph, session } = setup();
    await service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code');
    expect(graph.exchangeCode).toHaveBeenCalledWith(
      'code',
      config.env.FACEBOOK_OAUTH_REDIRECT_URI,
    );
    expect(graph.exchangeLongLivedToken).toHaveBeenCalledWith(
      'short-user-token',
    );
    expect(session.encryptedFacebookSelection).toMatch(/^v1\./);
    expect(session.encryptedFacebookSelection).not.toContain(pageToken);
    const status = await service.status(ADMIN_OWNER_ID, sessionId);
    expect(status.availablePages).toEqual([
      {
        id: pageId,
        name: 'Support',
        avatarUrl: 'https://scontent.xx.fbcdn.net/page.jpg',
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(pageToken);
    expect(JSON.stringify(status)).not.toContain('long-user-token');
    expect(
      (await service.status('other-owner', sessionId)).availablePages,
    ).toEqual([]);
    await expect(
      service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    expect(graph.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('requires granted scopes, a matching app, valid expiry and an actual messaging Page task', async () => {
    const declined = setup();
    declined.graph.grantedPermissions.mockResolvedValueOnce([
      { permission: 'pages_messaging', status: 'declined' },
    ]);
    await expect(
      declined.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PERMISSION_DENIED' });
    expect(declined.graph.listPages).not.toHaveBeenCalled();
    const wrongApp = setup();
    wrongApp.inspection.appId = 'another-app';
    await expect(
      wrongApp.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_REAUTH_REQUIRED' });
    const expired = setup();
    expired.inspection.expiresAt = 1;
    await expect(
      expired.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_REAUTH_REQUIRED' });
    const noTask = setup();
    noTask.graph.listPages.mockResolvedValueOnce({
      items: [
        {
          id: pageId,
          name: 'Page',
          avatarUrl: null,
          accessToken: pageToken,
          tasks: ['ANALYZE'],
        },
      ],
      after: null,
    });
    await expect(
      noTask.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_NO_PAGES' });
  });

  it('prevents slow callbacks from overwriting a new OAuth flow and stops repeated Page cursors', async () => {
    const replaced = setup();
    replaced.graph.listPages.mockImplementationOnce(async () => {
      await replaced.service.connect(sessionId);
      return {
        items: [
          {
            id: pageId,
            name: 'Page',
            avatarUrl: null,
            accessToken: pageToken,
            tasks: ['MESSAGING'],
          },
        ],
        after: null,
      };
    });
    await expect(
      replaced.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'OAUTH_SESSION_EXPIRED' });
    expect(replaced.session.encryptedFacebookSelection).toBeNull();
    const repeat = setup();
    repeat.graph.listPages.mockResolvedValue({
      items: [],
      after: 'same-cursor',
    });
    await expect(
      repeat.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_INVALID_RESPONSE' });
    expect(repeat.graph.listPages).toHaveBeenCalledTimes(2);
  });

  it('verifies the selected Page, encrypts its token, queues an initial sync and consumes selection exactly once', async () => {
    const { service, tx, session, graph } = setup();
    await service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code');
    const account = await service.selectPage(ADMIN_OWNER_ID, sessionId, pageId);
    expect(graph.getPage).toHaveBeenCalledWith(pageId, pageToken);
    expect(graph.subscribePage).toHaveBeenCalledWith(pageId, pageToken);
    expect(account).toMatchObject({
      name: 'Verified Support',
      externalAccountId: pageId,
      channelType: 'FACEBOOK_PAGE',
      connectionStatus: 'CONNECTED',
      workerOnline: true,
    });
    expect(JSON.stringify(account)).not.toContain(pageToken);
    const data = tx.channelAccount.upsert.mock.calls[0][0];
    expect(data.where).toEqual({
      ownerId_channelType_externalAccountId: {
        ownerId: ADMIN_OWNER_ID,
        channelType: 'FACEBOOK_PAGE',
        externalAccountId: pageId,
      },
    });
    expect(
      JSON.parse(crypto.decrypt(data.create.encryptedCredentials)),
    ).toEqual({ pageId, accessToken: pageToken });
    expect(tx.personalCommand.create.mock.calls[0][0].data).toMatchObject({
      channelAccountId: account.id,
      kind: 'SYNC',
      generation: 1,
      payload: {},
    });
    expect(session.encryptedFacebookSelection).toBeNull();
    await expect(
      service.selectPage(ADMIN_OWNER_ID, sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_SELECTION_EXPIRED' });
    expect(tx.channelAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects unoffered Page IDs, expired selection and foreign owners without provider calls', async () => {
    const { service, graph, session } = setup();
    await service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code');
    await expect(
      service.selectPage(ADMIN_OWNER_ID, sessionId, '999'),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PAGE_NOT_AVAILABLE' });
    await expect(
      service.selectPage('other-owner', sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_SELECTION_EXPIRED' });
    session.facebookSelectionExpiresAt = new Date(0);
    await expect(
      service.selectPage(ADMIN_OWNER_ID, sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_SELECTION_EXPIRED' });
    expect(graph.getPage).not.toHaveBeenCalled();
    expect(graph.subscribePage).not.toHaveBeenCalled();
  });

  it('does not link the Page if token targets mismatch, Meta refuses subscription, or logout wins the commit race', async () => {
    const mismatched = setup();
    await mismatched.service.callback(
      sessionId,
      ADMIN_OWNER_ID,
      'state',
      'code',
    );
    mismatched.graph.inspectToken.mockResolvedValueOnce({
      ...mismatched.inspection,
      type: 'PAGE',
      profileId: 'other-page',
    });
    await expect(
      mismatched.service.selectPage(ADMIN_OWNER_ID, sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PAGE_MISMATCH' });
    expect(mismatched.tx.channelAccount.upsert).not.toHaveBeenCalled();
    const refused = setup();
    await refused.service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code');
    refused.graph.subscribePage.mockRejectedValueOnce(
      new FacebookGraphError(
        'FACEBOOK_PERMISSION_DENIED',
        'Required Facebook permission missing.',
        { status: 403 },
      ),
    );
    await expect(
      refused.service.selectPage(ADMIN_OWNER_ID, sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_PERMISSION_DENIED' });
    expect(refused.tx.channelAccount.upsert).not.toHaveBeenCalled();
    const loggedOut = setup();
    await loggedOut.service.callback(
      sessionId,
      ADMIN_OWNER_ID,
      'state',
      'code',
    );
    loggedOut.graph.subscribePage.mockImplementationOnce(async () => {
      loggedOut.session.expiresAt = new Date(0);
    });
    await expect(
      loggedOut.service.selectPage(ADMIN_OWNER_ID, sessionId, pageId),
    ).rejects.toMatchObject({ code: 'FACEBOOK_SELECTION_EXPIRED' });
    expect(loggedOut.tx.channelAccount.upsert).not.toHaveBeenCalled();
  });

  it('fails stale commands and pending sends on reconnect and preserves ambiguous sends as UNKNOWN', async () => {
    const { service, tx } = setup();
    await service.callback(sessionId, ADMIN_OWNER_ID, 'state', 'code');
    await service.selectPage(ADMIN_OWNER_ID, sessionId, pageId);
    const authorization = new URL(await service.connect(sessionId));
    await service.callback(
      sessionId,
      ADMIN_OWNER_ID,
      authorization.searchParams.get('state')!,
      'new-code',
    );
    await service.selectPage(ADMIN_OWNER_ID, sessionId, pageId);
    expect(tx.personalCommand.updateMany.mock.calls[1][0]).toMatchObject({
      where: { generation: { not: 2 } },
      data: { status: 'FAILED' },
    });
    expect(tx.personalCommand.create.mock.calls[1][0].data.generation).toBe(2);
    expect(tx.message.updateMany.mock.calls[2][0]).toMatchObject({
      where: { deliveryStatus: 'PENDING' },
      data: { deliveryStatus: 'FAILED' },
    });
    expect(tx.message.updateMany.mock.calls[3][0]).toMatchObject({
      where: { deliveryStatus: 'SENDING' },
      data: { deliveryStatus: 'UNKNOWN' },
    });
  });
});

describe('Facebook OAuth callback controller', () => {
  it('requires a real cookie session and redirects only safe status codes to the fixed frontend', async () => {
    const facebook = { callback: vi.fn() };
    const auth = { session: vi.fn().mockResolvedValue(null) };
    const redirect = vi.fn();
    const controller = new FacebookPageController(
      facebook as unknown as FacebookPageService,
      auth as unknown as AuthService,
      config,
    );
    await controller.callback(
      {} as AdminRequest,
      { state: 'state', code: 'secret-code' },
      { redirect } as unknown as Response,
    );
    expect(redirect).toHaveBeenLastCalledWith(
      303,
      'http://localhost:5173/facebook/page?error=OAUTH_SESSION_EXPIRED',
    );
    expect(facebook.callback).not.toHaveBeenCalled();
    auth.session.mockResolvedValue({ id: sessionId });
    await controller.callback(
      {} as AdminRequest,
      { state: 'state', code: 'secret-code' },
      { redirect } as unknown as Response,
    );
    expect(facebook.callback).toHaveBeenLastCalledWith(
      sessionId,
      ADMIN_OWNER_ID,
      'state',
      'secret-code',
    );
    expect(redirect).toHaveBeenLastCalledWith(
      303,
      'http://localhost:5173/facebook/page?oauth=select',
    );
    facebook.callback.mockRejectedValueOnce(
      new Error(`raw provider error ${pageToken}`),
    );
    await controller.callback(
      {} as AdminRequest,
      { state: 'state', code: 'secret-code' },
      { redirect } as unknown as Response,
    );
    expect(redirect).toHaveBeenLastCalledWith(
      303,
      'http://localhost:5173/facebook/page?error=FACEBOOK_OAUTH_FAILED',
    );
    facebook.callback.mockRejectedValueOnce(
      new ApiError(403, 'FACEBOOK_PERMISSION_DENIED', 'Permission missing'),
    );
    await controller.callback(
      {} as AdminRequest,
      { state: 'state', code: 'secret-code' },
      { redirect } as unknown as Response,
    );
    expect(redirect).toHaveBeenLastCalledWith(
      303,
      'http://localhost:5173/facebook/page?error=FACEBOOK_PERMISSION_DENIED',
    );
  });
});
