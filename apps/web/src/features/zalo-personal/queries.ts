import { useQuery } from '@tanstack/react-query';
import { personalAccountsSchema } from '@zalo/shared';
import { api } from '@/lib/api';
export function usePersonalAccounts() {
  return useQuery({
    queryKey: ['personal-accounts'],
    queryFn: () => api('/channels/zalo-personal', personalAccountsSchema),
    refetchInterval: (query) =>
      query.state.data?.accounts.some((a) =>
        ['QR_PENDING', 'CONNECTING'].includes(a.connectionStatus),
      )
        ? 2000
        : 10000,
  });
}
