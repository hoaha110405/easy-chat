import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { channelMediaSupport } from '@zalo/shared';
import { ConversationComposer } from './composer';
const message = {
  id: 'cmedia',
  externalMessageId: null,
  direction: 'OUTGOING',
  type: 'file',
  content: '',
  source: 'PERSONAL',
  sentAt: '2026-11-07T00:00:00Z',
  attachments: [],
  deliveryStatus: 'PENDING',
};
function setup(type: string, canSend = true, mediaCanSend = canSend) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConversationComposer
        conversationId="cchat"
        channelType={type}
        canSend={canSend}
        mediaSupport={{ ...channelMediaSupport(type), canSend: mediaCanSend }}
        onOptimistic={() => {}}
      />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('shared attachment actions', () => {
  it.each([
    ['ZALO_PERSONAL', 'Zalo'],
    ['FACEBOOK_PAGE', 'Facebook'],
    ['TELEGRAM_BOT', 'Telegram'],
    ['TELEGRAM_PERSONAL', 'Telegram'],
  ])(
    'uploads a document for %s through the common endpoint',
    async (type, provider) => {
      const fetcher = vi.fn(async () => ({
        ok: true,
        status: 202,
        json: async () => ({ data: message }),
      }));
      vi.stubGlobal('fetch', fetcher);
      const client = setup(type);
      fireEvent.change(screen.getByLabelText(`Chọn tài liệu ${provider}`), {
        target: {
          files: [
            new File(['%PDF-fixture'], 'invoice.pdf', {
              type: 'application/pdf',
            }),
          ],
        },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const [url, options] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/conversations/cchat/media');
      expect((options.body as FormData).get('kind')).toBe('document');
      expect(options.headers).not.toHaveProperty('Content-Type');
      client.clear();
    },
  );
  it('enables an OA document independently from text and disables unsupported OA audio', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ data: message }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const client = setup('ZALO_OA', false, true);
    expect(screen.getByRole('button', { name: 'Tài liệu' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Âm thanh' })).toBeDisabled();
    expect(screen.getByText(/Tài liệu ≤ 5 MB/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Chọn tài liệu Zalo'), {
      target: {
        files: [
          new File(['%PDF-fixture'], 'invoice.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });
    expect(screen.getByLabelText('Tin nhắn')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    client.clear();
  });
  it.each(['TIKTOK_SHOP', 'TIKTOK_BUSINESS', 'FACEBOOK_PERSONAL'])(
    'explains API restrictions instead of showing a working upload for %s',
    (type) => {
      const client = setup(type);
      expect(screen.getByRole('button', { name: 'Tài liệu' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Âm thanh' })).toBeDisabled();
      expect(screen.getByText(/(?:API|chưa được)/)).toBeInTheDocument();
      client.clear();
    },
  );
});
