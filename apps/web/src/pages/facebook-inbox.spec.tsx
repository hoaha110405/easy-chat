import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InboxPage } from './inbox';

afterEach(() => vi.unstubAllGlobals());
const conversation = {
  id: 'facebookchat',
  connectionId: null,
  channelAccountId: 'pageaccount',
  channelType: 'FACEBOOK_PAGE',
  accountName: 'Cửa hàng Page',
  accountAvatar: null,
  accountExternalId: '12345',
  canSend: true,
  sendBlockedReason: null,
  messagingWindowExpiresAt: '2099-01-01T00:00:00Z',
  externalUserId: '67890',
  customerName: 'Khách hàng Facebook',
  customerAvatar: null,
  lastMessageAt: '2026-11-05T00:00:00Z',
  lastMessagePreview: 'Tôi cần hỗ trợ',
};
function setup(canSend: boolean) {
  const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
    const selected = {
      ...conversation,
      canSend,
      sendBlockedReason: canSend
        ? null
        : 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED',
    };
    const data = input.endsWith('/conversations/accounts')
      ? {
          accounts: [
            {
              key: 'facebook-page:pageaccount',
              id: 'pageaccount',
              channelType: 'FACEBOOK_PAGE',
              name: 'Cửa hàng Page',
              avatarUrl: null,
              externalAccountId: '12345',
              status: 'CONNECTED',
              conversationCount: 1,
            },
          ],
        }
      : options?.method === 'POST'
        ? {
            id: 'outbound',
            externalMessageId: null,
            ...JSON.parse(String(options.body)),
            type: 'text',
            direction: 'OUTGOING',
            source: 'FACEBOOK',
            sentAt: '2026-11-05T00:01:00Z',
            attachments: [],
            deliveryStatus: 'PENDING',
          }
        : input.includes('/messages')
          ? { items: [], page: 1, limit: 50, hasMore: false }
          : { items: [selected], page: 1, limit: 30, hasMore: false };
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          '/inbox/facebookchat?focus=1&channelType=FACEBOOK_PAGE',
        ]}
      >
        <Routes>
          <Route path="/inbox/:conversationId?" element={<InboxPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetcher, client };
}
describe('Facebook in the shared inbox', () => {
  it('uses the Page identity and existing safe text composer while filtering channels on the server', async () => {
    const { client, fetcher } = setup(true);
    const draft = await screen.findByLabelText('Tin nhắn');
    expect(draft).toBeEnabled();
    expect(
      screen.getByText('Trong thời gian trả lời 24 giờ'),
    ).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([url]) =>
        url.includes('channelType=FACEBOOK_PAGE'),
      ),
    ).toBe(true);
    fireEvent.change(draft, { target: { value: 'Page trả lời' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, options]) =>
            url.endsWith('/conversations/facebookchat/messages') &&
            options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const request = fetcher.mock.calls.find(
      ([, options]) => options?.method === 'POST',
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      content: 'Page trả lời',
      idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    fireEvent.change(screen.getByLabelText('Lọc kênh'), {
      target: { value: 'ZALO_PERSONAL' },
    });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) =>
          url.includes('channelType=ZALO_PERSONAL'),
        ),
      ).toBe(true),
    );
    expect(screen.queryByLabelText('Tin nhắn')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Thu nhỏ hội thoại' }),
    ).toBeInTheDocument();
    client.clear();
  });
  it('clearly blocks Page replies when the 24-hour window closes', async () => {
    const { client, fetcher } = setup(false);
    expect(await screen.findByLabelText('Tin nhắn')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
    expect(
      screen.getByText(/Đã hết thời gian trả lời 24 giờ/),
    ).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([, options]) => options?.method === 'POST'),
    ).toBe(false);
    client.clear();
  });
});
