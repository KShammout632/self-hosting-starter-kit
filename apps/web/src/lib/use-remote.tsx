import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RemoteLink, RemoteSnapshot } from '@selfhost/shared';
import { ReauthDialog } from '@/components/reauth-dialog';
import { api, ApiError } from './api';

export const REMOTE_KEY = ['remote'];

// Polls quickly while the owner is partway through setup, so the page moves on by itself.
export function useRemote() {
  return useQuery({
    queryKey: REMOTE_KEY,
    queryFn: () => api<RemoteSnapshot>('/api/remote'),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'waiting_for_sign_in' || state === 'needs_settings' ? 3_000 : 15_000;
    },
  });
}

export function useRemoteLink(target: string | undefined): RemoteLink | null {
  const remote = useRemote();
  if (remote.data?.state !== 'ready') return null;
  return remote.data.links.find((link) => link.target === target) ?? null;
}

// Sends a change. If the server wants the password again, it asks and then repeats the change.
export function useRemoteAction() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ path: string; body: object } | null>(null);

  const send = async (request: { path: string; body: object }) => {
    setError(null);
    setBusy(true);
    try {
      const snapshot = await api<RemoteSnapshot>(request.path, {
        method: 'POST',
        body: request.body,
      });
      client.setQueryData(REMOTE_KEY, snapshot);
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
    run: (path: string, body: object = {}) => send({ path, body }),
    recheck: () => client.invalidateQueries({ queryKey: REMOTE_KEY }),
  };
}
