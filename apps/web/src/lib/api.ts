import { z } from 'zod';
import { errorSchema } from '@zalo/shared';
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
// Only a public API origin belongs in Vite env. Credentials always use HttpOnly cookies.
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '/api').replace(
  /\/$/,
  '',
);
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error(
      'Chưa kết nối được với máy chủ. Vui lòng kiểm tra kết nối và thử lại.',
    );
  }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(value);
    if (response.status === 401)
      window.dispatchEvent(new Event('session-expired'));
    throw new ApiClientError(
      parsed.success
        ? parsed.data.error.code === 'INVALID_CREDENTIALS'
          ? 'Mật khẩu chưa đúng. Vui lòng thử lại.'
          : parsed.data.error.message
        : 'Máy chủ chưa thể xử lý yêu cầu. Vui lòng thử lại.',
      response.status,
      parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
    );
  }
  const envelope = z.object({ data: z.unknown() }).safeParse(value);
  const parsed = schema.safeParse(
    envelope.success ? envelope.data.data : undefined,
  );
  if (!parsed.success)
    throw new Error('Dữ liệu phản hồi chưa hợp lệ. Vui lòng tải lại trang.');
  return parsed.data;
}
