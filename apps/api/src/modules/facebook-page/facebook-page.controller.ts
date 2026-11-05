import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { facebookSelectPageSchema } from '@zalo/shared';
import { ApiError } from '../../common/api-error';
import { ConfigService } from '../../config/config.service';
import { AdminGuard } from '../auth/admin.guard';
import {
  ADMIN_OWNER_ID,
  AuthService,
  type AdminRequest,
} from '../auth/auth.service';
import { FacebookPageService } from './facebook-page.service';

const callbackSchema = z.object({
  state: z.string().min(1).max(256),
  code: z.string().min(1).max(8192).optional(),
  error: z.string().max(256).optional(),
});

@Controller('channels/facebook-page')
export class FacebookPageController {
  constructor(
    private readonly facebook: FacebookPageService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @UseGuards(AdminGuard)
  async status(@Req() req: AdminRequest) {
    return {
      data: await this.facebook.status(req.adminOwnerId!, req.adminSessionId!),
    };
  }

  @Get('connect')
  @UseGuards(AdminGuard)
  async connect(@Req() req: AdminRequest) {
    return {
      data: {
        authorizationUrl: await this.facebook.connect(req.adminSessionId!),
      },
    };
  }

  @Post('select')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async select(@Req() req: AdminRequest, @Body() body: unknown) {
    return {
      data: await this.facebook.selectPage(
        req.adminOwnerId!,
        req.adminSessionId!,
        facebookSelectPageSchema.parse(body).pageId,
      ),
    };
  }

  @Get('oauth/callback')
  async callback(
    @Req() req: AdminRequest,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    const target = new URL('/facebook/page', this.config.env.FRONTEND_URL);
    try {
      const session = await this.auth.session(req);
      if (!session)
        throw new ApiError(
          401,
          'OAUTH_SESSION_EXPIRED',
          'Sign in and start the connection again.',
        );
      const parsed = callbackSchema.safeParse(query);
      if (!parsed.success)
        throw new ApiError(
          400,
          'INVALID_OAUTH_CALLBACK',
          'The Facebook callback is invalid.',
        );
      await this.facebook.callback(
        session.id,
        ADMIN_OWNER_ID,
        parsed.data.state,
        parsed.data.error ? undefined : parsed.data.code,
      );
      target.searchParams.set('oauth', 'select');
    } catch (error) {
      target.searchParams.set(
        'error',
        error instanceof ApiError ? error.code : 'FACEBOOK_OAUTH_FAILED',
      );
    }
    res.redirect(303, target.toString());
  }
}
