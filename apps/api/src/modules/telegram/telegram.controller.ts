import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { z } from 'zod';
import { telegramAuthInputSchema } from '@zalo/shared';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { ApiError } from '../../common/api-error';
import { TelegramService } from './telegram.service';
import { TelegramReceipts } from './telegram-receipts.service';
import { TelegramError } from './telegram.types';
export function telegramApiError(error: unknown): never {
  if (error instanceof TelegramError)
    throw new ApiError(
      error.code === 'TELEGRAM_RATE_LIMITED'
        ? 429
        : error.code.includes('UNAVAILABLE') ||
            error.code === 'TELEGRAM_NOT_CONFIGURED'
          ? 503
          : 409,
      error.code,
      (
        {
          TELEGRAM_NOT_CONFIGURED:
            'Bổ sung API ID và API Hash của ứng dụng Telegram ở backend.',
          TELEGRAM_NATIVE_UNAVAILABLE:
            'TDLib native chưa sẵn sàng. Kiểm tra thư viện và bridge chính thức.',
          TELEGRAM_WORKER_UNAVAILABLE:
            'Khởi động worker chung trước khi kết nối hoặc xác thực.',
          TELEGRAM_AUTH_INPUT_INVALID:
            'Mã xác minh hoặc mật khẩu chưa đúng. Kiểm tra và nhập lại.',
          TELEGRAM_PUBLIC_HTTPS_REQUIRED:
            'Bot cần URL webhook HTTPS công khai.',
          TELEGRAM_RATE_LIMITED: 'Telegram yêu cầu chờ trước khi thử lại.',
          TELEGRAM_AUTH_SESSION_EXPIRED:
            'Phiên đăng nhập đã hết hạn. Bắt đầu kết nối lại.',
          TELEGRAM_SEND_UNKNOWN:
            'Chưa rõ kết quả gửi. Kiểm tra trên Telegram trước.',
        } as Record<string, string>
      )[error.code] ??
        'Telegram chưa hoàn tất yêu cầu. Kiểm tra kết nối và quyền truy cập.',
    );
  throw error;
}
@Controller('channels')
export class TelegramController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly receipts: TelegramReceipts,
  ) {}
  @Get(['telegram-bot', 'telegram-personal'])
  @UseGuards(AdminGuard)
  async status(@Req() req: AdminRequest) {
    return {
      data: await this.telegram.status(
        req.path.split('/').includes('telegram-bot')
          ? 'TELEGRAM_BOT'
          : 'TELEGRAM_PERSONAL',
        req.adminOwnerId!,
        req.adminSessionId!,
      ),
    };
  }
  @Post('telegram-bot/connect') @HttpCode(200) @UseGuards(AdminGuard) async bot(
    @Req() req: AdminRequest,
    @Body() body: unknown,
  ) {
    const input = z.object({ token: z.string().min(1).max(256) }).parse(body);
    try {
      return {
        data: await this.telegram.connectBot(req.adminOwnerId!, input.token),
      };
    } catch (error) {
      telegramApiError(error);
    }
  }
  @Post('telegram-bot/:id/verify-webhook')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async verify(@Req() req: AdminRequest, @Param('id') id: string) {
    try {
      return {
        data: await this.telegram.verifyBot(
          await this.telegram.owned(
            z.string().cuid().parse(id),
            req.adminOwnerId!,
            'TELEGRAM_BOT',
          ),
        ),
      };
    } catch (error) {
      telegramApiError(error);
    }
  }
  @Post('telegram-personal/connect')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async personal(@Req() req: AdminRequest, @Body() body: unknown) {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100).default('Telegram cá nhân'),
        accountId: z.string().cuid().optional(),
      })
      .parse(body);
    try {
      return {
        data: await this.telegram.startPersonal(
          req.adminOwnerId!,
          req.adminSessionId!,
          input.name,
          input.accountId,
        ),
      };
    } catch (error) {
      telegramApiError(error);
    }
  }
  @Post('telegram-personal/:id/auth')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  async auth(
    @Req() req: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = telegramAuthInputSchema.parse(body);
    try {
      return {
        data: await this.telegram.authenticate(
          z.string().cuid().parse(id),
          req.adminOwnerId!,
          req.adminSessionId!,
          input,
        ),
      };
    } catch (error) {
      telegramApiError(error);
    }
  }
  @Post('telegram-bot/:id/webhook') @HttpCode(200) async webhook(
    @Req() req: RawBodyRequest<AdminRequest>,
    @Param('id') id: string,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ) {
    await this.receipts.webhook(
      z.string().cuid().parse(id),
      req.rawBody,
      secret,
    );
    return { ok: true };
  }
}
