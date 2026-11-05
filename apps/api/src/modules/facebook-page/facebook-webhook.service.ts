import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../common/api-error';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../database/prisma.service';
import {
  FACEBOOK_WEBHOOK_MAX_BYTES,
  facebookWebhookDigest,
  parseFacebookWebhook,
  sameFacebookVerifyToken,
  verifyFacebookWebhookSignature,
} from './facebook-webhook';

@Injectable()
export class FacebookWebhookService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}

  verify(mode: unknown, token: unknown, challenge: unknown): string {
    const expected = this.config.env.FACEBOOK_VERIFY_TOKEN;
    if (!expected)
      throw new ApiError(
        503,
        'FACEBOOK_PAGE_NOT_CONFIGURED',
        'Facebook webhook verification is not configured.',
      );
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      token.length > 4096 ||
      !sameFacebookVerifyToken(token, expected)
    )
      throw new ApiError(
        403,
        'INVALID_FACEBOOK_VERIFY_TOKEN',
        'Facebook webhook verification failed.',
      );
    if (
      typeof challenge !== 'string' ||
      !challenge.length ||
      challenge.length > 2048
    )
      throw new ApiError(
        400,
        'INVALID_FACEBOOK_WEBHOOK_CHALLENGE',
        'A valid webhook challenge is required.',
      );
    return challenge;
  }

  async receive(raw: Buffer, signature?: string) {
    const secret = this.config.env.FACEBOOK_APP_SECRET;
    if (!secret)
      throw new ApiError(
        503,
        'FACEBOOK_PAGE_NOT_CONFIGURED',
        'Facebook webhook credentials are not configured.',
      );
    if (!raw.length || raw.length > FACEBOOK_WEBHOOK_MAX_BYTES)
      throw new ApiError(
        raw.length ? 413 : 400,
        'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
        'A bounded JSON request body is required.',
      );
    verifyFacebookWebhookSignature(raw, secret, signature);
    const { events, ignored } = parseFacebookWebhook(raw);
    const result = await this.db.$transaction(async (tx) => {
      const accounts = events.length
        ? await tx.channelAccount.findMany({
            where: {
              channelType: 'FACEBOOK_PAGE',
              connectionStatus: 'CONNECTED',
              externalAccountId: {
                in: [...new Set(events.map((event) => event.pageId))],
              },
            },
            select: { id: true, externalAccountId: true },
          })
        : [];
      const rows: Prisma.WebhookEventCreateManyInput[] = [];
      let unmatched = 0;
      for (const payload of events) {
        const matching = accounts.filter(
          (account) => account.externalAccountId === payload.pageId,
        );
        if (!matching.length) unmatched++;
        for (const account of matching) {
          rows.push({
            digest: facebookWebhookDigest(account.id, payload),
            channelAccountId: account.id,
            eventName: 'facebook.page',
            payload: payload as unknown as Prisma.InputJsonObject,
          });
        }
      }
      if (rows.length > 10000)
        throw new ApiError(
          413,
          'INVALID_FACEBOOK_WEBHOOK_PAYLOAD',
          'The webhook batch exceeds supported limits.',
        );
      const inserted = rows.length
        ? await tx.webhookEvent.createMany({ data: rows, skipDuplicates: true })
        : { count: 0 };
      return { accepted: inserted.count, ignored: ignored + unmatched };
    });
    // Completion of $transaction is the durability boundary. Processing belongs
    // to the existing worker, and no external message is sent by this request.
    return { received: true, ...result };
  }
}
