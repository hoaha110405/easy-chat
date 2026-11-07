import { Module } from '@nestjs/common';
import { TelegramRuntimeModule } from './telegram-runtime.module';
import { TelegramController } from './telegram.controller';
@Module({ imports: [TelegramRuntimeModule], controllers: [TelegramController] })
export class TelegramModule {}
