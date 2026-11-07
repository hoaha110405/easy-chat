import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  ZALO_PERSONAL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ZALO_PERSONAL_SEND_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3),
  ZALO_PERSONAL_SEND_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(1500),
  ZALO_APP_ID: z.string().default(''),
  ZALO_APP_SECRET: z.string().default(''),
  ZALO_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:3000/api/zalo/callback'),
  ZALO_OA_SECRET_KEY: z.string().default(''),
  FACEBOOK_APP_ID: z.string().default(''),
  FACEBOOK_APP_SECRET: z.string().default(''),
  FACEBOOK_GRAPH_API_VERSION: z
    .string()
    .regex(/^v[1-9]\d*\.\d+$/)
    .default('v26.0'),
  FACEBOOK_VERIFY_TOKEN: z.string().default(''),
  FACEBOOK_OAUTH_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:3000/api/channels/facebook-page/oauth/callback'),
  FACEBOOK_PERSONAL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  TIKTOK_BUSINESS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TIKTOK_BUSINESS_APP_ID: z.string().default(''),
  TIKTOK_BUSINESS_APP_SECRET: z.string().default(''),
  TIKTOK_BUSINESS_AUTHORIZATION_URL: z.string().default(''),
  TIKTOK_BUSINESS_REDIRECT_URI: z
    .string()
    .url()
    .default(
      'http://localhost:3000/api/channels/tiktok-business/oauth/callback',
    ),
  TIKTOK_SHOP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TIKTOK_SHOP_APP_KEY: z.string().default(''),
  TIKTOK_SHOP_APP_SECRET: z.string().default(''),
  TIKTOK_SHOP_AUTHORIZATION_URL: z.string().default(''),
  TIKTOK_SHOP_REDIRECT_URI: z
    .string()
    .url()
    .default('http://localhost:3000/api/channels/tiktok-shop/oauth/callback'),
  WHATSAPP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WHATSAPP_GRAPH_API_VERSION: z.enum(['v26.0', 'v27.0']).default('v27.0'),
  WHATSAPP_META_APP_ID: z.string().default(''),
  WHATSAPP_META_APP_SECRET: z.string().default(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_WEBHOOK_CALLBACK_URL: z.string().default(''),
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: z.string().default(''),
  TELEGRAM_PERSONAL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TELEGRAM_API_ID: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(2147483647)
    .default(0),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_BOT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TELEGRAM_BOT_WEBHOOK_BASE_URL: z.string().default(''),
  TELEGRAM_TDLIB_BRIDGE_PATH: z
    .string()
    .default('../../native/telegram/build/tdjson-bridge'),
  TELEGRAM_TDJSON_LIBRARY: z
    .string()
    .default('../../.local/tdlib/lib/libtdjson.so'),
  TELEGRAM_DATA_DIR: z.string().default('../../.local/telegram'),
  TELEGRAM_RPC_SOCKET: z.string().default('../../.local/telegram/worker.sock'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, 'Use a 32-byte hex encryption key'),
  ADMIN_PASSWORD: z.string().min(12).max(256),
  SESSION_SECRET: z.string().min(32),
});
export type Environment = z.infer<typeof schema>;
export function parseEnvironment(value: NodeJS.ProcessEnv): Environment {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const env = result.data;
  if (
    env.NODE_ENV === 'production' &&
    (!env.FRONTEND_URL.startsWith('https://') ||
      (Boolean(env.ZALO_APP_ID && env.ZALO_APP_SECRET) &&
        !env.ZALO_REDIRECT_URI.startsWith('https://')) ||
      (Boolean(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) &&
        !env.FACEBOOK_OAUTH_REDIRECT_URI.startsWith('https://')) ||
      (Boolean(env.TIKTOK_BUSINESS_APP_ID && env.TIKTOK_BUSINESS_APP_SECRET) &&
        !env.TIKTOK_BUSINESS_REDIRECT_URI.startsWith('https://')) ||
      (Boolean(env.TIKTOK_SHOP_APP_KEY && env.TIKTOK_SHOP_APP_SECRET) &&
        !env.TIKTOK_SHOP_REDIRECT_URI.startsWith('https://')))
  )
    throw new Error(
      'Production frontend and configured channel callback URLs must use HTTPS',
    );
  return env;
}
