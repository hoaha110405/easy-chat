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
        !env.FACEBOOK_OAUTH_REDIRECT_URI.startsWith('https://')))
  )
    throw new Error(
      'Production frontend and configured channel callback URLs must use HTTPS',
    );
  return env;
}
