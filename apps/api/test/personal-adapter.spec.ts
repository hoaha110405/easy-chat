import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Zalo, LoginQRCallbackEventType, ThreadType, type API } from 'zca-js';
import { ZcaPersonalAdapter } from '../src/modules/zalo-personal/zca-personal.adapter';
const creds = {
  imei: 'test-imei',
  userAgent: 'test-user-agent',
  cookie: [
    {
      key: 'zpw_test',
      value: 'test-secret-cookie',
      domain: 'zalo.me',
      path: '/',
    },
  ],
};
function apiFixture() {
  const events = new EventEmitter();
  const listener = Object.assign(events, {
    start: vi.fn(() => queueMicrotask(() => events.emit('connected'))),
    stop: vi.fn(),
    requestOldMessages: vi.fn(() =>
      queueMicrotask(() => events.emit('old_messages', [], ThreadType.User)),
    ),
  });
  const sendMessage = vi
    .fn()
    .mockResolvedValue({ message: { msgId: 123456789 }, attachment: [] });
  const getUserInfo = vi.fn().mockResolvedValue({
    changed_profiles: {
      '1234567890123456789': {
        displayName: 'Profile account',
        avatar: 'https://example.com/account.jpg',
      },
    },
  });
  const api = {
    listener,
    getOwnId: () => '1234567890123456789',
    getContext: () => creds,
    getCookie: () => ({ toJSON: () => ({ cookies: creds.cookie }) }),
    sendMessage,
    uploadAttachment: vi
      .fn()
      .mockResolvedValue([
        { fileType: 'others', fileUrl: 'https://files.dlfl.vn/fixture.m4a' },
      ]),
    sendVoice: vi.fn().mockResolvedValue({ msgId: '998877' }),
    getUserInfo,
    getStickersDetail: vi.fn().mockResolvedValue([]),
  };
  return { api: api as unknown as API, listener, sendMessage, getUserInfo };
}
afterEach(() => vi.restoreAllMocks());
describe('real zca-js adapter boundary', () => {
  it('uses loginQR callbacks without writing a QR file and returns restorable credentials privately', async () => {
    const { api } = apiFixture();
    const events: unknown[] = [];
    vi.spyOn(Zalo.prototype, 'loginQR').mockImplementation(
      async (_options, callback) => {
        callback?.({
          type: LoginQRCallbackEventType.QRCodeGenerated,
          data: {
            code: 'private-qr-code',
            token: 'private-token',
            image: 'aGVsbG8=',
            options: { enabledCheckOCR: false, enabledMultiLayer: false },
          },
          actions: {
            abort: () => undefined,
            retry: () => undefined,
            saveToFile: vi.fn(),
          },
        });
        callback?.({
          type: LoginQRCallbackEventType.QRCodeScanned,
          data: { display_name: 'Fixture', avatar: '' },
          actions: { abort: () => undefined, retry: () => undefined },
        });
        callback?.({
          type: LoginQRCallbackEventType.GotLoginInfo,
          data: creds,
          actions: null,
        });
        return api;
      },
    );
    const adapter = new ZcaPersonalAdapter();
    const result = await adapter.connectWithQR((event) => events.push(event));
    expect(events).toMatchObject([
      { type: 'generated', image: 'data:image/png;base64,aGVsbG8=' },
      { type: 'scanned', name: 'Fixture' },
    ]);
    expect(JSON.stringify(events)).not.toContain('private-token');
    expect(JSON.parse(result.credentials)).toEqual(creds);
    expect(result.externalAccountId).toBe('1234567890123456789');
    expect(result).toMatchObject({
      name: 'Profile account',
      avatarUrl: 'https://example.com/account.jpg',
    });
    adapter.disconnect();
  });
  it('restores through login(), starts self-listening, and sends explicitly to ThreadType.User', async () => {
    const { api, sendMessage, listener } = apiFixture();
    const login = vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    const restored = await adapter.restoreSession(JSON.stringify(creds));
    expect(restored).toMatchObject({
      name: 'Profile account',
      avatarUrl: 'https://example.com/account.jpg',
    });
    expect(login).toHaveBeenCalledWith(creds);
    await adapter.startListening(vi.fn(), vi.fn());
    expect(listener.start).toHaveBeenCalledWith({ retryOnClose: false });
    expect(await adapter.sendTextMessage('1234', 'Text')).toEqual({
      externalMessageId: '123456789',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      { msg: 'Text' },
      '1234',
      ThreadType.User,
    );
    adapter.disconnect();
    expect(listener.stop).toHaveBeenCalled();
  });
  it('never marks a send exception safe to automatically retry', async () => {
    const { api, sendMessage } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    sendMessage.mockRejectedValue(new Error('sensitive transport failure'));
    await expect(adapter.sendTextMessage('1234', 'Text')).rejects.toMatchObject(
      { code: 'ZALO_SEND_UNKNOWN', safeToRetry: false },
    );
    adapter.disconnect();
  });
  it('rejects sends before connecting and invalid stored sessions', async () => {
    const adapter = new ZcaPersonalAdapter();
    await expect(adapter.sendTextMessage('1234', 'Text')).rejects.toMatchObject(
      { code: 'ZALO_NOT_CONNECTED', safeToRetry: true },
    );
    await expect(
      adapter.restoreSession('{"imei":"incomplete"}'),
    ).rejects.toMatchObject({ code: 'ZALO_SESSION_EXPIRED' });
    adapter.disconnect();
  });
  it('keeps a valid session usable when the optional profile request fails', async () => {
    const { api, getUserInfo } = apiFixture();
    getUserInfo.mockRejectedValue(new Error('Profile unavailable'));
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    expect(await adapter.restoreSession(JSON.stringify(creds))).toMatchObject({
      externalAccountId: '1234567890123456789',
    });
    await adapter.startListening(vi.fn(), vi.fn());
    expect(adapter.getConnectionStatus()).toBe('CONNECTED');
    adapter.disconnect();
  });
  it('looks up contact profiles in batches and returns only requested public identity fields', async () => {
    const { api, getUserInfo } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    getUserInfo.mockResolvedValueOnce({
      changed_profiles: {
        '200000000000000001': {
          displayName: 'Contact A',
          avatar: 'https://example.com/contact.jpg',
          phoneNumber: 'private-phone',
          dob: 12345,
        },
        '200000000000000002': {
          displayName: 'Contact B',
          avatar: 'javascript:alert(1)',
        },
        '999': {
          displayName: 'Unrequested contact',
          avatar: 'https://example.com/foreign.jpg',
        },
      },
      unchanged_profiles: {},
    });
    const profiles = await adapter.getUserProfiles([
      '200000000000000001',
      '200000000000000002',
      '200000000000000001',
    ]);
    expect(getUserInfo).toHaveBeenLastCalledWith([
      '200000000000000001',
      '200000000000000002',
    ]);
    expect(profiles).toEqual([
      {
        externalUserId: '200000000000000001',
        name: 'Contact A',
        avatarUrl: 'https://example.com/contact.jpg',
      },
      {
        externalUserId: '200000000000000002',
        name: 'Contact B',
        avatarUrl: undefined,
      },
    ]);
    expect(JSON.stringify(profiles)).not.toMatch(
      /phoneNumber|private-phone|dob|Unrequested/,
    );
    adapter.disconnect();
  });
  it('bounds contact lookups and exposes a safe error while preserving the connected listener', async () => {
    const { api, getUserInfo } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await expect(adapter.getUserProfiles(['123'])).rejects.toMatchObject({
      code: 'ZALO_NOT_CONNECTED',
    });
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    getUserInfo.mockClear();
    await expect(
      adapter.getUserProfiles(Array.from({ length: 51 }, (_, i) => String(i))),
    ).rejects.toMatchObject({ code: 'ZALO_PROFILE_UNAVAILABLE' });
    expect(getUserInfo).not.toHaveBeenCalled();
    getUserInfo.mockRejectedValueOnce(new Error('private upstream details'));
    await expect(adapter.getUserProfiles(['123'])).rejects.toMatchObject({
      message: 'ZALO_PROFILE_UNAVAILABLE',
    });
    expect(adapter.getConnectionStatus()).toBe('CONNECTED');
    adapter.disconnect();
  });
  it('uses WebP sticker assets, caches requested IDs and does not use sprite sheets or unsafe URLs', async () => {
    const { api } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const getStickersDetail = vi
      .spyOn(api, 'getStickersDetail')
      .mockResolvedValue([
        {
          id: 123,
          stickerWebpUrl: 'https://example.com/animated.webp',
          stickerUrl: 'https://example.com/static.png',
        },
        {
          id: 456,
          stickerWebpUrl: null,
          stickerUrl: 'javascript:alert(1)',
          stickerSpriteUrl: 'https://example.com/sprite.png',
        },
        { id: 999, stickerWebpUrl: 'https://example.com/unrequested.webp' },
      ] as Awaited<ReturnType<API['getStickersDetail']>>);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    expect(await adapter.getStickerAssets([123, 123, 456])).toEqual([
      { stickerId: 123, url: 'https://example.com/animated.webp' },
    ]);
    expect(getStickersDetail).toHaveBeenCalledWith([123, 456]);
    expect(await adapter.getStickerAssets([123])).toEqual([
      { stickerId: 123, url: 'https://example.com/animated.webp' },
    ]);
    expect(getStickersDetail).toHaveBeenCalledTimes(1);
    adapter.disconnect();
  });
  it('requests one bounded user-history page and cleans up the temporary listener', async () => {
    const { api, listener } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    listener.requestOldMessages.mockImplementation(() =>
      queueMicrotask(() => {
        listener.emit('old_messages', [{ ignored: 'group' }], ThreadType.Group);
        listener.emit(
          'old_messages',
          Array.from({ length: 250 }, (_, i) => ({ index: i })),
          ThreadType.User,
        );
      }),
    );
    const first = adapter.getRecentMessages();
    expect(adapter.getRecentMessages()).toBe(first);
    expect(await first).toHaveLength(200);
    expect(listener.requestOldMessages).toHaveBeenCalledExactlyOnceWith(
      ThreadType.User,
    );
    expect(listener.listenerCount('old_messages')).toBe(0);
    adapter.disconnect();
  });
  it('cancels a pending bounded history read on disconnect', async () => {
    const { api, listener } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    listener.requestOldMessages.mockImplementation(() => undefined);
    const pending = expect(adapter.getRecentMessages()).rejects.toMatchObject({
      code: 'ZALO_LOGIN_CANCELLED',
    });
    adapter.disconnect();
    await pending;
    expect(listener.listenerCount('old_messages')).toBe(0);
  });
});

describe('Zalo document and voice SDK boundary', () => {
  it('sends one document without a separate empty text message', async () => {
    const { api, sendMessage } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    sendMessage.mockResolvedValueOnce({
      message: null,
      attachment: [{ msgId: 112233 }],
    } as never);
    const bytes = Buffer.from('%PDF-fixture');
    expect(
      await adapter.sendMediaMessage(
        '1234',
        { bytes, name: 'invoice.pdf', mime: 'application/pdf' },
        'document',
      ),
    ).toEqual({ externalMessageId: '112233' });
    expect(sendMessage).toHaveBeenCalledWith(
      {
        msg: '',
        attachments: [
          {
            data: bytes,
            filename: 'invoice.pdf',
            metadata: { totalSize: bytes.length },
          },
        ],
      },
      '1234',
      ThreadType.User,
    );
    adapter.disconnect();
  });
  it('uploads audio in the connected session then sends voice using only the provider asset URL', async () => {
    const { api } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    const bytes = Buffer.from('ID3fixture');
    expect(
      await adapter.sendMediaMessage(
        '1234',
        { bytes, name: 'voice.mp3', mime: 'audio/mpeg' },
        'audio',
      ),
    ).toEqual({ externalMessageId: '998877' });
    expect(api.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ data: bytes }),
      '1234',
      ThreadType.User,
    );
    expect(api.sendVoice).toHaveBeenCalledWith(
      { voiceUrl: 'https://files.dlfl.vn/fixture.m4a' },
      '1234',
      ThreadType.User,
    );
    adapter.disconnect();
  });
  it('distinguishes a failed upload from an ambiguous voice send and rejects an unexpected asset host', async () => {
    const { api } = apiFixture();
    vi.spyOn(Zalo.prototype, 'login').mockResolvedValue(api);
    const adapter = new ZcaPersonalAdapter();
    await adapter.restoreSession(JSON.stringify(creds));
    await adapter.startListening(vi.fn(), vi.fn());
    const file = {
      bytes: Buffer.from('ID3fixture'),
      name: 'voice.mp3',
      mime: 'audio/mpeg',
    };
    vi.mocked(api.uploadAttachment).mockRejectedValueOnce(
      Error('private-upload-error'),
    );
    await expect(
      adapter.sendMediaMessage('1234', file, 'audio'),
    ).rejects.toMatchObject({
      code: 'ZALO_MEDIA_UPLOAD_FAILED',
      safeToRetry: true,
    });
    vi.mocked(api.uploadAttachment).mockResolvedValueOnce([
      { fileType: 'others', fileUrl: 'https://evil.example/private' },
    ] as never);
    await expect(
      adapter.sendMediaMessage('1234', file, 'audio'),
    ).rejects.toMatchObject({ safeToRetry: true });
    expect(api.sendVoice).not.toHaveBeenCalled();
    vi.mocked(api.sendVoice).mockRejectedValueOnce(Error('unconfirmed'));
    await expect(
      adapter.sendMediaMessage('1234', file, 'audio'),
    ).rejects.toMatchObject({ code: 'ZALO_SEND_UNKNOWN', safeToRetry: false });
    adapter.disconnect();
  });
});
