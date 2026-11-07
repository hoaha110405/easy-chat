import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationComposer } from './composer';
import { MessageAttachment } from './message-attachment';
const message = {
  id: 'cmediafixture',
  externalMessageId: null,
  type: 'file',
  direction: 'OUTGOING',
  content: '',
  source: 'WHATSAPP',
  sentAt: '2026-11-07T00:00:00Z',
  attachments: [],
  deliveryStatus: 'PENDING',
};
function setup(canSend = true, source: 'WHATSAPP' | 'PERSONAL' = 'WHATSAPP') {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const optimistic = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ConversationComposer
        conversationId="cchatfixture"
        canSend={canSend}
        sendBlockedReason={canSend ? null : 'WHATSAPP_WINDOW_CLOSED'}
        source={source}
        onOptimistic={optimistic}
      />
    </QueryClientProvider>,
  );
  return { client, optimistic };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('WhatsApp document and audio composer', () => {
  it('sends a document with its caption as multipart and clears the selected file after acceptance', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: message }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const { client, optimistic } = setup();
    fireEvent.change(screen.getByLabelText('Chọn tài liệu WhatsApp'), {
      target: {
        files: [
          new File(['%PDF-fixture'], 'invoice.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });
    fireEvent.change(screen.getByLabelText('Tin nhắn'), {
      target: { value: 'Hóa đơn' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [url, options] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ],
      body = options.body as FormData;
    expect(url).toBe('/api/conversations/cchatfixture/whatsapp/media');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('kind')).toBe('document');
    expect(body.get('caption')).toBe('Hóa đơn');
    expect((body.get('file') as File).name).toBe('invoice.pdf');
    expect(options.headers).not.toHaveProperty('Content-Type');
    expect(options.credentials).toBe('include');
    expect(optimistic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        attachments: [expect.objectContaining({ name: 'invoice.pdf' })],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Bỏ tệp đính kèm' }),
      ).not.toBeInTheDocument(),
    );
    client.clear();
  });
  it('sends audio as its own message and uses the native player for received audio', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ...message, type: 'audio' } }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const { client } = setup();
    fireEvent.change(screen.getByLabelText('Chọn âm thanh WhatsApp'), {
      target: {
        files: [
          new File(['ID3fixture'], 'recording.mp3', { type: 'audio/mpeg' }),
        ],
      },
    });
    expect(screen.getByLabelText('Tin nhắn')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const body = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as FormData;
    expect(body.get('kind')).toBe('audio');
    expect(body.get('caption')).toBe('');
    render(
      <MessageAttachment
        attachment={{
          type: 'audio',
          url: null,
          name: 'received.mp3',
          authenticatedPath: '/channels/whatsapp/messages/cmediafixture/media',
        }}
      />,
    );
    expect(screen.getByLabelText('received.mp3')).toHaveAttribute(
      'src',
      '/api/channels/whatsapp/messages/cmediafixture/media',
    );
    expect(screen.getByLabelText('received.mp3').tagName).toBe('AUDIO');
    client.clear();
  });
  it('keeps the same attachment and idempotency key while resolving an unconfirmed upload request', async () => {
    const calls: FormData[] = [];
    const fetcher = vi.fn(async (_url: string, o: RequestInit) => {
      calls.push(o.body as FormData);
      if (calls.length === 1) throw Error('network');
      return { ok: true, status: 200, json: async () => ({ data: message }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const { client } = setup();
    fireEvent.change(screen.getByLabelText('Chọn tài liệu WhatsApp'), {
      target: {
        files: [
          new File(['%PDF-fixture'], 'invoice.pdf', {
            type: 'application/pdf',
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi' }));
    await screen.findByRole('button', { name: 'Kiểm tra yêu cầu' });
    expect(
      screen.getByRole('button', { name: 'Bỏ tệp đính kèm' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra yêu cầu' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].get('idempotencyKey')).toBe(calls[1].get('idempotencyKey'));
    expect(calls[0].get('file')).toBe(calls[1].get('file'));
    client.clear();
  });
  it('rejects unsupported selections and requires text to be sent separately from audio', async () => {
    const { client } = setup();
    fireEvent.change(screen.getByLabelText('Chọn tài liệu WhatsApp'), {
      target: { files: [new File(['binary'], 'program.exe')] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('20 MB');
    expect(screen.getByRole('button', { name: 'Gửi' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tin nhắn'), {
      target: { value: 'Draft remains' },
    });
    fireEvent.change(screen.getByLabelText('Chọn âm thanh WhatsApp'), {
      target: {
        files: [new File(['ID3'], 'sound.mp3', { type: 'audio/mpeg' })],
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Âm thanh không kèm chú thích',
    );
    expect(screen.getByLabelText('Tin nhắn')).toHaveValue('Draft remains');
    client.clear();
  });
  it('disables attachment actions outside the WhatsApp reply window', () => {
    const { client } = setup(false);
    expect(screen.getByRole('button', { name: 'Tài liệu' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Âm thanh' })).toBeDisabled();
    client.clear();
  });
  it('offers Zalo attachment actions through the common composer', () => {
    const { client } = setup(true, 'PERSONAL');
    expect(screen.getByRole('button', { name: 'Tài liệu' })).toBeEnabled();
    expect(screen.getByLabelText('Chọn tài liệu Zalo')).toBeInTheDocument();
    client.clear();
  });
});
