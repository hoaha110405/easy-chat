import { Module } from '@nestjs/common';
import { WhatsAppRuntimeModule } from '../whatsapp/whatsapp.module';
import { TelegramRuntimeModule } from '../telegram/telegram-runtime.module';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
@Module({
  imports: [WhatsAppRuntimeModule, TelegramRuntimeModule],
  providers: [MediaService],
  controllers: [MediaController],
})
export class MediaModule {}
