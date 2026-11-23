import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { RemoteAccess } from '@/components/remote-access';
import { ServicePicker } from '@/components/service-picker';
import { StorageManager } from '@/components/storage-manager';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useSession, useSetSession } from '@/lib/session';
import { isRunning, useStatus } from '@/lib/status';
import { useRemote } from '@/lib/use-remote';
import { useStorage } from '@/lib/use-storage';
import { SetupForm } from '@/pages/auth-pages';

const STEPS = [
  { id: 'account', label: 'Your password' },
  { id: 'remote', label: 'Away from home' },
  { id: 'drives', label: 'Drives' },
  { id: 'services', label: 'Apps' },
  { id: 'done', label: 'All done' },
] as const;

type StepId = (typeof STEPS)[number]['id'];

const isStep = (value: string | null): value is StepId => STEPS.some((step) => step.id === value);

function Progress({ current }: { current: StepId }) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Setup progress">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {STEPS.map((step, position) => (
          <li
            key={step.id}
            aria-current={step.id === current ? 'step' : undefined}
            className={
              step.id === current
                ? 'font-semibold'
                : position < index
                  ? 'text-foreground'
                  : 'text-muted-foreground'
            }
          >
            {position + 1}. {step.label}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StepFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
      </div>
      {children}
    </div>
  );
}

function DrivesStep() {
  const storage = useStorage();
  const onlySystemDrive =
    storage.data !== undefined && storage.data.disks.every((disk) => disk.isSystem);
  return (
    <StepFrame
      title="Where should your files live?"
      intro="Your server can keep movies, music and photos on its own drive or on extra drives you plug in. You can change this at any time on the Storage page."
    >
      {onlySystemDrive ? (
        <Card role="note" className="text-sm">
          Only your server's own drive was found, and that is fine to start with. Your files will be
          kept there. If you plug in another drive later, you can move them from the Storage page.
        </Card>
      ) : null}
      <StorageManager />
    </StepFrame>
  );
}

function DoneStep() {
  const status = useStatus();
  const remote = useRemote();
  const installed = (status.data?.services ?? []).filter(
    (service) => service.status !== 'not_installed',
  );
  const links = remote.data?.state === 'ready' ? remote.data.links : [];

  return (
    <StepFrame
      title="Your server is ready"
      intro="Here is where to find everything. You can always come back to these from the Home page."
    >
      {installed.length === 0 ? (
        <Card className="text-sm">
          No apps are installed yet. You can install them from the Home page whenever you like.
        </Card>
      ) : (
        <ul className="space-y-3">
          {installed.map((service) => {
            const remoteLink = links.find((link) => link.target === service.name);
            return (
              <li key={service.name}>
                <Card aria-label={service.displayName} className="space-y-2">
                  <h2 className="font-semibold">{service.displayName}</h2>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {service.firstLoginTips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                  {service.credentialsPending ? (
                    <p className="text-sm">
                      Your {service.displayName} login is waiting.{' '}
                      <Link className="text-primary underline" to={`/services/${service.name}`}>
                        Show my login
                      </Link>
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {isRunning(service.status) ? (
                      <Button size="sm" asChild>
                        <a
                          href={`http://${window.location.hostname}:${service.lanPort}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open
                        </a>
                      </Button>
                    ) : null}
                    {isRunning(service.status) && remoteLink ? (
                      <Button size="sm" variant="outline" asChild>
                        <a href={remoteLink.url} target="_blank" rel="noreferrer">
                          Open from anywhere
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {remote.data?.state !== 'ready' ? (
        <p className="text-sm text-muted-foreground">
          Remote access is not on yet. You can turn it on from the Remote access page.
        </p>
      ) : null}
    </StepFrame>
  );
}

export function WizardPage() {
  const session = useSession();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = useRemote();

  if (session.isPending) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (session.isError) {
    return (
      <p role="alert" className="p-6">
        Cannot reach the dashboard. Try reloading the page.
      </p>
    );
  }

  const info = session.data;
  if (info.state === 'logged_out') {
    return <Navigate to={info.setupAvailable ? '/setup' : '/login'} replace />;
  }

  const again = params.get('again') === '1';
  if (info.state === 'logged_in' && info.wizardComplete && !again) {
    return <Navigate to="/" replace />;
  }

  const requested = params.get('step');
  let step: StepId = isStep(requested) ? requested : 'account';
  if (info.state === 'setup_required') step = 'account';
  else if (step === 'account') step = 'remote';

  const go = (next: StepId) => {
    const query: Record<string, string> = { step: next };
    if (again) query.again = '1';
    setParams(query);
    window.scrollTo?.(0, 0);
  };

  const finish = async (skipped: boolean) => {
    setError(null);
    try {
      if (info.state === 'logged_in' && !info.wizardComplete) {
        await api('/api/wizard/complete', { method: 'POST', body: { skipped } });
        setSession({ ...info, wizardComplete: true });
      }
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    }
  };

  const index = STEPS.findIndex((item) => item.id === step);
  const previous = index > 1 ? STEPS[index - 1] : undefined;
  const next = STEPS[index + 1];
  const remoteReady = remote.data?.state === 'ready';

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <Progress current={step} />

      {step === 'account' ? (
        <StepFrame
          title="Welcome! Let's set up your server"
          intro="This takes a few minutes. First, enter the setup code the installer showed on the server, then choose a password for this dashboard."
        >
          <Card>
            <SetupForm onDone={() => go('remote')} />
          </Card>
        </StepFrame>
      ) : null}

      {step === 'remote' ? (
        <StepFrame
          title="Reach your server from anywhere"
          intro="This step is optional. Without it your apps only work at home."
        >
          <RemoteAccess />
        </StepFrame>
      ) : null}

      {step === 'drives' ? <DrivesStep /> : null}

      {step === 'services' ? (
        <StepFrame
          title="Choose your apps"
          intro="Pick the ones you want now. Each one downloads the first time, which can take a few minutes. You can add or remove apps later."
        >
          <ServicePicker onBusyChange={setInstalling} />
        </StepFrame>
      ) : null}

      {step === 'done' ? <DoneStep /> : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {step !== 'account' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div>
            {previous && step !== 'done' ? (
              <Button variant="ghost" disabled={installing} onClick={() => go(previous.id)}>
                Back
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {step !== 'done' && !again ? (
              <Button variant="ghost" disabled={installing} onClick={() => finish(true)}>
                Skip the rest
              </Button>
            ) : null}
            {step === 'done' ? (
              <Button onClick={() => finish(false)}>Go to my dashboard</Button>
            ) : next ? (
              <Button disabled={installing} onClick={() => go(next.id)}>
                {step === 'remote' && !remoteReady ? 'Skip for now' : 'Next'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
