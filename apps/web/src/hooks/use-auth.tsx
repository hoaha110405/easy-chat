import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiClientError } from '@/lib/api';
const authSchema = z.object({ authenticated: z.boolean() });
export function useAuth() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api('/auth/session', authSchema);
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401)
          return { authenticated: false };
        throw error;
      }
    },
    retry: false,
    staleTime: 60000,
  });
  useEffect(() => {
    const expire = () =>
      client.setQueryData(['session'], { authenticated: false });
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [client]);
  return {
    ...session,
    login: async (password: string) => {
      await api('/auth/login', authSchema, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      client.setQueryData(['session'], { authenticated: true });
    },
    logout: async () => {
      await api('/auth/logout', authSchema, { method: 'POST' });
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      client.setQueryData(['session'], { authenticated: false });
    },
  };
}
