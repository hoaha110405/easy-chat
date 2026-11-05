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
import { FacebookPageWorker } from './facebook-page.worker';
@Controller()
@UseGuards(AdminGuard)
export class ChannelSyncController {
  constructor(
    private readonly worker: FacebookPageWorker,
    private readonly db: PrismaService,
  ) {}
  @Post('channels/:id/sync') @HttpCode(202) async channel(
    @Param('id') id: string,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.worker.enqueue(
        req.adminOwnerId!,
        z.string().cuid().parse(id),
      ),
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
    return {
      data: await this.worker.enqueue(
        req.adminOwnerId!,
        item.channelAccountId,
        item.id,
      ),
    };
  }
}
