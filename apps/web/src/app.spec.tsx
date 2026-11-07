import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
afterEach(() => vi.unstubAllGlobals());
describe('workspace authentication flow', () => {
  it('opens WhatsApp from the compact inbox without a connected account and returns after sign-out', async () => {
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
                : input.endsWith('/channels/whatsapp')
                  ? {
                      enabled: true,
                      configured: false,
                      embeddedAvailable: false,
                      embeddedStatus: 'CONFIGURATION_OR_APPROVAL_REQUIRED',
                      workerOnline: true,
                      accounts: [],
                      selection: null,
                      restrictions: [],
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
    const whatsapp = screen.getByRole('link', {
      name: 'WhatsApp',
    });
    expect(whatsapp).toHaveAttribute('href', '/whatsapp');
    fireEvent.click(whatsapp);
    expect(
      await screen.findByRole('heading', {
        name: 'Chưa cấu hình WhatsApp Business',
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(
        screen.getByRole('navigation', { name: 'Điều hướng chính' }),
      ).getByRole('link', { name: 'Hộp thư' }),
    );
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
