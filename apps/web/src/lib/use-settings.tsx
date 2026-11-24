import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntryView, KitSnapshot, SystemUpdatesSnapshot } from '@selfhost/shared';
import { ReauthDialog } from '@/components/reauth-dialog';
import { api, ApiError } from './api';

export const KIT_KEY = ['settings', 'kit'];
export const SYSTEM_KEY = ['settings', 'system'];
export const AUDIT_KEY = ['settings', 'audit'];

export function kitIsBusy(kit: KitSnapshot | undefined): boolean {
  return kit?.job?.state === 'running' || kit?.update?.state === 'running';
}

// Polls quickly while an update is running. The dashboard itself restarts during a kit update, so
// failed requests are expected and the last answer stays on screen.
export function useKit() {
  return useQuery({
    queryKey: KIT_KEY,
    queryFn: () => api<KitSnapshot>('/api/settings/kit'),
    retry: false,
    refetchInterval: (query) => (kitIsBusy(query.state.data) ? 3_000 : 10 * 60_000),
  });
}

export function useSystemUpdates() {
  return useQuery({
    queryKey: SYSTEM_KEY,
    queryFn: () => api<SystemUpdatesSnapshot>('/api/settings/system'),
    retry: false,
    refetchInterval: (query) => (query.state.data?.job?.state === 'running' ? 5_000 : 5 * 60_000),
  });
}

export function useAuditLog(enabled: boolean) {
  return useQuery({
    queryKey: AUDIT_KEY,
    queryFn: () => api<{ entries: AuditEntryView[] }>('/api/settings/audit?limit=100'),
    enabled,
    retry: false,
  });
}

// Sends a change. If the server wants the password again, it asks and then repeats the change.
export function useSettingsAction() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ path: string; body: object } | null>(null);

  const send = async (request: { path: string; body: object }) => {
    setError(null);
    setBusy(true);
    try {
      const result = await api<unknown>(request.path, { method: 'POST', body: request.body });
      await client.invalidateQueries({ queryKey: ['settings'] });
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'reauth_required') {
        setPending(request);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      }
      return null;
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
  };
}
