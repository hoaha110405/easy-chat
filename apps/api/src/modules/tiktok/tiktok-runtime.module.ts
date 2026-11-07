import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { ConfigService } from '../../config/config.service';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { TikTokBusinessClient } from '../tiktok-business/tiktok-business.client';
import { TikTokShopClient } from '../tiktok-shop/tiktok-shop.client';
import { TikTokRegistry } from './tiktok.registry';
import { TikTokTokenService } from './tiktok-token.service';
import { TikTokWorker } from './tiktok.worker';
@Module({
  imports: [CoreModule, MessagePersistenceModule],
  providers: [
    {
      provide: TikTokBusinessClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new TikTokBusinessClient(config),
    },
    {
      provide: TikTokShopClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new TikTokShopClient(config),
    },
    TikTokRegistry,
    TikTokTokenService,
    TikTokWorker,
  ],
  exports: [TikTokRegistry, TikTokTokenService, TikTokWorker],
})
export class TikTokRuntimeModule {}
