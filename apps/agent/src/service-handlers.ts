import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { getManifest, renderCompose, type ServiceManifest } from '@selfhost/catalog';
import {
  LIBRARY_FOLDER_PATHS,
  type ServiceCredentialsResult,
  type ServiceName,
} from '@selfhost/shared';
import { projectName } from './docker';
import { AgentError } from './errors';
import type { Deps, Handlers } from './handlers';
import { parseComposeLine, parseComposeLogs, type LogLine } from './logs';

async function* toAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  yield* items;
}

async function* followLogs(
  deps: Deps,
  service: ServiceName,
  tail: number,
  signal: AbortSignal,
): AsyncGenerator<LogLine> {
  const args = [
    'compose',
    '--project-name',
    projectName(service),
    '--file',
    composeFile(deps, service),
    'logs',
    '--no-color',
    '--timestamps',
    '--follow',
    '--tail',
    String(tail),
  ];
  try {
    for await (const raw of deps.stream('docker', args, signal)) {
      const parsed = parseComposeLine(raw);
      if (parsed) yield parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentError('docker_unavailable', 'Docker is not installed or cannot be reached.');
    }
    throw error;
  }
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

const ENV_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tailscale)/;

// Names this machine answers to, for services that reject requests addressed to an unknown host.
function trustedDomains(): string[] {
  const addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  const names = ['localhost', '127.0.0.1', os.hostname(), ...addresses];
  return [...new Set(names)].filter((name) => SAFE_HOST.test(name));
}

function parseEnv(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = ENV_LINE.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

const envFile = (deps: Deps, service: ServiceName) => `${deps.paths.configDir}/${service}/.env`;
const credentialsMarker = (deps: Deps, service: ServiceName) =>
  `${deps.paths.configDir}/${service}/.credentials-shown`;

// Generates each secret once and keeps it across updates, so a reinstall never changes a database
// password the data folder was already created with. Root-owned and 0600: only compose reads it.
async function writeSecrets(deps: Deps, manifest: ServiceManifest): Promise<void> {
  if (manifest.secrets.length === 0) return;
  const path = envFile(deps, manifest.name);
  const existing = parseEnv(await deps.fs.readFile(path));
  const lines = manifest.secrets.flatMap(({ name, aliases }) => {
    const value = existing.get(name) ?? randomBytes(32).toString('hex');
    return [name, ...aliases].map((key) => `${key}=${value}`);
  });
  await deps.fs.writeFile(path, `${lines.join('\n')}\n`, 0o600);
}

export async function credentialsPending(deps: Deps, manifest: ServiceManifest): Promise<boolean> {
  return (
    manifest.credentials.length > 0 &&
    !(await deps.fs.exists(credentialsMarker(deps, manifest.name)))
  );
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
    trustedDomains: trustedDomains(),
  });

  const owner = { uid, gid };
  await deps.fs.ensureDir(configDir, owner);
  for (const dir of manifest.configDirs) await deps.fs.ensureDir(`${configDir}/${dir}`, owner);
  await writeSecrets(deps, manifest);
  if (manifest.libraryOwnerUid !== undefined) {
    const libraryOwner = { uid: manifest.libraryOwnerUid, gid };
    for (const { folder, access } of manifest.libraryFolders) {
      const path = LIBRARY_FOLDER_PATHS[folder];
      if (access === 'rw' && (await deps.fs.exists(path))) {
        await deps.fs.setOwner(path, libraryOwner, 0o2775);
      }
    }
  }
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

  // Returns the one-time login details once, then refuses. The marker is written before the reply
  // so a crash can never show the same password twice.
  async 'service.credentials'(request, deps) {
    const manifest = requireManifest(request.service);
    await requireInstalled(deps, request.service);
    if (manifest.credentials.length === 0) {
      throw new AgentError('not_found', 'This service has no login details to show.');
    }
    if (!(await credentialsPending(deps, manifest))) {
      throw new AgentError('refused', 'The login details were already shown.');
    }
    const secrets = parseEnv(await deps.fs.readFile(envFile(deps, request.service)));
    const credentials = manifest.credentials.map((entry) => {
      const value = entry.value ?? secrets.get(entry.secret!);
      if (value === undefined) {
        throw new AgentError(
          'failed',
          'The saved login details are missing. Reinstall the service.',
        );
      }
      return { label: entry.label, value };
    });
    await deps.fs.writeFile(credentialsMarker(deps, request.service), 'shown', 0o600);
    const data: ServiceCredentialsResult = { credentials };
    return { data };
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

  // Without follow, returns the last lines and ends. With follow, keeps sending new lines until the
  // caller disconnects.
  async 'logs.stream'(request, deps, { signal }) {
    await requireInstalled(deps, request.service);
    if (request.follow) {
      return { stream: followLogs(deps, request.service, request.tail, signal) };
    }
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
