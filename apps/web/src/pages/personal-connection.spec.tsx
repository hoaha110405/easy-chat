import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PersonalConnectionPage } from './personal-connection';
afterEach(() => vi.unstubAllGlobals());
describe('personal QR connection UI', () => {
  it('shows the secure QR and a cancel action for an active account', async () => {
    const account = {
      id: 'personal-account',
      name: 'Fixture account',
      externalAccountId: null,
      connectionStatus: 'QR_PENDING',
      qrStatus: 'GENERATED',
      qrImage: 'data:image/png;base64,aGVsbG8=',
      qrExpiresAt: new Date(Date.now() + 60000).toISOString(),
      lastConnectedAt: null,
      lastError: null,
      workerOnline: true,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { enabled: true, workerOnline: true, accounts: [account] },
        }),
      })),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PersonalConnectionPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('img', {
        name: 'Quét mã QR bằng ứng dụng Zalo',
      }),
    ).toHaveAttribute('src', account.qrImage);
    expect(screen.getByRole('button', { name: 'Hủy đăng nhập' })).toBeEnabled();
    client.clear();
  });
});
