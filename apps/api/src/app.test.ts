import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRequestError } from './agent-client';
import { LOCKOUT_MS, MAX_FAILURES, REAUTH_AFTER_MS } from './auth';
import {
  createTestApp,
  PASSWORD,
  setupAndLogin,
  SETUP_CODE,
  toLogin,
  type TestApp,
} from './test-helpers';

let current: TestApp | null = null;
const make = async (options?: Parameters<typeof createTestApp>[0]) => {
  current = await createTestApp(options);
  return current;
};
afterEach(async () => {
  current?.monitor.stop();
  await current?.app.close();
  current = null;
});

const post = (t: TestApp, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers });

describe('setup and login', () => {
  it('asks for setup until an admin exists, then accepts the setup code once', async () => {
    const t = await make();
    expect((await t.app.inject('/api/session')).json()).toEqual({ state: 'setup_required' });

    const bad = await post(t, '/api/setup', { code: 'WRONG-CODE', password: PASSWORD });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_code');

    const ok = await post(t, '/api/setup', { code: SETUP_CODE.toLowerCase(), password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/HttpOnly/);
    expect(ok.headers['set-cookie']).toMatch(/SameSite=Strict/);
    expect(existsSync(t.setupCodeFile)).toBe(false);

    const again = await post(t, '/api/setup', { code: SETUP_CODE, password: PASSWORD });
    expect(again.statusCode).toBe(403);
  });

  it('rejects short passwords during setup', async () => {
    const t = await make();
    const response = await post(t, '/api/setup', { code: SETUP_CODE, password: 'short' });
    expect(response.statusCode).toBe(400);
    expect(existsSync(t.setupCodeFile)).toBe(true);
  });

  it('logs in with the password and reports the session', async () => {
    const t = await make();
    await setupAndLogin(t);

    expect((await t.app.inject('/api/session')).json()).toMatchObject({ state: 'logged_out' });
    expect((await post(t, '/api/login', { password: 'nope nope nope' })).statusCode).toBe(401);

    const login = toLogin(await post(t, '/api/login', { password: PASSWORD }));
    const info = await t.app.inject({ url: '/api/session', headers: { cookie: login.cookie } });
    expect(info.json()).toMatchObject({ state: 'logged_in', reauthRequired: false });
  });

  it('locks out after too many wrong passwords, then unlocks', async () => {
    let time = 1_000_000;
    const t = await make({ now: () => time });
    await setupAndLogin(t);

    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect((await post(t, '/api/login', { password: 'wrong wrong wrong' })).statusCode).toBe(401);
    }
    const locked = await post(t, '/api/login', { password: 'wrong wrong wrong' });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().retryAfterSeconds).toBeGreaterThan(0);

    expect((await post(t, '/api/login', { password: PASSWORD })).statusCode).toBe(429);

    time += LOCKOUT_MS + 1000;
    expect((await post(t, '/api/login', { password: PASSWORD })).statusCode).toBe(200);
  });

  it('writes denied logins and successful setup to the audit log', async () => {
    const t = await make();
    await setupAndLogin(t);
    await post(t, '/api/login', { password: 'wrong wrong wrong' });
    const events = t.audit.recent(10).map((row) => `${row.event}:${row.outcome}`);
    expect(events).toContain('setup:ok');
    expect(events).toContain('login:denied');
  });

  it('lets a new setup code reset the password and signs everyone out', async () => {
    const t = await make();
    const first = await setupAndLogin(t);

    const { writeFileSync } = await import('node:fs');
    const { sha256 } = await import('./auth');
    writeFileSync(t.setupCodeFile, sha256('WXYZ6789') + '\n');
    expect((await t.app.inject('/api/session')).json()).toMatchObject({ setupAvailable: true });

    const reset = await post(t, '/api/setup', {
      code: 'WXYZ-6789',
      password: 'a brand new password',
    });
    expect(reset.statusCode).toBe(200);

    const old = await t.app.inject({ url: '/api/services', headers: { cookie: first.cookie } });
    expect(old.statusCode).toBe(401);
    expect((await post(t, '/api/login', { password: PASSWORD })).statusCode).toBe(401);
    expect((await post(t, '/api/login', { password: 'a brand new password' })).statusCode).toBe(
      200,
    );
  });
});

describe('sessions and CSRF', () => {
  it('requires a session for service endpoints', async () => {
    const t = await make();
    await setupAndLogin(t);
    expect((await t.app.inject('/api/services')).statusCode).toBe(401);
    expect((await post(t, '/api/services/jellyfin/start', {})).statusCode).toBe(401);
  });

  it('requires the CSRF token on changes', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    const withoutToken = await post(
      t,
      '/api/services/jellyfin/start',
      {},
      { cookie: login.cookie },
    );
    expect(withoutToken.statusCode).toBe(403);
    expect(withoutToken.json().error).toBe('csrf');
    const wrong = await post(
      t,
      '/api/services/jellyfin/start',
      {},
      { cookie: login.cookie, 'x-csrf-token': 'x'.repeat(32) },
    );
    expect(wrong.statusCode).toBe(403);
    expect(t.agent.calls.filter((c) => c.action === 'service.start')).toHaveLength(0);
  });

  it('expires sessions after seven days', async () => {
    let time = 1_000_000;
    const t = await make({ now: () => time });
    const login = await setupAndLogin(t);
    expect((await t.app.inject({ url: '/api/services', headers: login.headers })).statusCode).toBe(
      200,
    );
    time += 7 * 24 * 60 * 60_000 + 1;
    expect((await t.app.inject({ url: '/api/services', headers: login.headers })).statusCode).toBe(
      401,
    );
  });

  it('logs out', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    expect((await post(t, '/api/logout', {}, login.headers)).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/services', headers: login.headers })).statusCode).toBe(
      401,
    );
  });
});

describe('services', () => {
  it('lists catalog services with status and system numbers', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    await t.monitor.refresh();
    const body = (await t.app.inject({ url: '/api/services', headers: login.headers })).json();
    expect(body.agentReachable).toBe(true);
    expect(body.services.map((service: { name: string }) => service.name)).toEqual([
      'jellyfin',
      'navidrome',
      'immich',
      'nextcloud',
    ]);
    expect(body.services[0]).toMatchObject({
      name: 'jellyfin',
      displayName: 'Jellyfin',
      status: 'not_installed',
      lanPort: 8096,
      busy: null,
    });
    expect(body.system).toMatchObject({ cpuLoadPercent: 12.5, hostname: 'box' });
  });

  it('marks every card as an error when the agent cannot be reached', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.unreachable = true;
    await t.monitor.refresh();
    const body = (await t.app.inject({ url: '/api/services', headers: login.headers })).json();
    expect(body.agentReachable).toBe(false);
    expect(body.services[0].status).toBe('error');
  });

  it('returns 404 for services that are not in the catalog', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    expect((await post(t, '/api/services/rm-rf/start', {}, login.headers)).statusCode).toBe(404);
  });

  it('shows one-time login details once, then refuses', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    t.agent.credentialsPending = true;
    await t.monitor.refresh();
    const listed = (await t.app.inject({ url: '/api/services', headers: login.headers })).json();
    expect(listed.services[3]).toMatchObject({ name: 'nextcloud', credentialsPending: true });

    const first = await post(t, '/api/services/nextcloud/credentials', {}, login.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      credentials: [{ label: 'Admin password', value: 'secret-value' }],
    });

    const again = await post(t, '/api/services/nextcloud/credentials', {}, login.headers);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_shown' });
    expect(JSON.stringify(t.audit.recent?.(20) ?? [])).not.toContain('secret-value');
  });

  it('runs an install in the background and shows it as busy until it finishes', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    let release!: () => void;
    t.agent.gate = new Promise<void>((resolve) => (release = resolve));

    const started = await post(t, '/api/services/jellyfin/install', {}, login.headers);
    expect(started.statusCode).toBe(202);
    expect(t.monitor.snapshot().services[0]?.busy).toBe('installing');

    const second = await post(t, '/api/services/jellyfin/install', {}, login.headers);
    expect(second.statusCode).toBe(409);

    release();
    await vi.waitFor(() => expect(t.monitor.snapshot().services[0]?.busy).toBeNull());
    expect(t.monitor.snapshot().services[0]?.status).toBe('online');
    expect(t.audit.recent(5)[0]).toMatchObject({ event: 'service.install', outcome: 'ok' });
  });

  it('turns a failed action into an error card with a plain-English reason', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.failNext = new AgentRequestError('docker_unavailable', 'Docker is not running.');
    await post(t, '/api/services/jellyfin/install', {}, login.headers);
    await vi.waitFor(() => expect(t.monitor.snapshot().services[0]?.busy).toBeNull());
    expect(t.monitor.snapshot().services[0]).toMatchObject({
      status: 'error',
      message: 'Docker is not running on the server.',
    });
    expect(t.audit.recent(5)[0]).toMatchObject({ outcome: 'failed' });
  });

  it('stops and starts a service', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    await post(t, '/api/services/jellyfin/stop', {}, login.headers);
    await vi.waitFor(() => expect(t.monitor.snapshot().services[0]?.status).toBe('offline'));
    await post(t, '/api/services/jellyfin/start', {}, login.headers);
    await vi.waitFor(() => expect(t.monitor.snapshot().services[0]?.status).toBe('online'));
  });

  it('counts errors in recent logs and suggests a fix', async () => {
    const t = await make();
    await setupAndLogin(t);
    t.agent.serviceState = 'running';
    t.agent.logLines = [
      'all fine',
      '[ERR] Failed to write /srv/media/movies: Permission denied',
      'Exception while scanning',
    ];
    await t.monitor.refresh();
    const card = t.monitor.snapshot().services[0];
    expect(card?.errorCount).toBe(2);
    expect(card?.hints.join(' ')).toMatch(/not allowed/);
  });
});

describe('uninstall', () => {
  it('needs a recent password check', async () => {
    let time = 1_000_000;
    const t = await make({ now: () => time });
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    time += REAUTH_AFTER_MS + 1000;

    const refused = await post(
      t,
      '/api/services/jellyfin/uninstall',
      { deleteData: false },
      login.headers,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('reauth_required');

    expect(
      (await post(t, '/api/session/reauth', { password: 'wrong wrong wrong' }, login.headers))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(t, '/api/session/reauth', { password: PASSWORD }, login.headers)).statusCode,
    ).toBe(200);
    const ok = await post(
      t,
      '/api/services/jellyfin/uninstall',
      { deleteData: false },
      login.headers,
    );
    expect(ok.statusCode).toBe(202);
  });

  it('keeps data unless the service name is typed, then asks the agent for a confirm token', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';

    const mismatch = await post(
      t,
      '/api/services/jellyfin/uninstall',
      { deleteData: true, confirmName: 'jelly' },
      login.headers,
    );
    expect(mismatch.statusCode).toBe(400);
    expect(t.agent.calls.some((c) => c.action === 'service.uninstall')).toBe(false);

    const ok = await post(
      t,
      '/api/services/jellyfin/uninstall',
      { deleteData: true, confirmName: 'jellyfin' },
      login.headers,
    );
    expect(ok.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(t.agent.calls.some((c) => c.action === 'service.uninstall')).toBe(true),
    );
    const issue = t.agent.calls.find((c) => c.action === 'confirm.issue');
    expect(issue).toMatchObject({ kind: 'service.uninstall', target: 'jellyfin' });
    const uninstall = t.agent.calls.find((c) => c.action === 'service.uninstall');
    expect(uninstall).toMatchObject({ deleteData: true, confirm: 'T'.repeat(43) });
  });

  it('does not ask for a confirm token when keeping data', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    await post(t, '/api/services/jellyfin/uninstall', { deleteData: false }, login.headers);
    await vi.waitFor(() =>
      expect(t.agent.calls.some((c) => c.action === 'service.uninstall')).toBe(true),
    );
    expect(t.agent.calls.some((c) => c.action === 'confirm.issue')).toBe(false);
  });
});

describe('streams', () => {
  const readEvents = async (response: Response, count: number) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while ((text.match(/\n\n/g) ?? []).length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    return text;
  };

  it('streams log lines over SSE, following until the client leaves', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    t.agent.logLines = ['first line', 'second line'];
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/services/jellyfin/logs?tail=50&follow=1`, {
      headers: { cookie: login.cookie },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await readEvents(response, 3);
    expect(text).toContain('event: ready');
    expect(text).toContain('"line":"first line"');
    expect(text).toContain('"line":"second line"');
    expect(t.agent.calls.find((c) => c.action === 'logs.stream')).toMatchObject({
      tail: 50,
      follow: true,
    });
  });

  it('says so when the service is not installed', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${address}/api/services/jellyfin/logs`, {
      headers: { cookie: login.cookie },
    });
    const text = await readEvents(response, 2);
    expect(text).toContain('event: problem');
    expect(text).toContain('not installed');
  });

  it('pushes the current status first, then changes', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${address}/api/status/stream`, {
      headers: { cookie: login.cookie },
    });
    const first = readEvents(response, 1);
    expect(await first).toContain('event: status');
  });

  it('refuses streams without a session', async () => {
    const t = await make();
    await setupAndLogin(t);
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    expect((await fetch(`${address}/api/status/stream`)).status).toBe(401);
  });

  it('downloads logs as a text file', async () => {
    const t = await make();
    const login = await setupAndLogin(t);
    t.agent.serviceState = 'running';
    t.agent.logLines = ['hello'];
    const response = await t.app.inject({
      url: '/api/services/jellyfin/logs/download',
      headers: login.headers,
    });
    expect(response.headers['content-disposition']).toContain('jellyfin-logs.txt');
    expect(response.body).toBe('hello\n');
  });
});

describe('web app files', () => {
  it('serves the page for app routes but a real 404 for missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfhost-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

    const t = await createTestApp({ webDir: dir });
    current = t;

    const route = await t.app.inject('/services/jellyfin');
    expect(route.statusCode).toBe(200);
    expect(route.headers['content-type']).toContain('text/html');

    const asset = await t.app.inject('/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');

    const missing = await t.app.inject('/assets/gone.js');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).not.toContain('text/html');
  });
});
