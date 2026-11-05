import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  conversationSchema,
  inboxAccountsSchema,
  messageSchema,
  pageSchema,
} from '@zalo/shared';
import { api } from '@/lib/api';
export function useConversations(account?: string, channelType?: string) {
  return useInfiniteQuery({
    queryKey: ['conversations', account ?? 'all', channelType ?? 'all'],
    initialPageParam: { page: 1, cursor: undefined as string | undefined },
    queryFn: ({ pageParam }) =>
      api(
        `/conversations?page=${pageParam.page}&limit=30${pageParam.cursor ? `&cursor=${encodeURIComponent(pageParam.cursor)}` : ''}${account ? `&account=${encodeURIComponent(account)}` : ''}${channelType ? `&channelType=${encodeURIComponent(channelType)}` : ''}`,
        pageSchema(conversationSchema),
      ),
    getNextPageParam: (last) =>
      last.hasMore
        ? { page: last.page + 1, cursor: last.nextCursor ?? undefined }
        : undefined,
    refetchInterval: 5000,
  });
}
export function useInboxAccounts() {
  return useQuery({
    queryKey: ['inbox-accounts'],
    queryFn: () => api('/conversations/accounts', inboxAccountsSchema),
    staleTime: 5000,
    refetchInterval: 10000,
  });
}
export function useMessages(id: string) {
  return useInfiniteQuery({
    queryKey: ['messages', id],
    initialPageParam: { page: 1, cursor: undefined as string | undefined },
    queryFn: ({ pageParam }) =>
      api(
        `/conversations/${encodeURIComponent(id)}/messages?page=${pageParam.page}&limit=50${pageParam.cursor ? `&cursor=${encodeURIComponent(pageParam.cursor)}` : ''}`,
        pageSchema(messageSchema),
      ),
    getNextPageParam: (last) =>
      last.hasMore
        ? { page: last.page + 1, cursor: last.nextCursor ?? undefined }
        : undefined,
    refetchInterval: 4000,
    enabled: Boolean(id),
  });
}

export function useConversation(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () =>
      api(`/conversations/${encodeURIComponent(id)}`, conversationSchema),
    enabled: Boolean(id) && enabled,
    refetchInterval: 5000,
  });
}
