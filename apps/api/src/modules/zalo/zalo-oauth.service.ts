import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService, hash } from '../../common/crypto.service';
import { ApiError } from '../../common/api-error';
import { ZaloApiClient } from './zalo-api.client';
export function createPkce() {
  // 32 random bytes yield a 43-character verifier (RFC 7636).
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url'),
  };
}
@Injectable()
export class ZaloOAuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly api: ZaloApiClient,
  ) {}
  async connect(sessionId: string) {
    if (!this.config.zaloConfigured)
      throw new ApiError(
        503,
        'ZALO_NOT_CONFIGURED',
        'Set the backend Zalo App ID and App Secret before connecting.',
      );
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = createPkce();
    await this.db.adminSession.update({
      where: { id: sessionId },
      data: {
        oauthStateHash: hash(state),
        encryptedVerifier: this.crypto.encrypt(verifier),
        oauthExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const url = new URL('https://oauth.zaloapp.com/v4/oa/permission');
    url.search = new URLSearchParams({
      app_id: this.config.env.ZALO_APP_ID,
      redirect_uri: this.config.env.ZALO_REDIRECT_URI,
      code_challenge: challenge,
      state,
    }).toString();
    return url.toString();
  }
  async callback(
    sessionId: string,
    state: string,
    code?: string,
    oaId?: string,
  ) {
    const verifier = await this.db.$transaction(async (tx) => {
      const session = await tx.adminSession.findUnique({
        where: { id: sessionId },
      });
      if (
        !session ||
        !session.encryptedVerifier ||
        !session.oauthExpiresAt ||
        session.oauthExpiresAt < new Date() ||
        session.expiresAt < new Date()
      )
        throw new ApiError(
          400,
          'INVALID_OAUTH_STATE',
          'The connection request has expired. Start again.',
        );
      const consumed = await tx.adminSession.updateMany({
        where: {
          id: sessionId,
          oauthStateHash: hash(state),
          oauthExpiresAt: { gt: new Date() },
        },
        data: {
          oauthStateHash: null,
          encryptedVerifier: null,
          oauthExpiresAt: null,
        },
      });
      if (consumed.count !== 1)
        throw new ApiError(
          400,
          'INVALID_OAUTH_STATE',
          'The connection state is invalid or already used.',
        );
      return this.crypto.decrypt(session.encryptedVerifier);
    });
    if (!code)
      throw new ApiError(
        400,
        'OAUTH_DENIED',
        'Zalo authorization was cancelled.',
      );
    const tokens = await this.api.exchangeToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    const profile = await this.api.profileWithToken(tokens.access_token);
    const profileId = profile.oaid ?? profile.oa_id!;
    if (oaId && oaId !== profileId)
      throw new ApiError(
        400,
        'OA_MISMATCH',
        'The authorized OA does not match the callback.',
      );
    // One active OA in this MVP, while retaining prior conversations and schema support.
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(80110901)`;
      await tx.zaloConnection.updateMany({
        where: { oaId: { not: profileId }, status: { not: 'DISCONNECTED' } },
        data: {
          status: 'DISCONNECTED',
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
        },
      });
      await tx.zaloConnection.upsert({
        where: { oaId: profileId },
        create: {
          oaId: profileId,
          oaName: profile.name,
          avatarUrl: profile.avatar ?? null,
          ...this.api.tokenData(tokens),
        },
        update: {
          oaName: profile.name,
          avatarUrl: profile.avatar ?? null,
          ...this.api.tokenData(tokens),
        },
      });
    });
  }
}
