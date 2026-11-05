import {
  Controller,
  Get,
  Delete,
  Req,
  Res,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AuthService, type AdminRequest } from '../auth/auth.service';
import { ConfigService } from '../../config/config.service';
import { ApiError } from '../../common/api-error';
import { ZaloOAuthService } from './zalo-oauth.service';
import { ZaloService } from './zalo.service';
const callbackSchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().max(2048).optional(),
  oa_id: z.string().max(128).optional(),
  error: z.string().max(256).optional(),
});
@Controller('zalo')
export class ZaloController {
  constructor(
    private readonly oauth: ZaloOAuthService,
    private readonly zalo: ZaloService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}
  @Get('connect')
  @UseGuards(AdminGuard)
  async connect(@Req() req: AdminRequest) {
    return {
      data: { authorizationUrl: await this.oauth.connect(req.adminSessionId!) },
    };
  }
  @Get('callback')
  async callback(
    @Req() req: AdminRequest,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    let result = 'connected';
    try {
      const parsed = callbackSchema.parse(query);
      const session = await this.auth.session(req);
      if (!session)
        throw new ApiError(
          401,
          'OAUTH_SESSION_EXPIRED',
          'Sign in and start the connection again.',
        );
      await this.oauth.callback(
        session.id,
        parsed.state,
        parsed.error ? undefined : parsed.code,
        parsed.oa_id,
      );
    } catch (error) {
      result = error instanceof ApiError ? error.code : 'OAUTH_FAILED';
    }
    const target = new URL('/connection', this.config.env.FRONTEND_URL);
    target.searchParams.set('oauth', result);
    res.redirect(303, target.toString());
  }
  @Get('status')
  @UseGuards(AdminGuard)
  async status() {
    return { data: await this.zalo.status() };
  }
  @Get('profile')
  @UseGuards(AdminGuard)
  async profile() {
    return { data: await this.zalo.profile() };
  }
  @Delete('connection')
  @UseGuards(AdminGuard)
  async disconnect() {
    return { data: await this.zalo.disconnect() };
  }
}
