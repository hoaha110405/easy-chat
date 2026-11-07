import { createHmac, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import axios, { type AxiosRequestConfig } from 'axios';
import { z } from 'zod';
import { ConfigService } from '../../config/config.service';
import {
  waFailure,
  waId,
  waJson,
  waMid,
  waRecipient,
  waTemplateSchema,
  WhatsAppError,
} from './whatsapp.types';
export interface WhatsAppTransport {
  request(config: AxiosRequestConfig): Promise<{
    status: number;
    data: unknown;
    headers?: Record<string, unknown>;
  }>;
}
const success = z.object({
  success: z.union([z.literal(true), z.literal('true')]),
});
const phone = z.object({
  id: waId,
  display_phone_number: z.string(),
  verified_name: z.string(),
  platform_type: z.string(),
  status: z.string(),
  code_verification_status: z.string().optional(),
  is_on_biz_app: z.boolean().optional(),
});
const fields =
  'id,display_phone_number,verified_name,platform_type,status,code_verification_status,is_on_biz_app';
@Injectable()
export class WhatsAppClient {
  constructor(
    readonly config: ConfigService,
    private readonly http: WhatsAppTransport = axios,
  ) {}
  async call<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    schema: T,
    params: Record<string, unknown> = {},
    data?: unknown,
    effect: 'read' | 'write' | 'send' = 'read',
  ): Promise<z.output<T>> {
    if (
      !/^(?:\d{1,30}(?:\/[a-z_]+)?|debug_token|oauth\/access_token)$/.test(path)
    )
      throw new WhatsAppError('WHATSAPP_INVALID_REQUEST');
    const e = this.config.env;
    if (!e.WHATSAPP_META_APP_ID || !e.WHATSAPP_META_APP_SECRET)
      throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED');
    let response: Awaited<ReturnType<WhatsAppTransport['request']>>;
    try {
      response = await this.http.request({
        method,
        url: `https://graph.facebook.com/${e.WHATSAPP_GRAPH_API_VERSION}/${path}`,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(data instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' }),
          'X-Request-ID': randomUUID(),
        },
        params: {
          ...params,
          ...(path === 'oauth/access_token'
            ? {}
            : {
                appsecret_proof: createHmac(
                  'sha256',
                  e.WHATSAPP_META_APP_SECRET,
                )
                  .update(token)
                  .digest('hex'),
              }),
        },
        data,
        timeout: data instanceof FormData ? 30000 : 8000,
        signal: AbortSignal.timeout(data instanceof FormData ? 30000 : 8000),
        maxBodyLength: 20_000_000 + 65536,
        maxRedirects: 0,
        proxy: false,
        maxContentLength: 2 * 1024 * 1024,
        responseType: 'text',
        transformResponse: [
          (v: unknown) => (typeof v === 'string' ? waJson.parse(v) : v),
        ],
        validateStatus: () => true,
      });
    } catch {
      throw new WhatsAppError(
        effect === 'send' ? 'WHATSAPP_SEND_UNKNOWN' : 'WHATSAPP_UNAVAILABLE',
        effect === 'send',
        null,
        effect === 'read',
      );
    }
    const failure = z
      .object({
        error: z.object({
          code: z.number(),
          fbtrace_id: z.string().max(200).optional(),
        }),
      })
      .safeParse(response.data);
    if (failure.success)
      throw waFailure(
        failure.data.error.code,
        response.status,
        effect,
        Number(response.headers?.['retry-after']) || 30,
        failure.data.error.fbtrace_id ?? null,
      );
    if (response.status < 200 || response.status >= 300)
      throw effect === 'send'
        ? new WhatsAppError('WHATSAPP_SEND_UNKNOWN', true)
        : waFailure(0, response.status, effect);
    const parsed = schema.safeParse(response.data);
    if (!parsed.success)
      throw new WhatsAppError(
        effect === 'send'
          ? 'WHATSAPP_SEND_UNKNOWN'
          : 'WHATSAPP_INVALID_RESPONSE',
        effect === 'send',
      );
    return parsed.data;
  }
  inspect(token: string) {
    const e = this.config.env;
    return this.call(
      'GET',
      'debug_token',
      `${e.WHATSAPP_META_APP_ID}|${e.WHATSAPP_META_APP_SECRET}`,
      z.object({
        data: z.object({
          app_id: waId,
          is_valid: z.boolean(),
          type: z.string().optional(),
          expires_at: z.number().optional(),
          data_access_expires_at: z.number().optional(),
          scopes: z.array(z.string()).default([]),
          granular_scopes: z
            .array(
              z.object({
                scope: z.string(),
                target_ids: z.array(waId).optional(),
              }),
            )
            .optional(),
        }),
      }),
      { input_token: token },
    );
  }
  exchange(code: string) {
    const e = this.config.env;
    return this.call(
      'GET',
      'oauth/access_token',
      `${e.WHATSAPP_META_APP_ID}|${e.WHATSAPP_META_APP_SECRET}`,
      z.object({
        access_token: z.string().min(10).max(16384),
        expires_in: z.number().positive().optional(),
      }),
      {
        client_id: e.WHATSAPP_META_APP_ID,
        client_secret: e.WHATSAPP_META_APP_SECRET,
        code,
      },
    );
  }
  business(token: string, id: string) {
    return this.call(
      'GET',
      waId.parse(id),
      token,
      z.object({ id: waId, name: z.string() }),
      { fields: 'id,name' },
    );
  }
  phones(token: string, wabaId: string, after?: string) {
    return this.call(
      'GET',
      `${waId.parse(wabaId)}/phone_numbers`,
      token,
      z.object({
        data: z.array(phone).max(100),
        paging: z
          .object({
            cursors: z
              .object({ after: z.string().max(4096).optional() })
              .optional(),
            next: z.string().optional(),
          })
          .optional(),
      }),
      { fields, limit: 100, ...(after ? { after } : {}) },
    );
  }
  phone(token: string, id: string) {
    return this.call('GET', waId.parse(id), token, phone, { fields });
  }
  appSubscriptions() {
    const e = this.config.env;
    return this.call(
      'GET',
      `${waId.parse(e.WHATSAPP_META_APP_ID)}/subscriptions`,
      `${e.WHATSAPP_META_APP_ID}|${e.WHATSAPP_META_APP_SECRET}`,
      z.object({
        data: z.array(
          z.object({
            object: z.string(),
            callback_url: z.string(),
            active: z.boolean().optional(),
            fields: z
              .array(z.union([z.string(), z.object({ name: z.string() })]))
              .optional(),
          }),
        ),
      }),
    );
  }
  subscribe(token: string, wabaId: string) {
    return this.call(
      'POST',
      `${waId.parse(wabaId)}/subscribed_apps`,
      token,
      success,
      {},
      {},
      'write',
    );
  }
  subscriptions(token: string, wabaId: string) {
    return this.call(
      'GET',
      `${waId.parse(wabaId)}/subscribed_apps`,
      token,
      z.object({
        data: z.array(
          z.object({
            whatsapp_business_api_data: z.object({
              id: waId,
              name: z.string().optional(),
            }),
          }),
        ),
      }),
    );
  }
  unsubscribe(token: string, wabaId: string) {
    return this.call(
      'DELETE',
      `${waId.parse(wabaId)}/subscribed_apps`,
      token,
      success,
      {},
      {},
      'write',
    );
  }
  register(token: string, id: string, pin: string) {
    return this.call(
      'POST',
      `${waId.parse(id)}/register`,
      token,
      success,
      {},
      {
        messaging_product: 'whatsapp',
        pin: z
          .string()
          .regex(/^\d{6}$/)
          .parse(pin),
      },
      'write',
    );
  }
  templates(token: string, wabaId: string, after?: string, name?: string) {
    return this.call(
      'GET',
      `${waId.parse(wabaId)}/message_templates`,
      token,
      z.object({
        data: z.array(waTemplateSchema).max(100),
        paging: z
          .object({
            cursors: z
              .object({ after: z.string().max(4096).optional() })
              .optional(),
            next: z.string().optional(),
          })
          .optional(),
      }),
      {
        fields: 'id,name,language,category,status,components,parameter_format',
        limit: 100,
        ...(after ? { after } : {}),
        ...(name ? { name } : {}),
      },
    );
  }
  async send(
    token: string,
    phoneId: string,
    wabaId: string,
    to: string,
    payload: Record<string, unknown>,
    correlation: string,
  ) {
    const r = await this.call(
      'POST',
      `${waId.parse(phoneId)}/messages`,
      token,
      z.object({
        messaging_product: z.literal('whatsapp'),
        contacts: z
          .array(z.object({ input: z.string(), wa_id: waRecipient }))
          .optional(),
        messages: z
          .array(z.object({ id: waMid, message_status: z.string().optional() }))
          .length(1),
      }),
      {},
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waRecipient.parse(to),
        ...payload,
        biz_opaque_callback_data: z
          .string()
          .max(100)
          .refine((v) => {
            const [id, attempt, extra] = v.split('.');
            return (
              z.string().cuid().safeParse(id).success &&
              !extra &&
              (attempt === undefined ||
                z.string().uuid().safeParse(attempt).success)
            );
          })
          .parse(correlation),
        ...(this.config.env.WHATSAPP_GRAPH_API_VERSION === 'v27.0'
          ? { messaging_account_id: waId.parse(wabaId) }
          : {}),
      },
      'send',
    );
    if (r.contacts?.some((c) => c.wa_id !== to))
      throw new WhatsAppError('WHATSAPP_SEND_UNKNOWN', true);
    return r.messages[0];
  }
  upload(
    token: string,
    phoneId: string,
    bytes: Buffer,
    mime: string,
    name: string,
  ) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mime);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
    return this.call(
      'POST',
      `${waId.parse(phoneId)}/media`,
      token,
      z.object({ id: waId }),
      {},
      form,
      'write',
    );
  }
  markRead(token: string, phoneId: string, messageId: string) {
    return this.call(
      'POST',
      `${waId.parse(phoneId)}/messages`,
      token,
      success,
      {},
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMid.parse(messageId),
      },
      'read',
    );
  }
  media(token: string, id: string, phoneId: string) {
    return this.call(
      'GET',
      waId.parse(id),
      token,
      z.object({
        url: z.string().url(),
        mime_type: z.string(),
        sha256: z.string(),
        file_size: z.coerce.number().int().nonnegative(),
        id: waId,
      }),
      { phone_number_id: waId.parse(phoneId) },
    );
  }
  async download(token: string, url: string, maxBytes: number) {
    const u = new URL(url);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'lookaside.fbsbx.com' ||
      u.username ||
      u.password ||
      u.port
    )
      throw new WhatsAppError('WHATSAPP_MEDIA_UNAVAILABLE');
    try {
      const r = await this.http.request({
        method: 'GET',
        url: u.href,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
        signal: AbortSignal.timeout(15000),
        maxRedirects: 0,
        proxy: false,
        maxContentLength: maxBytes,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
      if (
        r.status !== 200 ||
        !Buffer.isBuffer(r.data) ||
        r.data.length > maxBytes
      )
        throw Error();
      return r.data;
    } catch {
      throw new WhatsAppError('WHATSAPP_MEDIA_UNAVAILABLE');
    }
  }
}
