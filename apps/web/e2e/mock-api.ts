import type { Page, Route } from '@playwright/test';
import type { ServiceSummary, SessionInfo, StatusSnapshot } from '@selfhost/shared';

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
  ...overrides,
});

export interface MockState {
  session: SessionInfo;
  service: ServiceSummary;
  agentReachable: boolean;
  logLines: string[];
  requests: { method: string; path: string; body: unknown }[];
  reauthNeeded: boolean;
  failNextAction: { status: number; error: string; message: string } | null;
}

export function newState(overrides: Partial<MockState> = {}): MockState {
  return {
    session: { state: 'logged_in', csrfToken: 'csrf-test', reauthRequired: false },
    service: jellyfin(),
    agentReachable: true,
    logLines: ['Server startup complete', '[ERR] Could not write /srv/media: Permission denied'],
    requests: [],
    reauthNeeded: false,
    failNextAction: null,
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
