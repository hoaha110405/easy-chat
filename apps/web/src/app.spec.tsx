import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
afterEach(() => vi.unstubAllGlobals());
describe('workspace authentication flow', () => {
  it('moves from sign-in into the inbox, then back after sign-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/auth/session'))
          return {
            ok: false,
            status: 401,
            json: async () => ({
              error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' },
            }),
          };
        const data = input.endsWith('/auth/login')
          ? { authenticated: true }
          : input.endsWith('/auth/logout')
            ? { authenticated: false }
            : input.includes('/conversations/accounts')
              ? { accounts: [] }
              : input.includes('/zalo/status')
                ? {
                    configured: false,
                    webhookConfigured: false,
                    connection: null,
                    failedWebhookCount: 0,
                  }
                : { items: [], page: 1, limit: 30, hasMore: false };
        return { ok: true, status: 200, json: async () => ({ data }) };
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Mật khẩu quản trị'), {
      target: { value: 'fixture-admin-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Vào không gian làm việc' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Hộp thư' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mở rộng thanh điều hướng' }),
    );
    expect(
      screen.getByRole('button', { name: 'Thu gọn thanh điều hướng' }),
    ).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(
      screen.getByRole('button', { name: 'Thu gọn thanh điều hướng' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Phóng to hội thoại' }));
    expect(
      screen.queryByRole('complementary', { name: 'Thanh điều hướng' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Thu nhỏ hội thoại' }));
    expect(
      screen.getByRole('complementary', { name: 'Thanh điều hướng' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Đăng xuất' })[0]);
    expect(
      await screen.findByLabelText('Mật khẩu quản trị'),
    ).toBeInTheDocument();
    client.clear();
  });
});
