import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import {
  telegramJson,
  TelegramError,
  tdError,
} from '../telegram/telegram.types';
export type TdObject = Record<string, unknown> & { '@type': string };
export interface TdClient {
  on(event: 'update', listener: (event: TdObject) => void): this;
  on(event: 'closed', listener: () => void): this;
  request(
    value: Record<string, unknown>,
    effect?: 'read' | 'send' | 'auth',
    timeout?: number,
  ): Promise<TdObject>;
  close(): Promise<void>;
}
export class TdJsonClient extends EventEmitter implements TdClient {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private pending = new Map<
    string,
    {
      resolve: (value: TdObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      effect: 'read' | 'send' | 'auth';
    }
  >();
  private closing = false;
  start(bridge: string, library: string) {
    const child = spawn(bridge, [library], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME },
      shell: false,
    });
    this.process = child;
    child.stderr.on('data', () => undefined); // Native diagnostics must never enter application logs.
    child.stdout.on('data', (chunk: Buffer) =>
      this.receive(this.decoder.write(chunk)),
    );
    child.stdin.on('error', () => this.failed());
    child.stdout.on('error', () => this.failed());
    child.on('error', () => this.failed());
    child.on('close', () => this.failed());
    return this;
  }
  private receive(text: string) {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
      void this.close();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let value: TdObject;
      try {
        value = telegramJson.parse(line) as TdObject;
        if (!value || typeof value['@type'] !== 'string') throw Error();
      } catch {
        void this.close();
        return;
      }
      const key = typeof value['@extra'] === 'string' ? value['@extra'] : '';
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        if (value['@type'] === 'error')
          pending.reject(
            tdError(
              { code: value.code, message: value.message },
              pending.effect,
            ),
          );
        else pending.resolve(value);
      } else if (value['@type'].startsWith('update'))
        this.emit('update', value);
    }
  }
  request(
    value: Record<string, unknown>,
    effect: 'read' | 'send' | 'auth' = 'read',
    timeout = 12000,
  ): Promise<TdObject> {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable || this.closing)
      return Promise.reject(new TelegramError('TELEGRAM_NATIVE_UNAVAILABLE'));
    const id = randomUUID();
    const line = telegramJson.stringify({ ...value, '@extra': id }) + '\n';
    if (Buffer.byteLength(line) > 128 * 1024 || this.pending.size >= 64)
      return Promise.reject(new TelegramError('TELEGRAM_NATIVE_BUSY'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new TelegramError(
            effect === 'send' ? 'TELEGRAM_SEND_UNKNOWN' : 'TELEGRAM_TIMEOUT',
            effect === 'send',
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, effect });
      child.stdin.write(line, (error) => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new TelegramError(
              effect === 'send'
                ? 'TELEGRAM_SEND_UNKNOWN'
                : 'TELEGRAM_NATIVE_UNAVAILABLE',
              effect === 'send',
            ),
          );
        }
      });
    });
  }
  private failed() {
    if (!this.process) return;
    this.process = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new TelegramError(
          pending.effect === 'send'
            ? 'TELEGRAM_SEND_UNKNOWN'
            : 'TELEGRAM_NATIVE_UNAVAILABLE',
          pending.effect === 'send',
        ),
      );
    }
    this.pending.clear();
    this.emit('closed');
  }
  async close() {
    const child = this.process;
    if (!child) return;
    if (!this.closing) {
      try {
        await this.request({ '@type': 'close' }, 'read', 2000);
      } catch {
        /* bounded graceful close */
      }
    }
    this.closing = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.failed();
  }
}
