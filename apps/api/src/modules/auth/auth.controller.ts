import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { loginSchema } from '@zalo/shared';
import { AuthService } from './auth.service';
import { AdminGuard } from './admin.guard';
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.assertOrigin(req);
    await this.auth.login(loginSchema.parse(body).password, res);
    return { data: { authenticated: true } };
  }
  @Get('session')
  @UseGuards(AdminGuard)
  session() {
    return { data: { authenticated: true } };
  }
  @Post('logout')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req, res);
    return { data: { authenticated: false } };
  }
}
