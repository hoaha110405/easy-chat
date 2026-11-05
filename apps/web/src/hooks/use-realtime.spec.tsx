import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRealtime } from './use-realtime';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('authenticated SSE invalidation', () => {
  it('refreshes stored state on reconnect and message events, then closes the stream', async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    class FakeSource {
      onmessage: ((event: { data: string }) => void) | null = null;
      close = vi.fn();
      constructor(
        readonly url: string,
        readonly options: EventSourceInit,
      ) {
        sources.push(this);
      }
    }
    vi.stubGlobal('EventSource', FakeSource);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    function Component() {
      useRealtime();
      return null;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
    const source = sources[0];
    expect(source?.options.withCredentials).toBe(true);
    expect(source?.url).toBe('/api/events');
    await act(async () => {
      source?.onmessage?.({
        data: JSON.stringify({
          type: 'message.created',
          conversationId: 'conversation',
        }),
      });
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(source?.close).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
