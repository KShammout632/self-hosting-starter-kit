import { getManifest, renderCompose, type ServiceManifest } from '@selfhost/catalog';
import type { ServiceName } from '@selfhost/shared';
import { projectName } from './docker';
import { AgentError } from './errors';
import type { Deps, Handlers } from './handlers';
import { parseComposeLogs } from './logs';

async function* toAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  yield* items;
}

const SAFE_TIMEZONE = /^[A-Za-z0-9_/+-]{1,64}$/;
const SERVICE_USER = 'selfhost';
const MINUTES = 60_000;

const composeFile = (deps: Deps, service: ServiceName) =>
  `${deps.paths.servicesDir}/${service}/compose.yml`;

function timezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return SAFE_TIMEZONE.test(zone) ? zone : 'UTC';
}

async function serviceUserId(deps: Deps, flag: '-u' | '-g'): Promise<number> {
  const value = Number.parseInt((await deps.run('id', [flag, SERVICE_USER])).trim(), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentError('failed', 'The selfhost system user is missing. Run the installer again.');
  }
  return value;
}

function requireManifest(service: ServiceName): ServiceManifest {
  const manifest = getManifest(service);
  if (!manifest) throw new AgentError('not_implemented', 'This service is not available yet.');
  return manifest;
}

async function requireInstalled(deps: Deps, service: ServiceName): Promise<void> {
  if (!(await deps.fs.exists(composeFile(deps, service)))) {
    throw new AgentError('not_installed', 'This service is not installed yet.');
  }
}

async function compose(
  deps: Deps,
  service: ServiceName,
  args: readonly string[],
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<string> {
  try {
    return await deps.run(
      'docker',
      [
        'compose',
        '--project-name',
        projectName(service),
        '--file',
        composeFile(deps, service),
        ...args,
      ],
      options,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentError('docker_unavailable', 'Docker is not installed or cannot be reached.');
    }
    throw error;
  }
}

// Renders the compose file from the manifest pin and writes it, along with the config folders the
// container needs. Safe to run again: this is also how an update picks up a new pinned version.
async function writeService(deps: Deps, manifest: ServiceManifest): Promise<void> {
  const uid = await serviceUserId(deps, '-u');
  const gid = await serviceUserId(deps, '-g');
  const configDir = `${deps.paths.configDir}/${manifest.name}`;
  const renderGid = manifest.gpu.intel ? await deps.fs.gidOf(deps.paths.renderDevice) : null;

  const rendered = renderCompose(manifest, {
    puid: uid,
    pgid: gid,
    tz: timezone(),
    configDir,
    renderGid,
  });

  const owner = { uid, gid };
  await deps.fs.ensureDir(configDir, owner);
  for (const dir of manifest.configDirs) await deps.fs.ensureDir(`${configDir}/${dir}`, owner);
  await deps.fs.ensureDir(`${deps.paths.servicesDir}/${manifest.name}`);
  await deps.fs.writeFile(composeFile(deps, manifest.name), rendered, 0o644);
}

export const serviceHandlers: Handlers = {
  async 'service.install'(request, deps) {
    const manifest = requireManifest(request.service);
    await writeService(deps, manifest);
    await compose(deps, request.service, ['up', '--detach'], { timeoutMs: 20 * MINUTES });
    return { data: {} };
  },

  async 'service.start'(request, deps) {
    await requireInstalled(deps, request.service);
    await compose(deps, request.service, ['up', '--detach'], { timeoutMs: 5 * MINUTES });
    return { data: {} };
  },

  async 'service.stop'(request, deps) {
    await requireInstalled(deps, request.service);
    await compose(deps, request.service, ['stop'], { timeoutMs: 2 * MINUTES });
    return { data: {} };
  },

  async 'service.restart'(request, deps) {
    await requireInstalled(deps, request.service);
    await compose(deps, request.service, ['restart'], { timeoutMs: 5 * MINUTES });
    return { data: {} };
  },

  // Moves to whatever version this kit release pins. Snapshots and rollback arrive in M5.
  async 'service.update'(request, deps) {
    const manifest = requireManifest(request.service);
    await requireInstalled(deps, request.service);
    await writeService(deps, manifest);
    await compose(deps, request.service, ['pull'], { timeoutMs: 20 * MINUTES });
    await compose(deps, request.service, ['up', '--detach'], { timeoutMs: 5 * MINUTES });
    return { data: {} };
  },

  // Never touches library folders under /srv. deleteData removes only the service's own config.
  async 'service.uninstall'(request, deps) {
    await requireInstalled(deps, request.service);
    await compose(deps, request.service, ['down', '--remove-orphans'], { timeoutMs: 5 * MINUTES });
    await deps.fs.removeDir(`${deps.paths.servicesDir}/${request.service}`);
    if (request.deleteData) await deps.fs.removeDir(`${deps.paths.configDir}/${request.service}`);
    return { data: {} };
  },

  // Returns the last lines and ends. Following live output arrives with the dashboard in M2.
  async 'logs.stream'(request, deps) {
    await requireInstalled(deps, request.service);
    const output = await compose(
      deps,
      request.service,
      ['logs', '--no-color', '--timestamps', '--tail', String(request.tail)],
      { timeoutMs: MINUTES, maxBufferBytes: 16 * 1024 * 1024 },
    );
    return { stream: toAsync(parseComposeLogs(output)) };
  },

  async 'logs.download'(request, deps) {
    await requireInstalled(deps, request.service);
    const output = await compose(
      deps,
      request.service,
      ['logs', '--no-color', '--timestamps', '--tail', 'all'],
      { timeoutMs: 2 * MINUTES, maxBufferBytes: 64 * 1024 * 1024 },
    );
    return { stream: toAsync(parseComposeLogs(output)) };
  },
};
