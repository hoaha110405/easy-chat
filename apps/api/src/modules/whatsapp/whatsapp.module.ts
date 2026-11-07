import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { ConfigService } from '../../config/config.service';
import { WhatsAppClient } from './whatsapp.client';
import {
  WhatsAppSettings,
  WhatsAppService,
  WhatsAppCleanup,
} from './whatsapp.service';
import { WhatsAppWebhook } from './whatsapp.webhook';
import { WhatsAppWorker } from './whatsapp.worker';
import {
  WhatsAppController,
  WhatsAppWebhookController,
} from './whatsapp.controller';
@Module({
  imports: [CoreModule, MessagePersistenceModule],
  providers: [
    {
      provide: WhatsAppClient,
      useFactory: (config: ConfigService) => new WhatsAppClient(config),
      inject: [ConfigService],
    },
    WhatsAppSettings,
    WhatsAppService,
    WhatsAppCleanup,
    WhatsAppWebhook,
    WhatsAppWorker,
  ],
  exports: [WhatsAppService, WhatsAppCleanup, WhatsAppWorker, WhatsAppWebhook],
})
export class WhatsAppRuntimeModule {}
@Module({
  imports: [WhatsAppRuntimeModule],
  controllers: [WhatsAppController, WhatsAppWebhookController],
})
export class WhatsAppModule {}
