import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WhatsAppConnectionPage } from './whatsapp-connection';
import { WhatsAppTemplates } from '@/features/inbox/whatsapp-templates';
import { InboxPage } from './inbox';
import * as signup from '@/lib/whatsapp-signup';
import type { Conversation } from '@zalo/shared';
const account = {
  id: 'waaccount',
  name: 'Store · +84 900 111 111',
  channelType: 'WHATSAPP_BUSINESS',
  avatarUrl: null,
  externalAccountId: '101',
  connectionStatus: 'CONNECTED',
  lastConnectedAt: '2026-11-07T00:00:00Z',
  lastSyncAt: '2026-11-07T00:00:00Z',
  lastError: null,
  lastSyncError: null,
  syncComplete: true,
  workerOnline: true,
  tokenExpiresAt: '2099-01-01T00:00:00Z',
  metadata: {
    wabaId: '201',
    phoneNumberId: '101',
    displayPhoneNumber: '+84 900 111 111',
    verifiedName: 'Store',
    businessName: 'Authorized business',
    onboardingMode: 'DIRECT',
    webhookVerifiedAt: '2026-11-07T00:00:00Z',
    isOnBizApp: false,
  },
  capabilities: {
    receiveMessages: true,
    sendMessages: true,
    syncConversations: false,
    readReceipts: true,
    templates: true,
    providerMarkRead: true,
    coexistence: false,
  },
};
const status = {
  enabled: true,
  configured: true,
  embeddedAvailable: false,
  embeddedStatus: 'CONFIGURATION_OR_APPROVAL_REQUIRED',
  workerOnline: true,
  accounts: [],
  selection: null,
  restrictions: [
    'Chỉ WhatsApp Business Cloud API chính thức; không kết nối WhatsApp cá nhân.',
  ],
};
const chat: Conversation = {
  id: 'wachat',
  connectionId: null,
  channelAccountId: 'waaccount',
  channelType: 'WHATSAPP_BUSINESS',
  accountName: account.name,
  accountAvatar: null,
  accountExternalId: '101',
  canSend: false,
  sendBlockedReason: 'WHATSAPP_WINDOW_CLOSED',
  externalUserId: '84901234567',
  externalConversationId: '84901234567',
  externalContactId: '84901234567',
  unreadCount: null,
  inboxUnreadCount: 2,
  customerName: 'WhatsApp customer',
  customerAvatar: null,
  lastMessageAt: '2026-11-07T00:00:00Z',
  lastMessagePreview: 'Hello',
};
const outgoing = {
  id: 'wamessage',
  type: 'template',
  direction: 'OUTGOING',
  content: 'Chào An',
  externalMessageId: null,
  source: 'WHATSAPP',
  sentAt: '2026-11-07T00:01:00Z',
  attachments: [],
  deliveryStatus: 'PENDING',
};
function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}
function setup(node: React.ReactNode, path = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('WhatsApp setup and the existing inbox', () => {
  it('reports missing configuration and gates both connection modes without fake accounts', async () => {
    const fetcher = vi.fn(async () =>
      response({ ...status, configured: false }),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<WhatsAppConnectionPage />);
    expect(
      await screen.findByText('Chưa cấu hình WhatsApp Business'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Kết nối WhatsApp Business' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Chuẩn bị kết nối Meta' }),
    ).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it('connects an authorized direct number, clears secret inputs and exposes shared inbox actions', async () => {
    let linked = false;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/connect')) {
        linked = true;
        return response(account);
      }
      if (url.endsWith('/sync')) return response({ queued: true });
      if (options?.method === 'DELETE') return response({ disconnected: true });
      return response({ ...status, accounts: linked ? [account] : [] });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<WhatsAppConnectionPage />);
    const token = await screen.findByLabelText('Access token WhatsApp');
    fireEvent.change(screen.getByLabelText('WABA ID'), {
      target: { value: '201' },
    });
    fireEvent.change(screen.getByLabelText('Phone Number ID'), {
      target: { value: '101' },
    });
    fireEvent.change(token, { target: { value: 'private-ui-token' } });
    fireEvent.change(screen.getByLabelText('PIN đăng ký trực tiếp'), {
      target: { value: '123456' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Kết nối WhatsApp Business' }),
    );
    expect(token).toHaveValue('');
    expect(screen.getByLabelText('PIN đăng ký trực tiếp')).toHaveValue('');
    expect(await screen.findByText(account.name)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mở hộp thư' })).toHaveAttribute(
      'href',
      '/inbox?account=whatsapp-business%3Awaaccount',
    );
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toMatch(/private-ui-token|123456/);
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
  it('uses a prepared official SDK action, exchanges the code immediately and selects only authorized phones', async () => {
    vi.spyOn(signup, 'loadWhatsAppSignup').mockResolvedValue();
    vi.spyOn(signup, 'launchWhatsAppSignup').mockImplementation(
      async (_id, onAssets) => {
        onAssets({ wabaId: '201', phoneNumberId: '101' });
        return 'ephemeral-meta-code';
      },
    );
    let selected = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/embedded/begin'))
        return response({
          authorizationId: 'auth1',
          state: 'state',
          appId: '301',
          configId: '401',
          graphVersion: 'v27.0',
        });
      if (url.endsWith('/embedded/complete')) {
        selected = true;
        return response({ authorizationId: 'auth1' });
      }
      if (url.includes('/phones?'))
        return response({
          items: [
            {
              id: '101',
              displayPhoneNumber: '+84 900 111 111',
              verifiedName: 'Store',
              status: 'CONNECTED',
              platformType: 'CLOUD_API',
              coexistence: false,
            },
          ],
          nextCursor: null,
        });
      if (url.endsWith('/embedded/select')) {
        selected = false;
        return response(account);
      }
      return response({
        ...status,
        embeddedAvailable: true,
        selection: selected
          ? { id: 'auth1', wabaIds: ['201'], expiresAt: '2099-01-01T00:00:00Z' }
          : null,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<WhatsAppConnectionPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Chuẩn bị kết nối Meta' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Tiếp tục với Meta' }),
    );
    expect(
      await screen.findByRole('option', { name: 'Store · +84 900 111 111' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Hoàn tất kết nối số' }),
    );
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) => url.endsWith('/embedded/select')),
      ).toBe(true),
    );
    expect(signup.loadWhatsAppSignup).toHaveBeenCalledWith('301', 'v27.0');
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain('ephemeral-meta-code');
    client.clear();
  });
  it('offers approved templates outside the freeform window and requires explicit opt-in confirmation', async () => {
    const fetcher = vi.fn(async (url: string) =>
      response(
        url.endsWith('/send-template')
          ? outgoing
          : {
              items: [
                {
                  id: '900',
                  name: 'order_update',
                  language: 'vi',
                  category: 'UTILITY',
                  status: 'APPROVED',
                  supported: true,
                  reason: null,
                  variables: [{ component: 'body', name: '1' }],
                  components: [{ type: 'BODY', text: 'Chào {{1}}' }],
                },
                {
                  id: '901',
                  name: 'pending',
                  language: 'vi',
                  category: 'UTILITY',
                  status: 'PENDING',
                  supported: true,
                  reason: null,
                  variables: [],
                  components: [],
                },
              ],
              nextCursor: null,
            },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<WhatsAppTemplates conversation={chat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chọn mẫu WhatsApp' }));
    const select = await screen.findByLabelText('Mẫu WhatsApp đã duyệt');
    await screen.findByRole('option', {
      name: 'order_update · vi · UTILITY · APPROVED',
    });
    expect(
      screen.getByRole('option', { name: 'pending · vi · UTILITY · PENDING' }),
    ).toBeDisabled();
    fireEvent.change(select, { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Biến body 1'), {
      target: { value: 'An' },
    });
    expect(
      screen.getByRole('button', { name: 'Gửi mẫu WhatsApp' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Gửi mẫu WhatsApp' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) => url.endsWith('/send-template')),
      ).toBe(true),
    );
    client.clear();
  });
  it('reuses a template idempotency key after an unconfirmed request', async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/send-template')) {
        requests.push(String(options?.body));
        throw Error('Network unavailable');
      }
      return response({
        items: [
          {
            id: '900',
            name: 'hello',
            language: 'vi',
            category: 'UTILITY',
            status: 'APPROVED',
            supported: true,
            reason: null,
            variables: [],
            components: [{ type: 'BODY', text: 'Chào' }],
          },
        ],
        nextCursor: null,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(<WhatsAppTemplates conversation={chat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chọn mẫu WhatsApp' }));
    await screen.findByRole('option', {
      name: 'hello · vi · UTILITY · APPROVED',
    });
    fireEvent.change(screen.getByLabelText('Mẫu WhatsApp đã duyệt'), {
      target: { value: '900' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Gửi mẫu WhatsApp' }));
    await screen.findByText(/Chưa kết nối được với máy chủ/);
    fireEvent.click(screen.getByRole('button', { name: 'Gửi mẫu WhatsApp' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.parse(requests[0]).idempotencyKey).toBe(
      JSON.parse(requests[1]).idempotencyKey,
    );
    client.clear();
  });
  it('shows WhatsApp identity/read status, blocks closed-window text and keeps provider mark-read explicit', async () => {
    let marked = false;
    const messages = [
      {
        ...outgoing,
        id: 'acceptedwa',
        content: 'Accepted only',
        deliveryStatus: 'SENT',
        externalMessageId: 'wamid.accepted',
      },
      {
        ...outgoing,
        id: 'incomingwa',
        type: 'text',
        direction: 'INCOMING',
        content: 'WhatsApp incoming',
        externalMessageId: 'wamid.incoming',
        inboxUnread: true,
      },
      {
        ...outgoing,
        id: 'readwa',
        content: 'Provider read',
        deliveryStatus: 'READ',
        readAt: '2026-11-07T00:02:00Z',
        externalMessageId: 'wamid.outgoing',
      },
    ];
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/whatsapp/read')) {
        marked = true;
        return response({ queued: true });
      }
      if (url.endsWith('/conversations/accounts'))
        return response({
          accounts: [
            {
              key: 'whatsapp-business:waaccount',
              id: 'waaccount',
              channelType: 'WHATSAPP_BUSINESS',
              name: account.name,
              avatarUrl: null,
              externalAccountId: '101',
              status: 'CONNECTED',
              conversationCount: 1,
              unreadMessageCount: 2,
            },
          ],
        });
      if (url.includes('/messages'))
        return response({
          items: messages,
          page: 1,
          limit: 50,
          hasMore: false,
        });
      if (options?.method === 'POST') return response({ markedRead: 0 });
      return response({ items: [chat], page: 1, limit: 30, hasMore: false });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup(
      <Routes>
        <Route path="/inbox/:conversationId?" element={<InboxPage />} />
      </Routes>,
      '/inbox/wachat?channelType=WHATSAPP_BUSINESS',
    );
    expect(await screen.findByText('WhatsApp incoming')).toBeInTheDocument();
    expect(screen.getByText('Đã xem')).toBeInTheDocument();
    expect(screen.getByText('Meta đã nhận yêu cầu')).toBeInTheDocument();
    expect(screen.getByLabelText('Tin nhắn')).toBeDisabled();
    expect(screen.getByLabelText('2 tin chưa đọc')).toBeInTheDocument();
    expect(marked).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Thông tin hội thoại' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Báo đã đọc trên WhatsApp' }),
    );
    expect(
      await screen.findByText('Đã xếp lịch báo đọc trên WhatsApp.'),
    ).toBeInTheDocument();
    expect(marked).toBe(true);
    client.clear();
  });
});
