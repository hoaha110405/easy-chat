import { Injectable } from '@nestjs/common';
import { createServer, createConnection, type Server } from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigService } from '../../config/config.service';
import { constantEquals } from '../../common/crypto.service';
import { TelegramSettings } from './telegram.config';
import { TelegramError } from './telegram.types';
export const rpcRequestSchema = z.object({
  nonce: z.string().uuid(),
  at: z.number().int(),
  ownerId: z.string().min(1).max(200),
  sessionId: z.string().max(200),
  accountId: z.string().cuid().optional(),
  action: z.enum([
    'health',
    'start',
    'status',
    'auth',
    'disconnect',
    'download',
  ]),
  authAction: z
    .enum(['phone', 'code', 'password', 'email', 'email_code', 'qr'])
    .optional(),
  value: z.string().max(1024).optional(),
});
export type TelegramRpcRequest = z.infer<typeof rpcRequestSchema>;
function signature(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
@Injectable()
export class TelegramRpcClient {
  constructor(
    private readonly settings: TelegramSettings,
    private readonly config: ConfigService,
  ) {}
  request(input: Omit<TelegramRpcRequest, 'nonce' | 'at'>): Promise<unknown> {
    const body = JSON.stringify({
      ...input,
      nonce: randomUUID(),
      at: Date.now(),
    });
    const wire =
      JSON.stringify({
        body,
        signature: signature(body, this.config.env.SESSION_SECRET),
      }) + '\n';
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.settings.paths().socket });
      socket.setEncoding('utf8');
      let data = '';
      let done = false;
      const fail = () => {
        if (done) return;
        done = true;
        socket.destroy();
        reject(new TelegramError('TELEGRAM_WORKER_UNAVAILABLE'));
      };
      socket.setTimeout(14000, fail);
      socket.on('error', fail);
      socket.on('end', () => {
        if (!done) fail();
      });
      socket.on('connect', () => socket.write(wire));
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.length > 65536) return fail();
        const newline = data.indexOf('\n');
        if (newline < 0) return;
        try {
          const result = z
            .object({
              data: z.unknown().optional(),
              error: z
                .object({
                  code: z.string().regex(/^TELEGRAM_[A-Z_]+$/),
                  retryAfter: z.number().nullable().optional(),
                })
                .optional(),
            })
            .parse(JSON.parse(data.slice(0, newline)));
          done = true;
          socket.end();
          if (result.error)
            reject(
              new TelegramError(
                result.error.code,
                false,
                result.error.retryAfter ?? null,
              ),
            );
          else resolve(result.data);
        } catch {
          fail();
        }
      });
    });
  }
}
@Injectable()
export class TelegramRpcServer {
  private server?: Server;
  private seen = new Map<string, number>();
  constructor(
    private readonly settings: TelegramSettings,
    private readonly config: ConfigService,
  ) {}
  async start(handler: (request: TelegramRpcRequest) => Promise<unknown>) {
    if (this.server) return;
    const path = this.settings.paths().socket;
    if (path.length > 100)
      throw new TelegramError('TELEGRAM_SOCKET_PATH_TOO_LONG');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    try {
      const existing = await lstat(path);
      if (!existing.isSocket())
        throw new TelegramError('TELEGRAM_SOCKET_PATH_INVALID');
      await unlink(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let text = '';
      let accepted = false;
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        if (accepted) return;
        text += chunk.toString('utf8');
        if (text.length > 32768) {
          socket.destroy();
          return;
        }
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        accepted = true;
        void (async () => {
          try {
            const envelope = z
              .object({ body: z.string(), signature: z.string().length(64) })
              .parse(JSON.parse(text.slice(0, newline)));
            if (
              !constantEquals(
                envelope.signature,
                signature(envelope.body, this.config.env.SESSION_SECRET),
              )
            )
              throw new TelegramError('TELEGRAM_RPC_REJECTED');
            const request = rpcRequestSchema.parse(JSON.parse(envelope.body));
            const now = Date.now();
            for (const [key, expiry] of this.seen)
              if (expiry < now) this.seen.delete(key);
            if (
              Math.abs(now - request.at) > 30000 ||
              this.seen.has(request.nonce) ||
              this.seen.size >= 1024
            )
              throw new TelegramError('TELEGRAM_RPC_REJECTED');
            this.seen.set(request.nonce, now + 30000);
            const data = await handler(request);
            socket.end(JSON.stringify({ data }) + '\n');
          } catch (error) {
            socket.end(
              JSON.stringify({
                error: {
                  code:
                    error instanceof TelegramError
                      ? error.code
                      : 'TELEGRAM_OPERATION_FAILED',
                  retryAfter:
                    error instanceof TelegramError ? error.retryAfter : null,
                },
              }) + '\n',
            );
          }
        })();
      });
    });
    server.maxConnections = 16;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  }
  async close() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.settings.paths().socket).catch(() => undefined);
    this.seen.clear();
  }
}
