import { WhatsAppRuntimeModule } from '../whatsapp/whatsapp.module';
import { TelegramRuntimeModule } from '../telegram/telegram-runtime.module';
import { TikTokRuntimeModule } from '../tiktok/tiktok-runtime.module';
import { Module } from '@nestjs/common';
import { FacebookRuntimeModule } from './facebook-runtime.module';
import { FacebookPageService } from './facebook-page.service';
import { FacebookPageController } from './facebook-page.controller';
import { FacebookWebhookService } from './facebook-webhook.service';
import { FacebookWebhookController } from './facebook-webhook.controller';
import { ChannelSyncController } from './channel-sync.controller';
@Module({
  imports: [
    WhatsAppRuntimeModule,
    FacebookRuntimeModule,
    TikTokRuntimeModule,
    TelegramRuntimeModule,
  ],
  providers: [FacebookPageService, FacebookWebhookService],
  controllers: [
    FacebookPageController,
    FacebookWebhookController,
    ChannelSyncController,
  ],
})
export class FacebookPageModule {}
