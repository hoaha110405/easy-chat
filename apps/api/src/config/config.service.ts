import { Injectable } from '@nestjs/common';
import { parseEnvironment, type Environment } from './env';
@Injectable()
export class ConfigService {
  readonly env: Environment = parseEnvironment(process.env);
  get zaloConfigured() {
    return Boolean(this.env.ZALO_APP_ID && this.env.ZALO_APP_SECRET);
  }
  get webhookConfigured() {
    return Boolean(this.env.ZALO_APP_ID && this.env.ZALO_OA_SECRET_KEY);
  }
  get facebookConfigured() {
    return Boolean(this.env.FACEBOOK_APP_ID && this.env.FACEBOOK_APP_SECRET);
  }
  get facebookWebhookConfigured() {
    return Boolean(this.facebookConfigured && this.env.FACEBOOK_VERIFY_TOKEN);
  }
}
