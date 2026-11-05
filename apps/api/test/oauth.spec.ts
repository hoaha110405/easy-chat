import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../src/database/prisma.service';
import type { ZaloApiClient } from '../src/modules/zalo/zalo-api.client';
import {
  ZaloOAuthService,
  createPkce,
} from '../src/modules/zalo/zalo-oauth.service';
import { hash } from '../src/common/crypto.service';
import { config, crypto } from './helpers';
function setup() {
  const state = {
    oauthStateHash: hash('valid-state'),
    encryptedVerifier: crypto.encrypt('verifier'),
    oauthExpiresAt: new Date(Date.now() + 60000),
    expiresAt: new Date(Date.now() + 60000),
  };
  const tx = {
    adminSession: {
      update: vi.fn(),
      findUnique: vi.fn().mockImplementation(async () => ({ ...state })),
      updateMany: vi
        .fn()
        .mockImplementation(
          async ({ where }: { where: { oauthStateHash: string } }) => {
            if (where.oauthStateHash !== state.oauthStateHash)
              return { count: 0 };
            state.oauthStateHash = '';
            return { count: 1 };
          },
        ),
    },
    zaloConnection: { updateMany: vi.fn(), upsert: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const api = {
    exchangeToken: vi.fn().mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 90000,
    }),
    profileWithToken: vi
      .fn()
      .mockResolvedValue({ oaid: '388613280878808645', name: 'Fixture OA' }),
    tokenData: vi.fn().mockReturnValue({ encryptedAccessToken: 'encrypted' }),
  };
  return {
    state,
    tx,
    api,
    service: new ZaloOAuthService(
      db as unknown as PrismaService,
      crypto,
      config,
      api as unknown as ZaloApiClient,
    ),
  };
}
describe('OAuth state and PKCE', () => {
  it('creates unique RFC 7636 verifiers and S256 base64url challenges', () => {
    const a = createPkce(),
      b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(
      createHash('sha256').update(a.verifier, 'ascii').digest('base64url'),
    );
  });
  it('stores encrypted verifier and a state hash, and uses the OA v4 authorization endpoint', async () => {
    const { service, tx } = setup();
    const url = new URL(await service.connect('session'));
    expect(url.origin + url.pathname).toBe(
      'https://oauth.zaloapp.com/v4/oa/permission',
    );
    expect(url.searchParams.get('app_id')).toBe(config.env.ZALO_APP_ID);
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    const stored = tx.adminSession.update.mock.calls[0][0].data;
    expect(stored.oauthStateHash).toBe(hash(url.searchParams.get('state')!));
    expect(stored.encryptedVerifier).toMatch(/^v1\./);
    expect(url.searchParams.has('secret_key')).toBe(false);
  });
  it('rejects invalid, expired and reused states before any token exchange', async () => {
    const { service, state, api } = setup();
    await expect(
      service.callback('session', 'wrong', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    expect(api.exchangeToken).not.toHaveBeenCalled();
    state.oauthExpiresAt = new Date(0);
    await expect(
      service.callback('session', 'valid-state', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    state.oauthExpiresAt = new Date(Date.now() + 60000);
    await service.callback('session', 'valid-state', 'code');
    await expect(
      service.callback('session', 'valid-state', 'code'),
    ).rejects.toMatchObject({ code: 'INVALID_OAUTH_STATE' });
    expect(api.exchangeToken).toHaveBeenCalledTimes(1);
  });
  it('exchanges a callback code with its verifier, verifies the OA and persists encrypted tokens', async () => {
    const { service, api, tx } = setup();
    await service.callback(
      'session',
      'valid-state',
      'auth-code',
      '388613280878808645',
    );
    expect(api.exchangeToken).toHaveBeenCalledWith({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verifier',
    });
    expect(tx.zaloConnection.upsert).toHaveBeenCalled();
  });
  it('rejects a callback OA mismatch and consumes cancelled requests', async () => {
    const { service, tx } = setup();
    await expect(
      service.callback('session', 'valid-state', 'code', 'another-oa'),
    ).rejects.toMatchObject({ code: 'OA_MISMATCH' });
    expect(tx.zaloConnection.upsert).not.toHaveBeenCalled();
    const cancelled = setup();
    await expect(
      cancelled.service.callback('session', 'valid-state'),
    ).rejects.toMatchObject({ code: 'OAUTH_DENIED' });
  });
  it('encrypts with a random IV and detects ciphertext tampering', () => {
    const first = crypto.encrypt('secret-token');
    expect(first).not.toContain('secret-token');
    expect(first).not.toBe(crypto.encrypt('secret-token'));
    expect(crypto.decrypt(first)).toBe('secret-token');
    const parts = first.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => crypto.decrypt(parts.join('.'))).toThrow();
  });
});
