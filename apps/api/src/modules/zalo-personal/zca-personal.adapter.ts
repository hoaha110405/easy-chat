import {
  Zalo,
  LoginQRCallbackEventType,
  ThreadType,
  type API,
  type Credentials,
} from 'zca-js';
import { z } from 'zod';
import {
  PersonalAdapterError,
  type PersonalAdapter,
  type PersonalLogin,
  type PersonalProfile,
  type PersonalSticker,
  type QrEvent,
} from './personal-adapter';
import { personalExternalId } from './personal-normalize';
import { mediaUrl } from './personal-media';
const credentialsSchema = z.object({
  imei: z.string().min(1),
  userAgent: z.string().min(1),
  cookie: z
    .array(
      z
        .object({
          key: z.string().optional(),
          name: z.string().optional(),
          value: z.string(),
          domain: z.string().optional(),
          path: z.string().optional(),
          expires: z.union([z.string(), z.literal('Infinity')]).optional(),
        })
        .passthrough(),
    )
    .min(1),
});
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(500).optional().catch(undefined),
  avatar: z
    .string()
    .url()
    .max(4096)
    .refine((value) => /^https?:\/\//.test(value))
    .optional()
    .catch(undefined),
});
export class ZcaPersonalAdapter implements PersonalAdapter {
  private api?: API;
  private abortQr?: () => unknown;
  private readonly stop = new AbortController();
  private state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' = 'DISCONNECTED';
  private readonly zalo: Zalo;
  private loginName?: string;
  private loginAvatar?: string;
  private recentMessages?: Promise<unknown[]>;
  private readonly stickerCache = new Map<number, PersonalSticker>();
  async getStickerAssets(stickerIds: number[]): Promise<PersonalSticker[]> {
    if (!this.api || this.state !== 'CONNECTED' || this.stop.signal.aborted)
      throw new PersonalAdapterError('ZALO_NOT_CONNECTED');
    const ids = [
      ...new Set(
        z
          .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
          .max(20)
          .parse(stickerIds),
      ),
    ];
    const missing = ids.filter((id) => !this.stickerCache.has(id));
    if (missing.length) {
      try {
        const results = await this.api.getStickersDetail(missing);
        for (const result of results) {
          if (!missing.includes(result.id)) continue;
          const url = [result.stickerWebpUrl, result.stickerUrl, result.uri]
            .map((value) => mediaUrl.safeParse(value))
            .find((value) => value.success);
          if (url?.success) {
            if (this.stickerCache.size >= 128) this.stickerCache.clear();
            this.stickerCache.set(result.id, {
              stickerId: result.id,
              url: url.data,
            });
          }
        }
      } catch {
        throw new PersonalAdapterError('ZALO_STICKER_UNAVAILABLE');
      }
    }
    return ids.flatMap((id) =>
      this.stickerCache.has(id) ? [this.stickerCache.get(id)!] : [],
    );
  }
  getRecentMessages(): Promise<unknown[]> {
    const api = this.api;
    if (!api || this.state !== 'CONNECTED' || this.stop.signal.aborted)
      return Promise.reject(new PersonalAdapterError('ZALO_NOT_CONNECTED'));
    if (this.recentMessages) return this.recentMessages;
    this.recentMessages = new Promise<unknown[]>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        api.listener.off('old_messages', received);
        this.stop.signal.removeEventListener('abort', cancelled);
      };
      const cancelled = () => {
        cleanup();
        reject(new PersonalAdapterError('ZALO_LOGIN_CANCELLED'));
      };
      const received = (messages: unknown[], type: ThreadType) => {
        if (type !== ThreadType.User) return;
        cleanup();
        resolve(messages.slice(0, 200));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PersonalAdapterError('ZALO_HISTORY_UNAVAILABLE'));
      }, 15000);
      api.listener.on('old_messages', received);
      this.stop.signal.addEventListener('abort', cancelled, { once: true });
      try {
        api.listener.requestOldMessages(ThreadType.User);
      } catch {
        cleanup();
        reject(new PersonalAdapterError('ZALO_HISTORY_UNAVAILABLE'));
      }
    }).finally(() => {
      this.recentMessages = undefined;
    });
    return this.recentMessages;
  }
  private async readProfiles(
    api: API,
    userIds: string[],
  ): Promise<PersonalProfile[]> {
    const ids = [
      ...new Set(z.array(personalExternalId).max(50).parse(userIds)),
    ];
    if (!ids.length) return [];
    const result = await api.getUserInfo(ids);
    return ids.flatMap((id) => {
      const parsed = profileSchema.safeParse(
        result.changed_profiles?.[id] ?? result.unchanged_profiles?.[id],
      );
      if (!parsed.success) return [];
      return [
        {
          externalUserId: id,
          name: parsed.data.displayName,
          avatarUrl: parsed.data.avatar,
        },
      ];
    });
  }
  async getUserProfiles(userIds: string[]) {
    if (!this.api || this.state !== 'CONNECTED' || this.stop.signal.aborted)
      throw new PersonalAdapterError('ZALO_NOT_CONNECTED');
    try {
      return await this.readProfiles(this.api, userIds);
    } catch {
      throw new PersonalAdapterError('ZALO_PROFILE_UNAVAILABLE');
    }
  }
  private async ownProfile(api: API) {
    try {
      const id = personalExternalId.parse(api.getOwnId());
      const [profile] = await this.readProfiles(api, [id]);
      return {
        name: profile?.name,
        avatarUrl: profile?.avatarUrl,
      };
    } catch {
      // Profile lookup is optional; it must never invalidate an otherwise valid login.
      return {};
    }
  }
  constructor() {
    const boundedFetch: typeof fetch = (input, options = {}) => {
      const waiting = String(input).includes('/qr/waiting-');
      const signals = [
        this.stop.signal,
        AbortSignal.timeout(waiting ? 110000 : 15000),
      ];
      if (options.signal) signals.push(options.signal);
      return fetch(input, { ...options, signal: AbortSignal.any(signals) });
    };
    this.zalo = new Zalo({
      selfListen: true,
      logging: false,
      checkUpdate: false,
      polyfill: boundedFetch,
    });
  }
  async connectWithQR(
    onEvent: (event: QrEvent) => void,
  ): Promise<PersonalLogin> {
    this.state = 'CONNECTING';
    let credentials: Credentials | undefined;
    let terminal = 'ZALO_LOGIN_FAILED';
    try {
      const api = await this.zalo.loginQR({}, (event) => {
        if (event.actions) this.abortQr = event.actions.abort;
        if (this.stop.signal.aborted) {
          event.actions?.abort();
          return;
        }
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            if (
              !/^[A-Za-z0-9+/=\r\n]+$/.test(event.data.image) ||
              event.data.image.length > 500000
            ) {
              terminal = 'ZALO_LOGIN_FAILED';
              event.actions.abort();
              break;
            }
            onEvent({
              type: 'generated',
              image: `data:image/png;base64,${event.data.image}`,
              expiresAt: new Date(Date.now() + 100000),
            });
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            this.loginName = event.data.display_name;
            this.loginAvatar = /^https?:\/\//.test(event.data.avatar)
              ? event.data.avatar
              : undefined;
            onEvent({ type: 'scanned', name: event.data.display_name });
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            terminal = 'ZALO_QR_EXPIRED';
            onEvent({ type: 'expired' });
            event.actions.abort();
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            terminal = 'ZALO_QR_DECLINED';
            onEvent({ type: 'declined' });
            event.actions.abort();
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            credentials = event.data;
            break;
        }
      });
      if (this.stop.signal.aborted) {
        api.listener.stop();
        throw new PersonalAdapterError('ZALO_LOGIN_CANCELLED');
      }
      if (!credentials) throw new PersonalAdapterError('ZALO_LOGIN_FAILED');
      this.api = api;
      const profile = await this.ownProfile(api);
      return {
        externalAccountId: personalExternalId.parse(api.getOwnId()),
        credentials: JSON.stringify(credentials),
        name: profile.name ?? this.loginName,
        avatarUrl: profile.avatarUrl ?? this.loginAvatar,
      };
    } catch {
      this.state = 'DISCONNECTED';
      throw new PersonalAdapterError(
        this.stop.signal.aborted ? 'ZALO_LOGIN_CANCELLED' : terminal,
      );
    }
  }
  async restoreSession(value: string): Promise<PersonalLogin> {
    this.state = 'CONNECTING';
    try {
      const credentials = credentialsSchema.parse(JSON.parse(value));
      const api = await this.zalo.login(credentials);
      if (this.stop.signal.aborted) {
        api.listener.stop();
        throw new Error('CANCELLED');
      }
      this.api = api;
      // Refresh cookies from the library's supported public context after restoration.
      const context = api.getContext();
      const cookies = api.getCookie().toJSON();
      if (!cookies) throw new Error('MISSING_COOKIES');
      const profile = await this.ownProfile(api);
      return {
        ...profile,
        externalAccountId: personalExternalId.parse(api.getOwnId()),
        credentials: JSON.stringify({
          imei: context.imei,
          userAgent: context.userAgent,
          cookie: cookies.cookies,
        }),
      };
    } catch {
      this.state = 'DISCONNECTED';
      throw new PersonalAdapterError('ZALO_SESSION_EXPIRED');
    }
  }
  async startListening(
    onMessage: (message: unknown) => void,
    onClosed: (code: string) => void,
  ) {
    const api = this.api;
    if (!api || this.stop.signal.aborted)
      throw new PersonalAdapterError('ZALO_NOT_CONNECTED', true);
    api.listener.on('message', onMessage);
    api.listener.on('closed', (code) => {
      if (!this.stop.signal.aborted) {
        this.state = 'DISCONNECTED';
        onClosed(
          code === 3000 || code === 3003
            ? 'ZALO_SESSION_EXPIRED'
            : 'ZALO_CONNECTION_LOST',
        );
      }
    });
    api.listener.on('error', () => {
      if (!this.stop.signal.aborted) {
        this.state = 'DISCONNECTED';
        api.listener.stop();
        onClosed('ZALO_CONNECTION_LOST');
      }
    });
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer);
        reject(new PersonalAdapterError('ZALO_LOGIN_CANCELLED'));
      };
      const timer = setTimeout(() => {
        this.stop.signal.removeEventListener('abort', cancelled);
        api.listener.stop();
        reject(new PersonalAdapterError('ZALO_CONNECTION_LOST'));
      }, 20000);
      api.listener.once('connected', () => {
        clearTimeout(timer);
        this.stop.signal.removeEventListener('abort', cancelled);
        this.state = 'CONNECTED';
        resolve();
      });
      api.listener.once('error', () => {
        clearTimeout(timer);
        this.stop.signal.removeEventListener('abort', cancelled);
        reject(new PersonalAdapterError('ZALO_CONNECTION_LOST'));
      });
      api.listener.once('closed', () => {
        clearTimeout(timer);
        this.stop.signal.removeEventListener('abort', cancelled);
        reject(new PersonalAdapterError('ZALO_CONNECTION_LOST'));
      });
      this.stop.signal.addEventListener('abort', cancelled, { once: true });
      api.listener.start({ retryOnClose: false });
    });
  }
  getConnectionStatus() {
    return this.state;
  }
  stopListening() {
    this.api?.listener.stop();
    this.api?.listener.removeAllListeners();
    this.state = 'DISCONNECTED';
  }
  disconnect() {
    this.stop.abort();
    this.abortQr?.();
    this.stopListening();
    this.api = undefined;
  }
  async sendMediaMessage(
    threadId: string,
    file: { bytes: Buffer; name: string; mime: string },
    kind: 'document' | 'audio',
  ) {
    if (!this.api || this.state !== 'CONNECTED' || this.stop.signal.aborted)
      throw new PersonalAdapterError('ZALO_NOT_CONNECTED', true);
    const to = personalExternalId.parse(threadId);
    const source = {
      data: file.bytes,
      filename: file.name as `${string}.${string}`,
      metadata: { totalSize: file.bytes.length },
    };
    if (kind === 'audio') {
      let uploaded: Awaited<ReturnType<API['uploadAttachment']>>;
      try {
        uploaded = await this.api.uploadAttachment(source, to, ThreadType.User);
      } catch {
        throw new PersonalAdapterError('ZALO_MEDIA_UPLOAD_FAILED', true);
      }
      const asset = uploaded.find((v) => v.fileType === 'others');
      if (!asset || asset.fileType !== 'others')
        throw new PersonalAdapterError('ZALO_MEDIA_UPLOAD_FAILED', true);
      const url = new URL(asset.fileUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        !/(?:^|\.)(?:zdn\.vn|zaloapp\.com|dlfl\.vn)$/.test(url.hostname)
      )
        throw new PersonalAdapterError('ZALO_MEDIA_UPLOAD_FAILED', true);
      try {
        const r = await this.api.sendVoice(
          { voiceUrl: url.href },
          to,
          ThreadType.User,
        );
        return { externalMessageId: personalExternalId.parse(r.msgId) };
      } catch {
        throw new PersonalAdapterError('ZALO_SEND_UNKNOWN');
      }
    }
    try {
      const r = await this.api.sendMessage(
        { msg: '', attachments: [source] },
        to,
        ThreadType.User,
      );
      if (r.message || r.attachment.length !== 1)
        throw Error('Unexpected message count');
      return {
        externalMessageId: personalExternalId.parse(r.attachment[0].msgId),
      };
    } catch {
      throw new PersonalAdapterError('ZALO_SEND_UNKNOWN');
    }
  }
  async sendTextMessage(threadId: string, content: string) {
    if (!this.api || this.state !== 'CONNECTED' || this.stop.signal.aborted)
      throw new PersonalAdapterError('ZALO_NOT_CONNECTED', true);
    try {
      const result: unknown = await this.api.sendMessage(
        { msg: content },
        personalExternalId.parse(threadId),
        ThreadType.User,
      );
      const parsed = z
        .object({ message: z.object({ msgId: personalExternalId }) })
        .parse(result);
      return { externalMessageId: parsed.message.msgId };
    } catch {
      throw new PersonalAdapterError('ZALO_SEND_UNKNOWN');
    }
  }
}
