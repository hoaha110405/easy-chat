import { Injectable } from '@nestjs/common';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '../../config/config.service';
import { TelegramError } from './telegram.types';
export const TDLIB_REVISION = '4c6377aa7386c39217878a9a56d581922ad37ca4';
@Injectable()
export class TelegramSettings {
  constructor(readonly config: ConfigService) {}
  get botEnabled() {
    return this.config.env.TELEGRAM_BOT_ENABLED ?? false;
  }
  get personalEnabled() {
    return this.config.env.TELEGRAM_PERSONAL_ENABLED ?? false;
  }
  get personalConfigured() {
    return Boolean(
      this.personalEnabled &&
      this.config.env.TELEGRAM_API_ID &&
      this.config.env.TELEGRAM_API_HASH,
    );
  }
  get botConfigured() {
    try {
      this.webhookBase();
      return this.botEnabled;
    } catch {
      return false;
    }
  }
  paths() {
    const e = this.config.env;
    return {
      bridge: resolve(
        e.TELEGRAM_TDLIB_BRIDGE_PATH ||
          '../../native/telegram/build/tdjson-bridge',
      ),
      library: resolve(
        e.TELEGRAM_TDJSON_LIBRARY || '../../.local/tdlib/lib/libtdjson.so',
      ),
      data: resolve(e.TELEGRAM_DATA_DIR || '../../.local/telegram'),
      socket: resolve(
        e.TELEGRAM_RPC_SOCKET || '../../.local/telegram/worker.sock',
      ),
    };
  }
  async nativeAvailable() {
    try {
      const { bridge, library } = this.paths();
      if (!(await stat(bridge)).isFile() || !(await stat(library)).isFile())
        return false;
      await access(bridge, constants.X_OK);
      await access(library, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  webhookBase() {
    let url: URL;
    try {
      url = new URL(this.config.env.TELEGRAM_BOT_WEBHOOK_BASE_URL);
    } catch {
      throw new TelegramError('TELEGRAM_PUBLIC_HTTPS_REQUIRED');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && !['443', '80', '88', '8443'].includes(url.port)) ||
      url.hostname === 'localhost'
    )
      throw new TelegramError('TELEGRAM_PUBLIC_HTTPS_REQUIRED');
    return url;
  }
  webhookUrl(id: string) {
    const url = this.webhookBase();
    url.pathname = `/api/channels/telegram-bot/${id}/webhook`;
    return url.href;
  }
}
