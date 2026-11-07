import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  Query,
  UseGuards,
  HttpCode,
  Headers,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ConfigService } from '../../config/config.service';
import { ApiError } from '../../common/api-error';
import { AdminGuard } from '../auth/admin.guard';
import {
  AuthService,
  ADMIN_OWNER_ID,
  type AdminRequest,
} from '../auth/auth.service';
import { TikTokAuthService } from './tiktok-auth.service';
import { TikTokWebhookService } from './tiktok-webhook.service';
import { TikTokError } from './tiktok-http';
import type { TikTokType } from './tiktok.types';
export function tiktokApiError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof TikTokError) {
    const messages: Record<string, string> = {
      TIKTOK_NOT_CONFIGURED: 'Chưa cấu hình đầy đủ ứng dụng TikTok.',
      TIKTOK_PERMISSION_DENIED:
        'Ứng dụng hoặc tài khoản chưa được cấp đủ quyền TikTok. Kiểm tra quyền ứng dụng và cấp quyền lại.',
      TIKTOK_SHOP_APPROVAL_REQUIRED:
        'TikTok Shop chưa cấp đủ quyền Customer Service. Cần seller.customer_service và seller.authorization.info.',
      TIKTOK_ACCOUNT_NOT_ELIGIBLE:
        'Tài khoản chưa đủ điều kiện sử dụng Business Messaging hoặc không có shop được cấp quyền.',
      TIKTOK_PUBLIC_HTTPS_REQUIRED:
        'Callback cần dùng URL HTTPS công khai trước khi đăng ký webhook.',
      TIKTOK_AUTH_URL_INVALID:
        'URL cấp quyền không hợp lệ. Sao chép URL chính thức từ trang quản lý ứng dụng TikTok.',
      TIKTOK_TOKEN_EXPIRED: 'Quyền TikTok đã hết hạn. Vui lòng kết nối lại.',
    };
    throw new ApiError(
      error.code === 'TIKTOK_NOT_CONFIGURED'
        ? 503
        : error.code.includes('PERMISSION') || error.code.includes('APPROVAL')
          ? 403
          : error.code === 'TIKTOK_RATE_LIMITED'
            ? 429
            : 409,
      error.code,
      messages[error.code] ??
        'TikTok chưa thể hoàn tất yêu cầu. Kiểm tra quyền và kết nối lại.',
    );
  }
  throw error;
}
function type(req: AdminRequest): TikTokType {
  return req.path.split('/').includes('tiktok-shop')
    ? 'TIKTOK_SHOP'
    : 'TIKTOK_BUSINESS';
}
@Controller('channels')
export class TikTokController {
  constructor(
    private readonly tiktok: TikTokAuthService,
    private readonly webhooks: TikTokWebhookService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}
  @Get(['tiktok-business', 'tiktok-shop']) @UseGuards(AdminGuard) async status(
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.tiktok.status(
        type(req),
        req.adminOwnerId!,
        req.adminSessionId!,
      ),
    };
  }
  @Post(['tiktok-business/connect', 'tiktok-shop/connect'])
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async connect(@Req() req: AdminRequest) {
    try {
      return {
        data: await this.tiktok.connect(
          type(req),
          req.adminOwnerId!,
          req.adminSessionId!,
        ),
      };
    } catch (error) {
      tiktokApiError(error);
    }
  }
  @Post(['tiktok-business/select', 'tiktok-shop/select'])
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async select(@Req() req: AdminRequest, @Body() body: unknown) {
    const data = z
      .object({
        authorizationId: z.string().cuid(),
        externalAccountId: z.string().min(1).max(512),
      })
      .parse(body);
    try {
      return {
        data: await this.tiktok.select(
          type(req),
          req.adminOwnerId!,
          req.adminSessionId!,
          data.authorizationId,
          data.externalAccountId,
        ),
      };
    } catch (error) {
      tiktokApiError(error);
    }
  }
  @Get(['tiktok-business/oauth/callback', 'tiktok-shop/oauth/callback'])
  async callback(
    @Req() req: AdminRequest,
    @Query() query: unknown,
    @Res() response: Response,
  ) {
    const channel = type(req);
    const target = new URL(
      channel === 'TIKTOK_BUSINESS' ? '/tiktok/business' : '/tiktok/shop',
      this.config.env.FRONTEND_URL,
    );
    try {
      const session = await this.auth.session(req);
      if (!session)
        throw new ApiError(401, 'OAUTH_SESSION_EXPIRED', 'Đăng nhập lại.');
      const data = z
        .object({
          state: z.string().min(1).max(256),
          code: z.string().max(8192).optional(),
          auth_code: z.string().max(8192).optional(),
          error: z.string().max(256).optional(),
        })
        .parse(query);
      await this.tiktok.callback(
        channel,
        ADMIN_OWNER_ID,
        session.id,
        data.state,
        data.error ? undefined : (data.code ?? data.auth_code),
      );
      target.searchParams.set('oauth', 'select');
    } catch (error) {
      target.searchParams.set(
        'error',
        error instanceof TikTokError || error instanceof ApiError
          ? error.code
          : 'TIKTOK_AUTH_FAILED',
      );
    }
    response.redirect(303, target.href);
  }
  @Post(['tiktok-business/webhook', 'tiktok-shop/webhook'])
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<AdminRequest>,
    @Headers('tiktok-signature') businessSignature: string | undefined,
    @Headers('authorization') shopSignature: string | undefined,
    @Res() response: Response,
  ) {
    await this.webhooks.receive(
      type(req),
      req.rawBody,
      type(req) === 'TIKTOK_BUSINESS' ? businessSignature : shopSignature,
    );
    response.status(200).end();
  }
}
