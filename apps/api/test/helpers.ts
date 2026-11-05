import type { ConfigService } from '../src/config/config.service';
import { CryptoService } from '../src/common/crypto.service';
export const config = {
  env: {
    NODE_ENV: 'test',
    ZALO_PERSONAL_ENABLED: true,
    ZALO_PERSONAL_SEND_MAX_ATTEMPTS: 3,
    ZALO_PERSONAL_SEND_INTERVAL_MS: 1500,
    PORT: 3000,
    DATABASE_URL:
      'postgresql://postgres:postgres@localhost:5432/zalo_inbox_test',
    FRONTEND_URL: 'http://localhost:5173',
    ZALO_APP_ID: '360846524940903967',
    ZALO_APP_SECRET: 'test-app-secret',
    ZALO_OA_SECRET_KEY: 'test-oa-secret',
    FACEBOOK_APP_ID: '',
    FACEBOOK_APP_SECRET: '',
    FACEBOOK_GRAPH_API_VERSION: 'v26.0',
    FACEBOOK_VERIFY_TOKEN: '',
    FACEBOOK_OAUTH_REDIRECT_URI:
      'http://localhost:3000/api/channels/facebook-page/oauth/callback',
    FACEBOOK_PERSONAL_ENABLED: false,
    ZALO_REDIRECT_URI: 'http://localhost:3000/api/zalo/callback',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 'test-session-secret-'.repeat(3),
    ADMIN_PASSWORD: 'test-administrator-password',
  },
  facebookConfigured: false,
  facebookWebhookConfigured: false,
  zaloConfigured: true,
  webhookConfigured: true,
} as ConfigService;
export const crypto = new CryptoService(config);
