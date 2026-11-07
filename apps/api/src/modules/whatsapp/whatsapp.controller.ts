import { sendPrivateMedia } from '../../common/media-response';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { whatsappMediaInputSchema } from '@zalo/shared';
import type { WhatsAppUpload } from './whatsapp.media';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { ApiError } from '../../common/api-error';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhook } from './whatsapp.webhook';
import { waId, WhatsAppError } from './whatsapp.types';
import { templateInputSchema } from './whatsapp.templates';
export function whatsappApiError(e: unknown): never {
  if (e instanceof WhatsAppError)
    throw new ApiError(
      e.code === 'WHATSAPP_RATE_LIMITED'
        ? 429
        : e.code.includes('UNAVAILABLE') || e.code === 'WHATSAPP_NOT_CONFIGURED'
          ? 503
          : 409,
      e.code,
      (
        {
          WHATSAPP_NOT_CONFIGURED:
            'Bổ sung cấu hình Meta App và webhook HTTPS tại máy chủ.',
          WHATSAPP_PERMISSION_REQUIRED:
            'Token thiếu quyền WhatsApp Business hoặc tài sản được cấp quyền.',
          WHATSAPP_REAUTH_REQUIRED:
            'Token WhatsApp đã hết hạn hoặc bị thu hồi. Kết nối lại.',
          WHATSAPP_REGISTRATION_REQUIRED:
            'Số điện thoại chưa đăng ký Cloud API. Cung cấp PIN 6 chữ số của số đã xác minh để đăng ký.',
          WHATSAPP_WEBHOOK_NOT_CONFIGURED:
            'Thiết lập webhook Meta đúng URL và đăng ký các trường cần thiết trước khi kết nối.',
          WHATSAPP_WINDOW_CLOSED:
            'Đã hết cửa sổ trả lời 24 giờ. Chọn mẫu đã duyệt và xác nhận sự đồng ý phù hợp.',
          WHATSAPP_COEXISTENCE_APPROVAL_REQUIRED:
            'Số này đang dùng Business App Coexistence. Luồng đồng bộ riêng chưa được bật trong easyChat.',
          WHATSAPP_TEMPLATE_PERMISSION_REQUIRED:
            'Chưa có quyền quản lý/đọc mẫu WhatsApp.',
          WHATSAPP_TEMPLATE_NOT_APPROVED:
            'Mẫu chưa được Meta phê duyệt hoặc đã tạm dừng.',
          WHATSAPP_TEMPLATE_PARAMETERS_INVALID:
            'Các biến của mẫu chưa đúng. Tải lại danh sách mẫu và kiểm tra giá trị.',
          WHATSAPP_TEMPLATE_TYPE_UNSUPPORTED:
            'MVP chỉ hỗ trợ mẫu văn bản Utility/Marketing, không có nút hoặc media.',
          WHATSAPP_EMBEDDED_APPROVAL_REQUIRED:
            'Embedded Signup cần cấu hình và quyền Meta phù hợp trên miền HTTPS.',
          WHATSAPP_OAUTH_STATE_INVALID:
            'Phiên cấp quyền hết hạn hoặc đã dùng. Bắt đầu lại.',
          WHATSAPP_MEDIA_REQUIRED:
            'Chọn một tài liệu hoặc tệp âm thanh để gửi.',
          WHATSAPP_AUDIO_CAPTION_UNSUPPORTED:
            'Tệp âm thanh không kèm chú thích. Hãy gửi văn bản thành tin riêng.',
          WHATSAPP_MEDIA_UNAVAILABLE: 'Tệp WhatsApp không còn khả dụng.',
          WHATSAPP_MEDIA_UNSUPPORTED:
            'Loại hoặc dung lượng tệp vượt phạm vi được hỗ trợ.',
        } as Record<string, string>
      )[e.code] ??
        'WhatsApp chưa hoàn tất yêu cầu. Kiểm tra quyền và trạng thái kết nối.',
    );
  throw e;
}
@Controller()
@UseGuards(AdminGuard)
export class WhatsAppController {
  constructor(readonly service: WhatsAppService) {}
  @Get('channels/whatsapp') async status(@Req() r: AdminRequest) {
    return {
      data: await this.service.status(r.adminOwnerId!, r.adminSessionId!),
    };
  }
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('channels/whatsapp/connect')
  @HttpCode(200)
  async connect(@Req() r: AdminRequest, @Body() body: unknown) {
    const v = z
      .object({
        accessToken: z.string().trim().min(10).max(16384),
        wabaId: waId,
        phoneNumberId: waId,
        pin: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .parse(body);
    try {
      return {
        data: await this.service.connect(
          r.adminOwnerId!,
          v.accessToken,
          v.wabaId,
          v.phoneNumberId,
          'DIRECT',
          v.pin,
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('channels/whatsapp/embedded/begin')
  @HttpCode(200)
  async begin(@Req() r: AdminRequest) {
    try {
      return {
        data: await this.service.begin(r.adminOwnerId!, r.adminSessionId!),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('channels/whatsapp/embedded/complete')
  @HttpCode(200)
  async complete(@Req() r: AdminRequest, @Body() body: unknown) {
    const v = z
      .object({
        authorizationId: z.string().cuid(),
        state: z.string().min(32).max(128),
        code: z.string().min(1).max(8192),
      })
      .parse(body);
    try {
      return {
        data: await this.service.complete(
          r.adminOwnerId!,
          r.adminSessionId!,
          v.authorizationId,
          v.state,
          v.code,
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('channels/whatsapp/embedded/select')
  @HttpCode(200)
  async select(@Req() r: AdminRequest, @Body() body: unknown) {
    const v = z
      .object({
        authorizationId: z.string().cuid(),
        wabaId: waId,
        phoneNumberId: waId,
        pin: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
      })
      .parse(body);
    try {
      return {
        data: await this.service.select(
          r.adminOwnerId!,
          r.adminSessionId!,
          v.authorizationId,
          v.wabaId,
          v.phoneNumberId,
          v.pin,
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @Get('channels/whatsapp/embedded/:id/phones')
  async phones(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Query('wabaId') wabaId: string,
    @Query('after') after?: string,
  ) {
    try {
      return {
        data: await this.service.selectionPhones(
          r.adminOwnerId!,
          r.adminSessionId!,
          z.string().cuid().parse(id),
          waId.parse(wabaId),
          z.string().max(4096).optional().parse(after),
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @Get('channels/:id/templates') async templates(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    try {
      return {
        data: await this.service.templates(
          await this.service.owned(
            z.string().cuid().parse(id),
            r.adminOwnerId!,
          ),
          z.string().max(4096).optional().parse(after),
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @Post('conversations/:id/send-template') @HttpCode(200) async template(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    try {
      return {
        data: await this.service.sendTemplate(
          r.adminOwnerId!,
          z.string().cuid().parse(id),
          templateInputSchema.parse(body),
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('conversations/:id/whatsapp/media')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20_000_000, files: 1, fields: 3, fieldSize: 8192 },
    }),
  )
  async sendMedia(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @UploadedFile() file?: WhatsAppUpload,
  ) {
    try {
      return {
        data: await this.service.sendMedia(
          r.adminOwnerId!,
          z.string().cuid().parse(id),
          whatsappMediaInputSchema.parse(body),
          file,
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @Post('conversations/:id/whatsapp/read') @HttpCode(202) async read(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = z
      .object({ messageIds: z.array(z.string().cuid()).min(1).max(200) })
      .parse(body);
    try {
      return {
        data: await this.service.enqueueRead(
          r.adminOwnerId!,
          z.string().cuid().parse(id),
          v.messageIds,
        ),
      };
    } catch (e) {
      whatsappApiError(e);
    }
  }
  @Get('channels/whatsapp/messages/:id/media') async media(
    @Req() r: AdminRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    try {
      const file = await this.service.media(
        r.adminOwnerId!,
        z.string().cuid().parse(id),
      );
      sendPrivateMedia(res, file, r.headers.range);
    } catch (e) {
      whatsappApiError(e);
    }
  }
}
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(readonly webhook: WhatsAppWebhook) {}
  @Get() verify(@Query() q: Record<string, unknown>, @Res() res: Response) {
    res.type('text/plain').send(this.webhook.verify(q));
  }
  @Post() @HttpCode(200) async receive(
    @Req() r: RawBodyRequest<AdminRequest>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    await this.webhook.receive(r.rawBody, signature);
    return { received: true };
  }
}
