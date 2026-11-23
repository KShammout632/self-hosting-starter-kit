import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { ServiceCredentialsResult } from '@selfhost/shared';
import { CredentialsCard } from '@/components/credentials-card';
import { LogViewer } from '@/components/log-viewer';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { BUSY_LABEL, isRunning, useStatus } from '@/lib/status';
import { useRemoteLink } from '@/lib/use-remote';
import { useServiceAction } from '@/lib/use-service-action';
import { serviceUrl } from './home-page';

function RemoveDialog({
  name,
  displayName,
  open,
  onClose,
  onRemove,
}: {
  name: string;
  displayName: string;
  open: boolean;
  onClose: () => void;
  onRemove: (deleteData: boolean, confirmName: string) => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const [typed, setTyped] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRemove(deleteData, typed);
    setTyped('');
    setDeleteData(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={'Remove ' + displayName}
      description="Your own files, such as movies and photos, are never touched."
    >
      <form onSubmit={submit} className="space-y-4">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={deleteData}
            onChange={(event) => setDeleteData(event.target.checked)}
          />
          <span>
            Also erase {displayName}&apos;s settings, accounts and library information. This cannot
            be undone.
          </span>
        </label>
        {deleteData ? (
          <div className="space-y-1">
            <label className="block text-sm font-medium" htmlFor="confirm-name">
              Type {name} to confirm
            </label>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={deleteData && typed !== name}>
            Remove {displayName}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ServicePage() {
  const { name } = useParams();
  const status = useStatus();
  const actions = useServiceAction();
  const remoteLink = useRemoteLink(name);
  const [removing, setRemoving] = useState(false);
  const [revealed, setRevealed] = useState<ServiceCredentialsResult['credentials'] | null>(null);

  if (status.isPending) return <p className="text-muted-foreground">Loading...</p>;
  const service = status.data?.services.find((candidate) => candidate.name === name);
  if (!service) {
    return (
      <p>
        That service was not found.{' '}
        <Link to="/" className="text-primary underline">
          Back to home
        </Link>
      </p>
    );
  }

  const busy = service.busy !== null;
  const running = isRunning(service.status);
  const installed = service.status !== 'not_installed';

  return (
    <div className="space-y-6">
      <Link to="/" className="text-sm text-primary underline">
        Back to home
      </Link>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{service.displayName}</h1>
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
        {!busy && service.notice ? (
          <p className="text-sm" role="status">
            {service.notice}
          </p>
        ) : null}
        {actions.error ? (
          <p role="alert" className="text-sm text-destructive">
            {actions.error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button asChild>
              <a href={serviceUrl(service)} target="_blank" rel="noreferrer">
                Open {service.displayName}
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
          {!running && installed ? (
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
          {installed ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => actions.run(service.name, 'restart')}
              >
                Restart
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => actions.run(service.name, 'install')}>
              Install
            </Button>
          )}
        </div>
      </Card>

      {installed && service.update?.available ? (
        <Card className="space-y-3" aria-label="Update available">
          <h2 className="font-semibold">An update is available</h2>
          <p className="text-sm">
            {service.update.installedVersion
              ? `You have version ${service.update.installedVersion}. Version ${service.update.newVersion} is ready.`
              : `Version ${service.update.newVersion} is ready.`}{' '}
            Your settings and data are saved first. If the new version does not start properly,
            everything is put back the way it was.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => actions.run(service.name, 'update')}>
              Update now
            </Button>
            <Button variant="ghost" asChild>
              <a href={service.update.releaseNotesUrl} target="_blank" rel="noreferrer">
                What is new
              </a>
            </Button>
          </div>
        </Card>
      ) : null}

      {service.hints.length > 0 ? (
        <Card className="space-y-2" aria-label="Suggestions">
          <h2 className="font-semibold">
            {service.errorCount === 1
              ? '1 problem in the log'
              : `${service.errorCount} problems in the log`}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {service.hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {installed && (service.credentialsPending || revealed) ? (
        <CredentialsCard
          service={service.name}
          displayName={service.displayName}
          revealed={revealed}
          onReveal={setRevealed}
        />
      ) : null}

      <Card className="space-y-2" aria-label="Getting started">
        <h2 className="font-semibold">Getting started</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {service.firstLoginTips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      </Card>

      {installed ? <LogViewer service={service.name} /> : null}

      <RemoveDialog
        name={service.name}
        displayName={service.displayName}
        open={removing}
        onClose={() => setRemoving(false)}
        onRemove={(deleteData, confirmName) => {
          setRemoving(false);
          void actions.run(service.name, 'uninstall', { deleteData, confirmName });
        }}
      />
      {actions.dialog}
    </div>
  );
}
