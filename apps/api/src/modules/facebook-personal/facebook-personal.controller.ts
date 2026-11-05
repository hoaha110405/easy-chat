import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { FacebookPersonalService } from './facebook-personal.service';

@Controller('channels/facebook-personal')
@UseGuards(AdminGuard)
export class FacebookPersonalController {
  constructor(private readonly personal: FacebookPersonalService) {}

  @Get('status')
  status() {
    return { data: this.personal.status() };
  }

  @Get('capabilities')
  capabilities() {
    return { data: this.personal.capabilities() };
  }

  // Intentionally no body binding: no authentication material is accepted,
  // persisted, echoed, or handed to another service while no driver is reviewed.
  @Post('connect')
  connect(): never {
    return this.personal.assertSupported('connect');
  }

  @Post()
  create(): never {
    return this.personal.assertSupported('connect');
  }
}
