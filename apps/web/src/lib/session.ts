import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@selfhost/shared';
import { api, setCsrfToken } from './api';

export const SESSION_KEY = ['session'];

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const info = await api<SessionInfo>('/api/session');
      setCsrfToken(info.state === 'logged_in' ? info.csrfToken : null);
      return info;
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetSession() {
  const client = useQueryClient();
  return (info: SessionInfo) => {
    setCsrfToken(info.state === 'logged_in' ? info.csrfToken : null);
    client.setQueryData(SESSION_KEY, info);
  };
}
