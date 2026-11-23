import { imageRef, type ServiceManifest } from '@selfhost/catalog';
import type { ServiceName, ServiceUpdateInfo, SnapshotCreateResult } from '@selfhost/shared';
import { AgentError } from './errors';
import type { Deps, Handlers } from './handlers';
import {
  MINUTES,
  compose,
  composeFile,
  requireInstalled,
  requireManifest,
  versionFile,
  writeService,
} from './service-handlers';

const KEEP_SNAPSHOTS = 3;
const HEALTH_TIMEOUT_MS = 5 * MINUTES;
const POLL_MS = 5000;
const DATABASE_READY_ATTEMPTS = 30;
const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/;
const DUMP_PATH_IN_CONTAINER = '/tmp/selfhost.sql';

const serviceSnapshotsDir = (deps: Deps, service: ServiceName) =>
  `${deps.paths.backupsDir}/${service}`;
const configDirOf = (deps: Deps, service: ServiceName) => `${deps.paths.configDir}/${service}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pollMs = (deps: Deps) => deps.timing?.pollMs ?? POLL_MS;

const IMAGE_LINE = /^\s*image:\s*(\S+)\s*$/gm;

// An update is available when the compose file on disk does not use every image this kit release
// pins. Reading the file means servers installed before versions were recorded still work.
export async function updateInfo(
  deps: Deps,
  manifest: ServiceManifest,
): Promise<ServiceUpdateInfo | null> {
  const text = await deps.fs.readFile(composeFile(deps, manifest.name));
  if (text === null) return null;
  const installed = new Set([...text.matchAll(IMAGE_LINE)].map((match) => match[1]!));
  const upToDate = manifest.images.every(
    (image) =>
      installed.has(imageRef(manifest, image, false)) ||
      installed.has(imageRef(manifest, image, true)),
  );
  const version = (await deps.fs.readFile(versionFile(deps, manifest.name)))?.trim() || null;
  return {
    available: !upToDate,
    installedVersion: version,
    newVersion: manifest.version,
    releaseNotesUrl: manifest.releaseNotesUrl,
  };
}

function newSnapshotId(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

async function listSnapshots(deps: Deps, service: ServiceName): Promise<string[]> {
  const entries = await deps.fs.listDir(serviceSnapshotsDir(deps, service));
  return entries.filter((entry) => SNAPSHOT_ID.test(entry)).sort();
}

// Keeps the newest few. Snapshots hold database dumps and secrets, so they are not left piling up.
async function pruneSnapshots(deps: Deps, service: ServiceName): Promise<void> {
  const all = await listSnapshots(deps, service);
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) {
    await deps.fs.removeDir(`${serviceSnapshotsDir(deps, service)}/${old}`);
  }
}

async function waitForDatabase(deps: Deps, manifest: ServiceManifest): Promise<void> {
  const database = manifest.snapshot.database!;
  for (let attempt = 0; attempt < DATABASE_READY_ATTEMPTS; attempt++) {
    // A TCP check, because the database's first-start helper only listens on a local socket and
    // would otherwise look ready just before it restarts.
    const ready = await compose(deps, manifest.name, [
      'exec',
      '-T',
      database.container,
      'pg_isready',
      '--host',
      '127.0.0.1',
      '--username',
      database.user,
      '--dbname',
      database.name,
    ]).then(
      () => true,
      () => false,
    );
    if (ready) return;
    await sleep(pollMs(deps));
  }
  throw new AgentError('failed', 'The database did not start in time.');
}

async function isHealthy(deps: Deps, manifest: ServiceManifest): Promise<boolean> {
  const containers = await deps.docker.listServiceContainers(manifest.name);
  if (containers.length === 0) return false;
  if (!containers.every((c) => c.state === 'running' && c.health !== 'unhealthy')) return false;
  return deps.httpCheck(
    `http://127.0.0.1:${manifest.ports.lan}${manifest.health.path}`,
    manifest.health.expect,
  );
}

async function waitUntilHealthy(deps: Deps, manifest: ServiceManifest): Promise<boolean> {
  const deadline = Date.now() + (deps.timing?.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  for (;;) {
    if (await isHealthy(deps, manifest).catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs(deps));
  }
}

// Saves the config folder, a database dump where there is one, and the compose file in use. Leaves
// the service stopped so the copy is consistent; the caller starts it again.
async function takeSnapshot(deps: Deps, manifest: ServiceManifest): Promise<string> {
  const service = manifest.name;
  const composeText = await deps.fs.readFile(composeFile(deps, service));
  if (composeText === null) throw new AgentError('not_installed', 'This service is not installed.');

  const id = newSnapshotId();
  const dir = `${serviceSnapshotsDir(deps, service)}/${id}`;
  const root = { uid: 0, gid: 0 };
  for (const path of [deps.paths.backupsDir, serviceSnapshotsDir(deps, service), dir]) {
    await deps.fs.ensureDir(path);
    await deps.fs.setOwner(path, root, 0o700);
  }

  const database = manifest.snapshot.database;
  if (database) {
    await compose(deps, service, ['up', '--detach', database.container], {
      timeoutMs: 5 * MINUTES,
    });
    await waitForDatabase(deps, manifest);
    await compose(
      deps,
      service,
      [
        'exec',
        '-T',
        database.container,
        'pg_dump',
        '--username',
        database.user,
        '--dbname',
        database.name,
        '--file',
        DUMP_PATH_IN_CONTAINER,
      ],
      { timeoutMs: 30 * MINUTES },
    );
    await compose(
      deps,
      service,
      ['cp', `${database.container}:${DUMP_PATH_IN_CONTAINER}`, `${dir}/database.sql`],
      { timeoutMs: 30 * MINUTES },
    );
    await compose(deps, service, [
      'exec',
      '-T',
      database.container,
      'rm',
      '-f',
      DUMP_PATH_IN_CONTAINER,
    ]);
  }

  await compose(deps, service, ['stop'], { timeoutMs: 5 * MINUTES });
  await deps.run(
    'tar',
    [
      '--create',
      '--numeric-owner',
      '--file',
      `${dir}/config.tar`,
      '--directory',
      configDirOf(deps, service),
      ...manifest.snapshot.skipDirs.map((skip) => `--exclude=./${skip}`),
      '.',
    ],
    { timeoutMs: 30 * MINUTES },
  );
  await deps.fs.writeFile(`${dir}/compose.yml`, composeText, 0o600);
  const version = await deps.fs.readFile(versionFile(deps, service));
  if (version !== null) await deps.fs.writeFile(`${dir}/version`, version, 0o600);
  return id;
}

// Puts a snapshot back and starts the service. The database is rebuilt from the dump into an empty
// data folder, so a failed update that changed the database layout is undone too.
async function restoreSnapshot(deps: Deps, manifest: ServiceManifest, id: string): Promise<void> {
  const service = manifest.name;
  const dir = `${serviceSnapshotsDir(deps, service)}/${id}`;
  const savedCompose = await deps.fs.readFile(`${dir}/compose.yml`);
  if (savedCompose === null) throw new AgentError('not_found', 'That saved copy does not exist.');
  const database = manifest.snapshot.database;
  if (database && !(await deps.fs.exists(`${dir}/database.sql`))) {
    throw new AgentError('failed', 'That saved copy has no database in it.');
  }

  await compose(deps, service, ['down', '--remove-orphans'], { timeoutMs: 5 * MINUTES });
  await deps.fs.writeFile(composeFile(deps, service), savedCompose, 0o644);

  const configDir = configDirOf(deps, service);
  const skipped = new Set(manifest.snapshot.skipDirs);
  for (const entry of await deps.fs.listDir(configDir)) {
    if (!skipped.has(entry)) await deps.fs.removeDir(`${configDir}/${entry}`);
  }
  await deps.run(
    'tar',
    ['--extract', '--numeric-owner', '--file', `${dir}/config.tar`, '--directory', configDir],
    { timeoutMs: 30 * MINUTES },
  );
  const version = await deps.fs.readFile(`${dir}/version`);
  if (version !== null) await deps.fs.writeFile(versionFile(deps, service), version, 0o644);

  if (database) {
    await deps.fs.removeDir(`${configDir}/${database.dataDir}`);
    await deps.fs.ensureDir(`${configDir}/${database.dataDir}`);
    await compose(deps, service, ['up', '--detach', database.container], {
      timeoutMs: 5 * MINUTES,
    });
    await waitForDatabase(deps, manifest);
    await compose(
      deps,
      service,
      ['cp', `${dir}/database.sql`, `${database.container}:${DUMP_PATH_IN_CONTAINER}`],
      { timeoutMs: 30 * MINUTES },
    );
    await compose(
      deps,
      service,
      [
        'exec',
        '-T',
        database.container,
        'psql',
        '--username',
        database.user,
        '--dbname',
        database.name,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
        '--file',
        DUMP_PATH_IN_CONTAINER,
      ],
      { timeoutMs: 60 * MINUTES },
    );
    await compose(deps, service, [
      'exec',
      '-T',
      database.container,
      'rm',
      '-f',
      DUMP_PATH_IN_CONTAINER,
    ]);
  }
  await compose(deps, service, ['up', '--detach'], { timeoutMs: 5 * MINUTES });
}

export const updateHandlers: Handlers = {
  // Saves the service, moves to the version this kit release pins, and waits for it to answer. If it
  // does not come up healthy in five minutes, the saved copy is put back.
  async 'service.update'(request, deps) {
    const manifest = requireManifest(request.service);
    await requireInstalled(deps, request.service);

    const snapshot = await takeSnapshot(deps, manifest);
    try {
      await writeService(deps, manifest);
      await compose(deps, request.service, ['pull'], { timeoutMs: 20 * MINUTES });
      await compose(deps, request.service, ['up', '--detach'], { timeoutMs: 5 * MINUTES });
      if (!(await waitUntilHealthy(deps, manifest))) {
        throw new Error('The new version did not become healthy in time.');
      }
    } catch {
      try {
        await restoreSnapshot(deps, manifest, snapshot);
      } catch {
        throw new AgentError(
          'failed',
          `The update did not work and the old version could not be put back automatically. A saved copy is in ${serviceSnapshotsDir(deps, request.service)}/${snapshot}.`,
        );
      }
      throw new AgentError(
        'rolled_back',
        `The update did not work, so ${manifest.displayName} was put back the way it was.`,
      );
    }
    await pruneSnapshots(deps, request.service);
    return { data: {} };
  },

  async 'snapshot.create'(request, deps) {
    const manifest = requireManifest(request.service);
    await requireInstalled(deps, request.service);
    const wasRunning = (await deps.docker.listServiceContainers(request.service)).some(
      (container) => container.state === 'running',
    );
    const snapshot = await takeSnapshot(deps, manifest);
    if (wasRunning) {
      await compose(deps, request.service, ['up', '--detach'], { timeoutMs: 5 * MINUTES });
    }
    await pruneSnapshots(deps, request.service);
    const data: SnapshotCreateResult = { snapshot };
    return { data };
  },

  async 'snapshot.restore'(request, deps) {
    const manifest = requireManifest(request.service);
    await requireInstalled(deps, request.service);
    await restoreSnapshot(deps, manifest, request.snapshot);
    return { data: {} };
  },
};
