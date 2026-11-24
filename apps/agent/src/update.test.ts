import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@selfhost/shared';
import { createConfirmTokens } from './confirm';
import { createDispatcher } from './dispatch';
import { dryRunStreamer } from './exec';
import { handlers, type Deps } from './handlers';
import type { HostFs, Paths } from './host';

const paths: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  backupsDir: '/opt/selfhost/backups',
  renderDevice: '/dev/dri/renderD128',
  unitDir: '/etc/systemd/system',
  mountRoot: '/mnt',
};
const JELLYFIN_COMPOSE = '/opt/selfhost/services/jellyfin/compose.yml';
const SNAPSHOTS = '/opt/selfhost/backups/jellyfin';

type Host = ReturnType<typeof makeHost>;

function makeHost(
  options: { healthy?: boolean; failOn?: (args: readonly string[]) => boolean } = {},
) {
  const files = new Map<string, string>();
  const commands: string[][] = [];
  const owned: string[] = [];

  const fs: HostFs = {
    async ensureDir() {},
    async writeFile(path, content) {
      files.set(path, content);
    },
    async removeDir(path) {
      for (const key of [...files.keys()]) if (key.startsWith(path + '/')) files.delete(key);
    },
    async exists(path) {
      return files.has(path);
    },
    async gidOf() {
      return null;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async removeFile(path) {
      files.delete(path);
    },
    async listDir(path) {
      return [
        ...new Set(
          [...files.keys()]
            .filter((key) => key.startsWith(path + '/'))
            .map((key) => key.slice(path.length + 1).split('/')[0]!),
        ),
      ];
    },
    async setOwner(path) {
      owned.push(path);
    },
    async realPath(path) {
      return path;
    },
  };

  const deps: Deps = {
    dryRun: false,
    docker: {
      listServiceContainers: async () => [
        { name: 'selfhost-jellyfin', state: 'running', health: null, startedAt: null },
      ],
    },
    run: async (file, args) => {
      commands.push([file, ...args]);
      if (file === 'id') return args[0] === '-u' ? '1001\n' : '1002\n';
      if (file === 'docker' && options.failOn?.(args)) throw new Error('failed');
      const [verb, from, to] = args.slice(5);
      if (file === 'docker' && verb === 'cp' && from!.includes(':') && to) files.set(to, 'dump');
      return '';
    },
    paths,
    fs,
    stream: dryRunStreamer,
    httpCheck: async () => options.healthy ?? true,
    confirmTokens: createConfirmTokens(),
    timing: { pollMs: 1, healthTimeoutMs: 20 },
  };
  return { deps, files, commands, owned };
}

async function ask(deps: Deps, request: Record<string, unknown>): Promise<AgentResponse[]> {
  const dispatch = createDispatcher({ handlers, deps, log: () => {} });
  const out: AgentResponse[] = [];
  for await (const message of dispatch(JSON.stringify({ id: 'r1', ...request }))) out.push(message);
  return out;
}

const composeSteps = (commands: string[][]) =>
  commands.filter((c) => c[0] === 'docker').map((c) => c.slice(6).join(' '));

// Installs, then makes the compose file look like it came from an older kit release.
async function installOld(host: Host, service = 'jellyfin') {
  await ask(host.deps, { action: 'service.install', service });
  const path = `/opt/selfhost/services/${service}/compose.yml`;
  host.files.set(path, host.files.get(path)!.replace(/@sha256:[a-f0-9]{64}/g, '-old'));
  host.files.set(`/opt/selfhost/services/${service}/version`, '12.3\n');
  host.commands.length = 0;
}

async function updateOf(host: Host, service = 'jellyfin') {
  const [reply] = await ask(host.deps, { action: 'service.status', service });
  return (reply as unknown as { data: { update: unknown } }).data.update;
}

describe('update availability', () => {
  it('records the version on install and reports no update', async () => {
    const host = makeHost();
    await ask(host.deps, { action: 'service.install', service: 'jellyfin' });
    expect(host.files.get('/opt/selfhost/services/jellyfin/version')).toBe('12.4\n');
    expect(host.files.get(JELLYFIN_COMPOSE)).toMatch(/image: jellyfin\/jellyfin:12\.4@sha256:/);
    expect(await updateOf(host)).toMatchObject({ available: false, installedVersion: '12.4' });
  });

  it('reports an update when the installed images differ from this release', async () => {
    const host = makeHost();
    await installOld(host);
    expect(await updateOf(host)).toMatchObject({
      available: true,
      installedVersion: '12.3',
      newVersion: '12.4',
    });
  });

  it('has nothing to report for a service that is not installed', async () => {
    expect(await updateOf(makeHost())).toBeNull();
  });
});

describe('service.update', () => {
  it('saves a copy first, then pulls, starts and waits for it to answer', async () => {
    const host = makeHost();
    await installOld(host);
    const old = host.files.get(JELLYFIN_COMPOSE)!;

    expect(await ask(host.deps, { action: 'service.update', service: 'jellyfin' })).toMatchObject([
      { ok: true },
    ]);

    expect(composeSteps(host.commands)).toEqual(['stop', 'pull', 'up --detach']);
    const tarAt = host.commands.findIndex((c) => c[0] === 'tar');
    const pullAt = host.commands.findIndex((c) => c.includes('pull'));
    expect(host.commands[tarAt]).toContain('--exclude=./cache');
    expect(tarAt).toBeLessThan(pullAt);

    const saved = [...host.files.entries()].find(
      ([key]) => key.startsWith(SNAPSHOTS) && key.endsWith('/compose.yml'),
    );
    expect(saved?.[0]).toMatch(/\/\d{8}T\d{6}Z\/compose\.yml$/);
    expect(saved?.[1]).toBe(old);
    expect(host.files.get(JELLYFIN_COMPOSE)).not.toBe(old);
    expect(await updateOf(host)).toMatchObject({ available: false, installedVersion: '12.4' });
    expect(host.owned).toContain('/opt/selfhost/backups');
  });

  it('puts the old version back when the new one does not answer', async () => {
    const host = makeHost({ healthy: false });
    await installOld(host);
    const old = host.files.get(JELLYFIN_COMPOSE)!;

    const [reply] = await ask(host.deps, { action: 'service.update', service: 'jellyfin' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'rolled_back' } });

    expect(host.files.get(JELLYFIN_COMPOSE)).toBe(old);
    expect(host.files.get('/opt/selfhost/services/jellyfin/version')).toBe('12.3\n');
    expect(host.commands.some((c) => c[0] === 'tar' && c.includes('--extract'))).toBe(true);
    expect(composeSteps(host.commands).slice(-2)).toEqual(['down --remove-orphans', 'up --detach']);
    expect(await updateOf(host)).toMatchObject({ available: true, installedVersion: '12.3' });
  });

  it('puts the old version back when the download fails', async () => {
    const host = makeHost({ failOn: (args) => args.includes('pull') });
    await installOld(host);
    const [reply] = await ask(host.deps, { action: 'service.update', service: 'jellyfin' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'rolled_back' } });
    expect(composeSteps(host.commands).at(-1)).toBe('up --detach');
  });

  it('says so plainly when the old version cannot be put back either', async () => {
    const host = makeHost({ healthy: false, failOn: (args) => args.includes('down') });
    await installOld(host);
    const [reply] = await ask(host.deps, { action: 'service.update', service: 'jellyfin' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect((reply as unknown as { error: { message: string } }).error.message).toContain(
      '/opt/selfhost/backups/jellyfin/',
    );
  });

  it('keeps only the three newest saved copies', async () => {
    const host = makeHost();
    await installOld(host);
    for (const id of [
      '20250101T000000Z',
      '20250102T000000Z',
      '20250103T000000Z',
      '20250104T000000Z',
    ]) {
      host.files.set(`${SNAPSHOTS}/${id}/compose.yml`, 'old');
    }
    await ask(host.deps, { action: 'service.update', service: 'jellyfin' });
    const ids = new Set(
      [...host.files.keys()]
        .filter((key) => key.startsWith(SNAPSHOTS))
        .map((key) => key.split('/')[5]),
    );
    expect(ids.size).toBe(3);
    expect(ids.has('20250101T000000Z')).toBe(false);
    expect(ids.has('20250104T000000Z')).toBe(true);
  });

  it('dumps the database before stopping, and restores it on rollback', async () => {
    const host = makeHost({ healthy: false });
    await installOld(host, 'immich');
    await ask(host.deps, { action: 'service.update', service: 'immich' });
    const steps = composeSteps(host.commands);

    const dump = steps.findIndex((s) => s.includes('pg_dump --username immich --dbname immich'));
    expect(dump).toBeGreaterThan(-1);
    expect(dump).toBeLessThan(steps.indexOf('stop'));
    expect(steps.some((s) => s.startsWith('cp database:/tmp/selfhost.sql '))).toBe(true);

    const restore = steps.findIndex((s) => s.includes('psql --username immich'));
    expect(restore).toBeGreaterThan(steps.indexOf('down --remove-orphans'));
    const tar = host.commands.find((c) => c[0] === 'tar' && c.includes('--create'))!;
    expect(tar).toEqual(expect.arrayContaining(['--exclude=./db', '--exclude=./ml-cache']));
  });
});

describe('snapshot actions', () => {
  it('creates a snapshot and starts the service again if it was running', async () => {
    const host = makeHost();
    await installOld(host);
    const [reply] = await ask(host.deps, { action: 'snapshot.create', service: 'jellyfin' });
    expect(reply).toMatchObject({
      ok: true,
      data: { snapshot: expect.stringMatching(/^\d{8}T\d{6}Z$/) },
    });
    expect(composeSteps(host.commands)).toEqual(['stop', 'up --detach']);
  });

  it('only restores with a confirm token made for that service', async () => {
    const host = makeHost();
    await installOld(host);
    host.files.set(`${SNAPSHOTS}/20250101T000000Z/compose.yml`, 'saved');
    const request = {
      action: 'snapshot.restore',
      service: 'jellyfin',
      snapshot: '20250101T000000Z',
    };

    expect((await ask(host.deps, request))[0]).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });
    const wrong = host.deps.confirmTokens.issue('snapshot.restore', 'navidrome');
    expect((await ask(host.deps, { ...request, confirm: wrong }))[0]).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });

    const token = host.deps.confirmTokens.issue('snapshot.restore', 'jellyfin');
    expect((await ask(host.deps, { ...request, confirm: token }))[0]).toMatchObject({ ok: true });
    expect(host.files.get(JELLYFIN_COMPOSE)).toBe('saved');
  });

  it('refuses a snapshot that does not exist', async () => {
    const host = makeHost();
    await installOld(host);
    const token = host.deps.confirmTokens.issue('snapshot.restore', 'jellyfin');
    const [reply] = await ask(host.deps, {
      action: 'snapshot.restore',
      service: 'jellyfin',
      snapshot: '20250101T000000Z',
      confirm: token,
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
