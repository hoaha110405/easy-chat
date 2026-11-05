import { useQuery } from '@tanstack/react-query';
import { statusSchema } from '@zalo/shared';
import { api } from '@/lib/api';
export function useConnection() {
  return useQuery({
    queryKey: ['connection'],
    queryFn: () => api('/zalo/status', statusSchema),
    refetchInterval: 15000,
  });
}
