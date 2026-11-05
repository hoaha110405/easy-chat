import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxPage } from './inbox';
afterEach(() => vi.unstubAllGlobals());
describe('stored conversation viewer', () => {
  it('opens a conversation and renders incoming and outgoing messages without a send action', async () => {
    const conversation = {
      id: 'conversation',
      connectionId: 'connection',
      externalUserId: '246845883529197922',
      customerName: 'Fixture customer',
      customerAvatar: 'https://example.com/contact.jpg',
      lastMessageAt: '2026-07-06T00:00:00.000Z',
      lastMessagePreview: 'Fixture preview',
    };
    const messages = [
      {
        id: '2',
        externalMessageId: 'out',
        direction: 'OUTGOING',
        content: 'Outgoing fixture',
        type: 'text',
        sentAt: '2026-07-06T00:00:01.000Z',
        source: 'WEBHOOK',
        attachments: [],
      },
      {
        id: '1',
        externalMessageId: 'in',
        direction: 'INCOMING',
        content: 'Incoming fixture',
        type: 'text',
        sentAt: '2026-07-06T00:00:00.000Z',
        source: 'WEBHOOK',
        attachments: [],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => ({
        ok: true,
        json: async () => ({
          data: input.includes('/messages')
            ? { items: messages, page: 1, limit: 50, hasMore: false }
            : input.includes('/conversations/accounts')
              ? { accounts: [] }
              : input.includes('/zalo/status')
                ? {
                    configured: true,
                    webhookConfigured: true,
                    connection: null,
                    failedWebhookCount: 0,
                  }
                : { items: [conversation], page: 1, limit: 30, hasMore: false },
        }),
      })),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox/:conversationId?" element={<InboxPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const list = screen.getByRole('region', { name: 'Danh sách hội thoại' });
    const contact = await within(list).findByRole('img', {
      name: 'Ảnh người liên hệ Fixture customer',
    });
    expect(contact.querySelector('img')).toHaveAttribute(
      'src',
      conversation.customerAvatar,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Fixture customer/ }),
    );
    expect(await screen.findByText('Incoming fixture')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Nội dung hội thoại' }))
        .getByRole('img', { name: 'Ảnh người liên hệ Fixture customer' })
        .querySelector('img'),
    ).toHaveAttribute('src', conversation.customerAvatar);
    expect(screen.getByText('Outgoing fixture')).toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: 'Tin nhắn đến' }),
    ).toHaveTextContent('Incoming fixture');
    expect(
      screen.getByRole('article', { name: 'Tin nhắn đã gửi' }),
    ).toHaveTextContent('Outgoing fixture');
    expect(
      screen.queryByRole('button', { name: /send/i }),
    ).not.toBeInTheDocument();
    client.clear();
  });
  it('shows the receiving identity and avatar, filters on the server, clears the old chat when switching, and returns to all', async () => {
    const accounts = [
      {
        key: 'personal:accounta',
        id: 'accounta',
        channelType: 'ZALO_PERSONAL',
        name: 'Tài khoản công việc',
        externalAccountId: '111',
        avatarUrl: 'https://example.com/work.jpg',
        status: 'CONNECTED',
        conversationCount: 1,
      },
      {
        key: 'personal:accountb',
        id: 'accountb',
        channelType: 'ZALO_PERSONAL',
        name: 'Tài khoản riêng',
        externalAccountId: '222',
        avatarUrl: 'https://example.com/private.jpg',
        status: 'CONNECTED',
        conversationCount: 1,
      },
      {
        key: 'oa:accountoa',
        id: 'accountoa',
        channelType: 'ZALO_OA',
        name: 'Cửa hàng OA',
        externalAccountId: '333',
        avatarUrl: null,
        status: 'CONNECTED',
        conversationCount: 1,
      },
      {
        key: 'personal:empty',
        id: 'empty',
        channelType: 'ZALO_PERSONAL',
        name: 'Tài khoản mới',
        externalAccountId: '444',
        avatarUrl: null,
        status: 'CONNECTED',
        conversationCount: 0,
      },
    ];
    const conversations = accounts.slice(0, 3).map((a, i) => ({
      id: `chat${i}`,
      connectionId: i === 2 ? a.id : null,
      channelAccountId: i === 2 ? null : a.id,
      channelType: a.channelType,
      accountName: a.name,
      accountAvatar: a.avatarUrl,
      accountExternalId: a.externalAccountId,
      canSend: i < 2,
      externalUserId: '999',
      customerName: 'Cùng một khách hàng',
      customerAvatar: null,
      lastMessageAt: '2026-11-05T00:00:00.000Z',
      lastMessagePreview: `Tin nhắn ${i}`,
    }));
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      const key = url.searchParams.get('account');
      const items = key
        ? conversations.filter(
            (c) =>
              (c.channelAccountId
                ? `personal:${c.channelAccountId}`
                : `oa:${c.connectionId}`) === key,
          )
        : conversations;
      return {
        ok: true,
        json: async () => ({
          data: input.includes('/conversations/accounts')
            ? { accounts }
            : input.includes('/zalo/status')
              ? {
                  configured: true,
                  webhookConfigured: true,
                  connection: null,
                  failedWebhookCount: 0,
                }
              : {
                  items: input.includes('/messages') ? [] : items,
                  page: 1,
                  limit: 30,
                  hasMore: false,
                },
        }),
      };
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox/:conversationId?" element={<InboxPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const list = screen.getByRole('region', { name: 'Danh sách hội thoại' });
    await waitFor(() =>
      expect(
        within(list).getAllByRole('button', { name: /Cùng một khách hàng/ }),
      ).toHaveLength(3),
    );
    const searchInput = within(list).getByRole('textbox', {
      name: 'Tìm hội thoại đã tải',
    });
    fireEvent.change(searchInput, { target: { value: 'cung mot khach hang' } });
    expect(
      within(list).getAllByRole('button', { name: /Cùng một khách hàng/ }),
    ).toHaveLength(3);
    fireEvent.change(searchInput, { target: { value: 'tin nhan 1' } });
    expect(
      within(list).getAllByRole('button', { name: /Cùng một khách hàng/ }),
    ).toHaveLength(1);
    expect(
      within(list).getByRole('button', { name: /Cùng một khách hàng/ }),
    ).toHaveTextContent('Tài khoản riêng');
    fireEvent.click(within(list).getByRole('button', { name: 'Xóa tìm kiếm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    const menu = await screen.findByRole('menu', { name: 'Tài khoản kết nối' });
    expect(
      within(menu)
        .getByRole('img', { name: 'Ảnh tài khoản Tài khoản công việc' })
        .querySelector('img'),
    ).toHaveAttribute('src', 'https://example.com/work.jpg');
    fireEvent.click(
      within(menu).getByRole('menuitemradio', { name: /Tài khoản công việc/ }),
    );
    await waitFor(() =>
      expect(
        within(list).getAllByRole('button', { name: /Cùng một khách hàng/ }),
      ).toHaveLength(1),
    );
    expect(
      fetcher.mock.calls.some(
        ([url]) =>
          url.includes('page=1') && url.includes('account=personal%3Aaccounta'),
      ),
    ).toBe(true);
    fireEvent.click(
      within(list).getByRole('button', { name: /Cùng một khách hàng/ }),
    );
    const history = screen.getByRole('region', { name: 'Nội dung hội thoại' });
    expect(
      await within(history).findByText('Tài khoản nhận tin · Cá nhân'),
    ).toBeInTheDocument();
    expect(
      within(history).getByText('Trả lời bằng', { exact: false }),
    ).toHaveTextContent('Tài khoản công việc');
    expect(
      within(history)
        .getByRole('img', { name: 'Ảnh tài khoản Tài khoản công việc' })
        .querySelector('img'),
    ).toHaveAttribute('src', 'https://example.com/work.jpg');
    const info = within(history).getByRole('button', {
      name: 'Thông tin hội thoại',
    });
    fireEvent.click(info);
    const details = within(history).getByRole('complementary', {
      name: 'Thông tin hội thoại',
    });
    expect(within(details).getByText('999')).toBeInTheDocument();
    expect(within(details).getByText('111')).toBeInTheDocument();
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), {
        clipboard: { writeText: copy },
      }),
    );
    fireEvent.click(
      within(details).getByRole('button', {
        name: 'Sao chép mã người liên hệ',
      }),
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith('999'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      within(history).queryByRole('complementary'),
    ).not.toBeInTheDocument();
    expect(info).toHaveFocus();
    fireEvent.change(within(history).getByLabelText('Tin nhắn'), {
      target: { value: 'Nội dung đang soạn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Phóng to hội thoại' }));
    expect(within(history).getByLabelText('Tin nhắn')).toHaveValue(
      'Nội dung đang soạn',
    );
    expect(
      screen.getByRole('button', { name: 'Thu nhỏ hội thoại' }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /Tài khoản riêng/ }),
    );
    await waitFor(() =>
      expect(
        within(list).getByRole('button', { name: /Cùng một khách hàng/ }),
      ).toHaveTextContent('Tài khoản riêng'),
    );
    expect(
      within(history).queryByText('Trả lời bằng', { exact: false }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /Tài khoản mới/ }),
    );
    expect(
      await within(list).findByText('Tài khoản này chưa có hội thoại'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /Tất cả tài khoản/ }),
    );
    await waitFor(() =>
      expect(
        within(list).getAllByRole('button', { name: /Cùng một khách hàng/ }),
      ).toHaveLength(3),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Chọn tài khoản' }),
    ).toHaveFocus();
    client.clear();
  });
  it('loads more conversations at the bottom and older messages at the top while keeping the current history', async () => {
    const first = {
      id: 'chat-a',
      connectionId: 'oa',
      externalUserId: '111',
      customerName: 'Contact A',
      customerAvatar: null,
      lastMessageAt: '2026-11-05T08:00:00.000Z',
      lastMessagePreview: 'Recent message',
    };
    const second = {
      ...first,
      id: 'chat-b',
      externalUserId: '222',
      customerName: 'Contact B',
    };
    const latest = {
      id: 'new',
      externalMessageId: '22',
      direction: 'INCOMING',
      content: 'Recent message',
      type: 'text',
      sentAt: '2026-11-05T08:00:00.000Z',
      source: 'WEBHOOK',
      attachments: [],
    };
    const older = {
      ...latest,
      id: 'old',
      externalMessageId: '11',
      content: 'Older message',
      sentAt: '2026-11-05T07:00:00.000Z',
    };
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      const page = Number(url.searchParams.get('page') ?? 1);
      const data = input.includes('/accounts')
        ? { accounts: [] }
        : input.includes('/messages')
          ? {
              items: [page === 1 ? latest : older],
              page,
              limit: 50,
              hasMore: page === 1,
            }
          : {
              items: [page === 1 ? first : second],
              page,
              limit: 30,
              hasMore: page === 1,
            };
      return { ok: true, json: async () => ({ data }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox/:conversationId?" element={<InboxPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: /Contact A/ });
    const list = screen.getByRole('region', {
      name: 'Cuộn danh sách hội thoại',
    });
    Object.defineProperties(list, {
      clientHeight: { value: 100, configurable: true },
      scrollHeight: { value: 500, configurable: true },
      scrollTop: { value: 405, writable: true, configurable: true },
    });
    fireEvent.scroll(list);
    expect(
      await screen.findByRole('button', { name: /Contact B/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Contact A/ }));
    const history = screen.getByRole('region', { name: 'Cuộn tin nhắn' });
    expect(
      await within(history).findByText('Recent message'),
    ).toBeInTheDocument();
    Object.defineProperties(history, {
      clientHeight: { value: 100, configurable: true },
      scrollHeight: { value: 400, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    });
    fireEvent.scroll(history);
    expect(
      await within(history).findByText('Older message'),
    ).toBeInTheDocument();
    expect(within(history).getByText('Recent message')).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([url]) => url.includes('/conversations?page=2')),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.includes('/chat-a/messages?page=2'),
      ),
    ).toBe(true);
    client.clear();
  });
});
