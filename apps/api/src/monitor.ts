import { catalog, type ServiceManifest } from '@selfhost/catalog';
import {
  hintsForLines,
  isErrorLine,
  type BusyAction,
  type ServiceName,
  type ServiceUpdateInfo,
  type ServiceStatusResult,
  type ServiceSummary,
  type StatusSnapshot,
  type SystemInfoResult,
} from '@selfhost/shared';
import { AgentRequestError, type AgentClient } from './agent-client';
import { computeStatus } from './status';

export const POLL_INTERVAL_MS = 15_000;
const LOG_SCAN_INTERVAL_MS = 60_000;
const LOG_SCAN_LINES = 200;

export interface MonitorOptions {
  agent: AgentClient;
  now?: () => number;
  manifests?: readonly ServiceManifest[];
}

export interface StatusMonitor {
  start(): void;
  stop(): void;
  snapshot(): StatusSnapshot;
  refresh(service?: ServiceName): Promise<void>;
  subscribe(listener: (snapshot: StatusSnapshot) => void): () => void;
  beginAction(service: ServiceName, action: BusyAction): boolean;
  endAction(service: ServiceName, failure?: string, notice?: string): Promise<void>;
  isAvailable(service: ServiceName): boolean;
}

interface ServiceState {
  status: ServiceSummary['status'];
  message: string | null;
  busy: BusyAction | null;
  lastFailure: string | null;
  errorCount: number;
  hints: string[];
  credentialsPending: boolean;
  update: ServiceUpdateInfo | null;
  notice: string | null;
  logScanAt: number;
}

export function createStatusMonitor(options: MonitorOptions): StatusMonitor {
  const { agent } = options;
  const now = options.now ?? Date.now;
  const manifests = options.manifests ?? catalog;

  const states = new Map<ServiceName, ServiceState>(
    manifests.map((manifest) => [
      manifest.name,
      {
        status: 'offline',
        message: null,
        busy: null,
        lastFailure: null,
        errorCount: 0,
        hints: [],
        credentialsPending: false,
        update: null,
        notice: null,
        logScanAt: 0,
      },
    ]),
  );
  let agentReachable = true;
  let system: StatusSnapshot['system'] = null;
  let updatedAt = new Date(now()).toISOString();
  let timer: NodeJS.Timeout | null = null;
  let lastPublished = '';
  const listeners = new Set<(snapshot: StatusSnapshot) => void>();

  const snapshot = (): StatusSnapshot => ({
    agentReachable,
    system,
    updatedAt,
    services: manifests.map((manifest) => {
      const state = states.get(manifest.name) as ServiceState;
      return {
        name: manifest.name,
        displayName: manifest.displayName,
        description: manifest.description,
        lanPort: manifest.ports.lan,
        firstLoginTips: manifest.firstLoginTips,
        status: state.status,
        message: state.message,
        busy: state.busy,
        errorCount: state.errorCount,
        hints: state.hints,
        credentialsPending: state.credentialsPending,
        update: state.update,
        notice: state.notice,
      };
    }),
  });

  // Listeners only hear about real changes. updatedAt is left out of the comparison so an idle
  // server is quiet, apart from the system numbers moving.
  const publish = () => {
    const current = snapshot();
    const key = JSON.stringify({ ...current, updatedAt: null });
    if (key === lastPublished) return;
    lastPublished = key;
    updatedAt = new Date(now()).toISOString();
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };

  async function scanLogs(manifest: ServiceManifest, state: ServiceState) {
    state.logScanAt = now();
    const lines: string[] = [];
    try {
      for await (const chunk of agent.stream(
        { action: 'logs.stream', service: manifest.name, tail: LOG_SCAN_LINES },
        AbortSignal.timeout(20_000),
      )) {
        lines.push((chunk as { line: string }).line);
      }
    } catch {
      return;
    }
    const errors = lines.filter(isErrorLine);
    state.errorCount = errors.length;
    state.hints = hintsForLines(errors);
  }

  async function refreshService(manifest: ServiceManifest) {
    const state = states.get(manifest.name) as ServiceState;
    try {
      const result = await agent.call<ServiceStatusResult>({
        action: 'service.status',
        service: manifest.name,
      });
      const computed = computeStatus({
        containerState: result.state,
        containers: result.containers,
        httpOk: result.http?.ok ?? null,
        missingFolders: result.missingFolders,
        now: now(),
        lastFailure: state.lastFailure,
      });
      state.status = computed.status;
      state.message = computed.message;
      state.credentialsPending = result.credentialsPending;
      state.update = result.update ?? null;
      if (result.state === 'not_found') {
        state.errorCount = 0;
        state.hints = [];
      } else if (now() - state.logScanAt >= LOG_SCAN_INTERVAL_MS) {
        await scanLogs(manifest, state);
      }
    } catch (error) {
      if (error instanceof AgentRequestError && error.code === 'docker_unavailable') {
        state.status = 'error';
        state.message = 'Docker is not running on the server.';
      } else {
        throw error;
      }
    }
  }

  async function refreshSystem() {
    const info = await agent.call<SystemInfoResult>({ action: 'system.info' });
    system = {
      hostname: info.hostname,
      cpuCount: info.cpuCount,
      cpuLoadPercent: info.cpuLoadPercent,
      memTotalBytes: info.memTotalBytes,
      memFreeBytes: info.memFreeBytes,
      diskTotalBytes: info.diskTotalBytes,
      diskFreeBytes: info.diskFreeBytes,
      temperatureCelsius: info.temperatureCelsius,
      uptimeSeconds: info.uptimeSeconds,
    };
  }

  async function refresh(service?: ServiceName) {
    try {
      const targets = manifests.filter((manifest) => !service || manifest.name === service);
      await Promise.all(targets.map(refreshService));
      if (!service) await refreshSystem();
      agentReachable = true;
    } catch (error) {
      if (error instanceof AgentRequestError && error.code === 'unreachable') {
        agentReachable = false;
        for (const state of states.values()) {
          state.status = 'error';
          state.message = 'The dashboard cannot reach the server helper.';
        }
      }
    }
    publish();
  }

  return {
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    snapshot,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isAvailable: (service) => states.has(service),

    beginAction(service, action) {
      const state = states.get(service);
      if (!state || state.busy) return false;
      state.busy = action;
      state.lastFailure = null;
      state.notice = null;
      publish();
      return true;
    },

    async endAction(service, failure, notice) {
      const state = states.get(service);
      if (!state) return;
      state.busy = null;
      state.lastFailure = failure ?? null;
      state.notice = notice ?? null;
      state.logScanAt = 0;
      await refresh(service);
    },
  };
}
