import type { Page, Route } from '@playwright/test';
import {
  LIBRARY_FOLDERS,
  type DiskInfo,
  type FolderUsageResult,
  type RemoteSnapshot,
  type ServiceSummary,
  type SessionInfo,
  type SmartResult,
  type StatusSnapshot,
  type StorageSnapshot,
  type VolumeInfo,
} from '@selfhost/shared';

export const volume = (overrides: Partial<VolumeInfo> = {}): VolumeInfo => ({
  partition: 'sdb1',
  uuid: '22222222-2222-4222-8222-222222222222',
  fsLabel: 'Media',
  filesystem: 'ext4',
  sizeBytes: 2 * 1024 ** 4,
  usedBytes: 400 * 1024 ** 3,
  freeBytes: 1600 * 1024 ** 3,
  mountLabel: null,
  mounted: false,
  configured: false,
  mountable: true,
  keepsPermissions: true,
  nearlyFull: false,
  ...overrides,
});

export const usbDisk = (volumes: VolumeInfo[] = [volume()]): DiskInfo => ({
  device: 'sdb',
  model: 'Portable USB Drive',
  sizeBytes: 2 * 1024 ** 4,
  transport: 'usb',
  removable: false,
  isSystem: false,
  canFormat: volumes.every((v) => !v.mounted),
  volumes,
});

export const systemDisk = (): DiskInfo => ({
  device: 'sda',
  model: 'Internal SSD',
  sizeBytes: 256 * 1024 ** 3,
  transport: 'sata',
  removable: false,
  isSystem: true,
  canFormat: false,
  volumes: [],
});

const folderUsage = (folder: (typeof LIBRARY_FOLDERS)[number]): FolderUsageResult => ({
  folder,
  path: '/srv/' + folder,
  mapped: null,
  volumeMissing: false,
  hasLocalFiles: false,
  usedBytes: null,
  freeBytes: null,
  totalBytes: null,
  nearlyFull: false,
});

export const newStorage = (disks: DiskInfo[] = [systemDisk(), usbDisk()]): StorageSnapshot => ({
  disks,
  missing: [],
  folders: LIBRARY_FOLDERS.map(folderUsage),
  job: null,
});

export const jellyfin = (overrides: Partial<ServiceSummary> = {}): ServiceSummary => ({
  name: 'jellyfin',
  displayName: 'Jellyfin',
  description: 'Stream your movies, shows and home videos to any device.',
  lanPort: 8096,
  firstLoginTips: ['Open Jellyfin and create your admin account.'],
  status: 'online',
  message: null,
  busy: null,
  errorCount: 0,
  hints: [],
  credentialsPending: false,
  ...overrides,
});

export const newRemote = (overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot => ({
  state: 'signed_out',
  name: 'homeserver',
  signInUrl: null,
  magicDnsEnabled: false,
  httpsEnabled: false,
  settingsUrl: 'https://login.tailscale.com/admin/dns',
  links: [],
  message: null,
  ...overrides,
});

export const readyRemote = (): RemoteSnapshot =>
  newRemote({
    state: 'ready',
    magicDnsEnabled: true,
    httpsEnabled: true,
    links: [
      { target: 'dashboard', label: 'Dashboard', url: 'https://homeserver.tail1234.ts.net' },
      { target: 'jellyfin', label: 'Jellyfin', url: 'https://homeserver.tail1234.ts.net:8920' },
    ],
  });

export interface MockState {
  remote: RemoteSnapshot;
  session: SessionInfo;
  service: ServiceSummary;
  agentReachable: boolean;
  logLines: string[];
  requests: { method: string; path: string; body: unknown }[];
  reauthNeeded: boolean;
  failNextAction: { status: number; error: string; message: string } | null;
  storage: StorageSnapshot;
  smart: SmartResult;
}

export function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    session: { state: 'logged_in', csrfToken: 'csrf-test', reauthRequired: false },
    remote: newRemote(),
    service: jellyfin(),
    agentReachable: true,
    logLines: ['Server startup complete', '[ERR] Could not write /srv/media: Permission denied'],
    requests: [],
    reauthNeeded: false,
    failNextAction: null,
    storage: newStorage(),
    smart: {
      supported: true,
      passed: true,
      temperatureCelsius: 36,
      reallocatedSectors: 0,
      powerOnHours: 900,
      warnings: [],
    },
    ...overrides,
  };
}

const snapshot = (state: MockState): StatusSnapshot => ({
  agentReachable: state.agentReachable,
  services: [state.service],
  system: {
    hostname: 'homeserver',
    cpuCount: 4,
    cpuLoadPercent: 12,
    memTotalBytes: 8 * 1024 ** 3,
    memFreeBytes: 4 * 1024 ** 3,
    diskTotalBytes: 500 * 1024 ** 3,
    diskFreeBytes: 400 * 1024 ** 3,
    temperatureCelsius: null,
    uptimeSeconds: 7200,
  },
  updatedAt: new Date().toISOString(),
});

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const events = (route: Route, chunks: [string, unknown][]) =>
  route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: chunks
      .map(([event, data]) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
      .join(''),
  });

const NEXT_STATUS: Record<string, Partial<ServiceSummary>> = {
  install: { status: 'online' },
  start: { status: 'online' },
  stop: { status: 'offline' },
  restart: { status: 'online' },
  update: { status: 'online' },
  uninstall: { status: 'not_installed' },
};

// Stands in for the whole dashboard API, so UI tests need no server.
export async function mockApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData() as string) : undefined;
    if (method !== 'GET') state.requests.push({ method, path, body });

    if (path === '/api/session' && method === 'GET') return json(route, 200, state.session);

    if (path === '/api/setup' || path === '/api/login') {
      if (body.password === 'wrong password') {
        return json(route, 401, {
          error: 'invalid_credentials',
          message: 'That password is not right.',
        });
      }
      state.session = { state: 'logged_in', csrfToken: 'csrf-test', reauthRequired: false };
      return json(route, 200, state.session);
    }
    if (path === '/api/logout') {
      state.session = { state: 'logged_out', setupAvailable: false };
      return json(route, 200, { ok: true });
    }
    if (path === '/api/session/reauth') {
      state.reauthNeeded = false;
      return json(route, 200, { ok: true });
    }

    if (path === '/api/services') return json(route, 200, snapshot(state));
    if (path === '/api/status/stream') return events(route, [['status', snapshot(state)]]);

    if (path === '/api/remote') return json(route, 200, state.remote);
    if (path === '/api/remote/connect' && method === 'POST') {
      state.remote = newRemote({
        state: 'waiting_for_sign_in',
        name: body.name,
        signInUrl: 'https://login.tailscale.com/a/abc123',
      });
      return json(route, 200, state.remote);
    }
    if (path === '/api/remote/disconnect' && method === 'POST') {
      if (state.reauthNeeded) {
        return json(route, 403, {
          error: 'reauth_required',
          message: 'Enter your password to continue.',
        });
      }
      state.remote = newRemote();
      return json(route, 200, state.remote);
    }

    if (path === '/api/storage') return json(route, 200, state.storage);

    const smart = /^\/api\/disks\/[^/]+\/smart$/.exec(path);
    if (smart) return json(route, 200, state.smart);

    const diskAction = /^\/api\/disks\/([^/]+)\/(mount|unmount)$/.exec(path);
    if (diskAction && method === 'POST') {
      const [, uuid, kind] = diskAction;
      if (state.failNextAction) {
        const failure = state.failNextAction;
        state.failNextAction = null;
        return json(route, failure.status, { error: failure.error, message: failure.message });
      }
      for (const disk of state.storage.disks) {
        for (const item of disk.volumes) {
          if (item.uuid !== uuid) continue;
          if (kind === 'mount') {
            Object.assign(item, { mounted: true, configured: true, mountLabel: body.label });
            disk.canFormat = false;
          } else {
            Object.assign(item, { mounted: false });
            disk.canFormat = true;
          }
        }
      }
      return json(route, 200, { ok: true });
    }

    if (/^\/api\/disks\/by-device\/[a-z0-9]+\/format$/.test(path) && method === 'POST') {
      if (state.reauthNeeded) {
        return json(route, 403, {
          error: 'reauth_required',
          message: 'Enter your password to continue.',
        });
      }
      state.storage.job = { kind: 'formatting', target: 'sdb', state: 'running', message: null };
      return json(route, 202, { started: true });
    }

    const assign = /^\/api\/folders\/([a-z-]+)\/assign$/.exec(path);
    if (assign && method === 'POST') {
      const entry = state.storage.folders.find((f) => f.folder === assign[1]);
      if (entry) entry.mapped = { mountLabel: 'media1', subpath: body.subpath };
      return json(route, 202, { started: true });
    }

    if (path === '/api/storage/job/dismiss') {
      state.storage.job = null;
      return json(route, 200, { ok: true });
    }

    const logs = /^\/api\/services\/[a-z]+\/logs$/.exec(path);
    if (logs) {
      return events(route, [
        ['ready', {}],
        ...state.logLines.map((line): [string, unknown] => [
          'line',
          { ts: '2026-11-22T10:00:00Z', line },
        ]),
      ]);
    }

    if (/^\/api\/services\/[a-z]+\/credentials$/.test(path) && method === 'POST') {
      if (!state.service.credentialsPending) {
        return json(route, 409, {
          error: 'already_shown',
          message: 'That was already shown once and cannot be shown again.',
        });
      }
      state.service = { ...state.service, credentialsPending: false };
      return json(route, 200, {
        credentials: [
          { label: 'Admin user name', value: 'admin' },
          { label: 'Admin password', value: 'correct-horse-battery' },
        ],
      });
    }

    const action = /^\/api\/services\/[a-z]+\/([a-z]+)$/.exec(path);
    if (action && method === 'POST') {
      const name = action[1] as string;
      if (name === 'uninstall' && state.reauthNeeded) {
        return json(route, 403, {
          error: 'reauth_required',
          message: 'Enter your password to continue.',
        });
      }
      if (state.failNextAction) {
        const failure = state.failNextAction;
        state.failNextAction = null;
        return json(route, failure.status, { error: failure.error, message: failure.message });
      }
      state.service = { ...state.service, ...NEXT_STATUS[name] };
      return json(route, 202, { started: true });
    }

    return json(route, 404, { error: 'not_found', message: 'Not found.' });
  });
}
