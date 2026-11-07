import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TikTokBusinessConnectionPage,
  TikTokShopConnectionPage,
} from './tiktok-connection';
import { InboxPage } from './inbox';

const capabilities = {
  receiveMessages: true,
  sendMessages: true,
  syncConversations: true,
  readReceipts: false,
};
const account = {
  id: 'shopaccount',
  name: 'Cửa hàng TikTok',
  avatarUrl: null,
  externalAccountId: 'shop-2',
  channelType: 'TIKTOK_SHOP',
  connectionStatus: 'CONNECTED',
  lastConnectedAt: '2026-11-06T00:00:00Z',
  lastSyncAt: null,
  lastError: null,
  lastSyncError: null,
  syncComplete: false,
  workerOnline: true,
  capabilities,
  tokenExpiresAt: '2099-01-01T00:00:00Z',
};
const status = {
  channelType: 'TIKTOK_SHOP',
  enabled: true,
  configured: true,
  workerOnline: true,
  status: 'NOT_CONNECTED',
  approvalStatus: 'UNVERIFIED',
  accounts: [],
  selection: null,
  restrictions: ['Chỉ trả lời hội thoại hiện có.'],
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
describe('TikTok connection and shared inbox', () => {
  it('shows unconfigured Business honestly and disables connection until backend configuration is ready', async () => {
    const fetcher = vi.fn(async () =>
      response({
        ...status,
        channelType: 'TIKTOK_BUSINESS',
        configured: false,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<TikTokBusinessConnectionPage />);
    expect(
      await screen.findByText('Chưa cấu hình ứng dụng TikTok'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Kết nối TikTok Business' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Quyền ứng dụng chưa được xác minh/),
    ).toBeInTheDocument();
    expect(fetcher.mock.calls).toHaveLength(1);
    client.clear();
  });
  it('selects only a server-authorized shop and exposes shared inbox, sync and disconnect actions', async () => {
    let linked = false;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/tiktok-shop/select')) {
        linked = true;
        return response(account);
      }
      if (url.endsWith('/sync')) return response({ queued: true });
      if (options?.method === 'DELETE') return response({ disconnected: true });
      return response({
        ...status,
        accounts: linked ? [account] : [],
        selection: linked
          ? null
          : {
              id: 'auth-fixture',
              expiresAt: '2099-01-01T00:00:00Z',
              accounts: [
                {
                  id: 'shop-2',
                  name: account.name,
                  avatarUrl: null,
                  region: 'VN',
                },
              ],
            },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(
      <TikTokShopConnectionPage />,
      '/tiktok/shop?oauth=select',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối' }));
    expect(
      await screen.findByRole('link', { name: 'Mở hộp thư' }),
    ).toHaveAttribute('href', '/inbox?account=tiktok-shop%3Ashopaccount');
    const selected = fetcher.mock.calls.find(([url]) =>
      url.endsWith('/tiktok-shop/select'),
    );
    expect(JSON.parse(String(selected?.[1]?.body))).toEqual({
      authorizationId: 'auth-fixture',
      externalAccountId: 'shop-2',
    });
    expect(
      screen.getByText('Trạng thái xem · chưa có quyền/dữ liệu'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Đồng bộ' }));
    expect(await screen.findByText(/Đã xếp lịch đồng bộ/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ngắt kết nối' }));
    expect(
      fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận ngắt' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, options]) =>
            url.endsWith('/channels/shopaccount') &&
            options?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    client.clear();
  });
  it('blocks an untrusted OAuth redirect and provides a readable permission error after callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        response(
          url.endsWith('/connect')
            ? {
                authorizationUrl:
                  'https://www.tiktok.com.evil.example/v2/auth/authorize',
              }
            : status,
        ),
      ),
    );
    const client = setup(
      <TikTokShopConnectionPage />,
      '/tiktok/shop?error=TIKTOK_SHOP_APPROVAL_REQUIRED',
    );
    expect(
      await screen.findByText(
        /Ứng dụng cần được TikTok Shop duyệt Customer Service/,
      ),
    ).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'Kết nối TikTok Shop' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    expect(
      await screen.findByText(
        'URL cấp quyền TikTok chưa hợp lệ. Hãy thử kết nối lại.',
      ),
    ).toBeInTheDocument();
    client.clear();
  });
  it.each([true, false])(
    'uses Shop identity, local unread count and send status with canSend=%s',
    async (canSend) => {
      const chat = {
        id: 'shopchat',
        connectionId: null,
        channelAccountId: 'shopaccount',
        channelType: 'TIKTOK_SHOP',
        accountName: account.name,
        accountAvatar: null,
        accountExternalId: 'shop-2',
        canSend,
        sendBlockedReason: canSend ? null : 'TIKTOK_REPLY_NOT_ALLOWED',
        externalUserId: 'remote-thread',
        externalConversationId: 'remote-thread',
        externalContactId: 'buyer-42',
        unreadCount: 7,
        inboxUnreadCount: 3,
        customerName: 'Khách TikTok',
        customerAvatar: 'https://cdn.example/peer.jpg',
        lastMessageAt: '2026-11-06T00:00:00Z',
        lastMessagePreview: 'Tôi cần hỗ trợ',
      };
      let sent = false;
      const outgoing = {
        id: 'tiktok-outgoing',
        type: 'text',
        direction: 'OUTGOING',
        content: 'Shop trả lời',
        externalMessageId: 'provider-ack',
        source: 'TIKTOK',
        sentAt: '2026-11-06T00:01:00Z',
        attachments: [],
        deliveryStatus: 'SENT',
      };
      const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith('/conversations/accounts'))
          return response({
            accounts: [
              {
                key: 'tiktok-shop:shopaccount',
                id: 'shopaccount',
                channelType: 'TIKTOK_SHOP',
                name: account.name,
                avatarUrl: null,
                externalAccountId: 'shop-2',
                status: 'CONNECTED',
                conversationCount: 1,
              },
            ],
          });
        if (options?.method === 'POST') {
          sent = true;
          return response(outgoing);
        }
        if (url.includes('/messages'))
          return response({
            items: sent ? [outgoing] : [],
            page: 1,
            limit: 50,
            hasMore: false,
          });
        return response({ items: [chat], page: 1, limit: 30, hasMore: false });
      });
      vi.stubGlobal('fetch', fetcher);
      const client = setup(
        <Routes>
          <Route path="/inbox/:conversationId?" element={<InboxPage />} />
        </Routes>,
        '/inbox/shopchat?channelType=TIKTOK_SHOP',
      );
      const draft = await screen.findByLabelText('Tin nhắn');
      expect(screen.getByLabelText('3 tin chưa đọc')).toBeInTheDocument();
      expect(
        fetcher.mock.calls.some(([url]) =>
          url.includes('channelType=TIKTOK_SHOP'),
        ),
      ).toBe(true);
      if (canSend) {
        expect(draft).toBeEnabled();
        fireEvent.change(draft, { target: { value: 'Shop trả lời' } });
        fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
        expect(await screen.findByText('Đã gửi')).toBeInTheDocument();
      } else {
        expect(draft).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
        expect(
          screen.getByText(/TikTok chưa cho phép trả lời/),
        ).toBeInTheDocument();
        expect(
          fetcher.mock.calls.some(([, options]) => options?.method === 'POST'),
        ).toBe(false);
      }
      client.clear();
    },
  );
});
