import { afterEach, describe, expect, it } from 'vitest';
import { AgentRequestError } from './agent-client';
import { REAUTH_AFTER_MS } from './auth';
import { createTestApp, setupAndLogin, type Login, type TestApp } from './test-helpers';

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
  return { t, login: await setupAndLogin(t) };
};

const post = (t: TestApp, login: Login, url: string, payload: unknown = {}) =>
  t.app.inject({ method: 'POST', url, payload: payload as object, headers: login.headers });

const UUID = '22222222-2222-4222-8222-222222222222';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('storage API', () => {
  it('needs a signed in session', async () => {
    const t = await createTestApp();
    opened.push(t);
    expect((await t.app.inject('/api/storage')).statusCode).toBe(401);
  });

  it('returns the disks, every library folder and no job at rest', async () => {
    const { t, login } = await make();
    t.agent.disks = [{ device: 'sdb', volumes: [] }];
    t.agent.mappedFolders = { movies: { mountLabel: 'media1', subpath: 'Movies' } };
    const response = await t.app.inject({ url: '/api/storage', headers: login.headers });
    const body = response.json();
    expect(body.disks).toHaveLength(1);
    expect(body.folders).toHaveLength(6);
    expect(body.folders.find((f: { folder: string }) => f.folder === 'movies').mapped).toEqual({
      mountLabel: 'media1',
      subpath: 'Movies',
    });
    expect(body.job).toBeNull();
  });

  it('mounts a drive and records it', async () => {
    const { t, login } = await make();
    const response = await post(t, login, `/api/disks/${UUID}/mount`, { label: 'media1' });
    expect(response.statusCode).toBe(200);
    expect(t.agent.calls).toContainEqual({ action: 'disk.mount', uuid: UUID, label: 'media1' });
    expect(t.audit.recent(1)[0]).toMatchObject({ event: 'disk.mount', outcome: 'ok' });
  });

  it('rejects drive names that could be paths or commands', async () => {
    const { t, login } = await make();
    for (const label of ['../etc', 'Media 1', 'a;b', '']) {
      const response = await post(t, login, `/api/disks/${UUID}/mount`, { label });
      expect(response.statusCode, label).toBe(400);
    }
    expect((await post(t, login, '/api/disks/x%3By/mount', { label: 'ok' })).statusCode).toBe(400);
    expect(t.agent.calls.some((c) => c.action === 'disk.mount')).toBe(false);
  });

  it('passes the agent reason through when a drive is in use', async () => {
    const { t, login } = await make();
    t.agent.failNext = new AgentRequestError(
      'in_use',
      'Stop Jellyfin first, then unmount the drive.',
    );
    const response = await post(t, login, `/api/disks/${UUID}/unmount`);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Stop Jellyfin first, then unmount the drive.');
  });

  it('stops the services that use the drive when asked, then unmounts', async () => {
    const { t, login } = await make();
    t.agent.disks = [{ device: 'sdb', volumes: [{ uuid: UUID, mountLabel: 'media1' }] }];
    t.agent.mappedFolders = { movies: { mountLabel: 'media1', subpath: 'Movies' } };
    t.agent.serviceState = 'running';
    await t.monitor.refresh();

    const response = await post(t, login, `/api/disks/${UUID}/unmount`, { stopServices: true });
    expect(response.statusCode).toBe(200);
    const actions = t.agent.calls.map((c) => c.action);
    expect(actions.indexOf('service.stop')).toBeGreaterThan(-1);
    expect(actions.indexOf('service.stop')).toBeLessThan(actions.indexOf('disk.unmount'));
  });

  describe('format', () => {
    const DISK_ID = '0123456789abcdef';
    const format = (t: TestApp, login: Login, payload: unknown, device = 'sdb') =>
      post(t, login, `/api/disks/by-device/${device}/format`, payload);

    it('needs the disk name typed out', async () => {
      const { t, login } = await make();
      const response = await format(t, login, {
        diskId: DISK_ID,
        label: 'media1',
        confirmName: 'media1',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('confirmation_mismatch');
      expect(t.agent.calls.some((c) => c.action === 'disk.format')).toBe(false);
    });

    it('needs the disk id the page was showing', async () => {
      const { t, login } = await make();
      for (const payload of [
        { label: 'media1', confirmName: 'sdb' },
        { diskId: 'not-an-id', label: 'media1', confirmName: 'sdb' },
      ]) {
        const response = await format(t, login, payload);
        expect(response.statusCode).toBe(400);
      }
      expect(t.agent.calls.some((c) => c.action === 'disk.format')).toBe(false);
    });

    it('needs a recent password', async () => {
      let time = Date.now();
      const { t, login } = await make({ now: () => time });
      time += REAUTH_AFTER_MS + 1000;
      const response = await format(t, login, {
        diskId: DISK_ID,
        label: 'media1',
        confirmName: 'sdb',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('reauth_required');
    });

    it('only accepts kernel disk names, not partitions or paths', async () => {
      const { t, login } = await make();
      for (const device of ['sdb1', 'loop0', 'sda%3Breboot']) {
        const response = await format(
          t,
          login,
          { diskId: DISK_ID, label: 'media1', confirmName: device },
          device,
        );
        expect(response.statusCode, device).toBe(400);
      }
    });

    it('gets a confirm token from the agent and formats in the background', async () => {
      const { t, login } = await make();
      const response = await format(t, login, {
        diskId: DISK_ID,
        label: 'media1',
        confirmName: 'sdb',
      });
      expect(response.statusCode).toBe(202);
      await settle();
      const calls = t.agent.calls.map((c) => c.action);
      expect(calls.indexOf('confirm.issue')).toBeLessThan(calls.indexOf('disk.format'));
      expect(t.agent.calls.find((c) => c.action === 'disk.format')).toMatchObject({
        device: 'sdb',
        diskId: DISK_ID,
        label: 'media1',
        confirm: 'T'.repeat(43),
      });
      expect(t.audit.recent(1)[0]).toMatchObject({ event: 'disk.format', outcome: 'ok' });
      const body = (await t.app.inject({ url: '/api/storage', headers: login.headers })).json();
      expect(body.job).toBeNull();
    });

    it('keeps a failed format visible until it is dismissed', async () => {
      const { t, login } = await make();
      t.agent.failNext = new AgentRequestError(
        'refused',
        'The drive the server runs from can never be erased here.',
      );
      await format(t, login, { diskId: DISK_ID, label: 'media1', confirmName: 'sdb' });
      await settle();
      const read = async () =>
        (await t.app.inject({ url: '/api/storage', headers: login.headers })).json().job;
      expect(await read()).toMatchObject({
        kind: 'formatting',
        state: 'failed',
        message: 'The drive the server runs from can never be erased here.',
      });
      await post(t, login, '/api/storage/job/dismiss');
      expect(await read()).toBeNull();
    });

    it('refuses a second change while one is running', async () => {
      const { t, login } = await make();
      let release!: () => void;
      t.agent.gate = new Promise<void>((resolve) => (release = resolve));
      await format(t, login, { diskId: DISK_ID, label: 'media1', confirmName: 'sdb' });
      await settle();
      const second = await format(
        t,
        login,
        { diskId: DISK_ID, label: 'media2', confirmName: 'sdc' },
        'sdc',
      );
      expect(second.statusCode).toBe(409);
      release();
      await settle();
    });
  });

  describe('folder assign', () => {
    const assign = (t: TestApp, login: Login, payload: object, folder = 'movies') =>
      post(t, login, `/api/folders/${folder}/assign`, payload);

    it('maps a library folder to a folder on a drive', async () => {
      const { t, login } = await make();
      const response = await assign(t, login, { uuid: UUID, subpath: 'Movies' });
      expect(response.statusCode).toBe(202);
      await settle();
      expect(t.agent.calls).toContainEqual({
        action: 'folder.assign',
        folder: 'movies',
        uuid: UUID,
        subpath: 'Movies',
        copyExisting: false,
      });
    });

    it('rejects paths that try to leave the drive and unknown folders', async () => {
      const { t, login } = await make();
      expect((await assign(t, login, { uuid: UUID, subpath: '../etc' })).statusCode).toBe(400);
      expect((await assign(t, login, { uuid: UUID, subpath: 'a/../b' })).statusCode).toBe(400);
      expect((await assign(t, login, { uuid: UUID, subpath: 'x' }, 'etc')).statusCode).toBe(400);
    });

    it('stops the services that use the folder and starts them again after', async () => {
      const { t, login } = await make();
      t.agent.serviceState = 'running';
      await t.monitor.refresh();
      await assign(t, login, { uuid: UUID, subpath: 'Movies', stopServices: true });
      await settle();
      const actions = t.agent.calls.map((c) => c.action);
      const stop = actions.indexOf('service.stop');
      const assigned = actions.indexOf('folder.assign');
      const start = actions.lastIndexOf('service.start');
      expect(stop).toBeGreaterThan(-1);
      expect(stop).toBeLessThan(assigned);
      expect(start).toBeGreaterThan(assigned);
    });

    it('shows why a change failed', async () => {
      const { t, login } = await make();
      t.agent.failNext = new AgentRequestError('refused', 'This folder already has files in it.');
      await assign(t, login, { uuid: UUID, subpath: 'Movies' });
      await settle();
      const job = (await t.app.inject({ url: '/api/storage', headers: login.headers })).json().job;
      expect(job).toMatchObject({
        state: 'failed',
        message: 'This folder already has files in it.',
      });
    });
  });

  it('turns a service with a missing drive into an error on its card', async () => {
    const { t, login } = await make();
    t.agent.serviceState = 'running';
    t.agent.missingFolders = ['movies'];
    await t.monitor.refresh();
    const services = (await t.app.inject({ url: '/api/services', headers: login.headers })).json()
      .services;
    expect(services[0]).toMatchObject({ status: 'error' });
    expect(services[0].message).toContain('movies');
  });
});
