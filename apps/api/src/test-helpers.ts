import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceStatusResult, TailscaleStatusResult } from '@selfhost/shared';
import { AgentRequestError, type AgentCall, type AgentClient } from './agent-client';
import { type AppDeps, buildApp } from './app';
import { createAuditLog } from './audit';
import { createAuth, sha256 } from './auth';
import { openDb } from './db';
import { createStatusMonitor } from './monitor';

export const SETUP_CODE = 'ABCD-2345';
export const PASSWORD = 'correct horse battery';

export interface FakeAgent extends AgentClient {
  calls: AgentCall[];
  serviceState: ServiceStatusResult['state'];
  failNext: AgentRequestError | null;
  gate: Promise<void> | null;
  logLines: string[];
  unreachable: boolean;
  httpOk: boolean;
  missingFolders: string[];
  credentialsPending: boolean;
  updateAvailable: boolean;
  disks: unknown[];
  mappedFolders: Record<string, { mountLabel: string; subpath: string }>;
  tailscale: TailscaleStatusResult;
  onlyService: string | null;
}

export const SIGNED_OUT: TailscaleStatusResult = {
  installed: true,
  backendState: 'NeedsLogin',
  hostname: null,
  dnsName: null,
  authUrl: null,
  magicDnsEnabled: false,
  httpsEnabled: false,
};

export const CONNECTED: TailscaleStatusResult = {
  installed: true,
  backendState: 'Running',
  hostname: 'box',
  dnsName: 'box.tail1234.ts.net',
  authUrl: null,
  magicDnsEnabled: true,
  httpsEnabled: true,
};

export function createFakeAgent(): FakeAgent {
  const agent: FakeAgent = {
    calls: [],
    serviceState: 'not_found',
    failNext: null,
    gate: null,
    logLines: [],
    unreachable: false,
    httpOk: true,
    missingFolders: [],
    credentialsPending: false,
    updateAvailable: false,
    disks: [],
    mappedFolders: {},
    tailscale: SIGNED_OUT,
    onlyService: null,
    async call(request) {
      if (agent.unreachable) throw new AgentRequestError('unreachable', 'down');
      agent.calls.push(request);
      if (request.action === 'service.status') {
        const absent = agent.onlyService !== null && request.service !== agent.onlyService;
        const state = absent ? 'not_found' : agent.serviceState;
        return {
          service: request.service,
          state,
          http: state === 'running' ? { ok: agent.httpOk } : null,
          missingFolders: agent.missingFolders,
          credentialsPending: agent.credentialsPending,
          update:
            state === 'not_found'
              ? null
              : {
                  available: agent.updateAvailable,
                  installedVersion: '12.3',
                  newVersion: '12.4',
                  releaseNotesUrl: 'https://github.com/jellyfin/jellyfin/releases',
                },
          containers:
            state === 'not_found'
              ? []
              : [
                  {
                    name: 'selfhost-jellyfin-1',
                    state: state === 'running' ? 'running' : 'exited',
                    health: null,
                    startedAt: new Date().toISOString(),
                  },
                ],
        } as never;
      }
      if (request.action === 'system.info') {
        return {
          hostname: 'box',
          platform: 'linux',
          arch: 'x64',
          cpuCount: 4,
          memTotalBytes: 8e9,
          memFreeBytes: 4e9,
          uptimeSeconds: 100,
          loadAverage: [0, 0, 0],
          cpuLoadPercent: 12.5,
          diskTotalBytes: 500e9,
          diskFreeBytes: 400e9,
          temperatureCelsius: null,
        } as never;
      }
      if (request.action === 'disk.list') return { disks: agent.disks, missing: [] } as never;
      if (request.action === 'folder.usage') {
        const mapped = agent.mappedFolders[request.folder] ?? null;
        return {
          folder: request.folder,
          path: `/srv/${request.folder}`,
          mapped,
          volumeMissing: false,
          hasLocalFiles: false,
          usedBytes: null,
          freeBytes: null,
          totalBytes: null,
          nearlyFull: false,
        } as never;
      }
      if (request.action === 'service.credentials') {
        if (!agent.credentialsPending) {
          throw new AgentRequestError('refused', 'The login details were already shown.');
        }
        agent.credentialsPending = false;
        return { credentials: [{ label: 'Admin password', value: 'secret-value' }] } as never;
      }
      if (request.action === 'tailscale.status') return agent.tailscale as never;
      if (request.action === 'tailscale.login') {
        agent.tailscale = {
          ...SIGNED_OUT,
          authUrl: 'https://login.tailscale.com/a/abc',
        };
        return agent.tailscale as never;
      }
      if (request.action === 'tailscale.logout') {
        agent.tailscale = SIGNED_OUT;
        return agent.tailscale as never;
      }
      if (request.action === 'confirm.issue') {
        return { token: 'T'.repeat(43), expiresInSeconds: 300 } as never;
      }
      if (agent.gate) await agent.gate;
      if (agent.failNext) {
        const error = agent.failNext;
        agent.failNext = null;
        throw error;
      }
      if (request.action === 'service.install' || request.action === 'service.start') {
        agent.serviceState = 'running';
      }
      if (request.action === 'service.stop') agent.serviceState = 'stopped';
      if (request.action === 'service.uninstall') agent.serviceState = 'not_found';
      return {} as never;
    },
    async *stream(request, signal) {
      agent.calls.push(request);
      if (agent.serviceState === 'not_found') {
        throw new AgentRequestError('not_installed', 'This service is not installed yet.');
      }
      for (const line of agent.logLines) yield { ts: null, stream: 'stdout', line };
      if ('follow' in request && request.follow) {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      }
    },
  };
  return agent;
}

export async function createTestApp(options: { now?: () => number; webDir?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'selfhost-api-'));
  const setupCodeFile = join(dir, 'setup-code');
  writeFileSync(setupCodeFile, sha256('ABCD2345') + '\n');

  const db = openDb(':memory:');
  const auth = createAuth({ db, setupCodeFile, now: options.now });
  const audit = createAuditLog(db);
  const agent = createFakeAgent();
  const monitor = createStatusMonitor({
    agent,
    now: options.now,
  });
  const deps: AppDeps = {
    agent,
    auth,
    audit,
    monitor,
    webDir: options.webDir ?? null,
    now: options.now,
  };
  const app = await buildApp(deps);
  return { app, agent, auth, audit, monitor, db, setupCodeFile };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export interface Login {
  cookie: string;
  csrf: string;
  headers: Record<string, string>;
}

export async function setupAndLogin(t: TestApp): Promise<Login> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { code: SETUP_CODE, password: PASSWORD },
  });
  return toLogin(response);
}

export function toLogin(response: { headers: Record<string, unknown>; json(): unknown }): Login {
  const raw = response.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] as string;
  const csrf = (response.json() as { csrfToken: string }).csrfToken;
  return { cookie, csrf, headers: { cookie, 'x-csrf-token': csrf } };
}
