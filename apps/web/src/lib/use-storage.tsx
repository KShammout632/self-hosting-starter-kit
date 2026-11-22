import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { StorageSnapshot } from '@selfhost/shared';
import { ReauthDialog } from '@/components/reauth-dialog';
import { api, ApiError } from './api';
import { STATUS_KEY } from './status';

export const STORAGE_KEY = ['storage'];

// Polls faster while a long job (formatting or copying) is running, so the page notices when it ends.
export function useStorage() {
  return useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => api<StorageSnapshot>('/api/storage'),
    refetchInterval: (query) => (query.state.data?.job?.state === 'running' ? 3_000 : 15_000),
  });
}

interface Pending {
  path: string;
  body: object;
}

// Sends a change. If the server wants the password again, it asks and then repeats the change.
export function useStorageAction(onSuccess?: () => void) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const send = async (request: Pending) => {
    setError(null);
    setBusy(true);
    try {
      await api(request.path, { method: 'POST', body: request.body });
      await Promise.all([
        client.invalidateQueries({ queryKey: STORAGE_KEY }),
        client.invalidateQueries({ queryKey: STATUS_KEY }),
      ]);
      onSuccess?.();
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'reauth_required') {
        setPending(request);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <ReauthDialog
      open={pending !== null}
      onCancel={() => setPending(null)}
      onDone={() => {
        const request = pending;
        setPending(null);
        if (request) void send(request);
      }}
    />
  );

  return {
    error,
    busy,
    dialog,
    clearError: () => setError(null),
    run: (path: string, body: object = {}) => send({ path, body }),
  };
}
