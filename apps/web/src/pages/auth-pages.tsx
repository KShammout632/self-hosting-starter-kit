import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { SessionInfo } from '@selfhost/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { useSession, useSetSession } from '@/lib/session';

export function Shell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
      <Card className="w-full space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
        </div>
        {children}
      </Card>
    </main>
  );
}

function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium" htmlFor={props.id}>
        {label}
      </label>
      <Input {...props} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

export function SetupForm({ onDone }: { onDone: () => void }) {
  const setSession = useSetSession();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 10) return setError('Use at least 10 characters for your password.');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      setSession(
        await api<SessionInfo>('/api/setup', { method: 'POST', body: { code, password } }),
      );
      onDone();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        id="code"
        label="Setup code"
        hint="It looks like ABCD-EFGH."
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoComplete="off"
        autoFocus
      />
      <Field
        id="password"
        label="New password"
        hint="At least 10 characters."
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Field
        id="confirm"
        label="Type the password again"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={busy || code === '' || password === ''}>
        Create account
      </Button>
    </form>
  );
}

export function SetupPage() {
  const session = useSession();
  const navigate = useNavigate();

  if (session.data?.state === 'setup_required') return <Navigate to="/wizard" replace />;
  if (session.data?.state === 'logged_in') return <Navigate to="/" replace />;
  if (session.data?.state === 'logged_out' && !session.data.setupAvailable) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Shell
      title="Set up your server"
      intro="Enter the setup code the installer showed on the server, then choose a password for this dashboard."
    >
      <SetupForm onDone={() => navigate('/', { replace: true })} />
    </Shell>
  );
}

export function LoginPage() {
  const session = useSession();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  if (session.data?.state === 'logged_in') return <Navigate to="/" replace />;
  if (session.data?.state === 'setup_required') return <Navigate to="/wizard" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSession(await api<SessionInfo>('/api/login', { method: 'POST', body: { password } }));
      navigate('/', { replace: true });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const setupAvailable = session.data?.state === 'logged_out' && session.data.setupAvailable;

  return (
    <Shell title="Sign in" intro="Enter the password you chose when you set up this server.">
      <form onSubmit={submit} className="space-y-4">
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy || password === ''}>
          Sign in
        </Button>
      </form>
      <div className="text-sm">
        <button
          type="button"
          className="text-primary underline"
          onClick={() => setShowHelp((value) => !value)}
        >
          Forgot your password?
        </button>
        {showHelp ? (
          <div className="mt-2 space-y-2 text-muted-foreground">
            <p>
              For safety, passwords can only be reset on the server itself. Open a terminal there
              and run:
            </p>
            <code className="block rounded-md bg-muted px-3 py-2 text-foreground">
              sudo selfhost reset-password
            </code>
            <p>It prints a new setup code to use here.</p>
            {setupAvailable ? (
              <a className="text-primary underline" href="/setup">
                I have a new setup code
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
