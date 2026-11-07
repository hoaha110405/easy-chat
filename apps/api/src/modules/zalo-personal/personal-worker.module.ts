import { ZaloModule } from '../zalo/zalo.module';
import { WhatsAppRuntimeModule } from '../whatsapp/whatsapp.module';
import { TelegramRuntimeModule } from '../telegram/telegram-runtime.module';
import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { PERSONAL_ADAPTER_FACTORY } from './personal-adapter';
import { ZcaPersonalAdapter } from './zca-personal.adapter';
import { ZaloSessionManager } from './personal-session.manager';
import { PersonalWorker } from './personal.worker';
import { TikTokRuntimeModule } from '../tiktok/tiktok-runtime.module';
import { FacebookRuntimeModule } from '../facebook-page/facebook-runtime.module';
@Module({
  imports: [
    WhatsAppRuntimeModule,
    ZaloModule,
    CoreModule,
    TelegramRuntimeModule,
    FacebookRuntimeModule,
    TikTokRuntimeModule,
    MessagePersistenceModule,
  ],
  providers: [
    ZaloSessionManager,
    PersonalWorker,
    {
      provide: PERSONAL_ADAPTER_FACTORY,
      useValue: () => new ZcaPersonalAdapter(),
    },
  ],
})
export class PersonalWorkerModule {}
