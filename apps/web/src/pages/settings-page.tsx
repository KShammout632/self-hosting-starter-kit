import { useState, type FormEvent } from 'react';
import type { AuditEntryView, SessionInfo } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useSetSession } from '@/lib/session';
import {
  kitIsBusy,
  useAuditLog,
  useKit,
  useSettingsAction,
  useSystemUpdates,
} from '@/lib/use-settings';

function Problem({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function PasswordCard() {
  const setSession = useSetSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    if (next.length < 10) return setError('Choose a password with at least 10 characters.');
    if (next !== again) return setError('The two new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      setSession(
        await api<SessionInfo>('/api/settings/password', {
          method: 'POST',
          body: { current, next },
        }),
      );
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Change your password</h2>
      <p className="text-sm text-muted-foreground">
        This is the password for this dashboard. Your apps keep their own passwords. Changing it
        signs you out on your other devices.
      </p>
      <form onSubmit={submit} className="max-w-sm space-y-3">
        <div className="space-y-1">
          <label htmlFor="current-password" className="text-sm font-medium">
            Current password
          </label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-password" className="text-sm font-medium">
            New password
          </label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-password-again" className="text-sm font-medium">
            Type the new password again
          </label>
          <Input
            id="new-password-again"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
          />
        </div>
        <Problem>{error}</Problem>
        {done ? (
          <p role="status" className="text-sm">
            Your password was changed. Other devices were signed out.
          </p>
        ) : null}
        <Button type="submit" disabled={busy || current === '' || next === ''}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function KitCard() {
  const kit = useKit();
  const action = useSettingsAction();
  const data = kit.data;
  const busy = kitIsBusy(data);
  const failedJob = data?.job?.state === 'failed' ? data.job.message : null;
  const finished =
    data?.update && data.update.state !== 'running' && data.update.state !== 'done'
      ? data.update
      : null;
  const justUpdated =
    data?.update?.state === 'done' && data.update.version === data.currentVersion
      ? data.update
      : null;

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Updates for this kit</h2>
      {action.dialog}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {kit.isError ? 'Could not load this right now.' : 'Loading...'}
        </p>
      ) : (
        <>
          <p className="text-sm">
            You have version <strong>{data.currentVersion ?? 'unknown'}</strong>.
          </p>
          {kit.isError && busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              The dashboard is restarting. This page comes back by itself.
            </p>
          ) : null}
          {busy ? (
            <p role="status" className="text-sm">
              Updating to version {data.update?.version ?? data.latestVersion}. This takes a few
              minutes. The dashboard goes offline for a moment, and your apps keep running.
            </p>
          ) : data.updateAvailable ? (
            <p className="text-sm">
              Version <strong>{data.latestVersion}</strong> is available.{' '}
              {data.releaseNotesUrl ? (
                <a
                  className="text-primary underline"
                  href={data.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  What is new
                </a>
              ) : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">You are up to date.</p>
          )}
          {data.checkFailed && !busy ? (
            <p className="text-sm text-muted-foreground">
              Could not look for a new version just now. Check that the server is online.
            </p>
          ) : null}
          {justUpdated ? (
            <p role="status" className="text-sm">
              {justUpdated.message}
            </p>
          ) : null}
          {finished ? (
            <p role="alert" className="text-sm text-destructive">
              {finished.message}
            </p>
          ) : null}
          <Problem>{failedJob ?? action.error}</Problem>
          <div className="flex flex-wrap gap-2">
            {data.updateAvailable && !busy ? (
              <Button
                disabled={action.busy}
                onClick={() => void action.run('/api/settings/kit/update')}
              >
                Update now
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={action.busy || busy}
              onClick={() => void action.run('/api/settings/kit/check')}
            >
              Check for updates
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function SystemCard() {
  const updates = useSystemUpdates();
  const action = useSettingsAction();
  const data = updates.data;
  const installing = data?.job?.state === 'running';

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Updates for the server itself</h2>
      <p className="text-sm text-muted-foreground">
        Security fixes for Ubuntu install by themselves. This is where you can check and install
        everything else.
      </p>
      {action.dialog}
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {updates.isError ? 'Could not check for updates right now.' : 'Loading...'}
        </p>
      ) : (
        <>
          {installing ? (
            <p role="status" className="text-sm">
              Installing updates. This can take a few minutes. Your apps stay on.
            </p>
          ) : data.packages === 0 ? (
            <p className="text-sm text-muted-foreground">Everything is up to date.</p>
          ) : (
            <p className="text-sm">
              {data.packages} {data.packages === 1 ? 'update is' : 'updates are'} waiting
              {data.security > 0
                ? `, including ${data.security} security ${data.security === 1 ? 'fix' : 'fixes'}`
                : ''}
              .
            </p>
          )}
          {data.rebootRequired ? (
            <p className="text-sm">A restart is needed to finish the updates.</p>
          ) : null}
          <Problem>
            {(data.job?.state === 'failed' ? data.job.message : null) ?? action.error}
          </Problem>
          <div className="flex flex-wrap gap-2">
            {data.packages > 0 && !installing ? (
              <Button
                disabled={action.busy}
                onClick={() => void action.run('/api/settings/system/apply')}
              >
                Install updates
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={action.busy || installing}
              onClick={() => void action.run('/api/settings/system/check')}
            >
              {action.busy ? 'Checking...' : 'Check for updates'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function RestartCard() {
  const action = useSettingsAction();
  const [asking, setAsking] = useState(false);
  const [started, setStarted] = useState(false);

  const restart = async () => {
    setAsking(false);
    if (await action.run('/api/settings/reboot')) setStarted(true);
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Restart the server</h2>
      {action.dialog}
      {started ? (
        <p role="status" className="text-sm">
          The server is restarting. Your apps will be back in a minute or two. Reload this page
          then.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Every app stops for a minute or two while the server restarts, then starts again by
            itself.
          </p>
          <Problem>{action.error}</Problem>
          <Button variant="outline" disabled={action.busy} onClick={() => setAsking(true)}>
            Restart the server
          </Button>
        </>
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Restart the server?"
        description="Everyone using your apps right now will be disconnected for a minute or two."
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAsking(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void restart()}>
            Restart now
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

const EVENT_LABELS: Record<string, string> = {
  setup: 'Dashboard set up',
  login: 'Signed in',
  logout: 'Signed out',
  reauth: 'Password confirmed',
  'password.change': 'Password changed',
  'password.reset': 'Password reset from the server',
  'wizard.complete': 'Setup guide finished',
  'kit.update': 'Kit update',
  'system.updates.apply': 'Server updates installed',
  'system.reboot': 'Server restarted',
  'service.install': 'App installed',
  'service.uninstall': 'App removed',
  'service.start': 'App started',
  'service.stop': 'App stopped',
  'service.restart': 'App restarted',
  'service.update': 'App updated',
  'service.credentials': 'Login details shown',
  'tailscale.login': 'Remote access turned on',
  'tailscale.logout': 'Remote access turned off',
};

const OUTCOME_LABELS: Record<string, string> = {
  ok: '',
  failed: ' (did not work)',
  denied: ' (refused)',
};

function describeEvent(entry: AuditEntryView): string {
  const label = EVENT_LABELS[entry.event] ?? entry.event;
  const target = entry.target ? `: ${entry.target}` : '';
  return `${label}${target}${OUTCOME_LABELS[entry.outcome] ?? ''}`;
}

function ActivityCard() {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const log = useAuditLog(open);

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">What happened lately</h2>
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide activity' : 'Show activity'}
        </Button>
      </div>
      {open ? (
        log.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : log.isError ? (
          <Problem>Could not load the activity.</Problem>
        ) : log.data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <>
            <button
              type="button"
              className="text-sm text-primary underline"
              onClick={() => setDetails((value) => !value)}
            >
              {details ? 'Hide details' : 'Show details'}
            </button>
            <ul aria-label="Activity" className="divide-y text-sm">
              {log.data.entries.map((entry, index) => (
                <li key={`${entry.ts}-${index}`} className="py-2">
                  <span className="text-muted-foreground">
                    {new Date(entry.ts).toLocaleString()}
                  </span>
                  <br />
                  {describeEvent(entry)}
                  {details ? (
                    <code className="mt-1 block rounded bg-muted px-1 text-xs">
                      {[entry.actor, entry.event, entry.target, entry.outcome, entry.detail]
                        .filter(Boolean)
                        .join(' | ')}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <PasswordCard />
      <KitCard />
      <SystemCard />
      <RestartCard />
      <ActivityCard />
    </div>
  );
}
