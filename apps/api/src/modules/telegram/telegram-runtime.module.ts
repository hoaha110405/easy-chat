import { Module } from '@nestjs/common';
import { CoreModule } from '../../common/core.module';
import { MessagePersistenceModule } from '../messaging/message-persistence.module';
import { TelegramBotClient } from '../telegram-bot/telegram-bot.client';
import { TdJsonClient } from '../telegram-personal/tdjson.client';
import {
  TdLibManager,
  TDLIB_CLIENT_FACTORY,
} from '../telegram-personal/tdlib.manager';
import { TelegramSettings } from './telegram.config';
import { TelegramRpcClient, TelegramRpcServer } from './telegram.rpc';
import { TelegramReceipts } from './telegram-receipts.service';
import { TelegramService, TelegramCleanup } from './telegram.service';
import { TelegramWorker } from './telegram.worker';
@Module({
  imports: [CoreModule, MessagePersistenceModule],
  providers: [
    { provide: TelegramBotClient, useFactory: () => new TelegramBotClient() },
    {
      provide: TDLIB_CLIENT_FACTORY,
      useValue: (bridge: string, library: string) =>
        new TdJsonClient().start(bridge, library),
    },
    TelegramSettings,
    TelegramRpcClient,
    TelegramRpcServer,
    TelegramReceipts,
    TdLibManager,
    TelegramService,
    TelegramCleanup,
    TelegramWorker,
  ],
  exports: [
    TelegramSettings,
    TelegramService,
    TelegramCleanup,
    TelegramWorker,
    TelegramReceipts,
  ],
})
export class TelegramRuntimeModule {}
