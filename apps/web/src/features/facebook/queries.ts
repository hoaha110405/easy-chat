import { useQuery } from '@tanstack/react-query';
import {
  facebookPageStatusSchema,
  facebookPersonalStatusSchema,
} from '@zalo/shared';
import { api } from '@/lib/api';

export function useFacebookPages() {
  return useQuery({
    queryKey: ['facebook-page'],
    queryFn: () => api('/channels/facebook-page', facebookPageStatusSchema),
    refetchInterval: 10000,
  });
}

export function useFacebookPersonalStatus() {
  return useQuery({
    queryKey: ['facebook-personal'],
    queryFn: () =>
      api('/channels/facebook-personal/status', facebookPersonalStatusSchema),
    staleTime: 30000,
  });
}
