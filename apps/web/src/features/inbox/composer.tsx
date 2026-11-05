import { useState, type FormEvent } from 'react';
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { messageSchema, type InboxMessage, type Paginated } from '@zalo/shared';
import { Send, RefreshCw } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api';
import { sendBlockedMessage } from '@/lib/channels';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/feedback';
type RequestMessage = { content: string; idempotencyKey: string };
export function ConversationComposer({
  conversationId,
  canSend,
  sendBlockedReason,
  source = 'PERSONAL',
  onOptimistic,
}: {
  conversationId: string;
  canSend: boolean;
  sendBlockedReason?: string | null;
  source?: InboxMessage['source'];
  onOptimistic: (message: InboxMessage | null) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [unconfirmed, setUnconfirmed] = useState<RequestMessage | null>(null);
  const send = useMutation({
    mutationFn: (input: RequestMessage) =>
      api(`/conversations/${conversationId}/messages`, messageSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onMutate: (input) => {
      onOptimistic({
        id: `client:${input.idempotencyKey}`,
        externalMessageId: null,
        idempotencyKey: input.idempotencyKey,
        direction: 'OUTGOING',
        type: 'text',
        content: input.content,
        sentAt: new Date().toISOString(),
        source,
        attachments: [],
        deliveryStatus: 'PENDING',
        deliveryError: null,
      });
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
        onOptimistic({
          id: `client:${input.idempotencyKey}`,
          externalMessageId: null,
          idempotencyKey: input.idempotencyKey,
          direction: 'OUTGOING',
          type: 'text',
          content: input.content,
          sentAt: new Date().toISOString(),
          source,
          attachments: [],
          deliveryStatus: 'UNKNOWN',
          deliveryError: 'REQUEST_UNCONFIRMED',
        });
      }
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    const input = unconfirmed ?? {
      content: draft.trim(),
      idempotencyKey: crypto.randomUUID(),
    };
    if (!input.content || (!canSend && !unconfirmed)) return;
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
      <div className="flex items-end gap-3">
        <label htmlFor="message-draft" className="sr-only">
          Tin nhắn
        </label>
        <textarea
          id="message-draft"
          rows={2}
          maxLength={2000}
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
          disabled={send.isPending || Boolean(unconfirmed) || !canSend}
          placeholder={
            canSend ? 'Nhập tin nhắn…' : 'Hiện chưa thể trả lời hội thoại này'
          }
          className="min-h-[56px] flex-1 resize-none rounded-xl border border-slate-200/80 bg-slate-50/60 px-3.5 py-2 text-[13px] leading-5 outline-none transition-colors placeholder:text-slate-500 focus:border-teal-300 focus:bg-white focus:ring-2 focus:ring-teal-50 disabled:text-slate-400"
        />
        <Button
          type="submit"
          disabled={
            send.isPending || (!unconfirmed && (!canSend || !draft.trim()))
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
      {!canSend ? (
        <p role="status" className="mt-2 text-[11px] leading-5 text-amber-800">
          {sendBlockedMessage(sendBlockedReason)}
        </p>
      ) : null}
      <p className="mt-1 text-right text-[10px] text-slate-400">
        Enter để gửi · Shift + Enter để xuống dòng · {draft.length}/2000
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
            : labels[status]}
      </span>
      {status === 'FAILED' && message.deliveryError ? (
        <span className="ml-1">
          · {sendBlockedMessage(message.deliveryError)}
        </span>
      ) : null}
      {status === 'FAILED' &&
      message.deliveryError !== 'FACEBOOK_PAGE_MESSAGING_WINDOW_CLOSED' &&
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
