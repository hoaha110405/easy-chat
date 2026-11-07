import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { InboxMessage } from '@zalo/shared';
import { useInboxRead } from './use-inbox-read';
import { InboxPage } from '@/pages/inbox';

const messages: InboxMessage[] = [
  {
    id: 'cvisiblemessage00000000001',
    direction: 'INCOMING',
    inboxUnread: true,
    externalMessageId: 'm1',
    type: 'text',
    content: 'Visible message',
    source: 'PERSONAL',
    sentAt: '2026-11-07T00:00:00Z',
    attachments: [],
  },
  {
    id: 'chiddenmessage000000000002',
    direction: 'INCOMING',
    inboxUnread: true,
    externalMessageId: 'm2',
    type: 'text',
    content: 'Hidden message',
    source: 'PERSONAL',
    sentAt: '2026-11-07T00:00:01Z',
    attachments: [],
  },
  {
    id: 'coutgoingmessage0000000003',
    direction: 'OUTGOING',
    inboxUnread: false,
    externalMessageId: 'm3',
    type: 'text',
    content: 'Outgoing message',
    source: 'PERSONAL',
    sentAt: '2026-11-07T00:00:02Z',
    attachments: [],
  },
];
let observers: FakeObserver[];
class FakeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    observers.push(this);
  }
  show(element: Element, visible = true) {
    this.callback(
      [
        {
          target: element,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}
function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['messages', 'chat'], {
    pages: [{ items: messages }],
    pageParams: [1],
  });
  function Component() {
    const viewport = useRef<HTMLDivElement>(null);
    const read = useInboxRead('chat', viewport, messages);
    return (
      <div ref={viewport}>
        {messages.map((m) => (
          <article key={m.id} data-inbox-message-id={m.id}>
            {m.content}
          </article>
        ))}
        {read.error ? <p role="alert">{read.error.message}</p> : null}
        <button onClick={read.retry}>Thử lưu lại</button>
      </div>
    );
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return { client, ...view };
}
beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('local unread visibility and counters', () => {
  it('marks only visible incoming IDs, updates their cache and refreshes counters once', async () => {
    const fetcher = vi.fn(async () => response({ markedRead: 1 }));
    vi.stubGlobal('fetch', fetcher);
    const { client } = setup();
    const observer = observers[0];
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(observer.observe).toHaveBeenCalledTimes(2);
    await act(async () => {
      observer.show(screen.getByText('Visible message'));
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/conversations/chat/read');
    expect(JSON.parse(String(options.body))).toEqual({
      messageIds: [messages[0].id],
    });
    const cached = client.getQueryData<{ pages: { items: InboxMessage[] }[] }>([
      'messages',
      'chat',
    ]);
    expect(cached?.pages[0].items[0].inboxUnread).toBe(false);
    expect(cached?.pages[0].items[1].inboxUnread).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inbox-accounts'] });
    await act(async () => {
      observer.show(screen.getByText('Visible message'));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it('preserves unread state while hidden or unfocused and resumes when the window is active', async () => {
    const fetcher = vi.fn(async () => response({ markedRead: 1 }));
    vi.stubGlobal('fetch', fetcher);
    const { client } = setup();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    await act(async () => {
      observers[0].show(screen.getByText('Visible message'));
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).not.toHaveBeenCalled();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).not.toHaveBeenCalled();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it('cancels the read timer when leaving the conversation', async () => {
    const fetcher = vi.fn(async () => response({ markedRead: 1 }));
    vi.stubGlobal('fetch', fetcher);
    const { client, unmount } = setup();
    observers[0].show(screen.getByText('Visible message'));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(observers[0].disconnect).toHaveBeenCalled();
    client.clear();
  });
  it('keeps the unread flag on save failure and allows a safe retry', async () => {
    let healthy = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        healthy
          ? response({ markedRead: 1 })
          : {
              ok: false,
              status: 503,
              json: async () => ({
                error: { code: 'REQUEST_FAILED', message: 'Không lưu được' },
              }),
            },
      ),
    );
    const { client } = setup();
    await act(async () => {
      observers[0].show(screen.getByText('Visible message'));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Không lưu được');
    expect(
      client.getQueryData<{ pages: { items: InboxMessage[] }[] }>([
        'messages',
        'chat',
      ])?.pages[0].items[0].inboxUnread,
    ).toBe(true);
    healthy = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thử lưu lại' }));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      client.getQueryData<{ pages: { items: InboxMessage[] }[] }>([
        'messages',
        'chat',
      ])?.pages[0].items[0].inboxUnread,
    ).toBe(false);
    client.clear();
  });
  it('shows exact per-chat counts and totals for the selected account across all conversation pages', async () => {
    vi.useRealTimers();
    const accounts = [
      {
        key: 'personal:work',
        id: 'work',
        channelType: 'ZALO_PERSONAL',
        name: 'Zalo công việc',
        avatarUrl: null,
        externalAccountId: '1',
        status: 'CONNECTED',
        conversationCount: 20,
        unreadMessageCount: 3,
      },
      {
        key: 'facebook-page:shop',
        id: 'shop',
        channelType: 'FACEBOOK_PAGE',
        name: 'Shop Facebook',
        avatarUrl: null,
        externalAccountId: '2',
        status: 'CONNECTED',
        conversationCount: 30,
        unreadMessageCount: 5,
      },
    ];
    const rows = accounts.map((a, i) => ({
      id: `chat${i}`,
      connectionId: null,
      channelAccountId: a.id,
      channelType: a.channelType,
      accountName: a.name,
      accountAvatar: null,
      accountExternalId: a.externalAccountId,
      externalUserId: `user${i}`,
      customerName: i ? 'Khách Facebook' : 'Khách Zalo',
      customerAvatar: null,
      lastMessageAt: '2026-11-07T00:00:00Z',
      lastMessagePreview: 'Tin cần đọc',
      inboxUnreadCount: a.unreadMessageCount,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/accounts')) return response({ accounts });
        const key = new URL(url, 'http://localhost').searchParams.get(
          'account',
        );
        return response({
          items: rows.filter(
            (r) => !key || key.endsWith(':' + r.channelAccountId),
          ),
          page: 1,
          limit: 30,
          hasMore: false,
        });
      }),
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
    expect(
      await screen.findByLabelText('Tổng 8 tin chưa đọc'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('3 tin chưa đọc')).toBeInTheDocument();
    expect(screen.getByLabelText('5 tin chưa đọc')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tài khoản' }));
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: /Zalo công việc/ }),
    );
    expect(
      await screen.findByLabelText('Tổng 3 tin chưa đọc'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByLabelText('5 tin chưa đọc')).not.toBeInTheDocument(),
    );
    client.clear();
  });
});
