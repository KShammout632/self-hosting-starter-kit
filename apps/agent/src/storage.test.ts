import { describe, expect, it } from 'vitest';
import type { AgentResponse, ContainerSummary } from '@selfhost/shared';
import { createConfirmTokens } from './confirm';
import { createDispatcher } from './dispatch';
import { dryRunStreamer } from './exec';
import { handlers, type Deps } from './handlers';
import type { HostFs, Paths } from './host';
import { unitNameForPath } from './storage';

const paths: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  renderDevice: '/dev/dri/renderD128',
  unitDir: '/etc/systemd/system',
  mountRoot: '/mnt',
};

const SYSTEM_UUID = '11111111-1111-4111-8111-111111111111';
const USB_UUID = '22222222-2222-4222-8222-222222222222';
const NTFS_UUID = '0123456789ABCDEF';

interface Node {
  name: string;
  type: string;
  size?: number;
  fstype?: string | null;
  uuid?: string | null;
  label?: string | null;
  mountpoints?: (string | null)[];
  model?: string;
  tran?: string;
  rm?: boolean;
  fsavail?: number | null;
  fsused?: number | null;
  children?: Node[];
}

const systemDisk: Node = {
  name: 'sda',
  type: 'disk',
  size: 256e9,
  model: 'System SSD',
  tran: 'sata',
  rm: false,
  children: [
    { name: 'sda1', type: 'part', fstype: 'vfat', uuid: 'ABCD-1234', mountpoints: ['/boot/efi'] },
    {
      name: 'sda2',
      type: 'part',
      size: 250e9,
      fstype: 'ext4',
      uuid: SYSTEM_UUID,
      mountpoints: ['/'],
      fsavail: 150e9,
      fsused: 100e9,
    },
  ],
};

const usbDisk = (mountpoints: (string | null)[] = [null], extra: Partial<Node> = {}): Node => ({
  name: 'sdb',
  type: 'disk',
  size: 2e12,
  model: 'USB Drive',
  tran: 'usb',
  rm: false,
  children: [
    {
      name: 'sdb1',
      type: 'part',
      size: 2e12,
      fstype: 'ext4',
      uuid: USB_UUID,
      label: 'old',
      mountpoints,
      fsavail: 1e11,
      fsused: 9e11,
      ...extra,
    },
  ],
});

const container = (state: string): ContainerSummary => ({
  name: 'jellyfin',
  state,
  health: null,
  startedAt: null,
});

interface Options {
  disks?: Node[];
  files?: Record<string, string>;
  jellyfin?: string;
  smart?: string | Error;
}

function makeHost(options: Options = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const commands: string[][] = [];
  const dirs: string[] = [];
  let disks = options.disks ?? [systemDisk, usbDisk()];

  const fs: HostFs = {
    async ensureDir(path) {
      dirs.push(path);
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async removeDir() {},
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
      return [...files.keys()]
        .filter((key) => key.startsWith(path + '/'))
        .map((key) => key.slice(path.length + 1).split('/')[0]!);
    },
    async setOwner() {},
  };

  const run: Deps['run'] = async (file, args) => {
    commands.push([file, ...args]);
    if (file === 'id') return args[0] === '-u' ? '1001\n' : '1002\n';
    if (file === 'lsblk') {
      const target = args.find((arg) => arg.startsWith('/dev/'));
      if (target) {
        const disk = disks.find((d) => `/dev/${d.name}` === target);
        return JSON.stringify({ blockdevices: disk ? [disk] : [] });
      }
      return JSON.stringify({ blockdevices: disks });
    }
    if (file === 'smartctl') {
      if (options.smart instanceof Error) throw options.smart;
      return options.smart ?? JSON.stringify({ smart_status: { passed: true } });
    }
    if (file === 'df') return 'Size Used Avail\n1000 900 100\n';
    return '';
  };

  const deps: Deps = {
    dryRun: false,
    docker: {
      listServiceContainers: async (service) =>
        service === 'jellyfin' && options.jellyfin ? [container(options.jellyfin)] : [],
    },
    run,
    paths,
    fs,
    stream: dryRunStreamer,
    httpCheck: async () => true,
    confirmTokens: createConfirmTokens(),
  };
  return {
    deps,
    files,
    commands,
    dirs,
    setDisks(next: Node[]) {
      disks = next;
    },
  };
}

async function ask(deps: Deps, request: Record<string, unknown>): Promise<AgentResponse> {
  const dispatch = createDispatcher({ handlers, deps, log: () => {} });
  const out: AgentResponse[] = [];
  for await (const message of dispatch(JSON.stringify({ id: 'r1', ...request }))) out.push(message);
  return out[0]!;
}

const mountUnit = (label: string, uuid = USB_UUID) =>
  [
    '# Managed by selfhost. Changes may be overwritten.',
    '[Mount]',
    `What=/dev/disk/by-uuid/${uuid}`,
    `Where=/mnt/${label}`,
    '',
  ].join('\n');

const bindUnit = (path: string, what: string) =>
  [
    '# Managed by selfhost. Changes may be overwritten.',
    '[Mount]',
    `What=${what}`,
    `Where=${path}`,
    '',
  ].join('\n');

const unitFile = (path: string) => `/etc/systemd/system/${unitNameForPath(path)}`;

describe('unitNameForPath', () => {
  it('escapes hyphens the way systemd does', () => {
    expect(unitNameForPath('/mnt/media1')).toBe('mnt-media1.mount');
    expect(unitNameForPath('/mnt/media-1')).toBe('mnt-media\\x2d1.mount');
    expect(unitNameForPath('/srv/media/home-videos')).toBe('srv-media-home\\x2dvideos.mount');
  });
});

describe('disk.list', () => {
  it('marks the system disk and never offers it for formatting', async () => {
    const host = makeHost();
    const reply = await ask(host.deps, { action: 'disk.list' });
    const { disks } = (reply as { data: { disks: { volumes: { mountable: boolean }[] }[] } }).data;
    expect(disks[0]).toMatchObject({ device: 'sda', isSystem: true, canFormat: false });
    expect(disks[1]).toMatchObject({ device: 'sdb', isSystem: false, canFormat: true });
    expect(disks[0]!.volumes.some((volume) => volume.mountable)).toBe(false);
  });

  it('warns when a volume is 90 percent full or more', async () => {
    const host = makeHost();
    const reply = await ask(host.deps, { action: 'disk.list' });
    const { disks } = (reply as { data: { disks: { volumes: { nearlyFull: boolean }[] }[] } }).data;
    expect(disks[1]!.volumes[0]!.nearlyFull).toBe(true);
    expect(disks[0]!.volumes.some((volume) => volume.nearlyFull)).toBe(false);
  });

  it('shows a disk that is mounted by the kit as mounted under its name', async () => {
    const host = makeHost({
      disks: [systemDisk, usbDisk(['/mnt/media1', '/srv/media/movies'])],
      files: { [unitFile('/mnt/media1')]: mountUnit('media1') },
    });
    const reply = await ask(host.deps, { action: 'disk.list' });
    const volume = (reply as { data: { disks: { volumes: unknown[] }[] } }).data.disks[1]!
      .volumes[0];
    expect(volume).toMatchObject({ mountLabel: 'media1', mounted: true, configured: true });
  });

  it('keeps a drive the kit knows about listed when it is unplugged', async () => {
    const host = makeHost({
      disks: [systemDisk, usbDisk([null])],
      files: { [unitFile('/mnt/media1')]: mountUnit('media1') },
    });
    const reply = await ask(host.deps, { action: 'disk.list' });
    const volume = (reply as { data: { disks: { volumes: unknown[] }[] } }).data.disks[1]!
      .volumes[0];
    expect(volume).toMatchObject({ mountLabel: 'media1', mounted: false, configured: true });
  });

  it('lists a set up drive that is not plugged in at all as missing', async () => {
    const host = makeHost({
      disks: [systemDisk],
      files: { [unitFile('/mnt/media1')]: mountUnit('media1') },
    });
    const reply = await ask(host.deps, { action: 'disk.list' });
    expect((reply as { data: { missing: unknown[] } }).data.missing).toEqual([
      { uuid: USB_UUID, mountLabel: 'media1' },
    ]);
  });

  it('ignores devices that are not whole disks with a kernel name', async () => {
    const host = makeHost({
      disks: [systemDisk, { name: 'loop0', type: 'loop' }, { name: 'sr0', type: 'rom' }],
    });
    const reply = await ask(host.deps, { action: 'disk.list' });
    expect((reply as { data: { disks: unknown[] } }).data.disks).toHaveLength(1);
  });
});

describe('disk.mount', () => {
  const mount = (uuid = USB_UUID, label = 'media1') => ({ action: 'disk.mount', uuid, label });

  it('writes a mount unit by UUID that never blocks boot, and starts it', async () => {
    const host = makeHost();
    expect(await ask(host.deps, mount())).toMatchObject({ ok: true });

    const unit = host.files.get(unitFile('/mnt/media1'))!;
    expect(unit).toContain(`What=/dev/disk/by-uuid/${USB_UUID}`);
    expect(unit).toContain('Where=/mnt/media1');
    expect(unit).toContain('Type=ext4');
    expect(unit).toContain('Options=nofail');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(host.commands).toContainEqual(['systemctl', 'daemon-reload']);
    expect(host.commands).toContainEqual(['systemctl', 'enable', '--now', 'mnt-media1.mount']);
  });

  it('gives NTFS and exFAT drives to the selfhost user through mount options', async () => {
    const host = makeHost({
      disks: [
        systemDisk,
        {
          ...usbDisk(),
          children: [{ name: 'sdb1', type: 'part', fstype: 'ntfs', uuid: NTFS_UUID }],
        },
      ],
    });
    await ask(host.deps, mount(NTFS_UUID));
    const unit = host.files.get(unitFile('/mnt/media1'))!;
    expect(unit).toContain('Type=ntfs3');
    expect(unit).toContain('Options=nofail,uid=1001,gid=1002,umask=002');
  });

  it('refuses the system disk and unsupported formats', async () => {
    const host = makeHost();
    expect(await ask(host.deps, mount(SYSTEM_UUID))).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
    const efi = await ask(host.deps, mount('ABCD-1234'));
    expect(efi).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(host.files.size).toBe(0);
  });

  it('refuses a name that another drive already uses', async () => {
    const host = makeHost({
      files: { [unitFile('/mnt/media1')]: mountUnit('media1', 'OTHER-UUID') },
    });
    expect(await ask(host.deps, mount())).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  it('refuses a drive that something else already mounted', async () => {
    const host = makeHost({ disks: [systemDisk, usbDisk(['/media/user/usb'])] });
    expect(await ask(host.deps, mount())).toMatchObject({ ok: false, error: { code: 'in_use' } });
  });

  it('removes the unit again when the mount fails', async () => {
    const host = makeHost();
    const run = host.deps.run;
    host.deps.run = async (file, args, options) => {
      if (file === 'systemctl' && args[0] === 'enable') throw new Error('mount failed');
      return run(file, args, options);
    };
    expect(await ask(host.deps, mount())).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(host.files.size).toBe(0);
  });

  it('starts the mount again when the first try left it inactive', async () => {
    const host = makeHost();
    const run = host.deps.run;
    let checks = 0;
    host.deps.run = async (file, args, options) => {
      if (file === 'systemctl' && args[0] === 'is-active' && checks++ === 0) {
        throw new Error('inactive');
      }
      return run(file, args, options);
    };
    expect(await ask(host.deps, mount())).toMatchObject({ ok: true });
    expect(host.commands).toContainEqual(['systemctl', 'start', 'mnt-media1.mount']);
  });

  it('says the drive is missing when it is not plugged in', async () => {
    const host = makeHost();
    expect(await ask(host.deps, mount('99999999'))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('disk.unmount', () => {
  const files = {
    [unitFile('/mnt/media1')]: mountUnit('media1'),
    [unitFile('/srv/media/movies')]: bindUnit('/srv/media/movies', '/mnt/media1/Movies'),
  };
  const mounted = [systemDisk, usbDisk(['/mnt/media1'])];

  it('stops the folders on the drive, then the drive', async () => {
    const host = makeHost({ disks: mounted, files });
    expect(await ask(host.deps, { action: 'disk.unmount', uuid: USB_UUID })).toMatchObject({
      ok: true,
    });
    const stops = host.commands.filter((c) => c[1] === 'stop').map((c) => c[2]);
    expect(stops).toEqual(['srv-media-movies.mount', 'mnt-media1.mount']);
  });

  it('refuses while a service that uses the drive is running', async () => {
    const host = makeHost({ disks: mounted, files, jellyfin: 'running' });
    const reply = await ask(host.deps, { action: 'disk.unmount', uuid: USB_UUID });
    expect(reply).toMatchObject({ ok: false, error: { code: 'in_use' } });
    expect((reply as { error: { message: string } }).error.message).toContain('Jellyfin');
    expect(host.commands.some((c) => c[0] === 'systemctl')).toBe(false);
  });

  it('leaves drives it did not mount alone', async () => {
    const host = makeHost({ disks: [systemDisk, usbDisk(['/media/user/usb'])] });
    expect(await ask(host.deps, { action: 'disk.unmount', uuid: USB_UUID })).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });
  });
});

describe('disk.format', () => {
  const format = (device = 'sdb', label = 'media1') => ({
    action: 'disk.format',
    device,
    label,
  });
  const withToken = async (host: ReturnType<typeof makeHost>, device: string, label?: string) => {
    const issued = await ask(host.deps, {
      action: 'confirm.issue',
      kind: 'disk.format',
      target: device,
    });
    const confirm = (issued as { data: { token: string } }).data.token;
    return { ...format(device, label), confirm };
  };

  it('never formats the system disk, even with a valid confirmation', async () => {
    const host = makeHost();
    const reply = await ask(host.deps, await withToken(host, 'sda'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(host.commands.some((c) => c[0] === 'wipefs' || c[0] === 'parted')).toBe(false);
  });

  it('refuses a disk that is mounted', async () => {
    const host = makeHost({ disks: [systemDisk, usbDisk(['/mnt/media1'])] });
    const reply = await ask(host.deps, await withToken(host, 'sdb'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'in_use' } });
    expect(host.commands.some((c) => c[0] === 'wipefs')).toBe(false);
  });

  it('refuses a label ext4 cannot store, before touching the disk', async () => {
    const host = makeHost();
    const reply = await ask(host.deps, await withToken(host, 'sdb', 'a-very-long-drive-name'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(host.commands.some((c) => c[0] === 'wipefs')).toBe(false);
  });

  it('needs a confirmation token', async () => {
    const host = makeHost();
    expect(await ask(host.deps, format())).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });
  });

  it('wipes, partitions, formats, mounts and creates the standard folders', async () => {
    const host = makeHost();
    const reply = await ask(host.deps, await withToken(host, 'sdb'));
    expect(reply).toMatchObject({ ok: true, data: { uuid: USB_UUID, label: 'media1' } });

    const order = host.commands
      .map((c) => c[0])
      .filter((name) => ['wipefs', 'parted', 'mkfs.ext4', 'systemctl'].includes(name!));
    expect(order.slice(0, 3)).toEqual(['wipefs', 'parted', 'mkfs.ext4']);
    expect(host.commands).toContainEqual(['wipefs', '--all', '--force', '/dev/sdb']);
    expect(host.commands).toContainEqual([
      'mkfs.ext4',
      '-F',
      '-m',
      '1',
      '-L',
      'media1',
      '/dev/sdb1',
    ]);
    expect(host.dirs).toContain('/mnt/media1/Movies');
    expect(host.dirs).toContain('/mnt/media1/Home Videos');
  });

  it('cannot be replayed with the same token', async () => {
    const host = makeHost();
    const request = await withToken(host, 'sdb');
    await ask(host.deps, request);
    expect(await ask(host.deps, request)).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });
  });

  it('cannot use a token issued for another disk', async () => {
    const host = makeHost();
    const other = await withToken(host, 'sdc');
    expect(await ask(host.deps, { ...format('sdb'), confirm: other.confirm })).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });
  });
});

describe('folder.assign', () => {
  const mountedFiles = { [unitFile('/mnt/media1')]: mountUnit('media1') };
  const mounted = [systemDisk, usbDisk(['/mnt/media1'])];
  const assign = (extra: Record<string, unknown> = {}) => ({
    action: 'folder.assign',
    folder: 'movies',
    uuid: USB_UUID,
    subpath: 'Movies',
    ...extra,
  });

  it('writes a bind mount that follows the drive', async () => {
    const host = makeHost({ disks: mounted, files: mountedFiles });
    expect(await ask(host.deps, assign())).toMatchObject({ ok: true });

    const unit = host.files.get(unitFile('/srv/media/movies'))!;
    expect(unit).toContain('What=/mnt/media1/Movies');
    expect(unit).toContain('Where=/srv/media/movies');
    expect(unit).toContain('Options=bind');
    expect(unit).toContain('BindsTo=mnt-media1.mount');
    expect(host.dirs).toContain('/mnt/media1/Movies');
    expect(host.commands).toContainEqual([
      'systemctl',
      'enable',
      '--now',
      'srv-media-movies.mount',
    ]);
  });

  it('needs the drive to be mounted first', async () => {
    const host = makeHost({ files: mountedFiles });
    expect(await ask(host.deps, assign())).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  it('refuses while a service uses the folder', async () => {
    const host = makeHost({ disks: mounted, files: mountedFiles, jellyfin: 'running' });
    expect(await ask(host.deps, assign())).toMatchObject({ ok: false, error: { code: 'in_use' } });
  });

  it('will not hide existing files unless asked to copy them', async () => {
    const files = { ...mountedFiles, '/srv/media/movies/film.mkv': 'x' };
    const refused = makeHost({ disks: mounted, files });
    expect(await ask(refused.deps, assign())).toMatchObject({
      ok: false,
      error: { code: 'refused' },
    });

    const copied = makeHost({ disks: mounted, files });
    expect(await ask(copied.deps, assign({ copyExisting: true }))).toMatchObject({ ok: true });
    expect(copied.commands).toContainEqual([
      'rsync',
      '-a',
      '--',
      '/srv/media/movies/',
      '/mnt/media1/Movies/',
    ]);
  });

  it('stops an existing mapping before pointing it somewhere else', async () => {
    const files = {
      ...mountedFiles,
      [unitFile('/srv/media/movies')]: bindUnit('/srv/media/movies', '/mnt/media1/Old'),
    };
    const host = makeHost({ disks: mounted, files });
    expect(await ask(host.deps, assign())).toMatchObject({ ok: true });
    expect(host.commands).toContainEqual(['systemctl', 'stop', 'srv-media-movies.mount']);
  });

  it('rejects subpaths that try to leave the drive', async () => {
    const host = makeHost({ disks: mounted, files: mountedFiles });
    expect(await ask(host.deps, assign({ subpath: '../etc' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});

describe('folder.usage and missing folders', () => {
  const files = {
    [unitFile('/mnt/media1')]: mountUnit('media1'),
    [unitFile('/srv/media/movies')]: bindUnit('/srv/media/movies', '/mnt/media1/Movies'),
  };

  it('reports space for a folder on a mounted drive', async () => {
    const host = makeHost({ disks: [systemDisk, usbDisk(['/mnt/media1'])], files });
    const reply = await ask(host.deps, { action: 'folder.usage', folder: 'movies' });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        mapped: { mountLabel: 'media1', subpath: 'Movies' },
        volumeMissing: false,
        usedBytes: 900,
        freeBytes: 100,
        nearlyFull: true,
      },
    });
  });

  it('flags the folder when its drive is unplugged and does not report space', async () => {
    const host = makeHost({ disks: [systemDisk, usbDisk([null])], files });
    const reply = await ask(host.deps, { action: 'folder.usage', folder: 'movies' });
    expect(reply).toMatchObject({
      ok: true,
      data: { volumeMissing: true, usedBytes: null, totalBytes: null },
    });
  });

  it('makes a service show the missing folder in its status', async () => {
    const host = makeHost({
      disks: [systemDisk, usbDisk([null])],
      files,
      jellyfin: 'running',
    });
    const reply = await ask(host.deps, { action: 'service.status', service: 'jellyfin' });
    expect(reply).toMatchObject({ ok: true, data: { missingFolders: ['movies'] } });
  });

  it('does not run lsblk for the status of services with no mapped folders', async () => {
    const host = makeHost();
    await ask(host.deps, { action: 'service.status', service: 'jellyfin' });
    expect(host.commands.some((c) => c[0] === 'lsblk')).toBe(false);
  });
});

describe('disk.smart', () => {
  const smart = (report: unknown) =>
    ask(makeHost({ smart: JSON.stringify(report) }).deps, { action: 'disk.smart', uuid: USB_UUID });

  it('reports a healthy drive with no warnings', async () => {
    expect(
      await smart({
        smart_status: { passed: true },
        temperature: { current: 35 },
        power_on_time: { hours: 500 },
        ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
      }),
    ).toMatchObject({
      ok: true,
      data: { supported: true, passed: true, temperatureCelsius: 35, warnings: [] },
    });
  });

  it('warns about reallocated sectors, heat and a failing status', async () => {
    const reply = (await smart({
      smart_status: { passed: false },
      temperature: { current: 65 },
      ata_smart_attributes: { table: [{ id: 5, raw: { value: 12 } }] },
    })) as { data: { warnings: string[]; reallocatedSectors: number } };
    expect(reply.data.reallocatedSectors).toBe(12);
    expect(reply.data.warnings).toHaveLength(3);
  });

  it('reads the report even when smartctl exits non-zero', async () => {
    const failure = Object.assign(new Error('exit 4'), {
      stdout: JSON.stringify({ smart_status: { passed: true } }),
    });
    const host = makeHost({ smart: failure });
    expect(await ask(host.deps, { action: 'disk.smart', uuid: USB_UUID })).toMatchObject({
      ok: true,
      data: { supported: true, passed: true },
    });
  });

  it('says so when a USB bridge hides SMART', async () => {
    expect(await smart({})).toMatchObject({ ok: true, data: { supported: false } });
  });

  it('reads NVMe temperature and warnings', async () => {
    expect(
      await smart({
        smart_status: { passed: true },
        nvme_smart_health_information_log: { temperature: 41, critical_warning: 1 },
      }),
    ).toMatchObject({ ok: true, data: { temperatureCelsius: 41 } });
  });
});
