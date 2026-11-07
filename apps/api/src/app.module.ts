import { MediaModule } from './modules/media/media.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { TikTokModule } from './modules/tiktok/tiktok.module';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './common/core.module';
import { AuthController } from './modules/auth/auth.controller';
import { ZaloModule } from './modules/zalo/zalo.module';
import { PersonalModule } from './modules/zalo-personal/personal.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { FacebookPageModule } from './modules/facebook-page/facebook-page.module';
import { FacebookPersonalModule } from './modules/facebook-personal/facebook-personal.module';
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    WhatsAppModule,
    MediaModule,
    TelegramModule,
    TikTokModule,
    FacebookPageModule,
    FacebookPersonalModule,
    ZaloModule,
    InboxModule,
    PersonalModule,
    RealtimeModule,
  ],
  controllers: [AuthController],
})
export class AppModule {}
