import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import type { AdminRequest } from '../auth/auth.service';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeService } from './realtime.service';
@Controller('events')
@UseGuards(AdminGuard)
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly db: PrismaService,
  ) {}
  @Get()
  events(@Req() req: AdminRequest, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const write = (data: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    write({ type: 'ready' });
    const subscription = this.realtime.events.subscribe({
      next: (notification) => {
        if (notification.ownerId === req.adminOwnerId)
          write(notification.event);
      },
      complete: () => res.end(),
    });
    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.db.adminSession
        .findUnique({
          where: { id: req.adminSessionId! },
          select: { expiresAt: true },
        })
        .then((session) => {
          if (!session || session.expiresAt < new Date()) res.end();
          else if (!res.writableEnded) res.write(': heartbeat\n\n');
        })
        .catch(() => res.end())
        .finally(() => {
          checking = false;
        });
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    });
  }
}
