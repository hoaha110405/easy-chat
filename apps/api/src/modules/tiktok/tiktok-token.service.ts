import { Injectable } from '@nestjs/common';
import type { ChannelAccount } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CryptoService } from '../../common/crypto.service';
import { TikTokRegistry } from './tiktok.registry';
import { tokenSchema, type TikTokType } from './tiktok.types';
import { TikTokError } from './tiktok-http';
import { BUSINESS_SCOPES } from '../tiktok-business/tiktok-business.client';
@Injectable()
export class TikTokTokenService {
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: TikTokRegistry,
  ) {}
  async get(account: ChannelAccount, active: () => boolean) {
    const type = account.channelType as TikTokType;
    if (!this.registry.configured(type))
      throw new TikTokError('TIKTOK_NOT_CONFIGURED');
    const decode = (value: string | null) => {
      try {
        return tokenSchema.parse(JSON.parse(this.crypto.decrypt(value!)));
      } catch {
        throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
      }
    };
    const token = decode(account.encryptedCredentials);
    if (token.appId !== this.registry.settings(type).appId)
      throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
    if (token.expiresAt > Date.now() + 60000) return token;
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          ChannelAccount[]
        >`SELECT * FROM "ChannelAccount" WHERE "id"=${account.id} AND "generation"=${account.generation} AND "connectionStatus"='CONNECTED' FOR UPDATE`;
        if (!rows[0] || !active())
          throw new TikTokError('CHANNEL_NOT_CONNECTED');
        const current = decode(rows[0].encryptedCredentials);
        if (current.expiresAt > Date.now() + 60000) return current;
        if (current.refreshExpiresAt <= Date.now())
          throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
        const fresh = await this.registry.adapter(type).refresh(current);
        const required =
          type === 'TIKTOK_BUSINESS'
            ? BUSINESS_SCOPES
            : ['seller.customer_service', 'seller.authorization.info'];
        if (
          fresh.openId !== current.openId ||
          fresh.appId !== current.appId ||
          fresh.expiresAt <= Date.now() ||
          fresh.refreshExpiresAt <= Date.now()
        )
          throw new TikTokError('TIKTOK_TOKEN_EXPIRED');
        if (required.some((s) => !fresh.scopes.includes(s)))
          throw new TikTokError('TIKTOK_PERMISSION_DENIED');
        const updated = {
          ...fresh,
          ...(current.shopCipher ? { shopCipher: current.shopCipher } : {}),
        };
        if (!active())
          throw new TikTokError('TIKTOK_TOKEN_REFRESH_UNKNOWN', true);
        await tx.channelAccount.update({
          where: { id: account.id },
          data: {
            encryptedCredentials: this.crypto.encrypt(JSON.stringify(updated)),
            tokenExpiresAt: new Date(updated.expiresAt),
            refreshExpiresAt: new Date(updated.refreshExpiresAt),
          },
        });
        return updated;
      },
      { timeout: 15000, maxWait: 5000 },
    );
  }
}
