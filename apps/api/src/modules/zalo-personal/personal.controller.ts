import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { z } from 'zod';
import { createPersonalAccountSchema } from '@zalo/shared';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { PersonalService } from './personal.service';
const idSchema = z.string().cuid();
@Controller('channels')
@UseGuards(AdminGuard)
export class PersonalController {
  constructor(private readonly personal: PersonalService) {}
  @Get('zalo-personal') async list(@Req() req: AdminRequest) {
    return { data: await this.personal.list(req.adminOwnerId!) };
  }
  @Post('zalo-personal') async create(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    return {
      data: await this.personal.create(
        req.adminOwnerId!,
        createPersonalAccountSchema.parse(body).name,
      ),
    };
  }
  @Post(':id/login/qr') @HttpCode(202) async qr(
    @Req() req: AdminRequest,
    @Param('id') id: string,
  ) {
    return {
      data: await this.personal.startQr(idSchema.parse(id), req.adminOwnerId!),
    };
  }
  @Post(':id/login/cancel') @HttpCode(200) async cancel(
    @Req() req: AdminRequest,
    @Param('id') id: string,
  ) {
    return {
      data: await this.personal.disconnect(
        idSchema.parse(id),
        req.adminOwnerId!,
        true,
      ),
    };
  }
  @Get(':id/status') async status(
    @Req() req: AdminRequest,
    @Param('id') id: string,
  ) {
    return {
      data: await this.personal.status(idSchema.parse(id), req.adminOwnerId!),
    };
  }
  @Delete(':id') async disconnect(
    @Req() req: AdminRequest,
    @Param('id') id: string,
  ) {
    return {
      data: await this.personal.disconnect(
        idSchema.parse(id),
        req.adminOwnerId!,
      ),
    };
  }
}
