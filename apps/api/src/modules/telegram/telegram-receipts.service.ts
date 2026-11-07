import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  CryptoService,
  constantEquals,
  hash,
} from '../../common/crypto.service';
import { botMessageSchema } from '../telegram-bot/telegram-bot.client';
import { ApiError } from '../../common/api-error';
import {
  botCredentialsSchema,
  telegramId,
  telegramJson,
} from './telegram.types';
export const telegramReceiptSchema = z.object({
  generation: z.number().int(),
  kind: z.enum([
    'message',
    'chat',
    'edit',
    'delete',
    'read_inbox',
    'read_outbox',
    'send_succeeded',
    'send_failed',
    'member',
  ]),
  data: z.record(z.unknown()),
  at: z.number().int(),
});
export type TelegramReceipt = z.infer<typeof telegramReceiptSchema>;
@Injectable()
export class TelegramReceipts {
  private processor?: (id: string) => Promise<void>;
  setProcessor(processor: ((id: string) => Promise<void>) | undefined) {
    this.processor = processor;
  }
  constructor(
    private readonly db: PrismaService,
    private readonly crypto: CryptoService,
  ) {}
  async accept(
    account: ChannelAccount,
    event: Omit<TelegramReceipt, 'generation' | 'at'>,
    key: string,
  ) {
    const payload = telegramReceiptSchema.parse({
      ...event,
      generation: account.generation,
      at: Date.now(),
    });
    const digest = hash(`telegram:${account.id}:${account.generation}:${key}`);
    const result = await this.db.webhookEvent.createMany({
      data: [
        {
          channelAccountId: account.id,
          eventName:
            account.channelType === 'TELEGRAM_BOT'
              ? 'telegram.bot'
              : 'telegram.personal',
          digest,
          payload: JSON.parse(
            JSON.stringify(payload),
          ) as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count && this.processor) {
      const receipt = await this.db.webhookEvent.findUniqueOrThrow({
        where: { digest },
        select: { id: true },
      });
      await this.processor(receipt.id);
    }
    return result.count;
  }
  async webhook(accountId: string, raw: Buffer | undefined, secret?: string) {
    const account = await this.db.channelAccount.findFirst({
      where: {
        id: accountId,
        channelType: 'TELEGRAM_BOT',
        connectionStatus: { not: 'DISCONNECTED' },
      },
    });
    let expected = '';
    try {
      expected = botCredentialsSchema.parse(
        JSON.parse(this.crypto.decrypt(account!.encryptedCredentials!)),
      ).webhookSecret;
    } catch {
      /* no secret in errors */
    }
    if (!expected || !secret || !constantEquals(secret, expected))
      throw new ApiError(
        401,
        'TELEGRAM_WEBHOOK_INVALID',
        'Telegram webhook secret is invalid.',
      );
    if (!raw?.length || raw.length > 1024 * 1024)
      throw new ApiError(
        400,
        'TELEGRAM_WEBHOOK_INVALID',
        'Invalid webhook body.',
      );
    let update: {
      update_id: string;
      message?: Record<string, unknown>;
      edited_message?: Record<string, unknown>;
      my_chat_member?: Record<string, unknown>;
    };
    try {
      update = z
        .object({
          update_id: telegramId,
          message: botMessageSchema.optional(),
          edited_message: botMessageSchema.optional(),
          my_chat_member: z.record(z.unknown()).optional(),
        })
        .parse(telegramJson.parse(raw.toString('utf8')));
    } catch {
      throw new ApiError(
        400,
        'TELEGRAM_WEBHOOK_INVALID',
        'Invalid Telegram update.',
      );
    }
    const kind = update.message
      ? 'message'
      : update.edited_message
        ? 'edit'
        : update.my_chat_member
          ? 'member'
          : null;
    if (!kind) return { accepted: 0 };
    const data =
      update.message ?? update.edited_message ?? update.my_chat_member!;
    return {
      accepted: await this.accept(
        account!,
        { kind, data },
        `update:${update.update_id}`,
      ),
    };
  }
}
