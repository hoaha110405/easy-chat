import { WhatsAppRuntimeModule } from '../whatsapp/whatsapp.module';
import { TelegramRuntimeModule } from '../telegram/telegram-runtime.module';
import { Module } from '@nestjs/common';
import { PersonalController } from './personal.controller';
import { PersonalService } from './personal.service';
@Module({
  imports: [WhatsAppRuntimeModule, TelegramRuntimeModule],
  providers: [PersonalService],
  controllers: [PersonalController],
  exports: [PersonalService],
})
export class PersonalModule {}
