import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { DOCS } from '@/lib/docs';
import { SESSION_KEY, useSession } from '@/lib/session';
import { useStatus, useStatusStream } from '@/lib/status';
import { kitIsBusy, useKit, useSystemUpdates } from '@/lib/use-settings';
import { LoginPage, SetupPage } from '@/pages/auth-pages';
import { HomePage } from '@/pages/home-page';
import { RemotePage } from '@/pages/remote-page';
import { SettingsPage } from '@/pages/settings-page';
import { ServicePage } from '@/pages/service-page';
import { StoragePage } from '@/pages/storage-page';
import { WizardPage } from '@/pages/wizard-page';

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

function ServerNotices() {
  const kit = useKit();
  const system = useSystemUpdates();
  const notices: string[] = [];
  if (system.data?.rebootRequired) {
    notices.push('The server needs a restart to finish installing updates.');
  }
  if (kit.data?.updateAvailable && !kitIsBusy(kit.data)) {
    notices.push('A new version of the kit is available.');
  }
  if (notices.length === 0) return null;
  return (
    <div role="status" className="rounded-md border p-3 text-sm">
      {notices.map((notice) => (
        <p key={notice}>
          {notice}{' '}
          <NavLink to="/settings" className="text-primary underline">
            Open settings
          </NavLink>
        </p>
      ))}
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
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-xl font-semibold">Home server</span>
          <nav aria-label="Main" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {[
              { to: '/', label: 'Home', end: true },
              { to: '/storage', label: 'Storage', end: false },
              { to: '/remote', label: 'Remote access', end: false },
              { to: '/settings', label: 'Settings', end: false },
            ].map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  isActive ? 'font-semibold underline' : 'text-muted-foreground hover:underline'
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <Button variant="ghost" size="sm" onClick={logout}>
          Sign out
        </Button>
      </header>
      <AgentBanner />
      <ServerNotices />
      <main>
        <Outlet />
      </main>
      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-4 text-sm text-muted-foreground">
        <span>Need help?</span>
        <a className="underline" href={DOCS.userGuide} target="_blank" rel="noreferrer">
          User guide
        </a>
        <a className="underline" href={DOCS.troubleshooting} target="_blank" rel="noreferrer">
          Troubleshooting
        </a>
      </footer>
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
  if (session.data.state === 'setup_required') return <Navigate to="/wizard" replace />;
  if (session.data.state === 'logged_out') return <Navigate to="/login" replace />;
  if (!session.data.wizardComplete) return <Navigate to="/wizard" replace />;
  return <Layout />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/wizard" element={<WizardPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireSession />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/services/:name" element={<ServicePage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/remote" element={<RemotePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
