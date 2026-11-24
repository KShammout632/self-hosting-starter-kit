import { afterEach, describe, expect, it } from 'vitest';
import type { KitUpdateStatus } from '@selfhost/shared';
import { AgentRequestError } from './agent-client';
import { REAUTH_AFTER_MS } from './auth';
import { newestRelease } from './settings-routes';
import {
  PASSWORD,
  createTestApp,
  setupAndLogin,
  toLogin,
  type Login,
  type TestApp,
} from './test-helpers';

const opened: TestApp[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) {
    t.monitor.stop();
    await t.app.close();
  }
});

const release = (version: string) => async () => ({
  version,
  url: `https://github.com/example/releases/tag/v${version}`,
});

const make = async (options: Parameters<typeof createTestApp>[0] = {}) => {
  const t = await createTestApp({ fetchLatest: release('0.2.0'), ...options });
  opened.push(t);
  return { t, login: await setupAndLogin(t) };
};

const get = (t: TestApp, login: Login, url: string) =>
  t.app.inject({ url, headers: login.headers });
const post = (t: TestApp, login: Login, url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: login.headers });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const agentCalls = (t: TestApp, action: string) => t.agent.calls.filter((c) => c.action === action);

describe('settings API access', () => {
  it('needs a signed in session', async () => {
    const t = await createTestApp();
    opened.push(t);
    for (const url of ['/api/settings/kit', '/api/settings/system', '/api/settings/audit']) {
      expect((await t.app.inject(url)).statusCode).toBe(401);
    }
    for (const url of [
      '/api/settings/kit/update',
      '/api/settings/system/apply',
      '/api/settings/reboot',
      '/api/settings/password',
    ]) {
      expect((await t.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    }
  });
});

describe('kit updates', () => {
  it('shows an update when GitHub has a newer release', async () => {
    const { t, login } = await make();
    expect((await get(t, login, '/api/settings/kit')).json()).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checkFailed: false,
      releaseNotesUrl: 'https://github.com/example/releases/tag/v0.2.0',
    });
  });

  it('shows no update when already on the latest version', async () => {
    const { t, login } = await make({ fetchLatest: release('0.1.0') });
    expect((await get(t, login, '/api/settings/kit')).json()).toMatchObject({
      updateAvailable: false,
    });
  });

  it('keeps working when GitHub cannot be reached', async () => {
    const { t, login } = await make({
      fetchLatest: async () => {
        throw new Error('offline');
      },
    });
    expect((await get(t, login, '/api/settings/kit')).json()).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: null,
      updateAvailable: false,
      checkFailed: true,
    });
  });

  it('looks only once a day, and retries a failure after an hour', async () => {
    let time = 1_000_000;
    let calls = 0;
    let offline = true;
    const { t, login } = await make({
      now: () => time,
      fetchLatest: async () => {
        calls++;
        if (offline) throw new Error('offline');
        return release('0.2.0')();
      },
    });
    await get(t, login, '/api/settings/kit');
    await get(t, login, '/api/settings/kit');
    expect(calls).toBe(1);

    time += 61 * 60_000;
    offline = false;
    await get(t, login, '/api/settings/kit');
    expect(calls).toBe(2);
    time += 60 * 60_000;
    await get(t, login, '/api/settings/kit');
    expect(calls).toBe(2);
    time += 24 * 60 * 60_000;
    await get(t, login, '/api/settings/kit');
    expect(calls).toBe(3);
  });

  it('reports the last result written by the update script', async () => {
    const status: KitUpdateStatus = {
      state: 'rolled_back',
      version: '0.2.0',
      message: 'The new version did not start, so the old one was put back.',
      at: '2026-11-24T10:00:00Z',
    };
    const { t, login } = await make({ readUpdateStatus: () => status });
    expect((await get(t, login, '/api/settings/kit')).json()).toMatchObject({ update: status });
  });

  it('asks the agent for the newest version, and nothing else from the request', async () => {
    const { t, login } = await make();
    const response = await post(t, login, '/api/settings/kit/update', {
      version: '9.9.9',
      url: 'http://127.0.0.1:1',
    });
    expect(response.statusCode).toBe(202);
    await settle();
    expect(agentCalls(t, 'kit.update')).toEqual([{ action: 'kit.update', version: '0.2.0' }]);
    expect(t.audit.recent(1)[0]).toMatchObject({
      event: 'kit.update',
      target: '0.2.0',
      outcome: 'ok',
    });
  });

  it('refuses when already up to date', async () => {
    const { t, login } = await make({ fetchLatest: release('0.1.0') });
    const response = await post(t, login, '/api/settings/kit/update');
    expect(response.statusCode).toBe(409);
    expect(agentCalls(t, 'kit.update')).toEqual([]);
  });

  it('refuses while an update is already running', async () => {
    const { t, login } = await make({
      readUpdateStatus: () => ({
        state: 'running',
        version: '0.2.0',
        message: 'Installing',
        at: new Date().toISOString(),
      }),
    });
    expect((await post(t, login, '/api/settings/kit/update')).statusCode).toBe(409);
    expect(agentCalls(t, 'kit.update')).toEqual([]);
  });

  it('treats an update that stopped without finishing as failed, so a new one can start', async () => {
    const stale: KitUpdateStatus = {
      state: 'running',
      version: '0.2.0',
      message: 'Installing',
      at: new Date(Date.now() - 31 * 60_000).toISOString(),
    };
    const { t, login } = await make({ readUpdateStatus: () => stale });
    expect((await get(t, login, '/api/settings/kit')).json().update).toMatchObject({
      state: 'failed',
    });
    expect((await post(t, login, '/api/settings/kit/update')).statusCode).toBe(202);
  });

  it('needs a recent password', async () => {
    let time = 1_000_000;
    const { t, login } = await make({ now: () => time });
    time += REAUTH_AFTER_MS + 1;
    const response = await post(t, login, '/api/settings/kit/update');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'reauth_required' });
    expect(agentCalls(t, 'kit.update')).toEqual([]);
  });

  it('shows why the update did not start', async () => {
    const { t, login } = await make();
    t.agent.failNext = new AgentRequestError('failed', 'Could not download that version.');
    await post(t, login, '/api/settings/kit/update');
    await settle();
    const snapshot = (await get(t, login, '/api/settings/kit')).json();
    expect(snapshot.job).toEqual({ state: 'failed', message: 'Could not download that version.' });
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'kit.update', outcome: 'failed' });
  });
});

describe('system updates', () => {
  it('shows how many updates are waiting and whether a restart is needed', async () => {
    const { t, login } = await make();
    t.agent.updates = { packages: 5, security: 2, rebootRequired: true };
    expect((await get(t, login, '/api/settings/system')).json()).toMatchObject({
      packages: 5,
      security: 2,
      rebootRequired: true,
      job: null,
    });
    expect(agentCalls(t, 'system.updates.check')).toEqual([
      { action: 'system.updates.check', refresh: false },
    ]);
  });

  it('refreshes the package lists only when asked', async () => {
    const { t, login } = await make();
    await post(t, login, '/api/settings/system/check');
    expect(agentCalls(t, 'system.updates.check')).toEqual([
      { action: 'system.updates.check', refresh: true },
    ]);
  });

  it('installs updates in the background, with a recent password', async () => {
    const { t, login } = await make();
    expect((await post(t, login, '/api/settings/system/apply')).statusCode).toBe(202);
    await settle();
    expect(agentCalls(t, 'system.updates.apply')).toHaveLength(1);
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'system.updates.apply', outcome: 'ok' });
  });

  it('needs a recent password to install updates', async () => {
    let time = 1_000_000;
    const { t, login } = await make({ now: () => time });
    time += REAUTH_AFTER_MS + 1;
    expect((await post(t, login, '/api/settings/system/apply')).statusCode).toBe(403);
    expect(agentCalls(t, 'system.updates.apply')).toEqual([]);
  });

  it('shows a failure in plain words', async () => {
    const { t, login } = await make();
    t.agent.failNext = new AgentRequestError('busy', 'The server is busy with an update.');
    await post(t, login, '/api/settings/system/apply');
    await settle();
    expect((await get(t, login, '/api/settings/system')).json().job).toEqual({
      state: 'failed',
      message: 'The server is busy with an update.',
    });
  });
});

describe('restart', () => {
  it('asks the agent for a confirmation first, then restarts', async () => {
    const { t, login } = await make();
    expect((await post(t, login, '/api/settings/reboot')).statusCode).toBe(202);
    const actions = t.agent.calls.map((c) => c.action);
    expect(actions.indexOf('confirm.issue')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('confirm.issue')).toBeLessThan(actions.indexOf('system.reboot'));
    expect(agentCalls(t, 'confirm.issue')[0]).toMatchObject({ kind: 'system.reboot' });
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'system.reboot', outcome: 'ok' });
  });

  it('needs a recent password', async () => {
    let time = 1_000_000;
    const { t, login } = await make({ now: () => time });
    time += REAUTH_AFTER_MS + 1;
    expect((await post(t, login, '/api/settings/reboot')).statusCode).toBe(403);
    expect(agentCalls(t, 'system.reboot')).toEqual([]);
  });

  it('says so when the server is busy', async () => {
    const { t, login } = await make();
    t.agent.failNext = new AgentRequestError('busy', 'The server is busy with an update.');
    const response = await post(t, login, '/api/settings/reboot');
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('The server is busy with an update.');
  });
});

describe('change password', () => {
  const NEW_PASSWORD = 'a brand new password';
  const login = (t: TestApp, password: string) =>
    t.app.inject({ method: 'POST', url: '/api/login', payload: { password } });

  it('changes the password, signs other sessions out and keeps this one', async () => {
    const { t, login: current } = await make();
    const other = toLogin(await login(t, PASSWORD));

    const response = await post(t, current, '/api/settings/password', {
      current: PASSWORD,
      next: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(200);
    const fresh = toLogin(response);

    expect((await get(t, fresh, '/api/settings/audit')).statusCode).toBe(200);
    expect((await get(t, other, '/api/settings/audit')).statusCode).toBe(401);
    expect((await get(t, current, '/api/settings/audit')).statusCode).toBe(401);

    expect((await login(t, PASSWORD)).statusCode).toBe(401);
    expect((await login(t, NEW_PASSWORD)).statusCode).toBe(200);
    expect(t.audit.recent(5).map((e) => e.event)).toContain('password.change');
  });

  it('refuses a wrong current password', async () => {
    const { t, login: current } = await make();
    const response = await post(t, current, '/api/settings/password', {
      current: 'wrong password',
      next: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(401);
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'password.change', outcome: 'denied' });
    expect((await get(t, current, '/api/settings/audit')).statusCode).toBe(200);
  });

  it('refuses a short or unchanged password', async () => {
    const { t, login: current } = await make();
    const attempt = (next: string) =>
      post(t, current, '/api/settings/password', { current: PASSWORD, next });
    expect((await attempt('short')).statusCode).toBe(400);
    expect((await attempt(PASSWORD)).statusCode).toBe(400);
  });
});

describe('audit log', () => {
  it('lists the newest entries first and limits how many', async () => {
    const { t, login } = await make();
    await post(t, login, '/api/settings/system/apply');
    await settle();
    const { entries } = (await get(t, login, '/api/settings/audit?limit=2')).json();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ event: 'system.updates.apply', actor: 'admin' });
    expect((await get(t, login, '/api/settings/audit?limit=100000')).statusCode).toBe(400);
  });
});

describe('choosing the newest release', () => {
  const releases = [
    { tag_name: 'v1.0.0', prerelease: false, draft: false },
    { tag_name: 'v1.1.0', prerelease: true, draft: false },
    { tag_name: 'v0.9.1', prerelease: true, draft: false },
    { tag_name: 'v2.0.0', prerelease: false, draft: true },
    { tag_name: 'v9.0.0-rc.1', prerelease: false, draft: false },
    { tag_name: 42 },
    null,
  ];

  it('offers pre-releases to a server that is on a beta', () => {
    expect(newestRelease(releases, '0.9.0')).toBe('1.1.0');
    expect(newestRelease([releases[2]], '0.9.0')).toBe('0.9.1');
  });

  it('offers only full releases from 1.0.0 on', () => {
    expect(newestRelease(releases, '1.0.0')).toBe('1.0.0');
  });

  it('skips drafts and tags that are not plain versions', () => {
    expect(newestRelease(releases, '0.9.0')).not.toBe('2.0.0');
    expect(newestRelease([releases[3], releases[4], releases[5], releases[6]], '0.9.0')).toBeNull();
  });

  it('offers no pre-release when the installed version is unknown', () => {
    expect(newestRelease([releases[2]], null)).toBeNull();
  });
});
