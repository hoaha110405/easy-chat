import { WhatsAppWorker } from '../whatsapp/whatsapp.worker';
import {
  Controller,
  Post,
  Param,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../database/prisma.service';
import { ApiError } from '../../common/api-error';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { TelegramWorker } from '../telegram/telegram.worker';
import { TikTokWorker } from '../tiktok/tiktok.worker';
import { FacebookPageWorker } from './facebook-page.worker';
@Controller()
@UseGuards(AdminGuard)
export class ChannelSyncController {
  constructor(
    private readonly worker: FacebookPageWorker,
    private readonly db: PrismaService,
    private readonly tiktok: TikTokWorker,
    private readonly telegram: TelegramWorker,
    private readonly whatsapp: WhatsAppWorker,
  ) {}
  @Post('channels/:id/sync') @HttpCode(202) async channel(
    @Param('id') id: string,
    @Req() req: AdminRequest,
  ) {
    const account = await this.db.channelAccount.findFirst({
      where: { id: z.string().cuid().parse(id), ownerId: req.adminOwnerId! },
    });
    if (!account)
      throw new ApiError(404, 'CHANNEL_NOT_FOUND', 'Account not found.');
    return {
      data: await (
        account.channelType === 'WHATSAPP_BUSINESS'
          ? this.whatsapp
          : account.channelType.startsWith('TELEGRAM_')
            ? this.telegram
            : account.channelType.startsWith('TIKTOK_')
              ? this.tiktok
              : this.worker
      ).enqueue(req.adminOwnerId!, z.string().cuid().parse(id)),
    };
  }
  @Post('conversations/:id/sync') @HttpCode(202) async conversation(
    @Param('id') id: string,
    @Req() req: AdminRequest,
  ) {
    const item = await this.db.conversation.findFirst({
      where: {
        id: z.string().cuid().parse(id),
        channelAccount: { ownerId: req.adminOwnerId! },
      },
    });
    if (!item?.channelAccountId)
      throw new ApiError(
        404,
        'CONVERSATION_NOT_FOUND',
        'Không tìm thấy hội thoại.',
      );
    const account = await this.db.channelAccount.findUniqueOrThrow({
      where: { id: item.channelAccountId },
    });
    return {
      data: await (
        account.channelType === 'WHATSAPP_BUSINESS'
          ? this.whatsapp
          : account.channelType.startsWith('TELEGRAM_')
            ? this.telegram
            : account.channelType.startsWith('TIKTOK_')
              ? this.tiktok
              : this.worker
      ).enqueue(req.adminOwnerId!, item.channelAccountId, item.id),
    };
  }
}
