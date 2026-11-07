import axios, { type AxiosRequestConfig } from 'axios';
import { z } from 'zod';
export interface TikTokTransport {
  request(
    config: AxiosRequestConfig,
  ): Promise<{ data: unknown; status: number }>;
}
export class TikTokError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous = false,
    readonly retryable = false,
    readonly providerCode: number | null = null,
  ) {
    super(code);
    this.name = 'TikTokError';
  }
}
export class TikTokHttp {
  constructor(private readonly transport: TikTokTransport = axios) {}
  async request<T extends z.ZodTypeAny>(
    config: AxiosRequestConfig,
    schema: T,
    effect: 'read' | 'send' | 'token' | 'subscription' = 'read',
  ): Promise<z.output<T>> {
    let response: { data: unknown; status: number };
    try {
      response = await this.transport.request({
        ...config,
        timeout: 8000,
        signal: AbortSignal.timeout(8000),
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 128 * 1024,
        proxy: false,
        validateStatus: () => true,
      });
    } catch {
      throw new TikTokError(
        effect === 'send'
          ? 'TIKTOK_SEND_UNKNOWN'
          : effect === 'token'
            ? 'TIKTOK_TOKEN_REFRESH_UNKNOWN'
            : 'TIKTOK_UNAVAILABLE',
        effect === 'send' || effect === 'token',
        effect === 'read',
      );
    }
    const envelope = z
      .object({
        code: z.number().int(),
        data: z.unknown().optional(),
        message: z.string().optional(),
      })
      .safeParse(response.data);
    if (envelope.success && envelope.data.code !== 0) {
      const code = envelope.data.code;
      const message = envelope.data.message ?? '';
      const token =
        [40105, 105001, 105002, 105006, 36009013].includes(code) ||
        /access.?token.{0,30}(expired|invalid)|token.{0,15}expired/i.test(
          message,
        );
      const permission =
        [40001, 105005, 105007].includes(code) || response.status === 403;
      const rate =
        [40100, 36009002, 45101004].includes(code) || response.status === 429;
      const policy = [40064, 45109001].includes(code);
      // A timeout/system-error response to a send is not proof that no message was sent.
      const uncertain =
        effect === 'send' &&
        ([51065, 45101001, 36009003, 36009007].includes(code) ||
          (response.status >= 500 &&
            !token &&
            !permission &&
            !rate &&
            !policy));
      throw new TikTokError(
        uncertain
          ? 'TIKTOK_SEND_UNKNOWN'
          : token
            ? 'TIKTOK_TOKEN_EXPIRED'
            : permission
              ? 'TIKTOK_PERMISSION_DENIED'
              : rate
                ? 'TIKTOK_RATE_LIMITED'
                : policy
                  ? 'TIKTOK_REPLY_NOT_ALLOWED'
                  : 'TIKTOK_REQUEST_REJECTED',
        uncertain,
        (!uncertain && rate) ||
          (effect === 'read' &&
            [51065, 45101001, 36009003, 36009007].includes(code)),
        code,
      );
    }
    if (response.status < 200 || response.status >= 300 || !envelope.success) {
      const uncertain = effect === 'send' || effect === 'token';
      throw new TikTokError(
        uncertain
          ? effect === 'token'
            ? 'TIKTOK_TOKEN_REFRESH_UNKNOWN'
            : 'TIKTOK_SEND_UNKNOWN'
          : response.status === 401
            ? 'TIKTOK_TOKEN_EXPIRED'
            : response.status === 403
              ? 'TIKTOK_PERMISSION_DENIED'
              : 'TIKTOK_UNAVAILABLE',
        uncertain,
        !uncertain && (response.status >= 500 || response.status === 429),
      );
    }
    const result = schema.safeParse(envelope.data.data);
    if (!result.success)
      throw new TikTokError(
        effect === 'send'
          ? 'TIKTOK_SEND_UNKNOWN'
          : effect === 'token'
            ? 'TIKTOK_TOKEN_REFRESH_UNKNOWN'
            : 'TIKTOK_INVALID_RESPONSE',
        effect === 'send' || effect === 'token',
      );
    return result.data;
  }
}
export function requiredId(value: string) {
  if (
    !value ||
    value.length > 512 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new TikTokError('TIKTOK_INVALID_REQUEST');
  return value;
}
export function nextCursor(
  hasMore: boolean,
  cursor: string | number | undefined,
  previous?: string | null,
) {
  if (!hasMore) return null;
  const next = cursor === undefined ? '' : String(cursor);
  if (!next || next === previous || next.length > 4096)
    throw new TikTokError('TIKTOK_CURSOR_INVALID');
  return next;
}
export function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return;
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      !u.hostname.includes('.') ||
      u.hostname.endsWith('.local') ||
      u.hostname.endsWith('.localhost') ||
      u.hostname === 'localhost' ||
      u.hostname.includes(':') ||
      /^\d+(\.\d+){3}$/.test(u.hostname)
    )
      return;
    if (
      [...u.searchParams.keys()].some((k) =>
        /^(access_token|client_secret|app_secret|appsecret_proof)$/i.test(k),
      )
    )
      return;
    return u.href;
  } catch {
    return;
  }
}
