import { Module } from '@nestjs/common';
import { MessageStore } from '../inbox/message-store';

// One shared store instance per Nest application, used by every provider.
@Module({ providers: [MessageStore], exports: [MessageStore] })
export class MessagePersistenceModule {}
