import { Module } from '@nestjs/common';
import { FacebookPersonalController } from './facebook-personal.controller';
import { FacebookPersonalService } from './facebook-personal.service';

@Module({
  controllers: [FacebookPersonalController],
  providers: [FacebookPersonalService],
  exports: [FacebookPersonalService],
})
export class FacebookPersonalModule {}
