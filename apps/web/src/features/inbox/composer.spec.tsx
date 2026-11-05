import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationComposer, DeliveryState } from './composer';
import type { InboxMessage } from '@zalo/shared';
const message: InboxMessage = {
  id: 'message',
  externalMessageId: null,
  content: 'Personal reply',
  type: 'text',
  direction: 'OUTGOING',
  source: 'PERSONAL',
  sentAt: '2026-11-05T00:00:00.000Z',
  attachments: [],
  deliveryStatus: 'PENDING',
};
afterEach(() => vi.unstubAllGlobals());
describe('personal message composer', () => {
  it('uses Enter to send but keeps Shift+Enter and composing input from sending a message', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ data: message }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ConversationComposer
          conversationId="conversation"
          canSend
          onOptimistic={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const input = screen.getByLabelText('Tin nhắn');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    client.clear();
  });
  it('queues text and displays an optimistic pending message', async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({
      ok: true,
      status: 202,
      json: async () => ({ data: message }),
    }));
    vi.stubGlobal('fetch', fetch);
    const optimistic = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ConversationComposer
          conversationId="conversation"
          canSend
          onOptimistic={optimistic}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Tin nhắn'), {
      target: { value: 'Personal reply' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() =>
      expect(optimistic).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Personal reply',
          deliveryStatus: 'PENDING',
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Tin nhắn')).toHaveValue(''),
    );
    const request = JSON.parse(String(fetch.mock.calls[0][1].body));
    expect(request.content).toBe('Personal reply');
    expect(request.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    client.clear();
  });
  it('uses the same idempotency key to check a request after a transport failure', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ data: message }),
      });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ConversationComposer
          conversationId="conversation"
          canSend
          onOptimistic={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Tin nhắn'), {
      target: { value: 'Personal reply' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Kiểm tra yêu cầu' }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    client.clear();
  });
  it('does not offer retry for UNKNOWN deliveries and disables disconnected sends', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <DeliveryState
          message={{ ...message, deliveryStatus: 'UNKNOWN' }}
          conversationId="conversation"
        />
        <ConversationComposer
          conversationId="conversation"
          canSend={false}
          onOptimistic={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole('button', { name: 'Thử lại' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
    expect(screen.getByLabelText('Tin nhắn')).toBeDisabled();
    client.clear();
  });
});
