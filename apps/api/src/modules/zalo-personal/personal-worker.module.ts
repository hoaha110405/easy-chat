import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { PERSONAL_ADAPTER_FACTORY } from './personal-adapter';
import { ZcaPersonalAdapter } from './zca-personal.adapter';
import { ZaloSessionManager } from './personal-session.manager';
import { PersonalWorker } from './personal.worker';
import { FacebookRuntimeModule } from '../facebook-page/facebook-runtime.module';
@Module({
  imports: [CoreModule, FacebookRuntimeModule, MessagePersistenceModule],
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
