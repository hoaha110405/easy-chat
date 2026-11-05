import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { Response } from 'express';
import { RealtimeController } from '../src/modules/realtime/realtime.controller';
import type { RealtimeService } from '../src/modules/realtime/realtime.service';
import type { AdminRequest } from '../src/modules/auth/auth.service';
import type { PrismaService } from '../src/database/prisma.service';
describe('SSE lifecycle', () => {
  it('filters owner events and closes active responses when the API shuts down', () => {
    const events = new Subject<{
      ownerId: string;
      event: { type: 'message.created'; messageId: string };
    }>();
    let close: (() => void) | undefined;
    const response = {
      writableEnded: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      on: vi.fn((_event: string, callback: () => void) => {
        close = callback;
      }),
      end: vi.fn(() => close?.()),
    };
    const controller = new RealtimeController(
      { events } as unknown as RealtimeService,
      {} as PrismaService,
    );
    controller.events(
      {
        adminOwnerId: 'administrator',
        adminSessionId: 'session',
      } as AdminRequest,
      response as unknown as Response,
    );
    events.next({
      ownerId: 'foreign',
      event: { type: 'message.created', messageId: 'hidden' },
    });
    events.next({
      ownerId: 'administrator',
      event: { type: 'message.created', messageId: 'visible' },
    });
    expect(response.write).toHaveBeenCalledTimes(2);
    expect(response.write.mock.calls[1][0]).toContain('visible');
    events.complete();
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
