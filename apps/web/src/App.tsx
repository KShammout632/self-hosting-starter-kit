import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { SESSION_KEY, useSession } from '@/lib/session';
import { useStatus, useStatusStream } from '@/lib/status';
import { LoginPage, SetupPage } from '@/pages/auth-pages';
import { HomePage } from '@/pages/home-page';
import { ServicePage } from '@/pages/service-page';

function AgentBanner() {
  const status = useStatus();
  const [details, setDetails] = useState(false);
  if (!status.data || status.data.agentReachable) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
      <p>
        The dashboard cannot reach the helper that runs on your server, so what you see below may be
        out of date.{' '}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => setDetails((value) => !value)}
        >
          {details ? 'Hide details' : 'Show details'}
        </button>
      </p>
      {details ? (
        <p className="mt-2">
          On the server, run{' '}
          <code className="rounded bg-muted px-1">sudo systemctl status selfhost-agent</code> to see
          what is wrong.
        </p>
      ) : null}
    </div>
  );
}

function Layout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  useStatusStream();

  const logout = async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await client.invalidateQueries({ queryKey: SESSION_KEY });
    navigate('/login');
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="flex items-center justify-between">
        <span className="text-xl font-semibold">Home server</span>
        <Button variant="ghost" size="sm" onClick={logout}>
          Sign out
        </Button>
      </header>
      <AgentBanner />
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function RequireSession() {
  const session = useSession();
  if (session.isPending) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (session.isError) {
    return (
      <p role="alert" className="p-6">
        Cannot reach the dashboard. Try reloading the page.
      </p>
    );
  }
  if (session.data.state === 'setup_required') return <Navigate to="/setup" replace />;
  if (session.data.state === 'logged_out') return <Navigate to="/login" replace />;
  return <Layout />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireSession />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/services/:name" element={<ServicePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
