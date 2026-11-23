import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ServiceSummary, SystemSummary } from '@selfhost/shared';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BUSY_LABEL, formatBytes, isRunning, useStatus } from '@/lib/status';
import { useRemoteLink } from '@/lib/use-remote';
import { useServiceAction } from '@/lib/use-service-action';

export const serviceUrl = (service: ServiceSummary) =>
  `http://${window.location.hostname}:${service.lanPort}`;

function Meter({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{Math.round(clamped)}%</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={clamped >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function SystemCard({ system }: { system: SystemSummary }) {
  const [details, setDetails] = useState(false);
  const memUsed = system.memTotalBytes - system.memFreeBytes;
  const diskUsed = system.diskTotalBytes - system.diskFreeBytes;
  return (
    <Card aria-label="Server health" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Your server</h2>
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => setDetails((value) => !value)}
        >
          {details ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Meter label="Processor" percent={system.cpuLoadPercent} />
        <Meter
          label="Memory"
          percent={(memUsed / system.memTotalBytes) * 100}
          detail={`${formatBytes(memUsed)} of ${formatBytes(system.memTotalBytes)}`}
        />
        <Meter
          label="Storage"
          percent={system.diskTotalBytes ? (diskUsed / system.diskTotalBytes) * 100 : 0}
          detail={`${formatBytes(system.diskFreeBytes)} free`}
        />
      </div>
      {details ? (
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Name</dt>
            <dd>{system.hostname}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Processor cores</dt>
            <dd>{system.cpuCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Temperature</dt>
            <dd>
              {system.temperatureCelsius === null
                ? 'Not available'
                : `${system.temperatureCelsius} °C`}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Running for</dt>
            <dd>{Math.floor(system.uptimeSeconds / 3600)} hours</dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}

function ServiceCard({ service }: { service: ServiceSummary }) {
  const actions = useServiceAction();
  const remoteLink = useRemoteLink(service.name);
  const busy = service.busy !== null;
  const running = isRunning(service.status);

  return (
    <Card className="flex flex-col gap-3" aria-label={service.displayName}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{service.displayName}</h3>
          <p className="text-sm text-muted-foreground">{service.description}</p>
        </div>
        {busy ? null : <StatusBadge status={service.status} />}
      </div>

      {busy ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {BUSY_LABEL[service.busy as NonNullable<typeof service.busy>]}
        </p>
      ) : null}
      {!busy && service.message ? <p className="text-sm">{service.message}</p> : null}
      {service.errorCount > 0 ? (
        <p className="text-sm text-warning">
          {service.errorCount === 1
            ? '1 problem was written to the log.'
            : `${service.errorCount} problems were written to the log.`}
        </p>
      ) : null}
      {actions.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actions.error}
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
        {service.status === 'not_installed' ? (
          <Button disabled={busy} onClick={() => actions.run(service.name, 'install')}>
            Install
          </Button>
        ) : null}
        {running ? (
          <Button asChild>
            <a href={serviceUrl(service)} target="_blank" rel="noreferrer">
              Open
            </a>
          </Button>
        ) : null}
        {running && remoteLink ? (
          <Button variant="outline" asChild>
            <a href={remoteLink.url} target="_blank" rel="noreferrer">
              Open from anywhere
            </a>
          </Button>
        ) : null}
        {service.status === 'offline' || service.status === 'error' ? (
          <Button disabled={busy} onClick={() => actions.run(service.name, 'start')}>
            Start
          </Button>
        ) : null}
        {running ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => actions.run(service.name, 'stop')}
          >
            Stop
          </Button>
        ) : null}
        {service.status !== 'not_installed' ? (
          <Button variant="ghost" asChild>
            <Link to={`/services/${service.name}`}>Details and logs</Link>
          </Button>
        ) : null}
      </div>
      {actions.dialog}
    </Card>
  );
}

export function HomePage() {
  const status = useStatus();

  if (status.isPending) return <p className="text-muted-foreground">Loading...</p>;
  if (status.isError)
    return <p role="alert">Could not load your services. Try reloading the page.</p>;

  return (
    <div className="space-y-6">
      {status.data.system ? <SystemCard system={status.data.system} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {status.data.services.map((service) => (
          <ServiceCard key={service.name} service={service} />
        ))}
      </div>
    </div>
  );
}
