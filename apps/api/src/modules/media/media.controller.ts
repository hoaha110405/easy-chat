import { sendPrivateMedia } from '../../common/media-response';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { mediaInputSchema } from '@zalo/shared';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { MediaService } from './media.service';
import type { WhatsAppUpload } from '../whatsapp/whatsapp.media';
import { TelegramService } from '../telegram/telegram.service';
import { ApiError } from '../../common/api-error';
@Controller()
@UseGuards(AdminGuard)
export class MediaController {
  constructor(
    readonly service: MediaService,
    readonly telegram: TelegramService,
  ) {}
  @Post('conversations/:id/media')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20_000_000, files: 1, fields: 3, fieldSize: 8192 },
    }),
  )
  async send(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @UploadedFile() file?: WhatsAppUpload,
  ) {
    return {
      data: await this.service.send(
        r.adminOwnerId!,
        z.string().cuid().parse(id),
        mediaInputSchema.parse(body),
        file,
      ),
    };
  }
  @Get('messages/:id/media')
  async file(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    id = z.string().cuid().parse(id);
    const m = await this.service.message(r.adminOwnerId!, id);
    if (!(await this.service.store.exists(id)) && m.source === 'TELEGRAM')
      await this.telegram.downloadMedia(r.adminOwnerId!, r.adminSessionId!, id);
    const file = await this.service.store.read(id);
    const rechecked = await this.service.message(r.adminOwnerId!, id);
    if (rechecked.deletedAt)
      throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Tệp đã bị xóa.');
    sendPrivateMedia(res, file, r.headers.range);
  }
}
