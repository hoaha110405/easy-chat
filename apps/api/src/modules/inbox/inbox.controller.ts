import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Post,
  Req,
  Body,
  HttpCode,
} from '@nestjs/common';
import { z } from 'zod';
import {
  paginationSchema,
  conversationFilterSchema,
  sendTextSchema,
} from '@zalo/shared';
import { AdminGuard } from '../auth/admin.guard';
import { PersonalService } from '../zalo-personal/personal.service';
import type { AdminRequest } from '../auth/auth.service';
import { InboxService } from './inbox.service';
@Controller('conversations')
@UseGuards(AdminGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly personal: PersonalService,
  ) {}
  @Get() async conversations(
    @Query() query: unknown,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.inbox.conversations(
        conversationFilterSchema.parse(query),
        req.adminOwnerId!,
      ),
    };
  }
  @Get('accounts') async accounts(@Req() req: AdminRequest) {
    return { data: await this.inbox.accounts(req.adminOwnerId!) };
  }
  @Get(':id') async conversation(
    @Param('id') id: string,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.inbox.conversation(
        z.string().cuid().parse(id),
        req.adminOwnerId!,
      ),
    };
  }
  @Post(':id/messages') @HttpCode(202) async send(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.personal.send(
        z.string().cuid().parse(id),
        req.adminOwnerId!,
        sendTextSchema.parse(body),
      ),
    };
  }
  @Post(':id/messages/:messageId/retry') @HttpCode(202) async retry(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.personal.retry(
        z.string().cuid().parse(id),
        z.string().cuid().parse(messageId),
        req.adminOwnerId!,
      ),
    };
  }
  @Get(':id/messages') async messages(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() req: AdminRequest,
  ) {
    return {
      data: await this.inbox.messages(
        z.string().cuid().parse(id),
        paginationSchema.parse(query),
        req.adminOwnerId!,
      ),
    };
  }
}
