import { describe, it, expect } from 'vitest';
import { paginationSchema, connectionSchema } from './api';
describe('shared API contracts', () => {
  it('defaults and bounds pagination', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 30 });
    expect(paginationSchema.parse({ page: '2', limit: '50' })).toEqual({
      page: 2,
      limit: 50,
    });
    for (const input of [{ page: 0 }, { limit: 101 }, { page: 'bad' }])
      expect(paginationSchema.safeParse(input).success).toBe(false);
  });
  it('strips encrypted credentials from public connection DTOs', () => {
    expect(
      connectionSchema.parse({
        id: 'test',
        oaId: '123',
        oaName: 'OA',
        avatarUrl: null,
        status: 'CONNECTED',
        tokenExpiresAt: new Date().toISOString(),
        encryptedAccessToken: 'secret',
      }),
    ).not.toHaveProperty('encryptedAccessToken');
  });
});
