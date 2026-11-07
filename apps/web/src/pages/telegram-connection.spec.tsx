import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TelegramBotConnectionPage,
  TelegramPersonalConnectionPage,
  telegramConfirmationUrl,
} from './telegram-connection';
import { InboxPage } from './inbox';

const account = {
  id: 'telegramaccount',
  name: 'Telegram công việc',
  channelType: 'TELEGRAM_PERSONAL',
  avatarUrl: null,
  externalAccountId: null,
  connectionStatus: 'CONNECTING',
  lastConnectedAt: null,
  lastSyncAt: null,
  lastError: null,
  lastSyncError: null,
  syncComplete: false,
  workerOnline: true,
  capabilities: {
    receiveMessages: false,
    sendMessages: false,
    syncConversations: false,
    readReceipts: false,
  },
  authorization: {
    state: 'PHONE_REQUIRED',
    tdlibState: 'authorizationStateWaitPhoneNumber',
  },
  rateLimitedUntil: null,
};
const status = {
  channelType: 'TELEGRAM_PERSONAL',
  enabled: true,
  configured: true,
  nativeAvailable: true,
  workerOnline: true,
  accounts: [],
  restrictions: ['Chỉ Cloud Chats; không tự đánh dấu đã đọc trên Telegram.'],
};
function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}
function setup(node: React.ReactNode, entry = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => vi.unstubAllGlobals());
describe('Telegram connection screens and shared inbox', () => {
  it('shows missing configuration honestly without attempting login', async () => {
    const fetcher = vi.fn(async () =>
      response({ ...status, configured: false }),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<TelegramPersonalConnectionPage />);
    expect(
      await screen.findByText('Chưa cấu hình Telegram'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Kết nối Telegram cá nhân' }),
    ).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it.each([
    [
      'PHONE_REQUIRED',
      'authorizationStateWaitPhoneNumber',
      'Số điện thoại (có mã quốc gia)',
      '+84123456789',
      'Gửi mã xác minh',
      'phone',
    ],
    [
      'CODE_REQUIRED',
      'authorizationStateWaitCode',
      'Mã xác minh Telegram',
      'fixture-otp',
      'Xác minh mã',
      'code',
    ],
    [
      'PASSWORD_REQUIRED',
      'authorizationStateWaitPassword',
      'Mật khẩu 2FA Telegram',
      'fixture-2fa',
      'Xác minh mật khẩu',
      'password',
    ],
    [
      'EMAIL_REQUIRED',
      'authorizationStateWaitEmailAddress',
      'Email xác thực',
      'test@example.com',
      'Gửi mã email',
      'email',
    ],
    [
      'EMAIL_CODE_REQUIRED',
      'authorizationStateWaitEmailCode',
      'Mã xác minh email',
      'fixture-email-otp',
      'Xác minh email',
      'email_code',
    ],
  ])(
    'prompts for %s and never retains OTP/password in React Query mutations',
    async (state, tdlibState, label, value, button, action) => {
      const fetcher = vi.fn(async (_url: string, options?: RequestInit) =>
        response(
          options?.method === 'POST'
            ? { state, tdlibState }
            : {
                ...status,
                accounts: [
                  { ...account, authorization: { state, tdlibState } },
                ],
              },
        ),
      );
      vi.stubGlobal('fetch', fetcher);
      const client = setup(<TelegramPersonalConnectionPage />);
      const input = await screen.findByLabelText(label);
      if (action === 'password')
        expect(input).toHaveAttribute('type', 'password');
      fireEvent.change(input, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() =>
        expect(
          fetcher.mock.calls.some(([, options]) => options?.method === 'POST'),
        ).toBe(true),
      );
      expect(input).toHaveValue('');
      const sent = fetcher.mock.calls.find(
        ([, options]) => options?.method === 'POST',
      );
      expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ action, value });
      expect(
        JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((m) => m.state),
        ),
      ).not.toContain(value);
      client.clear();
    },
  );
  it('connects a bot, clears its token field and shows webhook status and inbox actions', async () => {
    let linked = false;
    const bot = {
      ...account,
      channelType: 'TELEGRAM_BOT',
      name: 'My bot @fixture_bot',
      externalAccountId: '1234567890',
      connectionStatus: 'CONNECTED',
      authorization: null,
      capabilities: {
        receiveMessages: true,
        sendMessages: true,
        syncConversations: false,
        readReceipts: false,
      },
    };
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/connect')) {
        linked = true;
        return response(bot);
      }
      if (url.endsWith('/verify-webhook'))
        return response({
          verified: true,
          pendingUpdateCount: 0,
          deliveryError: false,
        });
      if (options?.method === 'DELETE') return response({ disconnected: true });
      return response({
        ...status,
        channelType: 'TELEGRAM_BOT',
        accounts: linked ? [bot] : [],
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<TelegramBotConnectionPage />);
    const input = await screen.findByLabelText('Bot Token');
    fireEvent.change(input, { target: { value: 'fixture-token' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Kết nối Telegram Bot' }),
    );
    expect(input).toHaveValue('');
    expect(await screen.findByText('My bot @fixture_bot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mở hộp thư' })).toHaveAttribute(
      'href',
      '/inbox?account=telegram-bot%3Atelegramaccount',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra webhook' }));
    expect(
      await screen.findByText('Đã xác minh webhook với Telegram.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ngắt kết nối' }));
    expect(fetcher.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận ngắt' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(
        true,
      ),
    );
    client.clear();
  });
  it('accepts only Telegram device-confirmation links and displays additional required steps', async () => {
    expect(telegramConfirmationUrl('https://evil.example')).toBeUndefined();
    expect(
      telegramConfirmationUrl('tg://login?token=abc&other=1'),
    ).toBeUndefined();
    expect(telegramConfirmationUrl('tg://login?token=Ab_c-123=')).toBe(
      'tg://login?token=Ab_c-123=',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          ...status,
          accounts: [
            {
              ...account,
              authorization: {
                state: 'DEVICE_CONFIRMATION_REQUIRED',
                tdlibState: 'authorizationStateWaitOtherDeviceConfirmation',
                confirmationLink: 'tg://login?token=Ab_c-123=',
              },
            },
          ],
        }),
      ),
    );
    const client = setup(<TelegramPersonalConnectionPage />);
    expect(
      await screen.findByRole('link', { name: 'Mở Telegram để xác nhận' }),
    ).toHaveAttribute('href', 'tg://login?token=Ab_c-123=');
    client.clear();
  });
  it('renders Telegram senders, edits, deleted messages and local unread counts in the existing inbox', async () => {
    const chat = {
      id: 'telegramchat',
      connectionId: null,
      channelAccountId: 'telegramaccount',
      channelType: 'TELEGRAM_PERSONAL',
      accountName: 'Telegram công việc',
      accountAvatar: null,
      accountExternalId: '77',
      canSend: true,
      sendBlockedReason: null,
      externalUserId: '42',
      externalConversationId: '42',
      externalContactId: '42',
      unreadCount: 7,
      inboxUnreadCount: 2,
      customerName: 'Telegram peer',
      customerAvatar: null,
      lastMessageAt: '2026-11-07T00:00:00Z',
      lastMessagePreview: 'Hello',
    };
    const messages = [
      {
        id: 'edited-message',
        type: 'text',
        direction: 'INCOMING',
        content: 'Nội dung đã sửa',
        externalMessageId: '42:100',
        source: 'TELEGRAM',
        sentAt: '2026-11-07T00:00:00Z',
        attachments: [],
        deliveryStatus: 'SENT',
        senderName: 'Thành viên nhóm',
        editedAt: '2026-11-07T00:01:00Z',
      },
      {
        id: 'deleted-message',
        type: 'text',
        direction: 'INCOMING',
        content: 'Không được hiển thị',
        externalMessageId: '42:101',
        source: 'TELEGRAM',
        sentAt: '2026-11-07T00:02:00Z',
        attachments: [],
        deliveryStatus: 'SENT',
        deletedAt: '2026-11-07T00:03:00Z',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        response(
          url.endsWith('/sync')
            ? { queued: true }
            : url.endsWith('/conversations/accounts')
              ? {
                  accounts: [
                    {
                      key: 'telegram-personal:telegramaccount',
                      id: 'telegramaccount',
                      channelType: 'TELEGRAM_PERSONAL',
                      name: 'Telegram công việc',
                      avatarUrl: null,
                      externalAccountId: '77',
                      status: 'CONNECTED',
                      conversationCount: 1,
                      unreadMessageCount: 2,
                    },
                  ],
                }
              : url.includes('/messages')
                ? { items: messages, page: 1, limit: 50, hasMore: false }
                : { items: [chat], page: 1, limit: 30, hasMore: false },
        ),
      ),
    );
    const client = setup(
      <Routes>
        <Route path="/inbox/:conversationId?" element={<InboxPage />} />
      </Routes>,
      '/inbox/telegramchat?channelType=TELEGRAM_PERSONAL',
    );
    expect(await screen.findByText('Nội dung đã sửa')).toBeInTheDocument();
    expect(screen.getByText('Thành viên nhóm')).toBeInTheDocument();
    expect(screen.getByText(/Đã chỉnh sửa/)).toBeInTheDocument();
    expect(screen.queryByText('Không được hiển thị')).not.toBeInTheDocument();
    expect(screen.getByLabelText('2 tin chưa đọc')).toBeInTheDocument();
    expect(screen.getByLabelText('Tin nhắn')).toBeEnabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Thông tin hội thoại' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Đồng bộ lịch sử Telegram' }),
    );
    expect(
      await screen.findByText('Đã xếp lịch đồng bộ hội thoại.'),
    ).toBeInTheDocument();
    client.clear();
  });
});
