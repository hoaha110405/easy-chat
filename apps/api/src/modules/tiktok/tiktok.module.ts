import { Module } from '@nestjs/common';
import { TikTokRuntimeModule } from './tiktok-runtime.module';
import { TikTokAuthService } from './tiktok-auth.service';
import { TikTokWebhookService } from './tiktok-webhook.service';
import { TikTokController } from './tiktok.controller';
@Module({
  imports: [TikTokRuntimeModule],
  providers: [TikTokAuthService, TikTokWebhookService],
  controllers: [TikTokController],
})
export class TikTokModule {}
