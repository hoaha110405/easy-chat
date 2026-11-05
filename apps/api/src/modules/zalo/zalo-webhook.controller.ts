import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  Body,
  Headers,
  HttpCode,
  RawBodyRequest,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ApiError } from '../../common/api-error';
import { ZaloWebhookService } from './zalo-webhook.service';
@Controller()
export class ZaloWebhookController {
  constructor(private readonly webhooks: ZaloWebhookService) {}
  @Post('webhooks/zalo')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Headers('x-zevent-signature') signature?: string,
  ) {
    if (!req.rawBody)
      throw new ApiError(
        400,
        'RAW_BODY_REQUIRED',
        'A JSON request body is required.',
      );
    return { data: await this.webhooks.receive(req.rawBody, body, signature) };
  }
  @Get('zalo/webhook-events/failed')
  @UseGuards(AdminGuard)
  async failures() {
    return { data: await this.webhooks.failures() };
  }
  @Post('zalo/webhook-events/:id/retry')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async retry(@Param('id') id: string) {
    return { data: await this.webhooks.process(z.string().cuid().parse(id)) };
  }
}
