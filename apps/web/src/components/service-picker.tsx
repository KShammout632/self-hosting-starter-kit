import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ServiceName } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BUSY_LABEL, formatBytes, useStatus } from '@/lib/status';
import { useServiceAction } from '@/lib/use-service-action';

const LOW_MEMORY_BYTES = 7.5 * 1024 ** 3;

// Installs one app at a time, so a small server is not asked to download and start several large
// apps at once.
export function ServicePicker({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const status = useStatus();
  const actions = useServiceAction();
  const [selected, setSelected] = useState<ServiceName[]>([]);
  const [queue, setQueue] = useState<ServiceName[]>([]);
  const [phase, setPhase] = useState<'idle' | 'posting' | 'running'>('idle');
  const [failed, setFailed] = useState<Record<string, string>>({});

  const services = status.data?.services ?? [];
  const current = queue[0];
  const installing = queue.length > 0;

  useEffect(() => onBusyChange?.(installing), [installing, onBusyChange]);

  useEffect(() => {
    if (!current || !status.data) return;
    const service = services.find((item) => item.name === current);
    if (phase === 'idle') {
      setPhase('posting');
      void actions.run(current, 'install').then((ok) => {
        if (ok) return setPhase('running');
        setFailed((previous) => ({ ...previous, [current]: 'It could not be started.' }));
        setPhase('idle');
        setQueue((previous) => previous.slice(1));
      });
      return;
    }
    if (phase === 'running' && service && service.busy === null) {
      if (service.status === 'not_installed' || service.status === 'error') {
        setFailed((previous) => ({
          ...previous,
          [current]: service.message ?? 'The install did not finish.',
        }));
      }
      setPhase('idle');
      setQueue((previous) => previous.slice(1));
    }
  }, [current, phase, status.data]);

  if (status.isPending) return <p className="text-muted-foreground">Loading...</p>;
  if (status.isError) {
    return (
      <p role="alert" className="text-destructive">
        Could not load your apps. Try reloading the page.
      </p>
    );
  }

  const memory = status.data.system?.memTotalBytes ?? null;
  const lowMemory = memory !== null && memory < LOW_MEMORY_BYTES && selected.length >= 3;
  const toggle = (name: ServiceName) =>
    setSelected((previous) =>
      previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name],
    );
  const start = () => {
    setFailed({});
    setPhase('idle');
    setQueue(selected);
    setSelected([]);
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {services.map((service) => {
          const installed = service.status !== 'not_installed';
          const waiting = queue.includes(service.name);
          return (
            <li key={service.name}>
              <Card aria-label={service.displayName} className="space-y-2">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={installed || selected.includes(service.name) || waiting}
                    disabled={installed || installing || waiting}
                    onChange={() => toggle(service.name)}
                  />
                  <span>
                    <span className="block font-medium">{service.displayName}</span>
                    <span className="block text-sm text-muted-foreground">
                      {service.description}
                    </span>
                  </span>
                </label>
                {installed && service.busy === null ? (
                  <p className="text-sm text-success">Installed</p>
                ) : null}
                {service.busy ? (
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {BUSY_LABEL[service.busy]}
                  </p>
                ) : null}
                {waiting && service.name !== current ? (
                  <p className="text-sm text-muted-foreground">Waiting for the apps before it.</p>
                ) : null}
                {failed[service.name] ? (
                  <p role="alert" className="text-sm text-destructive">
                    {failed[service.name]}
                  </p>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
      {lowMemory && memory !== null ? (
        <p role="note" className="text-sm text-warning">
          Your server has {formatBytes(memory)} of memory. Running three or more of these apps works
          best with 8 GB or more, so some may feel slow. You can install fewer now and add others
          later.
        </p>
      ) : null}
      {actions.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actions.error}
        </p>
      ) : null}
      <Button disabled={selected.length === 0 || installing} onClick={start}>
        {installing ? 'Installing...' : 'Install the selected apps'}
      </Button>
      {actions.dialog}
    </div>
  );
}
