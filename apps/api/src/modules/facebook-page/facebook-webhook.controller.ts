import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '../../common/api-error';
import { FacebookWebhookService } from './facebook-webhook.service';

// Meta authenticates deliveries with signatures and the verification handshake.
// Administrator cookies must never be required for this provider endpoint.
@Controller('channels/facebook-page/webhook')
export class FacebookWebhookController {
  constructor(private readonly webhooks: FacebookWebhookService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') token: unknown,
    @Query('hub.challenge') challenge: unknown,
    @Res() response: Response,
  ) {
    const value = this.webhooks.verify(mode, token, challenge);
    response.status(200).type('text/plain').send(value);
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    if (!request.rawBody)
      throw new ApiError(
        400,
        'RAW_BODY_REQUIRED',
        'The exact JSON request body is required.',
      );
    return { data: await this.webhooks.receive(request.rawBody, signature) };
  }
}
