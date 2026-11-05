import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AppsPage } from './apps';
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const accounts = [
    {
      key: 'personal:accounta',
      id: 'accounta',
      name: 'Tài khoản công việc',
      channelType: 'ZALO_PERSONAL',
      avatarUrl: 'https://example.com/account.jpg',
      externalAccountId: '111',
      status: 'CONNECTED',
      conversationCount: 3,
    },
    {
      key: 'oa:accountb',
      id: 'accountb',
      name: 'Cửa hàng',
      channelType: 'ZALO_OA',
      avatarUrl: null,
      externalAccountId: '222',
      status: 'DISCONNECTED',
      conversationCount: 2,
    },
  ];
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: { accounts } }),
  }));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, fetcher, ...view };
}
describe('application connection hub', () => {
  it('offers Zalo and Page setup, labels personal Messenger unavailable, and disables future providers', async () => {
    const { client, fetcher } = setup();
    const apps = screen.getByRole('region', { name: 'Danh sách ứng dụng' });
    expect(within(apps).getByRole('link', { name: 'Cá nhân' })).toHaveAttribute(
      'href',
      '/personal',
    );
    expect(
      within(apps).getByRole('link', { name: 'Official Account' }),
    ).toHaveAttribute('href', '/connection');
    expect(
      within(apps)
        .getAllByRole('button', { name: 'Sắp hỗ trợ' })
        .filter((button) => button.hasAttribute('disabled')),
    ).toHaveLength(3);
    expect(
      within(apps).getByRole('link', { name: 'Facebook Page' }),
    ).toHaveAttribute('href', '/facebook/page');
    expect(
      within(apps).getByRole('link', { name: 'Messenger cá nhân Chưa hỗ trợ' }),
    ).toHaveAttribute('href', '/facebook/personal');
    const own = screen.getByRole('region', { name: 'Tài khoản của bạn' });
    expect(
      await within(own).findByText('Tài khoản công việc'),
    ).toBeInTheDocument();
    expect(
      within(own)
        .getAllByRole('link', { name: 'Mở hộp thư' })
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/inbox?account=personal%3Aaccounta',
      '/inbox?account=oa%3Aaccountb',
    ]);
    expect(within(own).getByText('Chưa kết nối')).toBeInTheDocument();
    expect(within(own).getByText('Đang kết nối')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it('searches and filters the application catalog without pretending unavailable integrations can connect', async () => {
    const { client } = setup();
    const apps = screen.getByRole('region', { name: 'Danh sách ứng dụng' });
    fireEvent.change(
      within(apps).getByRole('textbox', { name: 'Tìm ứng dụng' }),
      { target: { value: 'Instagram' } },
    );
    expect(
      within(apps).getByRole('heading', { name: 'Instagram' }),
    ).toBeInTheDocument();
    expect(
      within(apps).queryByRole('heading', { name: 'Zalo' }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(apps).getByRole('button', { name: 'Đang hỗ trợ' }));
    expect(
      within(apps).getByText('Không tìm thấy ứng dụng'),
    ).toBeInTheDocument();
    fireEvent.click(within(apps).getByRole('button', { name: 'Xóa bộ lọc' }));
    expect(
      within(apps).getByRole('heading', { name: 'Zalo' }),
    ).toBeInTheDocument();
    expect(
      within(apps).getByRole('heading', { name: 'Email' }),
    ).toBeInTheDocument();
    client.clear();
  });
});
