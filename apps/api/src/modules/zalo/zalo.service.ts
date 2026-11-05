import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ZaloApiClient } from './zalo-api.client';
import { ApiError } from '../../common/api-error';
import { ConfigService } from '../../config/config.service';
import { recoverableWebhookWhere } from './zalo-recovery';
const publicConnection = {
  id: true,
  oaId: true,
  oaName: true,
  avatarUrl: true,
  status: true,
  tokenExpiresAt: true,
} as const;
@Injectable()
export class ZaloService {
  constructor(
    private readonly db: PrismaService,
    private readonly api: ZaloApiClient,
    private readonly config: ConfigService,
  ) {}
  async status() {
    const [connection, failedWebhookCount] = await Promise.all([
      this.db.zaloConnection.findFirst({
        where: { status: { not: 'DISCONNECTED' } },
        orderBy: { updatedAt: 'desc' },
        select: publicConnection,
      }),
      this.db.webhookEvent.count({ where: recoverableWebhookWhere() }),
    ]);
    return {
      configured: this.config.zaloConfigured,
      webhookConfigured: this.config.webhookConfigured,
      connection,
      failedWebhookCount,
    };
  }
  async profile() {
    const connection = await this.db.zaloConnection.findFirst({
      where: { status: 'CONNECTED' },
    });
    if (!connection)
      throw new ApiError(
        404,
        'NO_CONNECTION',
        'Connect a Zalo Official Account first.',
      );
    const profile = await this.api.getProfile(connection.id);
    return this.db.zaloConnection.update({
      where: { id: connection.id },
      data: { oaName: profile.name, avatarUrl: profile.avatar ?? null },
      select: publicConnection,
    });
  }
  async disconnect() {
    // Lock the same rows as refresh, so a concurrent refresh cannot restore credentials.
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ZaloConnection" WHERE "status" != 'DISCONNECTED' FOR UPDATE`;
      await tx.zaloConnection.updateMany({
        where: { status: { not: 'DISCONNECTED' } },
        data: {
          status: 'DISCONNECTED',
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
        },
      });
    });
    return { disconnected: true };
  }
}
