import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Client } from 'pg';
import { Subject } from 'rxjs';
import { z } from 'zod';
import { realtimeEventSchema } from '@zalo/shared';
import { ConfigService } from '../../config/config.service';
import { REALTIME_CHANNEL } from './publish';
const notificationSchema = z.object({
  ownerId: z.string(),
  event: realtimeEventSchema,
});
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  readonly events = new Subject<z.infer<typeof notificationSchema>>();
  private client?: Client;
  private retry?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private readonly logger = new Logger(RealtimeService.name);
  constructor(private readonly config: ConfigService) {}
  async onModuleInit() {
    await this.connect();
  }
  private async connect() {
    if (this.stopping) return;
    const client = new Client({
      connectionString: this.config.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    this.client = client;
    const reconnect = () => {
      if (this.client !== client || this.stopping || this.retry) return;
      this.logger.warn(
        'Realtime database connection interrupted; reconnecting.',
      );
      void client.end().catch(() => undefined);
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.connect();
      }, 3000);
    };
    client.on('error', reconnect);
    client.on('end', reconnect);
    client.on('notification', (notification) => {
      try {
        const result = notificationSchema.safeParse(
          JSON.parse(notification.payload ?? ''),
        );
        if (result.success) this.events.next(result.data);
      } catch {
        /* Ignore untrusted notification data. */
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      this.events.next({ ownerId: 'administrator', event: { type: 'ready' } });
    } catch {
      reconnect();
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end().catch(() => undefined);
    this.events.complete();
  }
}
