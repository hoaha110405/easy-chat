import { Injectable } from '@nestjs/common';
import type { ZaloConnection } from '@prisma/client';
import { z } from 'zod';
import { ConfigService } from '../../config/config.service';
import { CryptoService } from '../../common/crypto.service';
import { PrismaService } from '../../database/prisma.service';
import { ApiError } from '../../common/api-error';
import { ZaloHttpService, ZaloError } from './zalo-http.service';
import {
  tokenSchema,
  oaProfileSchema,
  historyItemSchema,
  type TokenResult,
} from './zalo.schemas';
const OPEN_API = 'https://openapi.zalo.me';
const AUTH_FAILURES = new Set([-216, -220]);
@Injectable()
export class ZaloApiClient {
  constructor(
    private readonly http: ZaloHttpService,
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
  ) {}
  exchangeToken(fields: Record<string, string>) {
    return this.http.request(
      {
        method: 'POST',
        url: 'https://oauth.zaloapp.com/v4/oa/access_token',
        headers: {
          secret_key: this.config.env.ZALO_APP_SECRET,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: new URLSearchParams({
          app_id: this.config.env.ZALO_APP_ID,
          ...fields,
        }).toString(),
      },
      tokenSchema,
    );
  }
  profileWithToken(token: string) {
    return this.http
      .request(
        {
          method: 'GET',
          url: `${OPEN_API}/v2.0/oa/getoa`,
          headers: { access_token: token },
        },
        z.object({ data: oaProfileSchema }),
      )
      .then((v) => v.data);
  }
  tokenData(tokens: TokenResult) {
    return {
      encryptedAccessToken: this.crypto.encrypt(tokens.access_token),
      encryptedRefreshToken: this.crypto.encrypt(tokens.refresh_token),
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      status: 'CONNECTED' as const,
    };
  }
  async accessToken(id: string, rejectedToken?: string): Promise<string> {
    // A PostgreSQL row lock serializes rotating refresh tokens across processes.
    // The HTTP call is bounded to 10s; transaction allows 15s for commit.
    const result = await this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          ZaloConnection[]
        >`SELECT * FROM "ZaloConnection" WHERE "id" = ${id} FOR UPDATE`;
        const connection = rows[0];
        if (
          !connection ||
          connection.status !== 'CONNECTED' ||
          !connection.encryptedAccessToken ||
          !connection.encryptedRefreshToken
        )
          return null;
        const current = this.crypto.decrypt(connection.encryptedAccessToken);
        if (
          connection.tokenExpiresAt.getTime() > Date.now() + 60000 &&
          (!rejectedToken || current !== rejectedToken)
        )
          return current;
        try {
          const tokens = await this.exchangeToken({
            grant_type: 'refresh_token',
            refresh_token: this.crypto.decrypt(
              connection.encryptedRefreshToken,
            ),
          });
          await tx.zaloConnection.update({
            where: { id },
            data: this.tokenData(tokens),
          });
          return tokens.access_token;
        } catch (error) {
          // Explicit token endpoint refusals require a fresh OA authorization.
          // Network/timeouts are ambiguous for a single-use token: do not replay automatically.
          if (error instanceof ZaloError && error.getStatus() !== 429) {
            await tx.zaloConnection.update({
              where: { id },
              data: {
                status: 'REAUTH_REQUIRED',
                encryptedAccessToken: null,
                encryptedRefreshToken: null,
              },
            });
            return null;
          }
          if (error instanceof ApiError && error.code === 'ZALO_UNAVAILABLE') {
            await tx.zaloConnection.update({
              where: { id },
              data: { status: 'REAUTH_REQUIRED' },
            });
            return null;
          }
          throw error;
        }
      },
      { timeout: 15000, maxWait: 15000 },
    );
    if (!result)
      throw new ApiError(
        409,
        'REAUTH_REQUIRED',
        'Zalo authorization needs to be renewed. Reconnect the Official Account.',
      );
    return result;
  }
  private async authorized<T>(
    connectionId: string,
    operation: (token: string) => Promise<T>,
  ) {
    const token = await this.accessToken(connectionId);
    try {
      return await operation(token);
    } catch (error) {
      if (
        !(error instanceof ZaloError) ||
        !AUTH_FAILURES.has(Number(error.zaloCode))
      )
        throw error;
      const renewed = await this.accessToken(connectionId, token);
      try {
        return await operation(renewed);
      } catch (retryError) {
        if (
          retryError instanceof ZaloError &&
          AUTH_FAILURES.has(Number(retryError.zaloCode))
        ) {
          await this.db.zaloConnection.updateMany({
            where: { id: connectionId },
            data: { status: 'REAUTH_REQUIRED' },
          });
          throw new ApiError(
            409,
            'REAUTH_REQUIRED',
            'Zalo authorization was rejected. Reconnect the Official Account.',
          );
        }
        throw retryError;
      }
    }
  }
  uploadFile(
    connectionId: string,
    file: { bytes: Buffer; mime: string; name: string },
  ) {
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
      file.name,
    );
    return this.authorized(connectionId, (token) =>
      this.http.request(
        {
          method: 'POST',
          url: `${OPEN_API}/v2.0/oa/upload/file`,
          headers: { access_token: token },
          data: form,
          maxBodyLength: 5_000_000 + 65536,
        },
        z.object({ data: z.object({ token: z.string().min(1).max(4096) }) }),
      ),
    ).then((v) => v.data.token);
  }
  sendFile(connectionId: string, userId: string, fileToken: string) {
    if (!/^\d{1,30}$/.test(userId))
      throw new ApiError(400, 'INVALID_RECIPIENT', 'Người nhận không hợp lệ.');
    return this.authorized(connectionId, (token) =>
      this.http.request(
        {
          method: 'POST',
          url: `${OPEN_API}/v3.0/oa/message/cs`,
          headers: { access_token: token, 'Content-Type': 'application/json' },
          data: {
            recipient: { user_id: userId },
            message: {
              attachment: { type: 'file', payload: { token: fileToken } },
            },
          },
        },
        z.object({
          data: z.object({
            message_id: z.string().min(1).max(512),
            user_id: z.string().optional(),
          }),
        }),
      ),
    ).then((v) => {
      if (v.data.user_id && v.data.user_id !== userId)
        throw new ApiError(
          502,
          'ZALO_INVALID_RESPONSE',
          'Zalo trả kết quả người nhận không khớp.',
        );
      return v.data;
    });
  }
  getProfile(connectionId: string) {
    return this.authorized(connectionId, (token) =>
      this.profileWithToken(token),
    );
  }
  async getHistory(
    connectionId: string,
    userId: string,
    offset = 0,
    count = 10,
  ) {
    if (
      !/^\d+$/.test(userId) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 10
    )
      throw new ApiError(
        400,
        'INVALID_HISTORY_PAGE',
        'History requires a known numeric user ID, a nonnegative offset, and a count between 1 and 10.',
      );
    // Preserve the documented numeric user_id without converting it through JS Number.
    const data = `{"user_id":${userId},"offset":${offset},"count":${count}}`;
    return this.authorized(connectionId, (token) =>
      this.http
        .request(
          {
            method: 'GET',
            url: `${OPEN_API}/v2.0/oa/conversation`,
            headers: { access_token: token },
            params: { data },
          },
          z.object({ data: z.array(historyItemSchema).max(10) }),
        )
        .then((v) => v.data),
    );
  }
}
