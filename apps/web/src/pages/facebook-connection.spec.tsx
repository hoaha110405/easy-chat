import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FacebookPageConnectionPage } from './facebook-page-connection';
import { FacebookPersonalConnectionPage } from './facebook-personal-connection';

const account = {
  id: 'pageaccount',
  name: 'Cửa hàng Facebook',
  avatarUrl: 'https://example.com/page.jpg',
  externalAccountId: '12345',
  channelType: 'FACEBOOK_PAGE',
  connectionStatus: 'CONNECTED',
  lastConnectedAt: '2026-11-05T00:00:00Z',
  lastSyncAt: null,
  lastError: null,
  lastSyncError: null,
  syncComplete: false,
  workerOnline: true,
};
const pageStatus = {
  configured: true,
  webhookConfigured: true,
  workerOnline: true,
  accounts: [],
  availablePages: [
    { id: '12345', name: account.name, avatarUrl: account.avatarUrl },
  ],
  selectionExpiresAt: '2099-01-01T00:00:00Z',
};
const personalStatus = {
  enabled: true,
  status: 'UNSUPPORTED',
  experimental: true,
  reasonCode: 'FACEBOOK_PERSONAL_UNSUPPORTED',
  library: null,
  message:
    'Chưa có thư viện Messenger cá nhân được kiểm chứng, bao gồm hội thoại mã hóa đầu cuối (E2EE).',
  capabilities: {
    connect: false,
    listConversations: false,
    history: false,
    receive: false,
    sendText: false,
    e2ee: false,
  },
};
function setup(kind: 'page' | 'personal' = 'page', entry = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        {kind === 'page' ? (
          <FacebookPageConnectionPage />
        ) : (
          <FacebookPersonalConnectionPage />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
function response(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}
afterEach(() => vi.unstubAllGlobals());

describe('Facebook channel setup', () => {
  it('connects only a server-provided Page and shows the account sync and inbox actions', async () => {
    let linked = false;
    const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
      if (input.endsWith('/facebook-page/select')) {
        linked = true;
        return response(account);
      }
      if (input.endsWith('/sync')) return response({ queued: true });
      if (options?.method === 'DELETE') {
        linked = false;
        return response({ disconnected: true });
      }
      return response({ ...pageStatus, accounts: linked ? [account] : [] });
    });
    vi.stubGlobal('fetch', fetcher);
    const client = setup('page', '/facebook/page?oauth=success');
    const chooser = await screen.findByRole('region', {
      name: 'Chọn Facebook Page',
    });
    fireEvent.click(
      within(chooser).getByRole('button', { name: 'Kết nối Page' }),
    );
    const own = screen.getByRole('region', { name: 'Facebook Page của bạn' });
    expect(await within(own).findByText(account.name)).toBeInTheDocument();
    expect(
      within(own).getByRole('link', { name: 'Mở hộp thư' }),
    ).toHaveAttribute('href', '/inbox?account=facebook-page%3Apageaccount');
    const request = fetcher.mock.calls.find(([url]) =>
      url.endsWith('/facebook-page/select'),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ pageId: '12345' });
    fireEvent.click(
      within(own).getByRole('button', { name: 'Tiếp tục đồng bộ' }),
    );
    expect(
      await within(own).findByText(/Đã xếp lịch đồng bộ/),
    ).toBeInTheDocument();
    fireEvent.click(within(own).getByRole('button', { name: 'Ngắt kết nối' }));
    expect(
      fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE'),
    ).toBe(false);
    fireEvent.click(
      within(own).getByRole('button', { name: 'Xác nhận ngắt kết nối' }),
    );
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, options]) =>
            url.endsWith('/channels/pageaccount') &&
            options?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    client.clear();
  });

  it('rejects an untrusted OAuth destination instead of leaving easyChat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        response(
          input.endsWith('/connect')
            ? { authorizationUrl: 'https://untrusted.example/dialog/oauth' }
            : pageStatus,
        ),
      ),
    );
    const client = setup();
    const connectButton = await screen.findByRole('button', {
      name: 'Kết nối Facebook Page',
    });
    await waitFor(() => expect(connectButton).toBeEnabled());
    fireEvent.click(connectButton);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Địa chỉ cấp quyền Facebook chưa hợp lệ',
    );
    client.clear();
  });

  it('disables unconfigured OAuth and preserves explicit webhook and history failure guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          ...pageStatus,
          configured: false,
          webhookConfigured: false,
          availablePages: [],
          accounts: [
            {
              ...account,
              connectionStatus: 'REAUTH_REQUIRED',
              lastError: 'FACEBOOK_PAGE_TOKEN_EXPIRED',
              lastSyncError: 'FACEBOOK_PAGE_TOKEN_EXPIRED',
            },
          ],
        }),
      ),
    );
    const client = setup(
      'page',
      '/facebook/page?error=FACEBOOK_PAGE_PERMISSION_DENIED',
    );
    expect(
      await screen.findByRole('button', { name: 'Kết nối Facebook Page' }),
    ).toBeDisabled();
    expect(
      await screen.findByText('Chưa sẵn sàng nhận tin nhắn mới'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Chưa được cấp đủ quyền cho Page/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Chưa đồng bộ được lịch sử/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Tiếp tục đồng bộ' }),
    ).toBeDisabled();
    client.clear();
  });

  it('reports personal Messenger unsupported even when enabled and never offers credential or QR collection', async () => {
    const fetcher = vi.fn(async () => response(personalStatus));
    vi.stubGlobal('fetch', fetcher);
    const client = setup('personal');
    expect(
      await screen.findByRole('button', {
        name: 'Kết nối Messenger cá nhân · Chưa hỗ trợ',
      }),
    ).toBeDisabled();
    const capabilities = screen.getByRole('region', {
      name: 'Khả năng Messenger cá nhân',
    });
    expect(within(capabilities).getAllByText('Chưa hỗ trợ')).toHaveLength(6);
    expect(
      screen.getByText('Hội thoại mã hóa đầu cuối (E2EE)'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Kết nối Facebook Page' }),
    ).toHaveAttribute('href', '/facebook/page');
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
