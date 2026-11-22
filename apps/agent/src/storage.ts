import { getManifest } from '@selfhost/catalog';
import {
  LIBRARY_FOLDER_PATHS,
  LIBRARY_FOLDERS,
  SERVICE_NAMES,
  deviceName,
  type DiskInfo,
  type FolderUsageResult,
  type LibraryFolder,
  type SmartResult,
  type VolumeInfo,
} from '@selfhost/shared';
import { AgentError } from './errors';
import type { Deps } from './handlers';

const SERVICE_USER = 'selfhost';
const MARKER = '# Managed by selfhost. Changes may be overwritten.';
const MINUTES = 60_000;
const NEARLY_FULL = 0.9;
const MOUNTABLE = new Set(['ext4', 'ntfs', 'exfat']);
const MOUNT_TYPE: Record<string, string> = { ext4: 'ext4', ntfs: 'ntfs3', exfat: 'exfat' };
const STANDARD_FOLDERS = ['Movies', 'TV', 'Home Videos', 'Music', 'Photos', 'Nextcloud'];
const BY_UUID = '/dev/disk/by-uuid/';

// Mirrors `systemd-escape --path`: a mount unit must be named after the path it mounts.
export function unitNameForPath(path: string): string {
  const escape = (part: string) =>
    [...part]
      .map((char, index) =>
        /[A-Za-z0-9:_]/.test(char) || (char === '.' && index > 0)
          ? char
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
      )
      .join('');
  return `${path.split('/').filter(Boolean).map(escape).join('-')}.mount`;
}

interface RawDevice {
  name: string;
  type: string;
  size: number;
  fstype: string | null;
  uuid: string | null;
  label: string | null;
  mountpoints: string[];
  model: string | null;
  tran: string | null;
  rm: boolean;
  fsavail: number | null;
  fsused: number | null;
  children: RawDevice[];
}

const toNumber = (value: unknown): number | null => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};
const toText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

function parseDevice(raw: Record<string, unknown>): RawDevice {
  const mountpoints = Array.isArray(raw.mountpoints) ? raw.mountpoints : [raw.mountpoint];
  return {
    name: String(raw.name ?? ''),
    type: String(raw.type ?? ''),
    size: toNumber(raw.size) ?? 0,
    fstype: toText(raw.fstype),
    uuid: toText(raw.uuid),
    label: toText(raw.label),
    mountpoints: mountpoints.filter((m): m is string => typeof m === 'string'),
    model: toText(raw.model),
    tran: toText(raw.tran),
    rm: raw.rm === true || raw.rm === '1' || raw.rm === 1,
    fsavail: toNumber(raw.fsavail),
    fsused: toNumber(raw.fsused),
    children: Array.isArray(raw.children)
      ? raw.children.map((child) => parseDevice(child as Record<string, unknown>))
      : [],
  };
}

const flatten = (device: RawDevice): RawDevice[] => [device, ...device.children.flatMap(flatten)];

const readField = (text: string, key: string): string | null =>
  new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

interface ConfiguredMount {
  unit: string;
  what: string;
  where: string;
}

// Only units carrying the kit's marker line, so mounts the owner made by hand are never touched.
async function readConfiguredVolumes(deps: Deps): Promise<ConfiguredMount[]> {
  const names = (await deps.fs.listDir(deps.paths.unitDir)).filter((n) => n.endsWith('.mount'));
  const found: ConfiguredMount[] = [];
  for (const unit of names) {
    const text = await deps.fs.readFile(`${deps.paths.unitDir}/${unit}`);
    if (!text?.includes(MARKER)) continue;
    const what = readField(text, 'What');
    const where = readField(text, 'Where');
    if (what?.startsWith(BY_UUID) && where && parentOf(where) === deps.paths.mountRoot) {
      found.push({ unit, what, where });
    }
  }
  return found;
}

const LSBLK_COLUMNS = 'NAME,TYPE,SIZE,FSTYPE,UUID,LABEL,MOUNTPOINTS,MODEL,TRAN,RM,FSAVAIL,FSUSED';

export async function listDisks(deps: Deps): Promise<DiskInfo[]> {
  const output = await deps.run('lsblk', ['--json', '--bytes', '--output', LSBLK_COLUMNS]);
  const parsed = JSON.parse(output) as { blockdevices?: Record<string, unknown>[] };
  const configured = new Map(
    (await readConfiguredVolumes(deps)).map((m) => [m.what.slice(BY_UUID.length), m]),
  );
  const rootPrefix = `${deps.paths.mountRoot}/`;

  const disks: DiskInfo[] = [];
  for (const entry of parsed.blockdevices ?? []) {
    const disk = parseDevice(entry);
    if (disk.type !== 'disk' || !deviceName.safeParse(disk.name).success) continue;

    const nodes = flatten(disk);
    const mountpoints = nodes.flatMap((node) => node.mountpoints);
    const isSystem = mountpoints.some(
      (mount) => mount === '/' || mount.startsWith('/boot') || mount === '[SWAP]',
    );
    const hasPartitions = disk.children.some((child) => child.type === 'part');
    const candidates = nodes.filter(
      (node) => node.uuid && (node.type === 'part' || (node.type === 'disk' && !hasPartitions)),
    );

    const volumes: VolumeInfo[] = candidates.map((node) => {
      const mountPath = node.mountpoints.find(
        (mount) => mount.startsWith(rootPrefix) && !mount.slice(rootPrefix.length).includes('/'),
      );
      const known = configured.get(node.uuid!);
      const mountLabel = mountPath
        ? mountPath.slice(rootPrefix.length)
        : known
          ? known.where.slice(rootPrefix.length)
          : null;
      const used = node.fsused;
      const free = node.fsavail;
      const capacity = used !== null && free !== null ? used + free : null;
      return {
        partition: node.name,
        uuid: node.uuid!,
        fsLabel: node.label,
        filesystem: node.fstype,
        sizeBytes: node.size,
        usedBytes: used,
        freeBytes: free,
        mountLabel,
        mounted: node.mountpoints.length > 0,
        configured: known !== undefined,
        mountable: !isSystem && node.fstype !== null && MOUNTABLE.has(node.fstype),
        keepsPermissions: node.fstype === 'ext4',
        nearlyFull: capacity !== null && capacity > 0 && (used ?? 0) / capacity >= NEARLY_FULL,
      };
    });

    disks.push({
      device: disk.name,
      model: disk.model,
      sizeBytes: disk.size,
      transport: disk.tran,
      removable: disk.rm,
      isSystem,
      canFormat: !isSystem && mountpoints.length === 0,
      volumes,
    });
  }
  return disks;
}

export async function listMissing(deps: Deps, disks: DiskInfo[]) {
  const present = new Set(disks.flatMap((disk) => disk.volumes.map((volume) => volume.uuid)));
  const prefix = `${deps.paths.mountRoot}/`;
  return (await readConfiguredVolumes(deps))
    .map((mount) => ({
      uuid: mount.what.slice(BY_UUID.length),
      mountLabel: mount.where.slice(prefix.length),
    }))
    .filter((drive) => !present.has(drive.uuid));
}

function findVolume(disks: DiskInfo[], uuid: string) {
  for (const disk of disks) {
    const volume = disk.volumes.find((v) => v.uuid === uuid);
    if (volume) return { disk, volume };
  }
  throw new AgentError('not_found', 'That drive was not found. Check that it is plugged in.');
}

async function serviceOwner(deps: Deps) {
  const read = async (flag: '-u' | '-g') => {
    const value = Number.parseInt((await deps.run('id', [flag, SERVICE_USER])).trim(), 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new AgentError(
        'failed',
        'The selfhost system user is missing. Run the installer again.',
      );
    }
    return value;
  };
  return { uid: await read('-u'), gid: await read('-g') };
}

const volumePath = (deps: Deps, label: string) => `${deps.paths.mountRoot}/${label}`;

const systemctl = (deps: Deps, ...args: string[]) =>
  deps.run('systemctl', args, { timeoutMs: 2 * MINUTES });

// Services must be stopped before a library folder's drive changes underneath them. Otherwise they
// keep the old mount open, or write into an empty folder on the system drive.
async function runningServicesUsing(deps: Deps, folders: LibraryFolder[]): Promise<string[]> {
  const names: string[] = [];
  for (const name of SERVICE_NAMES) {
    const manifest = getManifest(name);
    if (!manifest?.libraryFolders.some((entry) => folders.includes(entry.folder))) continue;
    const containers = await deps.docker.listServiceContainers(name);
    if (containers.some((c) => c.state === 'running' || c.state === 'restarting')) {
      names.push(manifest.displayName);
    }
  }
  return names;
}

interface FolderMapping {
  folder: LibraryFolder;
  unit: string;
  mountLabel: string;
  subpath: string;
}

async function readFolderMappings(deps: Deps): Promise<FolderMapping[]> {
  const prefix = `${deps.paths.mountRoot}/`;
  const mappings: FolderMapping[] = [];
  for (const folder of LIBRARY_FOLDERS) {
    const unit = unitNameForPath(LIBRARY_FOLDER_PATHS[folder]);
    const text = await deps.fs.readFile(`${deps.paths.unitDir}/${unit}`);
    const what = text?.includes(MARKER) ? readField(text, 'What') : null;
    if (!what?.startsWith(prefix)) continue;
    const [mountLabel, ...rest] = what.slice(prefix.length).split('/');
    if (mountLabel) mappings.push({ folder, unit, mountLabel, subpath: rest.join('/') });
  }
  return mappings;
}

// A fresh drive's UUID link can lag behind mkfs, so the first start may fail with a dependency error
// even though `enable --now` reported success. Starting again a moment later works.
async function waitUntilActive(deps: Deps, unit: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await deps.run('systemctl', ['is-active', '--quiet', unit]);
      return;
    } catch {
      await sleep(1000);
      await systemctl(deps, 'start', unit).catch(() => {});
    }
  }
  await deps.run('systemctl', ['is-active', '--quiet', unit]);
}

export async function mountVolume(deps: Deps, uuid: string, label: string) {
  const { disk, volume } = findVolume(await listDisks(deps), uuid);
  if (disk.isSystem) {
    throw new AgentError('refused', 'The drive the server runs from cannot be used for storage.');
  }
  if (!volume.mountable || !volume.filesystem) {
    throw new AgentError('refused', 'This drive format is not supported. Use ext4, NTFS or exFAT.');
  }
  if (volume.mounted && !volume.configured) {
    throw new AgentError('in_use', 'This drive is already in use somewhere else on the server.');
  }

  const configured = await readConfiguredVolumes(deps);
  const where = volumePath(deps, label);
  const taken = configured.find((m) => m.where === where);
  if (taken && taken.what !== `${BY_UUID}${uuid}`) {
    throw new AgentError('refused', 'That name is already used by another drive.');
  }
  const current = configured.find((m) => m.what === `${BY_UUID}${uuid}`);
  if (current && current.where !== where) {
    throw new AgentError('refused', 'This drive is already set up under a different name.');
  }

  const owner = await serviceOwner(deps);
  // NTFS and exFAT cannot store Linux owners, so the mount itself says who owns every file.
  const options = volume.keepsPermissions
    ? ['nofail']
    : ['nofail', `uid=${owner.uid}`, `gid=${owner.gid}`, 'umask=002'];
  const unit = unitNameForPath(where);
  const unitPath = `${deps.paths.unitDir}/${unit}`;
  const text = [
    MARKER,
    '[Unit]',
    `Description=Drive ${label}`,
    '',
    '[Mount]',
    `What=${BY_UUID}${uuid}`,
    `Where=${where}`,
    `Type=${MOUNT_TYPE[volume.filesystem]}`,
    `Options=${options.join(',')}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');

  await deps.fs.ensureDir(where);
  await deps.fs.writeFile(unitPath, text, 0o644);
  try {
    await systemctl(deps, 'daemon-reload');
    await systemctl(deps, 'enable', '--now', unit);
    await waitUntilActive(deps, unit);
  } catch {
    await deps.fs.removeFile(unitPath);
    await systemctl(deps, 'daemon-reload').catch(() => {});
    throw new AgentError(
      'failed',
      'The drive could not be mounted. If it came from Windows, check it on a Windows computer first.',
    );
  }
  if (volume.keepsPermissions) await deps.fs.setOwner(where, owner, 0o775);
  // A folder unit stops when its drive goes away and does not come back by itself.
  for (const mapping of (await readFolderMappings(deps)).filter((m) => m.mountLabel === label)) {
    await systemctl(deps, 'start', mapping.unit).catch(() => {});
  }
  return { label, where };
}

export async function unmountVolume(deps: Deps, uuid: string) {
  const { volume } = findVolume(await listDisks(deps), uuid);
  if (!volume.configured || !volume.mountLabel) {
    if (volume.mounted) {
      throw new AgentError(
        'refused',
        'This drive was not mounted by the kit, so it is left alone.',
      );
    }
    return;
  }

  const mappings = (await readFolderMappings(deps)).filter(
    (m) => m.mountLabel === volume.mountLabel,
  );
  const busy = await runningServicesUsing(
    deps,
    mappings.map((m) => m.folder),
  );
  if (busy.length > 0) {
    throw new AgentError('in_use', `Stop ${busy.join(' and ')} first, then unmount the drive.`);
  }

  for (const mapping of mappings) await systemctl(deps, 'stop', mapping.unit);
  try {
    await systemctl(deps, 'stop', unitNameForPath(volumePath(deps, volume.mountLabel)));
  } catch {
    throw new AgentError(
      'in_use',
      'The drive is still busy. Close anything using it and try again.',
    );
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForPartition(deps: Deps, device: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await deps.run('udevadm', ['settle'], { timeoutMs: 30_000 });
    const output = await deps.run('lsblk', ['--json', '--output', 'NAME,TYPE', `/dev/${device}`]);
    const parsed = JSON.parse(output) as {
      blockdevices?: { children?: { name: string; type: string }[] }[];
    };
    const part = parsed.blockdevices?.[0]?.children?.find((c) => c.type === 'part');
    if (part) return part.name;
    await sleep(500);
  }
  throw new AgentError(
    'failed',
    'The new partition did not appear. Unplug the drive and try again.',
  );
}

export async function formatDisk(deps: Deps, device: string, label: string) {
  const disk = (await listDisks(deps)).find((d) => d.device === device);
  if (!disk) {
    throw new AgentError('not_found', 'That drive was not found. Check that it is plugged in.');
  }
  if (disk.isSystem) {
    throw new AgentError('refused', 'The drive the server runs from can never be erased here.');
  }
  if (!disk.canFormat) {
    throw new AgentError('in_use', 'Unmount this drive first, then try again.');
  }
  // ext4 stores at most 16 characters of label.
  if (label.length > 16) {
    throw new AgentError('refused', 'Use a name of 16 characters or fewer for a new drive.');
  }
  const taken = (await readConfiguredVolumes(deps)).some(
    (m) => m.where === volumePath(deps, label),
  );
  if (taken) throw new AgentError('refused', 'That name is already used by another drive.');

  const path = `/dev/${device}`;
  await deps.run('wipefs', ['--all', '--force', path], { timeoutMs: 2 * MINUTES });
  await deps.run(
    'parted',
    ['--script', path, 'mklabel', 'gpt', 'mkpart', 'primary', 'ext4', '1MiB', '100%'],
    { timeoutMs: 2 * MINUTES },
  );
  const partition = await waitForPartition(deps, device);
  await deps.run('mkfs.ext4', ['-F', '-m', '1', '-L', label, `/dev/${partition}`], {
    timeoutMs: 30 * MINUTES,
  });
  await deps.run('udevadm', ['settle'], { timeoutMs: 30_000 });

  const volume = (await listDisks(deps))
    .find((d) => d.device === device)
    ?.volumes.find((v) => v.partition === partition);
  if (!volume) throw new AgentError('failed', 'The new drive did not show up after formatting.');

  const { where } = await mountVolume(deps, volume.uuid, label);
  const owner = await serviceOwner(deps);
  for (const folder of STANDARD_FOLDERS) await deps.fs.ensureDir(`${where}/${folder}`, owner);
  return { uuid: volume.uuid, label };
}

export async function assignFolder(
  deps: Deps,
  folder: LibraryFolder,
  uuid: string,
  subpath: string,
  copyExisting: boolean,
) {
  const { volume } = findVolume(await listDisks(deps), uuid);
  if (!volume.configured || !volume.mountLabel || !volume.mounted) {
    throw new AgentError('refused', 'Mount this drive first, then choose its folders.');
  }

  const busy = await runningServicesUsing(deps, [folder]);
  if (busy.length > 0) {
    throw new AgentError('in_use', `Stop ${busy.join(' and ')} first, then change this folder.`);
  }

  const target = `${volumePath(deps, volume.mountLabel)}/${subpath}`;
  const path = LIBRARY_FOLDER_PATHS[folder];
  const unit = unitNameForPath(path);
  const unitPath = `${deps.paths.unitDir}/${unit}`;
  const existing = await deps.fs.readFile(unitPath);
  const alreadyMapped = existing?.includes(MARKER) === true;

  // Files already in the folder are hidden once a drive is mounted over it, so they are either
  // copied across first or the change is refused.
  const hasLocalFiles = !alreadyMapped && (await deps.fs.listDir(path)).length > 0;
  if (hasLocalFiles && !copyExisting) {
    throw new AgentError(
      'refused',
      'This folder already has files in it. Choose to copy them to the new drive, or empty it first.',
    );
  }

  const owner = await serviceOwner(deps);
  await deps.fs.ensureDir(target, volume.keepsPermissions ? owner : undefined);
  if (alreadyMapped) await systemctl(deps, 'stop', unit);
  if (hasLocalFiles) {
    await deps.run('rsync', ['-a', '--', `${path}/`, `${target}/`], {
      timeoutMs: 6 * 60 * MINUTES,
    });
  }

  const volumeUnit = unitNameForPath(volumePath(deps, volume.mountLabel));
  // BindsTo stops the folder when the drive goes away, so nothing writes into the empty mount point.
  const text = [
    MARKER,
    '[Unit]',
    `Description=Library folder ${folder}`,
    `BindsTo=${volumeUnit}`,
    `After=${volumeUnit}`,
    '',
    '[Mount]',
    `What=${target}`,
    `Where=${path}`,
    'Type=none',
    'Options=bind',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  await deps.fs.ensureDir(path);
  await deps.fs.writeFile(unitPath, text, 0o644);
  try {
    await systemctl(deps, 'daemon-reload');
    await systemctl(deps, 'enable', '--now', unit);
  } catch {
    throw new AgentError('failed', 'The folder could not be connected to the drive.');
  }
}

async function dfUsage(deps: Deps, path: string) {
  const output = await deps.run('df', ['-B1', '--output=size,used,avail', path]);
  const [total, used, free] = (output.trim().split('\n').pop() ?? '')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (total === undefined || used === undefined || free === undefined) return null;
  return [total, used, free].every(Number.isFinite) ? { total, used, free } : null;
}

export async function folderUsage(deps: Deps, folder: LibraryFolder): Promise<FolderUsageResult> {
  const path = LIBRARY_FOLDER_PATHS[folder];
  const mapping = (await readFolderMappings(deps)).find((m) => m.folder === folder);
  const volume = mapping
    ? (await listDisks(deps))
        .flatMap((d) => d.volumes)
        .find((v) => v.mountLabel === mapping.mountLabel)
    : undefined;
  const volumeMissing = mapping !== undefined && !volume?.mounted;

  const usage = volumeMissing ? null : await dfUsage(deps, path).catch(() => null);
  const hasLocalFiles = mapping === undefined && (await deps.fs.listDir(path)).length > 0;
  return {
    folder,
    path,
    mapped: mapping ? { mountLabel: mapping.mountLabel, subpath: mapping.subpath } : null,
    volumeMissing,
    hasLocalFiles,
    usedBytes: usage?.used ?? null,
    freeBytes: usage?.free ?? null,
    totalBytes: usage?.total ?? null,
    nearlyFull:
      usage !== null && usage.total > 0 && usage.used / (usage.used + usage.free) >= NEARLY_FULL,
  };
}

// Cheap enough for the status poll: with no mappings it reads a few files and never calls lsblk.
export async function missingFolders(
  deps: Deps,
  folders: LibraryFolder[],
): Promise<LibraryFolder[]> {
  const mappings = (await readFolderMappings(deps)).filter((m) => folders.includes(m.folder));
  if (mappings.length === 0) return [];
  const volumes = (await listDisks(deps)).flatMap((d) => d.volumes);
  return mappings
    .filter((m) => !volumes.some((v) => v.mountLabel === m.mountLabel && v.mounted))
    .map((m) => m.folder);
}

interface SmartJson {
  smart_status?: { passed?: boolean };
  temperature?: { current?: number };
  power_on_time?: { hours?: number };
  ata_smart_attributes?: { table?: { id: number; raw?: { value?: number } }[] };
  nvme_smart_health_information_log?: {
    temperature?: number;
    critical_warning?: number;
    percentage_used?: number;
  };
}

// smartctl uses its exit code as a bit field, so a healthy drive can exit non-zero. The report on
// stdout is what matters.
async function smartctl(deps: Deps, args: string[]): Promise<SmartJson | null> {
  let output: string;
  try {
    output = await deps.run('smartctl', args, { timeoutMs: MINUTES });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentError('failed', 'The drive health tool is not installed.');
    }
    if (typeof stdout !== 'string') return null;
    output = stdout;
  }
  try {
    return JSON.parse(output) as SmartJson;
  } catch {
    return null;
  }
}

export async function diskSmart(deps: Deps, uuid: string): Promise<SmartResult> {
  const { disk } = findVolume(await listDisks(deps), uuid);
  const path = `/dev/${disk.device}`;
  let report = await smartctl(deps, ['--json=c', '--all', path]);
  // Many USB drives need to be asked in SCSI-to-ATA mode before they answer.
  if (report?.smart_status === undefined) {
    report = (await smartctl(deps, ['--json=c', '--all', '--device=sat', path])) ?? report;
  }
  if (report?.smart_status === undefined) {
    return {
      supported: false,
      passed: null,
      temperatureCelsius: null,
      reallocatedSectors: null,
      powerOnHours: null,
      warnings: [],
    };
  }

  const nvme = report.nvme_smart_health_information_log;
  const reallocated =
    report.ata_smart_attributes?.table?.find((attribute) => attribute.id === 5)?.raw?.value ?? null;
  const temperature = report.temperature?.current ?? nvme?.temperature ?? null;
  const passed = report.smart_status?.passed ?? null;

  const warnings: string[] = [];
  if (passed === false)
    warnings.push('The drive reports that it is failing. Back up your files now.');
  if (reallocated !== null && reallocated > 0) {
    warnings.push('Some parts of this drive have worn out. Keep a copy of anything important.');
  }
  if (nvme && (nvme.critical_warning ?? 0) > 0) {
    warnings.push('The drive is reporting a warning about its own health.');
  }
  if (temperature !== null && temperature >= 60) warnings.push('The drive is running hot.');

  return {
    supported: true,
    passed,
    temperatureCelsius: temperature,
    reallocatedSectors: reallocated,
    powerOnHours: report.power_on_time?.hours ?? null,
    warnings,
  };
}
