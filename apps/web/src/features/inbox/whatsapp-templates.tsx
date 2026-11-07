import { useState, useRef, type FormEvent } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  whatsappTemplatesSchema,
  messageSchema,
  type Conversation,
} from '@zalo/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice } from '@/components/feedback';
export function WhatsAppTemplates({
  conversation,
}: {
  conversation: Conversation;
}) {
  const [open, setOpen] = useState(false),
    [chosen, setChosen] = useState(''),
    [values, setValues] = useState<Record<string, string>>({}),
    [consent, setConsent] = useState(false);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const client = useQueryClient();
  const templates = useInfiniteQuery({
    queryKey: ['whatsapp-templates', conversation.channelAccountId],
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api(
        `/channels/${conversation.channelAccountId}/templates${pageParam ? `?after=${encodeURIComponent(pageParam)}` : ''}`,
        whatsappTemplatesSchema,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const items = templates.data?.pages.flatMap((p) => p.items) ?? [],
    selected = items.find((t) => t.id === chosen);
  const send = useMutation({
    mutationFn: () =>
      api(`/conversations/${conversation.id}/send-template`, messageSchema, {
        method: 'POST',
        body: JSON.stringify({
          templateId: selected!.id,
          templateName: selected!.name,
          language: selected!.language,
          parameters: selected!.variables.map((v) => ({
            ...v,
            value: values[v.component + ':' + v.name] ?? '',
          })),
          optInConfirmed: true,
          idempotencyKey: (() => {
            const signature = JSON.stringify({
              conversation: conversation.id,
              chosen,
              values,
            });
            if (intent.current?.signature !== signature)
              intent.current = { signature, key: crypto.randomUUID() };
            return intent.current.key;
          })(),
        }),
      }),
    onSuccess: () => {
      intent.current = null;
      setOpen(false);
      setConsent(false);
      setValues({});
      for (const key of ['messages', 'conversations', 'inbox-accounts'])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      selected &&
      selected.status === 'APPROVED' &&
      selected.supported &&
      consent
    )
      send.mutate();
  }
  return (
    <div className="border-t bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {conversation.canSend
            ? 'Có thể trả lời trong cửa sổ chăm sóc khách hàng.'
            : 'Tin tự do đang bị hạn chế. Mẫu đã duyệt vẫn cần quyền gửi và sự đồng ý phù hợp.'}
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          Chọn mẫu WhatsApp
        </Button>
      </div>
      {open ? (
        <form
          onSubmit={submit}
          className="mt-3 space-y-3 rounded-xl border bg-slate-50 p-4"
        >
          <label className="block text-xs font-medium">
            Mẫu tin nhắn
            <select
              aria-label="Mẫu WhatsApp đã duyệt"
              className="mt-2 h-10 w-full rounded-lg border bg-white px-3"
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                setValues({});
                setConsent(false);
              }}
            >
              <option value="">Chọn mẫu đã duyệt</option>
              {items.map((t) => (
                <option
                  key={t.id}
                  value={t.id}
                  disabled={t.status !== 'APPROVED' || !t.supported}
                >
                  {t.name} · {t.language} · {t.category} · {t.status}
                  {!t.supported ? ' · Chưa hỗ trợ loại mẫu này' : ''}
                </option>
              ))}
            </select>
          </label>
          {templates.isPending ? (
            <p className="text-xs">Đang tải mẫu từ Meta…</p>
          ) : null}
          {templates.error ? <ErrorNotice error={templates.error} /> : null}
          {templates.hasNextPage ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={templates.isFetchingNextPage}
              onClick={() => void templates.fetchNextPage()}
            >
              Tải thêm mẫu
            </Button>
          ) : null}
          {selected ? (
            <>
              <p className="whitespace-pre-wrap rounded-lg border bg-white p-3 text-xs leading-6">
                {selected.components
                  .map((c) => c.text ?? '')
                  .filter(Boolean)
                  .join('\n')}
              </p>
              {selected.variables.map((v) => (
                <label key={v.component + v.name} className="block text-xs">
                  {v.component === 'header' ? 'Tiêu đề' : 'Nội dung'} · {v.name}
                  <Input
                    aria-label={`Biến ${v.component} ${v.name}`}
                    value={values[v.component + ':' + v.name] ?? ''}
                    onChange={(e) =>
                      setValues((old) => ({
                        ...old,
                        [v.component + ':' + v.name]: e.target.value,
                      }))
                    }
                    required
                    maxLength={1000}
                  />
                </label>
              ))}
              <label className="flex items-start gap-2 text-xs leading-6">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1.5"
                />
                Tôi xác nhận người nhận đã đồng ý nhận loại thông báo này từ
                doanh nghiệp.
              </label>
              <Button
                disabled={
                  !consent ||
                  send.isPending ||
                  selected.variables.some(
                    (v) => !values[v.component + ':' + v.name]?.trim(),
                  )
                }
              >
                Gửi mẫu WhatsApp
              </Button>
            </>
          ) : null}
          {send.error ? <ErrorNotice error={send.error} /> : null}
        </form>
      ) : null}
    </div>
  );
}
