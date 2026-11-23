import { afterEach, describe, expect, it } from 'vitest';
import { AgentRequestError } from './agent-client';
import { REAUTH_AFTER_MS } from './auth';
import { suggestName } from './remote-routes';
import { CONNECTED, createTestApp, setupAndLogin, type Login, type TestApp } from './test-helpers';

const opened: TestApp[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) {
    t.monitor.stop();
    await t.app.close();
  }
});

const make = async (options?: Parameters<typeof createTestApp>[0]) => {
  const t = await createTestApp(options);
  opened.push(t);
  t.agent.onlyService = 'jellyfin';
  await t.monitor.refresh();
  return { t, login: await setupAndLogin(t) };
};

const post = (t: TestApp, login: Login, url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: login.headers });
const get = (t: TestApp, login: Login) =>
  t.app.inject({ url: '/api/remote', headers: login.headers });
const applies = (t: TestApp) => t.agent.calls.filter((c) => c.action === 'tailscale.serve.apply');
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('remote access API', () => {
  it('needs a signed in session', async () => {
    const t = await createTestApp();
    opened.push(t);
    expect((await t.app.inject('/api/remote')).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/remote/connect' })).statusCode).toBe(
      401,
    );
  });

  it('proposes the machine name before Tailscale is connected', async () => {
    const { t, login } = await make();
    expect((await get(t, login)).json()).toMatchObject({
      state: 'signed_out',
      name: 'box',
      signInUrl: null,
      links: [],
    });
  });

  it('starts the sign in with the machine name and returns the address to open', async () => {
    const { t, login } = await make();
    const response = await post(t, login, '/api/remote/connect');
    expect(response.json()).toMatchObject({
      state: 'waiting_for_sign_in',
      signInUrl: 'https://login.tailscale.com/a/abc',
    });
    expect(t.agent.calls).toContainEqual({ action: 'tailscale.login', hostname: 'box' });
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'tailscale.login', outcome: 'ok' });
  });

  it('accepts a name the owner chose and rejects one that is not plain', async () => {
    const { t, login } = await make();
    await post(t, login, '/api/remote/connect', { name: 'my-server' });
    expect(t.agent.calls).toContainEqual({ action: 'tailscale.login', hostname: 'my-server' });
    const bad = await post(t, login, '/api/remote/connect', { name: 'My Server!' });
    expect(bad.statusCode).toBe(400);
  });

  it('asks for the two Tailscale settings while they are off', async () => {
    const { t, login } = await make();
    t.agent.tailscale = { ...CONNECTED, httpsEnabled: false };
    const body = (await get(t, login)).json();
    expect(body).toMatchObject({ state: 'needs_settings', httpsEnabled: false, links: [] });
    expect(body.settingsUrl).toBe('https://login.tailscale.com/admin/dns');
    expect(applies(t)).toHaveLength(0);
  });

  it('lists the dashboard and installed services once ready, and publishes once', async () => {
    const { t, login } = await make();
    await post(t, login, '/api/services/jellyfin/install');
    await settle();
    t.agent.tailscale = CONNECTED;
    const body = (await get(t, login)).json();
    expect(body.state).toBe('ready');
    expect(body.links).toEqual([
      { target: 'dashboard', label: 'Dashboard', url: 'https://box.tail1234.ts.net' },
      { target: 'jellyfin', label: 'Jellyfin', url: 'https://box.tail1234.ts.net:8920' },
    ]);
    await get(t, login);
    expect(applies(t)).toHaveLength(1);
  });

  it('publishes a new service after it is installed', async () => {
    const { t, login } = await make();
    t.agent.tailscale = CONNECTED;
    await get(t, login);
    expect(applies(t)).toHaveLength(1);
    await post(t, login, '/api/services/jellyfin/install');
    await settle();
    await settle();
    expect(applies(t)).toHaveLength(2);
  });

  it('shows a plain message and retries later when publishing fails', async () => {
    let time = Date.now();
    const { t, login } = await make({ now: () => time });
    t.agent.tailscale = CONNECTED;
    t.agent.failNext = new AgentRequestError('failed', 'x');
    const first = (await get(t, login)).json();
    expect(first.state).toBe('ready');
    expect(first.message).toContain('will try again');
    await get(t, login);
    expect(applies(t)).toHaveLength(1);
    time += 31_000;
    expect((await get(t, login)).json().message).toBeNull();
    expect(applies(t)).toHaveLength(2);
  });

  it('needs a recent password to disconnect', async () => {
    let time = Date.now();
    const { t, login } = await make({ now: () => time });
    t.agent.tailscale = CONNECTED;
    time += REAUTH_AFTER_MS + 1000;
    expect((await post(t, login, '/api/remote/disconnect')).statusCode).toBe(403);
    expect(t.agent.calls.some((c) => c.action === 'tailscale.logout')).toBe(false);
  });

  it('disconnects and goes back to signed out', async () => {
    const { t, login } = await make();
    t.agent.tailscale = CONNECTED;
    const response = await post(t, login, '/api/remote/disconnect');
    expect(response.json()).toMatchObject({ state: 'signed_out', links: [] });
  });

  it('reports a missing Tailscale install', async () => {
    const { t, login } = await make();
    t.agent.tailscale = { ...CONNECTED, installed: false, backendState: null };
    expect((await get(t, login)).json().state).toBe('not_installed');
  });
});

describe('suggestName', () => {
  it('turns a machine name into a valid Tailscale name', () => {
    expect(suggestName('Kareem-PC')).toBe('kareem-pc');
    expect(suggestName('My Home Server_1')).toBe('my-home-server-1');
    expect(suggestName('')).toBe('selfhost');
    expect(suggestName('-')).toBe('selfhost');
    expect(suggestName('a'.repeat(100))).toHaveLength(63);
  });
});
