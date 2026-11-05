import { Module } from '@nestjs/common';
import { PersonalController } from './personal.controller';
import { PersonalService } from './personal.service';
@Module({
  providers: [PersonalService],
  controllers: [PersonalController],
  exports: [PersonalService],
})
export class PersonalModule {}
