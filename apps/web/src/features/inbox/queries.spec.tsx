import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConversations, useMessages } from './queries';

afterEach(() => vi.unstubAllGlobals());

function PaginationControls() {
  const conversations = useConversations(
    'facebook-page:account',
    'FACEBOOK_PAGE',
  );
  const messages = useMessages('conversation');
  return (
    <>
      <button
        disabled={!conversations.hasNextPage}
        onClick={() => void conversations.fetchNextPage()}
      >
        Hội thoại tiếp theo
      </button>
      <button
        disabled={!messages.hasNextPage}
        onClick={() => void messages.fetchNextPage()}
      >
        Tin nhắn trước
      </button>
      <span>
        {conversations.data?.pages.flatMap((page) => page.items).length ?? 0}{' '}
        hội thoại
      </span>
      <span>
        {messages.data?.pages.flatMap((page) => page.items).length ?? 0} tin
        nhắn
      </span>
    </>
  );
}

describe('inbox cursor pagination', () => {
  it('preserves account and channel filters while using server cursors for older conversations and messages', async () => {
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      const isMessage = url.pathname.endsWith('/messages');
      const older = url.searchParams.has('cursor');
      const item = isMessage
        ? {
            id: older ? 'oldmessage' : 'newmessage',
            externalMessageId: null,
            direction: 'INCOMING',
            type: 'text',
            content: 'Tin nhắn',
            sentAt: '2026-11-05T00:00:00Z',
            source: 'FACEBOOK',
            attachments: [],
          }
        : {
            id: older ? 'oldconversation' : 'newconversation',
            connectionId: null,
            channelType: 'FACEBOOK_PAGE',
            externalUserId: '12345',
            customerName: null,
            customerAvatar: null,
            lastMessageAt: null,
            lastMessagePreview: null,
          };
      return {
        ok: true,
        json: async () => ({
          data: {
            items: [item],
            page: older ? 2 : 1,
            limit: isMessage ? 50 : 30,
            hasMore: !older,
            nextCursor: older
              ? null
              : isMessage
                ? 'message+cursor/=='
                : 'conversation+cursor/==',
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
        <PaginationControls />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Hội thoại tiếp theo' }),
      ).toBeEnabled(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Tin nhắn trước' }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Hội thoại tiếp theo' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tin nhắn trước' }));
    expect(await screen.findByText('2 hội thoại')).toBeInTheDocument();
    expect(await screen.findByText('2 tin nhắn')).toBeInTheDocument();
    const olderRequests = fetcher.mock.calls
      .map(([input]) => new URL(input, 'http://localhost'))
      .filter((url) => url.searchParams.has('cursor'));
    expect(olderRequests).toHaveLength(2);
    const conversationsUrl = olderRequests.find(
      (url) => !url.pathname.endsWith('/messages'),
    )!;
    expect(conversationsUrl.searchParams.get('cursor')).toBe(
      'conversation+cursor/==',
    );
    expect(conversationsUrl.searchParams.get('account')).toBe(
      'facebook-page:account',
    );
    expect(conversationsUrl.searchParams.get('channelType')).toBe(
      'FACEBOOK_PAGE',
    );
    expect(
      olderRequests
        .find((url) => url.pathname.endsWith('/messages'))
        ?.searchParams.get('cursor'),
    ).toBe('message+cursor/==');
    client.clear();
  });
});
