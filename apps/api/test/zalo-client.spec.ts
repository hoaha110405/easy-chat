import { describe, it, expect, vi, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';
import type { PrismaService } from '../src/database/prisma.service';
import {
  ZaloHttpService,
  ZaloError,
} from '../src/modules/zalo/zalo-http.service';
import { ZaloApiClient } from '../src/modules/zalo/zalo-api.client';
import { ApiError } from '../src/common/api-error';
import { config, crypto } from './helpers';
function setup() {
  const row = {
    id: 'connection',
    status: 'CONNECTED',
    encryptedAccessToken: crypto.encrypt('old-access'),
    encryptedRefreshToken: crypto.encrypt('old-refresh'),
    tokenExpiresAt: new Date(0),
  };
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async () => [row]),
    zaloConnection: {
      update: vi
        .fn()
        .mockImplementation(async ({ data }: { data: object }) =>
          Object.assign(row, data),
        ),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const http = {
    request: vi.fn().mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 90000,
    }),
  };
  return {
    row,
    tx,
    http,
    client: new ZaloApiClient(
      http as unknown as ZaloHttpService,
      db as unknown as PrismaService,
      crypto,
      config,
    ),
  };
}
afterEach(() => vi.restoreAllMocks());
describe('Zalo token lifecycle', () => {
  it('refreshes expiring tokens and encrypts both rotated credentials', async () => {
    const { client, row, http } = setup();
    expect(await client.accessToken('connection')).toBe('new-access');
    expect(crypto.decrypt(row.encryptedRefreshToken)).toBe('new-refresh');
    expect(row.tokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(http.request.mock.calls[0][0]).toMatchObject({
      url: 'https://oauth.zaloapp.com/v4/oa/access_token',
      headers: { secret_key: config.env.ZALO_APP_SECRET },
    });
    expect(http.request.mock.calls[0][0].data).toContain(
      'grant_type=refresh_token',
    );
  });
  it('reuses a token already refreshed by another caller', async () => {
    const { client, row, http } = setup();
    row.tokenExpiresAt = new Date(Date.now() + 120000);
    expect(
      await client.accessToken('connection', 'previously-rejected-token'),
    ).toBe('old-access');
    expect(http.request).not.toHaveBeenCalled();
  });
  it('marks explicit refresh refusals for reauthorization while committing the status', async () => {
    const { client, row, http } = setup();
    http.request.mockRejectedValue(new ZaloError('invalid_grant'));
    await expect(client.accessToken('connection')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    expect(row.status).toBe('REAUTH_REQUIRED');
    expect(row.encryptedRefreshToken).toBeNull();
  });
  it('does not consume a refresh token again after an ambiguous timeout', async () => {
    const { client, row, http } = setup();
    http.request.mockRejectedValue(
      new ApiError(502, 'ZALO_UNAVAILABLE', 'timeout'),
    );
    await expect(client.accessToken('connection')).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    expect(row.status).toBe('REAUTH_REQUIRED');
    expect(http.request).toHaveBeenCalledTimes(1);
  });
  it('retries only once for documented access-token failures', async () => {
    const { client, row, http } = setup();
    row.tokenExpiresAt = new Date(Date.now() + 120000);
    http.request
      .mockRejectedValueOnce(new ZaloError(-216))
      .mockResolvedValueOnce({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 90000,
      })
      .mockResolvedValueOnce({ data: { oaid: '123', name: 'OA' } });
    expect(await client.getProfile('connection')).toMatchObject({
      oaid: '123',
    });
    expect(http.request).toHaveBeenCalledTimes(3);
  });
  it('validates history pagination and serializes long user IDs without rounding', async () => {
    const { client, row, http } = setup();
    row.tokenExpiresAt = new Date(Date.now() + 120000);
    http.request.mockResolvedValue({ data: [] });
    await client.getHistory('connection', '246845883529197922', 0, 10);
    expect(http.request.mock.calls[0][0].params.data).toContain(
      '"user_id":246845883529197922',
    );
    await expect(
      client.getHistory('connection', '123', 0, 11),
    ).rejects.toMatchObject({ code: 'INVALID_HISTORY_PAGE' });
  });
});
describe('Zalo HTTP errors', () => {
  it('handles HTTP-200 business failures without returning provider secrets', async () => {
    vi.spyOn(axios, 'request').mockResolvedValue({
      data: { error: -223, message: 'sensitive provider detail' },
    });
    await expect(
      new ZaloHttpService().request(
        { url: 'https://openapi.zalo.me' },
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: 'ZALO_PERMISSION_DENIED' });
  });
  it('handles malformed success responses and network timeouts', async () => {
    const request = vi
      .spyOn(axios, 'request')
      .mockResolvedValue({ data: { unexpected: true } });
    const http = new ZaloHttpService();
    await expect(
      http.request({}, z.object({ data: z.string() })),
    ).rejects.toMatchObject({ code: 'ZALO_INVALID_RESPONSE' });
    request.mockRejectedValue(
      new AxiosError('sensitive token url', 'ECONNABORTED'),
    );
    await expect(http.request({}, z.unknown())).rejects.toMatchObject({
      code: 'ZALO_UNAVAILABLE',
    });
  });
  it('preserves unsafe JSON integers in external responses', async () => {
    const request = vi
      .spyOn(axios, 'request')
      .mockResolvedValue({ data: { data: 'ok' } });
    await new ZaloHttpService().request({}, z.unknown());
    const transform = request.mock.calls[0][0].transformResponse;
    const parse = Array.isArray(transform) ? transform[0] : null;
    expect(parse?.call({}, '{"oaid":4462152339089565647}', {})).toMatchObject({
      oaid: '4462152339089565647',
    });
  });
});
