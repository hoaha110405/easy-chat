import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionPage } from './connection';
afterEach(() => vi.unstubAllGlobals());
describe('Zalo connection setup', () => {
  it('enables OAuth with application credentials while showing missing webhook setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            configured: true,
            webhookConfigured: false,
            connection: null,
            failedWebhookCount: 0,
          },
        }),
      })),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ConnectionPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('button', {
        name: 'Kết nối Zalo Official Account',
      }),
    ).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Để nhận tin nhắn mới, quản trị viên cần hoàn tất cấu hình',
    );
    client.clear();
  });
});
