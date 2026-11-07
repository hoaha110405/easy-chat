import { useEffect, useRef, type RefObject } from 'react';
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { readMessagesResultSchema, type InboxMessage } from '@zalo/shared';
import { api } from '@/lib/api';

export function useInboxRead(
  conversationId: string,
  viewport: RefObject<HTMLDivElement | null>,
  messages: InboxMessage[],
) {
  const client = useQueryClient();
  const acknowledged = useRef(new Set<string>());
  const retry = useRef<() => void>(() => undefined);
  const unreadKey = messages
    .filter((m) => m.direction === 'INCOMING' && m.inboxUnread)
    .map((m) => m.id)
    .sort()
    .join(',');
  const { mutateAsync, error } = useMutation({
    mutationFn: (messageIds: string[]) =>
      api(
        `/conversations/${encodeURIComponent(conversationId)}/read`,
        readMessagesResultSchema,
        { method: 'POST', body: JSON.stringify({ messageIds }) },
      ),
    onSuccess: (_, ids) => {
      const read = new Set(ids);
      for (const id of ids) acknowledged.current.add(id);
      client.setQueryData<InfiniteData<{ items: InboxMessage[] }>>(
        ['messages', conversationId],
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((p) => ({
                  ...p,
                  items: p.items.map((m) =>
                    read.has(m.id) ? { ...m, inboxUnread: false } : m,
                  ),
                })),
              }
            : data,
      );
      for (const key of ['conversations', 'conversation', 'inbox-accounts'])
        void client.invalidateQueries({ queryKey: [key] });
    },
  });
  useEffect(() => {
    const root = viewport.current;
    if (!root || !unreadKey || typeof IntersectionObserver === 'undefined')
      return;
    const unread = new Set(unreadKey.split(','));
    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let sending = false;
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    function schedule() {
      cancel();
      if (
        disposed ||
        sending ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus()
      )
        return;
      timer = setTimeout(() => {
        timer = undefined;
        if (
          disposed ||
          document.visibilityState !== 'visible' ||
          !document.hasFocus()
        )
          return;
        const ids = [...visible]
          .filter((id) => !acknowledged.current.has(id))
          .slice(0, 200);
        if (!ids.length) return;
        sending = true;
        void mutateAsync(ids)
          .then(() => {
            sending = false;
            if (!disposed) schedule();
          })
          .catch(() => {
            sending = false;
          });
      }, 400);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.inboxMessageId;
          if (!id || !unread.has(id)) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        schedule();
      },
      { root, threshold: 0.1 },
    );
    root
      .querySelectorAll<HTMLElement>('[data-inbox-message-id]')
      .forEach((el) => {
        if (unread.has(el.dataset.inboxMessageId!)) observer.observe(el);
      });
    retry.current = schedule;
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      disposed = true;
      cancel();
      observer.disconnect();
      retry.current = () => undefined;
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [conversationId, unreadKey, viewport, mutateAsync]);
  return { error, retry: () => retry.current() };
}
