import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { realtimeEventSchema } from '@zalo/shared';
import { apiBaseUrl } from '@/lib/api';
export function useRealtime() {
  const client = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(`${apiBaseUrl}/events`, {
      withCredentials: true,
    });
    let refresh: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = (event) => {
      try {
        const parsed = realtimeEventSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success || refresh) return;
        refresh = setTimeout(() => {
          refresh = undefined;
          void client.invalidateQueries({
            predicate: (query) =>
              [
                'conversations',
                'conversation',
                'messages',
                'personal-accounts',
                'inbox-accounts',
                'facebook-page',
                'tiktok',
                'telegram',
                'whatsapp',
                'whatsapp-templates',
                'facebook-personal',
              ].includes(String(query.queryKey[0])),
          });
        }, 75);
      } catch {
        /* A malformed event must not interrupt the inbox. */
      }
    };
    // Reconnecting SSE starts with 'ready', which refetches durable state after gaps.
    return () => {
      if (refresh) clearTimeout(refresh);
      source.close();
    };
  }, [client]);
}
