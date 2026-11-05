import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosRequestConfig } from 'axios';
import JSONbig from 'json-bigint';
import { z } from 'zod';
import { ApiError } from '../../common/api-error';
const parser = JSONbig({
  storeAsString: true,
  protoAction: 'error',
  constructorAction: 'error',
});
export class ZaloError extends ApiError {
  constructor(
    readonly zaloCode: number | string,
    status = 502,
  ) {
    const permission =
      zaloCode === -223 ||
      zaloCode === -221 ||
      zaloCode === -224 ||
      zaloCode === -212;
    super(
      status,
      permission ? 'ZALO_PERMISSION_DENIED' : 'ZALO_API_ERROR',
      permission
        ? 'Zalo requires additional application permissions or OA eligibility. Check your Zalo Developer settings.'
        : `Zalo rejected the request (code ${String(zaloCode)
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 32)}).`,
    );
  }
}
@Injectable()
export class ZaloHttpService {
  private readonly logger = new Logger(ZaloHttpService.name);
  async request<T>(
    config: AxiosRequestConfig,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let value: unknown;
    try {
      const response = await axios.request({
        ...config,
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        transformResponse: [(raw: string) => parser.parse(raw)],
      });
      value = response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const body: unknown = error.response?.data;
        if (
          body &&
          typeof body === 'object' &&
          'error' in body &&
          (typeof body.error === 'number' || typeof body.error === 'string')
        )
          throw new ZaloError(
            body.error,
            error.response?.status === 429 ? 429 : 502,
          );
        const status = error.response?.status;
        this.logger.warn(
          `Zalo HTTP request failed (${status ?? 'network/timeout'}).`,
        );
        throw new ApiError(
          status === 429 ? 429 : 502,
          'ZALO_UNAVAILABLE',
          'Zalo is temporarily unavailable. Please try again later.',
        );
      }
      throw new ApiError(
        502,
        'ZALO_INVALID_RESPONSE',
        'Zalo returned an unreadable response.',
      );
    }
    if (
      value &&
      typeof value === 'object' &&
      'error' in value &&
      value.error !== 0 &&
      value.error !== undefined
    ) {
      if (typeof value.error === 'number' || typeof value.error === 'string')
        throw new ZaloError(value.error, value.error === -32 ? 429 : 502);
      throw new ApiError(
        502,
        'ZALO_INVALID_RESPONSE',
        'Zalo returned an invalid error response.',
      );
    }
    const result = schema.safeParse(value);
    if (!result.success)
      throw new ApiError(
        502,
        'ZALO_INVALID_RESPONSE',
        'Zalo returned an unexpected response format.',
      );
    return result.data;
  }
}
