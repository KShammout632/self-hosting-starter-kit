import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ServiceName } from '@selfhost/shared';
import { ReauthDialog } from '@/components/reauth-dialog';
import { api, ApiError } from './api';
import { STATUS_KEY } from './status';

export type ServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'update' | 'uninstall';

interface Pending {
  service: ServiceName;
  action: ServiceAction;
  body: object;
}

// Starts an action. If the server wants the password again (the session is older than 15 minutes),
// it asks for it and then repeats the action.
export function useServiceAction() {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const send = async (request: Pending) => {
    setError(null);
    try {
      await api(`/api/services/${request.service}/${request.action}`, {
        method: 'POST',
        body: request.body,
      });
      await client.invalidateQueries({ queryKey: STATUS_KEY });
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'reauth_required') {
        setPending(request);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      }
      return false;
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
    dialog,
    run: (service: ServiceName, action: ServiceAction, body: object = {}) =>
      send({ service, action, body }),
  };
}
