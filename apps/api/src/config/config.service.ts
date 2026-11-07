import { Injectable } from '@nestjs/common';
import { parseEnvironment, type Environment } from './env';
@Injectable()
export class ConfigService {
  readonly env: Environment = parseEnvironment(process.env);
  get whatsappConfigured() {
    return Boolean(
      this.env.WHATSAPP_ENABLED &&
      this.env.WHATSAPP_META_APP_ID &&
      this.env.WHATSAPP_META_APP_SECRET &&
      this.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN &&
      this.env.WHATSAPP_WEBHOOK_CALLBACK_URL,
    );
  }
  get telegramConfigured() {
    return Boolean(
      (this.env.TELEGRAM_PERSONAL_ENABLED &&
        this.env.TELEGRAM_API_ID &&
        this.env.TELEGRAM_API_HASH) ||
      (this.env.TELEGRAM_BOT_ENABLED && this.env.TELEGRAM_BOT_WEBHOOK_BASE_URL),
    );
  }
  get tiktokConfigured() {
    return Boolean(
      (this.env.TIKTOK_BUSINESS_ENABLED &&
        this.env.TIKTOK_BUSINESS_APP_ID &&
        this.env.TIKTOK_BUSINESS_APP_SECRET &&
        this.env.TIKTOK_BUSINESS_AUTHORIZATION_URL) ||
      (this.env.TIKTOK_SHOP_ENABLED &&
        this.env.TIKTOK_SHOP_APP_KEY &&
        this.env.TIKTOK_SHOP_APP_SECRET &&
        this.env.TIKTOK_SHOP_AUTHORIZATION_URL),
    );
  }
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
