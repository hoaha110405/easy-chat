import { createHmac } from 'node:crypto';
import axios, { type AxiosRequestConfig } from 'axios';
import { z } from 'zod';
import type {
  FacebookAttachment,
  FacebookConversation,
  FacebookCursorInput,
  FacebookCursorPage,
  FacebookGraphConfig,
  FacebookMessage,
  FacebookPageProfile,
  FacebookPageSummary,
  FacebookPermission,
  FacebookSendResult,
  FacebookToken,
  FacebookTokenInspection,
  FacebookUserProfile,
} from './facebook-graph.types';

export type * from './facebook-graph.types';

/** No SDK/request/response objects cross the adapter boundary. */
export interface FacebookGraphTransport {
  request(config: AxiosRequestConfig): Promise<{
    data: unknown;
    status: number;
    headers?: unknown;
  }>;
}

export type FacebookGraphErrorCode =
  | 'FACEBOOK_NOT_CONFIGURED'
  | 'FACEBOOK_INVALID_REQUEST'
  | 'FACEBOOK_REAUTH_REQUIRED'
  | 'FACEBOOK_PERMISSION_DENIED'
  | 'FACEBOOK_RATE_LIMITED'
  | 'FACEBOOK_REQUEST_REJECTED'
  | 'FACEBOOK_INVALID_RESPONSE'
  | 'FACEBOOK_UNAVAILABLE';

export class FacebookGraphError extends Error {
  readonly ambiguous: boolean;
  readonly definiteFailure: boolean;
  readonly retryable: boolean;
  readonly reauthRequired: boolean;
  readonly status: number;
  readonly providerCode: number | null;
  readonly providerSubcode: number | null;

  constructor(
    readonly code: FacebookGraphErrorCode,
    message: string,
    options: {
      ambiguous?: boolean;
      retryable?: boolean;
      status?: number;
      providerCode?: number;
      providerSubcode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'FacebookGraphError';
    this.ambiguous = options.ambiguous ?? false;
    this.definiteFailure = !this.ambiguous;
    this.retryable = !this.ambiguous && (options.retryable ?? false);
    this.reauthRequired = code === 'FACEBOOK_REAUTH_REQUIRED';
    this.status = options.status ?? 502;
    this.providerCode = options.providerCode ?? null;
    this.providerSubcode = options.providerSubcode ?? null;
  }
}

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const MAX_PAGE_SIZE = 100;
const id = z.string().min(1).max(512);
const timestamp = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)));
const participant = z.object({ id, name: z.string().max(1000).optional() });
const picture = z
  .object({
    data: z.object({ url: z.string().max(8192).optional() }).optional(),
  })
  .optional();
const pageProfile = z.object({
  id,
  name: z.string().min(1).max(1000),
  picture,
});
const pageSummary = pageProfile.extend({
  access_token: z.string().min(1).max(16384),
  tasks: z.array(z.string().max(100)).max(100).default([]),
});
const paging = z
  .object({
    cursors: z
      .object({ after: z.string().min(1).max(4096).optional() })
      .optional(),
    // Only the presence of next is inspected. Its URL is never requested or returned.
    next: z.string().max(32768).optional(),
  })
  .optional();
const tokenResponse = z.object({
  access_token: z.string().min(1).max(16384),
  expires_in: z.number().nonnegative().optional(),
  token_type: z.string().max(100).optional(),
});
const graphFailure = z.object({
  error: z.object({
    code: z.number().int(),
    error_subcode: z.number().int().optional(),
    is_transient: z.boolean().optional(),
  }),
});
const conversation = z.object({
  id,
  updated_time: timestamp,
  participants: z.object({ data: z.array(participant).max(100) }),
  message_count: z.number().int().nonnegative().optional(),
  snippet: z.string().max(20000).optional(),
});
const media = z
  .object({
    url: z.string().max(8192).optional(),
    preview_url: z.string().max(8192).optional(),
  })
  .optional();
const attachment = z.object({
  id: id.optional(),
  name: z.string().max(1000).optional(),
  mime_type: z.string().max(200).optional(),
  file_url: z.string().max(8192).optional(),
  image_data: media,
  video_data: media,
  // Webhook-shaped attachments are accepted for normalization as well.
  type: z.string().max(100).optional(),
  payload: media,
});
const message = z.object({
  id,
  created_time: timestamp,
  from: participant,
  to: z.object({ data: z.array(participant).max(100) }).optional(),
  message: z.string().max(100000).optional(),
  attachments: z.object({ data: z.array(attachment).max(100) }).optional(),
});

function invalidRequest(): never {
  throw new FacebookGraphError(
    'FACEBOOK_INVALID_REQUEST',
    'Invalid Facebook request parameters.',
    { status: 400 },
  );
}

/** HTTP(S) media URLs are data, never fetch targets. Reject credentials/local IPs. */
export function facebookMediaUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      !host.includes('.') ||
      host.includes(':') ||
      /^\d+(?:\.\d+){3}$/.test(host)
    )
      return null;
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(?:access_token|appsecret_proof|client_secret)$/i.test(key),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeAttachment(
  value: z.infer<typeof attachment>,
): FacebookAttachment {
  const mime = value.mime_type ?? '';
  const type =
    value.type ??
    (value.image_data || mime.startsWith('image/')
      ? 'image'
      : value.video_data || mime.startsWith('video/')
        ? 'video'
        : mime.startsWith('audio/')
          ? 'audio'
          : 'file');
  return {
    type,
    url: facebookMediaUrl(
      value.image_data?.url ??
        value.video_data?.url ??
        value.file_url ??
        value.payload?.url,
    ),
    previewUrl: facebookMediaUrl(
      value.video_data?.preview_url ??
        value.image_data?.preview_url ??
        value.payload?.preview_url,
    ),
    name: value.name ?? null,
  };
}

/** All calls are bounded, explicitly versioned, and made to one fixed origin. */
export class FacebookGraphClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly config: FacebookGraphConfig,
    private readonly transport: FacebookGraphTransport = axios,
  ) {
    if (!/^v[1-9]\d*\.\d+$/.test(config.graphVersion)) invalidRequest();
    this.timeoutMs = config.timeoutMs ?? 10000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 30000
    )
      invalidRequest();
  }

  private configured() {
    if (!/^\d{1,64}$/.test(this.config.appId) || !this.config.appSecret) {
      throw new FacebookGraphError(
        'FACEBOOK_NOT_CONFIGURED',
        'Configure the Facebook application before connecting a Page.',
        { status: 503 },
      );
    }
  }

  private numericId(value: string) {
    if (!/^\d{1,64}$/.test(value)) invalidRequest();
    return value;
  }

  private nodeId(value: string) {
    if (!/^[A-Za-z0-9_.:=$-]{1,512}$/.test(value)) invalidRequest();
    return encodeURIComponent(value);
  }

  private cursor(input: FacebookCursorInput) {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      invalidRequest();
    if (
      input.after !== undefined &&
      input.after !== null &&
      (!input.after ||
        input.after.length > 4096 ||
        [...input.after].some(
          (v) => v.charCodeAt(0) < 32 || v.charCodeAt(0) === 127,
        ))
    )
      invalidRequest();
    return { limit, ...(input.after ? { after: input.after } : {}) };
  }

  private nextCursor(
    value: { paging?: z.infer<typeof paging> },
    previous?: string | null,
  ) {
    const after = value.paging?.cursors?.after;
    if (!value.paging?.next) return null;
    if (!after || after === previous)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Facebook pagination did not advance. The saved checkpoint can be retried.',
      );
    return after;
  }

  private refusal(
    error: z.infer<typeof graphFailure>['error'],
    status: number,
  ) {
    const number = error.code;
    const reauth = number === 190 || number === 102;
    const rateLimit =
      status === 429 || [4, 17, 32, 613, 80004].includes(number);
    const permission = [10, 200, 299].includes(number);
    const code = reauth
      ? 'FACEBOOK_REAUTH_REQUIRED'
      : rateLimit
        ? 'FACEBOOK_RATE_LIMITED'
        : permission
          ? 'FACEBOOK_PERMISSION_DENIED'
          : 'FACEBOOK_REQUEST_REJECTED';
    const text = reauth
      ? 'Facebook authorization expired or was revoked. Reconnect the Page.'
      : rateLimit
        ? 'Facebook request limit reached. Try again later.'
        : permission
          ? 'Facebook did not grant the permission required for this operation.'
          : 'Facebook rejected this operation. Check the Page permissions and messaging policy.';
    return new FacebookGraphError(code, text, {
      status: reauth ? 409 : rateLimit ? 429 : permission ? 403 : 422,
      retryable:
        !reauth &&
        !permission &&
        (rateLimit || error.is_transient === true || [1, 2].includes(number)),
      providerCode: number,
      providerSubcode: error.error_subcode,
    });
  }

  private async request<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: T,
    options: {
      token?: string;
      params?: Record<string, string | number>;
      data?: unknown;
      send?: boolean;
    } = {},
  ): Promise<z.output<T>> {
    this.configured();
    if (
      options.token &&
      (options.token.length > 16384 || /[\r\n]/.test(options.token))
    )
      invalidRequest();
    const params = { ...options.params };
    if (options.token)
      params.appsecret_proof = createHmac('sha256', this.config.appSecret)
        .update(options.token)
        .digest('hex');
    let result: { data: unknown; status: number };
    try {
      result = await this.transport.request({
        method,
        url: `${GRAPH_ORIGIN}/${this.config.graphVersion}/${path}`,
        headers: {
          Accept: 'application/json',
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
        },
        params,
        ...(options.data !== undefined ? { data: options.data } : {}),
        timeout: options.data instanceof FormData ? 30000 : this.timeoutMs,
        signal: AbortSignal.timeout(
          options.data instanceof FormData ? 30000 : this.timeoutMs,
        ),
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength:
          options.data instanceof FormData ? 20_000_000 + 65536 : 128 * 1024,
        proxy: false,
        validateStatus: () => true,
      });
    } catch (error) {
      // A response with a structured Graph rejection is definite. All other
      // send transport failures may follow provider acceptance, including timeout.
      if (axios.isAxiosError(error) && error.response) {
        const rejected = graphFailure.safeParse(error.response.data);
        if (rejected.success)
          throw this.refusal(rejected.data.error, error.response.status);
      }
      throw new FacebookGraphError(
        'FACEBOOK_UNAVAILABLE',
        options.send
          ? 'Facebook send acknowledgement was lost. Check the conversation before sending again.'
          : 'Facebook is temporarily unavailable.',
        { ambiguous: options.send, retryable: !options.send },
      );
    }
    const rejected = graphFailure.safeParse(result.data);
    if (rejected.success)
      throw this.refusal(rejected.data.error, result.status);
    if (result.status < 200 || result.status >= 300) {
      throw new FacebookGraphError(
        'FACEBOOK_UNAVAILABLE',
        options.send
          ? 'Facebook did not confirm delivery. Check the conversation before sending again.'
          : 'Facebook is temporarily unavailable.',
        {
          ambiguous: options.send,
          retryable:
            !options.send && (result.status === 429 || result.status >= 500),
        },
      );
    }
    const parsed = schema.safeParse(result.data);
    if (!parsed.success)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Facebook returned an unexpected response.',
        { ambiguous: options.send },
      );
    return parsed.data;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<FacebookToken> {
    if (!code || code.length > 8192 || redirectUri.length > 4096)
      invalidRequest();
    const result = await this.request(
      'GET',
      'oauth/access_token',
      tokenResponse,
      {
        params: {
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          redirect_uri: redirectUri,
          code,
        },
      },
    );
    return {
      accessToken: result.access_token,
      expiresIn: result.expires_in ?? null,
      tokenType: result.token_type ?? null,
    };
  }

  async exchangeLongLivedToken(userToken: string): Promise<FacebookToken> {
    if (!userToken || userToken.length > 16384) invalidRequest();
    const result = await this.request(
      'GET',
      'oauth/access_token',
      tokenResponse,
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: this.config.appId,
          client_secret: this.config.appSecret,
          fb_exchange_token: userToken,
        },
      },
    );
    return {
      accessToken: result.access_token,
      expiresIn: result.expires_in ?? null,
      tokenType: result.token_type ?? null,
    };
  }

  async grantedPermissions(userToken: string): Promise<FacebookPermission[]> {
    const result = await this.request(
      'GET',
      'me/permissions',
      z.object({
        data: z
          .array(
            z.object({
              permission: z.string().max(100),
              status: z.string().max(100),
            }),
          )
          .max(1000),
      }),
      { token: userToken, params: { limit: 1000 } },
    );
    return result.data;
  }

  async inspectToken(token: string): Promise<FacebookTokenInspection> {
    if (!token || token.length > 16384) invalidRequest();
    const result = await this.request(
      'GET',
      'debug_token',
      z.object({
        data: z.object({
          app_id: id,
          is_valid: z.boolean(),
          type: z.string().max(100).optional(),
          user_id: id.optional(),
          profile_id: id.optional(),
          expires_at: z.number().nonnegative().optional(),
          data_access_expires_at: z.number().nonnegative().optional(),
          scopes: z.array(z.string().max(100)).max(1000).default([]),
          granular_scopes: z
            .array(
              z.object({
                scope: z.string().max(100),
                target_ids: z.array(id).max(10000).optional(),
              }),
            )
            .max(1000)
            .default([]),
        }),
      }),
      {
        token: `${this.config.appId}|${this.config.appSecret}`,
        params: { input_token: token },
      },
    );
    const value = result.data;
    return {
      appId: value.app_id,
      valid: value.is_valid,
      type: value.type ?? null,
      userId: value.user_id ?? null,
      profileId: value.profile_id ?? null,
      expiresAt: value.expires_at ?? null,
      dataAccessExpiresAt: value.data_access_expires_at ?? null,
      scopes: value.scopes,
      granularScopes: value.granular_scopes.map((v) => ({
        scope: v.scope,
        targetIds: v.target_ids ?? [],
      })),
    };
  }

  async listPages(
    userToken: string,
    input: FacebookCursorInput = {},
  ): Promise<FacebookCursorPage<FacebookPageSummary>> {
    const result = await this.request(
      'GET',
      'me/accounts',
      z.object({ data: z.array(pageSummary).max(MAX_PAGE_SIZE), paging }),
      {
        token: userToken,
        params: {
          ...this.cursor(input),
          fields: 'id,name,access_token,tasks,picture{url}',
        },
      },
    );
    return {
      items: result.data.map((value) => ({
        id: value.id,
        name: value.name,
        accessToken: value.access_token,
        tasks: value.tasks,
        avatarUrl: facebookMediaUrl(value.picture?.data?.url),
      })),
      after: this.nextCursor(result, input.after),
    };
  }

  async getPage(
    pageId: string,
    pageToken: string,
  ): Promise<FacebookPageProfile> {
    const result = await this.request(
      'GET',
      this.numericId(pageId),
      pageProfile,
      { token: pageToken, params: { fields: 'id,name,picture{url}' } },
    );
    if (result.id !== pageId)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Facebook returned a different Page.',
      );
    return {
      id: result.id,
      name: result.name,
      avatarUrl: facebookMediaUrl(result.picture?.data?.url),
    };
  }

  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.request(
      'POST',
      `${this.numericId(pageId)}/subscribed_apps`,
      z.object({ success: z.literal(true) }),
      {
        token: pageToken,
        data: {
          subscribed_fields: [
            'messages',
            'messaging_postbacks',
            'message_echoes',
            'message_deliveries',
            'message_reads',
          ],
        },
      },
    );
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.request(
      'DELETE',
      `${this.numericId(pageId)}/subscribed_apps`,
      z.object({ success: z.literal(true) }),
      { token: pageToken },
    );
  }

  async listConversations(
    pageId: string,
    pageToken: string,
    input: FacebookCursorInput = {},
  ): Promise<FacebookCursorPage<FacebookConversation>> {
    const result = await this.request(
      'GET',
      `${this.numericId(pageId)}/conversations`,
      z.object({ data: z.array(conversation).max(MAX_PAGE_SIZE), paging }),
      {
        token: pageToken,
        params: {
          ...this.cursor(input),
          platform: 'messenger',
          fields: 'id,updated_time,participants,message_count,snippet',
        },
      },
    );
    return {
      items: result.data.map((value) => ({
        id: value.id,
        updatedAt: value.updated_time,
        participants: value.participants.data,
        ...(value.message_count !== undefined
          ? { messageCount: value.message_count }
          : {}),
        ...(value.snippet !== undefined ? { snippet: value.snippet } : {}),
      })),
      after: this.nextCursor(result, input.after),
    };
  }

  async listMessages(
    conversationId: string,
    pageToken: string,
    input: FacebookCursorInput = {},
  ): Promise<FacebookCursorPage<FacebookMessage>> {
    const result = await this.request(
      'GET',
      `${this.nodeId(conversationId)}/messages`,
      z.object({ data: z.array(message).max(MAX_PAGE_SIZE), paging }),
      {
        token: pageToken,
        params: {
          ...this.cursor(input),
          fields: 'id,created_time,from,to,message,attachments',
        },
      },
    );
    return {
      items: result.data.map((value) => ({
        id: value.id,
        createdAt: value.created_time,
        from: value.from,
        to: value.to?.data ?? [],
        text: value.message ?? '',
        attachments: value.attachments?.data.map(normalizeAttachment) ?? [],
      })),
      after: this.nextCursor(result, input.after),
    };
  }

  async getUserProfile(
    psid: string,
    pageToken: string,
  ): Promise<FacebookUserProfile> {
    const result = await this.request(
      'GET',
      this.numericId(psid),
      z.object({
        id,
        first_name: z.string().max(1000).optional(),
        last_name: z.string().max(1000).optional(),
        name: z.string().max(2000).optional(),
        profile_pic: z.string().max(8192).optional(),
      }),
      {
        token: pageToken,
        params: { fields: 'id,first_name,last_name,profile_pic' },
      },
    );
    if (result.id !== psid)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Facebook returned a different participant.',
      );
    return {
      id: result.id,
      name:
        result.name ??
        ([result.first_name, result.last_name].filter(Boolean).join(' ') ||
          null),
      avatarUrl: facebookMediaUrl(result.profile_pic),
    };
  }

  uploadMedia(
    pageId: string,
    token: string,
    file: { bytes: Buffer; mime: string; name: string },
    kind: 'document' | 'audio',
  ) {
    const data = new FormData();
    data.set(
      'message',
      JSON.stringify({
        attachment: {
          type: kind === 'document' ? 'file' : 'audio',
          payload: { is_reusable: true },
        },
      }),
    );
    data.set(
      'filedata',
      new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
      file.name,
    );
    return this.request(
      'POST',
      `${this.numericId(pageId)}/message_attachments`,
      z.object({ attachment_id: id }),
      { token, data },
    );
  }
  async sendAttachment(
    pageId: string,
    token: string,
    psid: string,
    attachmentId: string,
    kind: 'document' | 'audio',
  ) {
    this.numericId(psid);
    this.nodeId(attachmentId);
    const r = await this.request(
      'POST',
      `${this.numericId(pageId)}/messages`,
      z.object({ message_id: id, recipient_id: id }),
      {
        token,
        send: true,
        data: {
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: {
            attachment: {
              type: kind === 'document' ? 'file' : 'audio',
              payload: { attachment_id: attachmentId },
            },
          },
        },
      },
    );
    if (r.recipient_id !== psid)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Unexpected recipient',
        { ambiguous: true },
      );
    return { messageId: r.message_id, recipientId: r.recipient_id };
  }
  /** Caller must enforce a verified customer-initiated 24h window before enqueue AND send. */
  async sendText(
    pageId: string,
    pageToken: string,
    psid: string,
    text: string,
  ): Promise<FacebookSendResult> {
    this.numericId(psid);
    if (!text.trim() || text.length > 2000) invalidRequest();
    const result = await this.request(
      'POST',
      `${this.numericId(pageId)}/messages`,
      z.object({ message_id: id, recipient_id: id }),
      {
        token: pageToken,
        data: {
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: { text },
        },
        send: true,
      },
    );
    if (result.recipient_id !== psid)
      throw new FacebookGraphError(
        'FACEBOOK_INVALID_RESPONSE',
        'Facebook returned an unexpected message recipient.',
        { ambiguous: true },
      );
    return { messageId: result.message_id, recipientId: result.recipient_id };
  }
}
