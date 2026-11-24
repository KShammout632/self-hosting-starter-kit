import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  env?: Readonly<Record<string, string>>;
}

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<string>;

// The only way the agent starts a process: fixed file, fixed argument array, no shell.
export const run: Runner = async (file, args, options = {}) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
  return stdout;
};

const DRY_RUN_FIXTURES: Record<string, string> = {
  tailscale: JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'selfhost-dev', DNSName: 'selfhost-dev.example.ts.net.' },
    CurrentTailnet: { MagicDNSEnabled: true },
    CertDomains: ['selfhost-dev.example.ts.net'],
  }),
  docker: 'selfhost-jellyfin-1  | 2026-11-22T09:30:00.000000000Z dry-run log line\n',
  id: '1001\n',
  lsblk: JSON.stringify({
    blockdevices: [
      {
        name: 'sda',
        type: 'disk',
        size: 256060514304,
        model: 'Dry Run SSD',
        tran: 'sata',
        rm: false,
        children: [
          {
            name: 'sda1',
            type: 'part',
            size: 256058417152,
            fstype: 'ext4',
            uuid: 'a1b2c3d4-0000-4000-8000-000000000001',
            mountpoints: ['/'],
            fsavail: 180000000000,
            fsused: 60000000000,
          },
        ],
      },
      {
        name: 'sdb',
        type: 'disk',
        size: 2000398934016,
        model: 'Dry Run USB Drive',
        tran: 'usb',
        rm: false,
        children: [
          {
            name: 'sdb1',
            type: 'part',
            size: 2000397795328,
            fstype: 'ext4',
            label: 'media1',
            uuid: 'a1b2c3d4-0000-4000-8000-000000000002',
            mountpoints: [null],
            fsavail: 1500000000000,
            fsused: 400000000000,
          },
        ],
      },
    ],
  }),
  df: 'Size Used Avail\n1000000000000 400000000000 600000000000\n',
  smartctl: JSON.stringify({
    smart_status: { passed: true },
    temperature: { current: 34 },
    power_on_time: { hours: 1200 },
    ata_smart_attributes: { table: [{ id: 5, raw: { value: 0 } }] },
  }),
  systemctl: '',
  'systemd-run': '',
  curl: '',
  'apt-get': [
    'Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
    'Inst tzdata [2024a-2ubuntu1] (2025b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
    '',
  ].join('\n'),
  wipefs: '',
  parted: '',
  udevadm: '',
  'mkfs.ext4': '',
  rsync: '',
  tar: '',
};

export const dryRunRunner: Runner = async (file, args) => {
  console.error(JSON.stringify({ event: 'dry-run', would: [file, ...args] }));
  const fixture = DRY_RUN_FIXTURES[file];
  if (fixture === undefined) throw new Error(`dry-run: no fixture for ${file}`);
  return fixture;
};

// Checks a service's health URL on this machine. The URL is built from the catalog, never from a request.
export type HttpChecker = (url: string, expect?: string) => Promise<boolean>;

export const httpCheck: HttpChecker = async (url, expect) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.status < 200 || response.status >= 400) return false;
    return expect === undefined || (await response.text()).includes(expect);
  } catch {
    return false;
  }
};

export const dryRunHttpCheck: HttpChecker = async (url) => {
  console.error(JSON.stringify({ event: 'dry-run', would: ['GET', url] }));
  return true;
};

export type LineStreamer = (
  file: string,
  args: readonly string[],
  signal: AbortSignal,
) => AsyncGenerator<string>;

// Follows a command's output line by line until it ends or the signal aborts. This uses spawn with
// an argument array and no shell, like the runner above. execFile is not used here because it
// keeps all output in memory, which never ends for a followed log.
export const streamLines: LineStreamer = async function* (file, args, signal) {
  const child = spawn(file, [...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    signal,
  });
  const failed = new Promise<never>((_, reject) => child.once('error', reject));
  failed.catch(() => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([lines.next(), failed]);
      if (next.done) return;
      yield next.value;
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    child.kill();
  }
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export const dryRunStreamer: LineStreamer = async function* (file, args, signal) {
  console.error(JSON.stringify({ event: 'dry-run', would: [file, ...args] }));
  for (let n = 1; !signal.aborted; n++) {
    yield `selfhost-jellyfin-1  | ${new Date().toISOString()} dry-run log line ${n}`;
    await sleep(2000, signal);
  }
};
