import { ZaloOaMediaWorker } from './zalo-oa-media.worker';
import { Module } from '@nestjs/common';
import { ZaloHttpService } from './zalo-http.service';
import { ZaloApiClient } from './zalo-api.client';
import { ZaloOAuthService } from './zalo-oauth.service';
import { ZaloService } from './zalo.service';
import { ZaloWebhookService } from './zalo-webhook.service';
import { ZaloHistoryService } from './zalo-history.service';
import { ZaloController } from './zalo.controller';
import { ZaloWebhookController } from './zalo-webhook.controller';
import { InboxModule } from '../inbox/inbox.module';
@Module({
  imports: [InboxModule],
  providers: [
    ZaloOaMediaWorker,
    ZaloHttpService,
    ZaloApiClient,
    ZaloOAuthService,
    ZaloService,
    ZaloWebhookService,
    ZaloHistoryService,
  ],
  controllers: [ZaloController, ZaloWebhookController],
  exports: [ZaloApiClient, ZaloHistoryService, ZaloOaMediaWorker],
})
export class ZaloModule {}
