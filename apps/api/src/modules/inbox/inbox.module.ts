import { PersonalModule } from '../zalo-personal/personal.module';
import { Module } from '@nestjs/common';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';
@Module({
  imports: [PersonalModule, MessagePersistenceModule],
  providers: [InboxService],
  controllers: [InboxController],
  exports: [MessagePersistenceModule],
})
export class InboxModule {}
