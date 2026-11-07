import { useRef, useState, type FormEvent } from 'react';
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  messageSchema,
  channelMediaSupport,
  type MediaSupport,
  type InboxMessage,
  type Paginated,
} from '@zalo/shared';
import { Send, RefreshCw, Paperclip, Music2, X, FileText } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api';
import { sendBlockedMessage } from '@/lib/channels';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/feedback';
type RequestMessage = {
  content: string;
  idempotencyKey: string;
  file?: File;
  kind?: 'document' | 'audio';
};
function pendingMessage(
  input: RequestMessage,
  source: InboxMessage['source'],
  unknown = false,
): InboxMessage {
  return {
    id: `client:${input.idempotencyKey}`,
    externalMessageId: null,
    idempotencyKey: input.idempotencyKey,
    direction: 'OUTGOING',
    type: input.file ? (input.kind === 'audio' ? 'audio' : 'file') : 'text',
    content: input.content,
    sentAt: new Date().toISOString(),
    source,
    attachments: input.file
      ? [
          {
            type: input.kind === 'audio' ? 'audio' : 'file',
            url: null,
            name: input.file.name,
          },
        ]
      : [],
    deliveryStatus: unknown ? 'UNKNOWN' : 'PENDING',
    deliveryError: unknown ? 'REQUEST_UNCONFIRMED' : null,
  };
}
export function ConversationComposer({
  conversationId,
  canSend,
  sendBlockedReason,
  source = 'PERSONAL',
  channelType,
  mediaSupport,
  onOptimistic,
}: {
  conversationId: string;
  canSend: boolean;
  sendBlockedReason?: string | null;
  source?: InboxMessage['source'];
  channelType?: string;
  mediaSupport?: MediaSupport;
  onOptimistic: (message: InboxMessage | null) => void;
}) {
  const client = useQueryClient();
  const type =
    channelType ??
    (
      {
        WHATSAPP: 'WHATSAPP_BUSINESS',
        PERSONAL: 'ZALO_PERSONAL',
        FACEBOOK: 'FACEBOOK_PAGE',
        TELEGRAM: 'TELEGRAM_BOT',
        TIKTOK: 'TIKTOK_BUSINESS',
        WEBHOOK: 'ZALO_OA',
        HISTORY: 'ZALO_OA',
      } as Record<string, string>
    )[source];
  const support = mediaSupport ?? { ...channelMediaSupport(type), canSend };
  const provider =
    type === 'WHATSAPP_BUSINESS'
      ? 'WhatsApp'
      : type.startsWith('ZALO_')
        ? 'Zalo'
        : type.startsWith('TELEGRAM_')
          ? 'Telegram'
          : type.startsWith('FACEBOOK_')
            ? 'Facebook'
            : 'TikTok';
  const captionAllowed = (kind: 'document' | 'audio') =>
    support.captions && (kind === 'document' || type !== 'WHATSAPP_BUSINESS');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<{
    file: File;
    kind: 'document' | 'audio';
  } | null>(null);
  const [fileError, setFileError] = useState('');
  const documentInput = useRef<HTMLInputElement>(null),
    audioInput = useRef<HTMLInputElement>(null);
  const maxLength = selected ? 1024 : 2000;
  function chooseFile(file: File | undefined, kind: 'document' | 'audio') {
    if (!file) return;
    const extensions = (
      kind === 'audio' ? support.audioAccept : support.documentAccept
    ).split(',');
    const limit =
      kind === 'audio' ? support.audioMaxBytes : support.documentMaxBytes;
    if (
      !support[kind] ||
      !extensions.includes(
        '.' + (file.name.split('.').at(-1)?.toLowerCase() ?? ''),
      ) ||
      file.size < 1 ||
      file.size > limit
    ) {
      setFileError(
        kind === 'audio'
          ? `Chọn ${support.audioAccept}, tối đa ${limit / 1_000_000} MB.`
          : `Chọn ${support.documentAccept}, tối đa ${limit / 1_000_000} MB.`,
      );
      return;
    }
    if (!captionAllowed(kind) && draft.trim()) {
      setFileError(
        kind === 'audio'
          ? 'Gửi hoặc xóa nội dung văn bản trước khi chọn âm thanh. Âm thanh không kèm chú thích.'
          : 'Gửi hoặc xóa văn bản trước. Tài liệu trên kênh này gửi thành tin riêng.',
      );
      return;
    }
    if (captionAllowed(kind) && draft.length > 1024) {
      setFileError(
        'Chú thích tài liệu tối đa 1024 ký tự. Hãy rút ngắn nội dung trước.',
      );
      return;
    }
    setSelected({ file, kind });
    setFileError('');
  }
  const [unconfirmed, setUnconfirmed] = useState<RequestMessage | null>(null);
  const send = useMutation({
    mutationFn: (input: RequestMessage) => {
      if (input.file) {
        const body = new FormData();
        body.set('file', input.file);
        body.set('kind', input.kind!);
        body.set('caption', input.content);
        body.set('idempotencyKey', input.idempotencyKey);
        return api(
          type === 'WHATSAPP_BUSINESS'
            ? `/conversations/${conversationId}/whatsapp/media`
            : `/conversations/${conversationId}/media`,
          messageSchema,
          { method: 'POST', body },
        );
      }
      return api(`/conversations/${conversationId}/messages`, messageSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onMutate: (input) => {
      onOptimistic(pendingMessage(input, source));
    },
    onSuccess: (message) => {
      client.setQueryData<InfiniteData<Paginated<InboxMessage>>>(
        ['messages', conversationId],
        (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page, i) =>
                  i === 0
                    ? {
                        ...page,
                        items: [
                          message,
                          ...page.items.filter(
                            (item) => item.id !== message.id,
                          ),
                        ],
                      }
                    : page,
                ),
              }
            : old,
      );
      onOptimistic(null);
      setUnconfirmed(null);
      setDraft('');
      setSelected(null);
      setFileError('');
      void client.invalidateQueries({ queryKey: ['messages', conversationId] });
      void client.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (error, input) => {
      const rejected =
        error instanceof ApiClientError &&
        error.status >= 400 &&
        error.status < 500;
      if (rejected) {
        onOptimistic(null);
        setUnconfirmed(null);
      } else {
        setUnconfirmed(input);
        onOptimistic(pendingMessage(input, source, true));
      }
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    const input = unconfirmed ?? {
      content: draft.trim(),
      idempotencyKey: crypto.randomUUID(),
      ...(selected ?? {}),
    };
    if (
      (!input.content && !input.file) ||
      (!(input.file ? support.canSend : canSend) && !unconfirmed)
    )
      return;
    send.mutate(input);
  }
  return (
    <form onSubmit={submit} className="shrink-0 bg-white px-4 pb-3 pt-2">
      {send.error ? (
        <div className="mb-3">
          <ErrorNotice error={send.error} />
        </div>
      ) : null}
      {unconfirmed ? (
        <p role="status" className="mb-3 text-xs leading-5 text-amber-800">
          Chưa xác nhận được yêu cầu gửi. Hãy kiểm tra lại yêu cầu này trước khi
          gửi tin mới để tránh trùng lặp.
        </p>
      ) : null}
      {
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            ref={documentInput}
            type="file"
            aria-label={`Chọn tài liệu ${provider}`}
            className="sr-only"
            tabIndex={-1}
            accept={support.documentAccept}
            disabled={
              !support.document ||
              !support.canSend ||
              send.isPending ||
              Boolean(unconfirmed)
            }
            onChange={(e) => {
              chooseFile(e.target.files?.[0], 'document');
              e.target.value = '';
            }}
          />
          <input
            ref={audioInput}
            type="file"
            aria-label={`Chọn âm thanh ${provider}`}
            className="sr-only"
            tabIndex={-1}
            accept={support.audioAccept}
            disabled={
              !support.audio ||
              !support.canSend ||
              send.isPending ||
              Boolean(unconfirmed)
            }
            onChange={(e) => {
              chooseFile(e.target.files?.[0], 'audio');
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => documentInput.current?.click()}
            disabled={
              !support.document ||
              !support.canSend ||
              send.isPending ||
              Boolean(unconfirmed)
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            <Paperclip className="size-3.5" />
            Tài liệu
          </button>
          <button
            type="button"
            onClick={() => audioInput.current?.click()}
            disabled={
              !support.audio ||
              !support.canSend ||
              send.isPending ||
              Boolean(unconfirmed)
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            <Music2 className="size-3.5" />
            Âm thanh
          </button>
          <span className="text-[10px] text-slate-400">
            {support.document
              ? `Tài liệu ≤ ${support.documentMaxBytes / 1_000_000} MB`
              : 'Tài liệu chưa hỗ trợ'}{' '}
            ·{' '}
            {support.audio
              ? `Âm thanh ≤ ${support.audioMaxBytes / 1_000_000} MB`
              : 'Âm thanh chưa hỗ trợ'}
          </span>
        </div>
      }
      {support.reason ? (
        <p role="status" className="mb-2 text-[11px] text-slate-500">
          {support.reason}
        </p>
      ) : null}
      {fileError ? (
        <p role="alert" className="mb-2 text-xs text-red-700">
          {fileError}
        </p>
      ) : null}
      {selected ? (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-teal-100 bg-teal-50 px-3 py-2 text-xs">
          {selected.kind === 'audio' ? (
            <Music2 className="size-4 shrink-0" />
          ) : (
            <FileText className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {selected.file.name} · {(selected.file.size / 1_000_000).toFixed(2)}{' '}
            MB
          </span>
          <button
            type="button"
            aria-label="Bỏ tệp đính kèm"
            disabled={send.isPending || Boolean(unconfirmed)}
            onClick={() => {
              setSelected(null);
              setFileError('');
            }}
            className="rounded p-1 hover:bg-teal-100 disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      <div className="flex items-end gap-3">
        <label htmlFor="message-draft" className="sr-only">
          Tin nhắn
        </label>
        <textarea
          id="message-draft"
          rows={2}
          maxLength={maxLength}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={
            send.isPending ||
            Boolean(unconfirmed) ||
            (selected
              ? !support.canSend || !captionAllowed(selected.kind)
              : !canSend)
          }
          placeholder={
            !canSend
              ? 'Hiện chưa thể trả lời hội thoại này'
              : selected && !captionAllowed(selected.kind)
                ? 'Tệp đính kèm gửi thành tin riêng'
                : selected
                  ? 'Thêm chú thích cho tài liệu…'
                  : 'Nhập tin nhắn…'
          }
          className="min-h-[56px] flex-1 resize-none rounded-xl border border-slate-200/80 bg-slate-50/60 px-3.5 py-2 text-[13px] leading-5 outline-none transition-colors placeholder:text-slate-500 focus:border-teal-300 focus:bg-white focus:ring-2 focus:ring-teal-50 disabled:text-slate-400"
        />
        <Button
          type="submit"
          disabled={
            send.isPending ||
            (!unconfirmed &&
              (!(selected ? support.canSend : canSend) ||
                (!draft.trim() && !selected)))
          }
        >
          {unconfirmed ? <RefreshCw /> : <Send />}
          {send.isPending
            ? 'Đang gửi…'
            : unconfirmed
              ? 'Kiểm tra yêu cầu'
              : 'Gửi'}
        </Button>
      </div>
      {!canSend && !selected ? (
        <p role="status" className="mt-2 text-[11px] leading-5 text-amber-800">
          {sendBlockedMessage(sendBlockedReason)}
        </p>
      ) : null}
      <p className="mt-1 text-right text-[10px] text-slate-400">
        {selected?.kind === 'audio' ? (
          'Bấm Gửi để gửi tệp âm thanh'
        ) : (
          <>
            Enter để gửi · Shift + Enter để xuống dòng · {draft.length}/
            {maxLength}
          </>
        )}
      </p>
    </form>
  );
}
export function DeliveryState({
  message,
  conversationId,
}: {
  message: InboxMessage;
  conversationId: string;
}) {
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: () =>
      api(
        `/conversations/${conversationId}/messages/${message.id}/retry`,
        messageSchema,
        { method: 'POST' },
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['messages', conversationId] }),
  });
  const labels = {
    PENDING: 'Đang chờ gửi',
    SENDING: 'Đang gửi…',
    SENT: 'Đã gửi',
    DELIVERED: 'Đã giao',
    READ: 'Đã đọc',
    FAILED: 'Chưa gửi được',
    UNKNOWN:
      message.deliveryError === 'REQUEST_UNCONFIRMED'
        ? 'Chưa xác nhận yêu cầu'
        : 'Chưa rõ kết quả gửi — kiểm tra trên ứng dụng gốc',
  };
  const status = message.deliveryStatus ?? 'SENT';
  return (
    <div className="mt-1 text-[10px] text-slate-500">
      <span role="status">
        {message.readAt
          ? 'Đã xem'
          : message.deliveredAt
            ? 'Đã nhận'
            : message.source === 'WHATSAPP' &&
                status === 'SENT' &&
                message.providerStatus !== 'sent'
              ? 'Meta đã nhận yêu cầu'
              : labels[status]}
      </span>
      {status === 'FAILED' && message.deliveryError ? (
        <span className="ml-1">
          · {sendBlockedMessage(message.deliveryError)}
        </span>
      ) : null}
      {status === 'FAILED' &&
      ![
        'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED',
        'MEDIA_EXPIRED',
        'MEDIA_CHANNEL_UNSUPPORTED',
      ].includes(message.deliveryError ?? '') &&
      !message.id.startsWith('client:') ? (
        <button
          type="button"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
          className="ml-2 text-primary underline"
        >
          {retry.isPending ? 'Đang thử…' : 'Thử lại'}
        </button>
      ) : null}
      {retry.error ? (
        <p role="alert" className="mt-1 text-red-700">
          {retry.error.message}
        </p>
      ) : null}
    </div>
  );
}
