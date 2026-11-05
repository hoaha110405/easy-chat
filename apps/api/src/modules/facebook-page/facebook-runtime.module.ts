import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { ConfigService } from '../../config/config.service';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { FacebookGraphClient } from './facebook-graph.client';
import { FacebookPageWorker } from './facebook-page.worker';
@Module({
  imports: [CoreModule, MessagePersistenceModule],
  providers: [
    FacebookPageWorker,
    {
      provide: FacebookGraphClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new FacebookGraphClient({
          appId: config.env.FACEBOOK_APP_ID,
          appSecret: config.env.FACEBOOK_APP_SECRET,
          graphVersion: config.env.FACEBOOK_GRAPH_API_VERSION ?? 'v26.0',
        }),
    },
  ],
  exports: [FacebookGraphClient, FacebookPageWorker],
})
export class FacebookRuntimeModule {}
