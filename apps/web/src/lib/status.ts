import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ServiceStatus, ServiceSummary, StatusSnapshot } from '@selfhost/shared';
import { api } from './api';

export const STATUS_KEY = ['status'];

export function useStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api<StatusSnapshot>('/api/services'),
    refetchInterval: 30_000,
  });
}

// The server pushes every change. The 30 second refetch above covers a dropped connection.
export function useStatusStream() {
  const client = useQueryClient();
  useEffect(() => {
    const source = new EventSource('/api/status/stream');
    source.addEventListener('status', (event) => {
      client.setQueryData(STATUS_KEY, JSON.parse((event as MessageEvent<string>).data));
    });
    return () => source.close();
  }, [client]);
}

export const STATUS_LABEL: Record<ServiceStatus, string> = {
  online: 'Online',
  starting: 'Starting up',
  degraded: 'Having problems',
  offline: 'Offline',
  error: 'Needs attention',
  not_installed: 'Not installed',
};

export const BUSY_LABEL: Record<NonNullable<ServiceSummary['busy']>, string> = {
  installing: 'Installing. The first time this downloads the app, so it can take a few minutes.',
  starting: 'Starting',
  stopping: 'Stopping',
  restarting: 'Restarting',
  updating:
    'Saving a copy of your data, then updating. If something goes wrong, it is put back. This can take a few minutes.',
  removing: 'Removing',
};

export const isRunning = (status: ServiceStatus) =>
  status === 'online' || status === 'starting' || status === 'degraded';

export const formatBytes = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
};
