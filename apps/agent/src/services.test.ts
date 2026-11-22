import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { AgentResponse } from '@selfhost/shared';
import { createDispatcher } from './dispatch';
import { handlers, type Deps } from './handlers';
import type { HostFs, Paths } from './host';
import { parseComposeLogs } from './logs';

const paths: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  renderDevice: '/dev/dri/renderD128',
};
const COMPOSE = '/opt/selfhost/services/jellyfin/compose.yml';

function makeHost(
  options: { renderGid?: number; docker?: (args: readonly string[]) => string } = {},
) {
  const files = new Map<string, string>();
  const dirs: { path: string; owner?: { uid: number; gid: number } }[] = [];
  const removed: string[] = [];
  const commands: (readonly string[])[] = [];

  const fs: HostFs = {
    async ensureDir(path, owner) {
      dirs.push({ path, owner });
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async removeDir(path) {
      removed.push(path);
      for (const key of files.keys()) if (key.startsWith(path + '/')) files.delete(key);
    },
    async exists(path) {
      return files.has(path);
    },
    async gidOf(path) {
      return path === paths.renderDevice ? (options.renderGid ?? null) : null;
    },
  };

  const run: Deps['run'] = async (file, args) => {
    commands.push([file, ...args]);
    if (file === 'id') return args[0] === '-u' ? '1001\n' : '1002\n';
    if (file === 'docker') return options.docker?.(args) ?? '';
    throw new Error(`unexpected command ${file}`);
  };

  const deps: Deps = {
    dryRun: false,
    docker: { listServiceContainers: async () => [] },
    run,
    paths,
    fs,
  };
  return { deps, files, dirs, removed, commands };
}

async function ask(deps: Deps, request: Record<string, unknown>): Promise<AgentResponse[]> {
  const dispatch = createDispatcher({ handlers, deps, log: () => {} });
  const out: AgentResponse[] = [];
  for await (const message of dispatch(JSON.stringify({ id: 'r1', ...request }))) out.push(message);
  return out;
}

const install = (deps: Deps) => ask(deps, { action: 'service.install', service: 'jellyfin' });
const dockerCommands = (commands: (readonly string[])[]) =>
  commands.filter((c) => c[0] === 'docker').map((c) => c.slice(6).join(' '));

describe('service.install', () => {
  it('writes the compose file, creates config folders for the selfhost user, and starts it', async () => {
    const host = makeHost();
    expect(await install(host.deps)).toMatchObject([{ ok: true }]);

    const compose = parse(host.files.get(COMPOSE)!);
    expect(compose.services.jellyfin.image).toBe('jellyfin/jellyfin:12.4');
    expect(compose.services.jellyfin.user).toBe('1001:1002');
    expect(compose.services.jellyfin.devices).toBeUndefined();

    const owner = { uid: 1001, gid: 1002 };
    expect(host.dirs).toContainEqual({ path: '/opt/selfhost/config/jellyfin/config', owner });
    expect(host.dirs).toContainEqual({ path: '/opt/selfhost/config/jellyfin/cache', owner });

    expect(host.commands).toContainEqual([
      'docker',
      'compose',
      '--project-name',
      'selfhost-jellyfin',
      '--file',
      COMPOSE,
      'up',
      '--detach',
    ]);
  });

  it('passes the Intel GPU through when the render device exists', async () => {
    const host = makeHost({ renderGid: 105 });
    await install(host.deps);
    const service = parse(host.files.get(COMPOSE)!).services.jellyfin;
    expect(service.devices).toEqual(['/dev/dri:/dev/dri']);
    expect(service.group_add).toEqual(['105']);
  });

  it('is safe to run twice', async () => {
    const host = makeHost();
    await install(host.deps);
    expect(await install(host.deps)).toMatchObject([{ ok: true }]);
  });

  it('says plainly that services outside the catalog are not available', async () => {
    const host = makeHost();
    const [reply] = await ask(host.deps, { action: 'service.install', service: 'immich' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
    expect(host.commands).toEqual([]);
  });

  it('reports a missing selfhost user instead of installing as root', async () => {
    const host = makeHost();
    const run: Deps['run'] = async (file) => {
      if (file === 'id') throw new Error('id: selfhost: no such user');
      return '';
    };
    const [reply] = await install({ ...host.deps, run });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(host.files.size).toBe(0);
  });

  it('reports Docker missing', async () => {
    const host = makeHost();
    const run: Deps['run'] = async (file) => {
      if (file === 'id') return '1001\n';
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    };
    const [reply] = await install({ ...host.deps, run });
    expect(reply).toMatchObject({ ok: false, error: { code: 'docker_unavailable' } });
  });
});

describe('start, stop and restart', () => {
  it('refuse a service that is not installed', async () => {
    const host = makeHost();
    for (const action of ['service.start', 'service.stop', 'service.restart']) {
      const [reply] = await ask(host.deps, { action, service: 'jellyfin' });
      expect(reply).toMatchObject({ ok: false, error: { code: 'not_installed' } });
    }
    expect(host.commands).toEqual([]);
  });

  it('run the matching compose command', async () => {
    const host = makeHost();
    await install(host.deps);
    host.commands.length = 0;
    for (const action of ['service.start', 'service.stop', 'service.restart']) {
      expect(await ask(host.deps, { action, service: 'jellyfin' })).toMatchObject([{ ok: true }]);
    }
    expect(dockerCommands(host.commands)).toEqual(['up --detach', 'stop', 'restart']);
  });
});

describe('service.update', () => {
  it('re-renders from the pinned version, pulls, then recreates', async () => {
    const host = makeHost();
    await install(host.deps);
    host.files.set(COMPOSE, 'stale: true\n');
    host.commands.length = 0;

    expect(await ask(host.deps, { action: 'service.update', service: 'jellyfin' })).toMatchObject([
      { ok: true },
    ]);
    expect(parse(host.files.get(COMPOSE)!).services.jellyfin.image).toBe('jellyfin/jellyfin:12.4');
    expect(dockerCommands(host.commands)).toEqual(['pull', 'up --detach']);
  });

  it('refuses a service that is not installed', async () => {
    const [reply] = await ask(makeHost().deps, { action: 'service.update', service: 'jellyfin' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_installed' } });
  });
});

describe('service.uninstall', () => {
  it('keeps config and library folders by default', async () => {
    const host = makeHost();
    await install(host.deps);
    const reply = await ask(host.deps, {
      action: 'service.uninstall',
      service: 'jellyfin',
      deleteData: false,
    });
    expect(reply).toMatchObject([{ ok: true }]);
    expect(host.removed).toEqual(['/opt/selfhost/services/jellyfin']);
    expect(dockerCommands(host.commands).at(-1)).toBe('down --remove-orphans');
  });

  it('deletes only the service config when asked, and never anything under /srv', async () => {
    const host = makeHost();
    await install(host.deps);
    const reply = await ask(host.deps, {
      action: 'service.uninstall',
      service: 'jellyfin',
      deleteData: true,
      confirm: 'a'.repeat(32),
    });
    expect(reply).toMatchObject([{ ok: true }]);
    expect(host.removed).toEqual([
      '/opt/selfhost/services/jellyfin',
      '/opt/selfhost/config/jellyfin',
    ]);
    expect(host.removed.some((p) => p.startsWith('/srv'))).toBe(false);
  });

  it('needs a confirm token to delete data', async () => {
    const host = makeHost();
    await install(host.deps);
    const [reply] = await ask(host.deps, {
      action: 'service.uninstall',
      service: 'jellyfin',
      deleteData: true,
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
    expect(host.removed).toEqual([]);
  });
});

describe('logs', () => {
  const output =
    'selfhost-jellyfin  | 2026-11-22T09:30:00.123456789Z Jellyfin is starting\n' +
    'selfhost-jellyfin  | 2026-11-22T09:30:01.000000000Z [ERR] something failed\n';

  it('streams parsed lines then ends', async () => {
    const host = makeHost({ docker: () => output });
    await install(host.deps);
    const replies = await ask(host.deps, { action: 'logs.stream', service: 'jellyfin', tail: 50 });
    expect(replies).toEqual([
      {
        id: 'r1',
        chunk: {
          ts: '2026-11-22T09:30:00.123456789Z',
          stream: 'stdout',
          line: 'Jellyfin is starting',
        },
      },
      {
        id: 'r1',
        chunk: {
          ts: '2026-11-22T09:30:01.000000000Z',
          stream: 'stdout',
          line: '[ERR] something failed',
        },
      },
      { id: 'r1', end: true },
    ]);
    expect(dockerCommands(host.commands).at(-1)).toBe('logs --no-color --timestamps --tail 50');
  });

  it('downloads every line', async () => {
    const host = makeHost({ docker: () => output });
    await install(host.deps);
    const replies = await ask(host.deps, { action: 'logs.download', service: 'jellyfin' });
    expect(replies).toHaveLength(3);
    expect(dockerCommands(host.commands).at(-1)).toBe('logs --no-color --timestamps --tail all');
  });

  it('refuses a service that is not installed', async () => {
    const [reply] = await ask(makeHost().deps, {
      action: 'logs.stream',
      service: 'jellyfin',
      tail: 10,
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_installed' } });
  });
});

describe('parseComposeLogs', () => {
  it('keeps lines without a prefix or timestamp', () => {
    expect([...parseComposeLogs('plain line\n\n')]).toEqual([
      { ts: null, stream: 'stdout', line: 'plain line' },
    ]);
  });
});
