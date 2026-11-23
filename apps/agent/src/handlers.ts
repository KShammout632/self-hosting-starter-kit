import os from 'node:os';
import { getManifest } from '@selfhost/catalog';
import si from 'systeminformation';
import {
  deviceName,
  serviceName,
  type AgentAction,
  type AgentRequest,
  type AgentVersionResult,
  type ConfirmIssueResult,
  type ContainerSummary,
  type ServiceStatusResult,
  type SystemInfoResult,
  type TailscaleStatusResult,
} from '@selfhost/shared';
import pkg from '../package.json' with { type: 'json' };
import { CONFIRM_TTL_MS, type ConfirmTokens } from './confirm';
import type { DockerClient } from './docker';
import { AgentError } from './errors';
import type { HttpChecker, LineStreamer, Runner } from './exec';
import type { HostFs, Paths } from './host';
import { credentialsPending, serviceHandlers } from './service-handlers';
import { missingFolders } from './storage';
import { storageHandlers } from './storage-handlers';

export interface Deps {
  dryRun: boolean;
  docker: DockerClient;
  run: Runner;
  paths: Paths;
  fs: HostFs;
  stream: LineStreamer;
  httpCheck: HttpChecker;
  confirmTokens: ConfirmTokens;
}

export interface HandlerContext {
  signal: AbortSignal;
}

// A handler either returns data for one reply, or a stream that becomes chunk messages then end.
export type HandlerResult = { data?: unknown } | { stream: AsyncIterable<unknown> };

export type Handler<A extends AgentAction> = (
  request: Extract<AgentRequest, { action: A }>,
  deps: Deps,
  context: HandlerContext,
) => Promise<HandlerResult>;

export type Handlers = { [A in AgentAction]?: Handler<A> };

export function deriveServiceState(containers: ContainerSummary[]): ServiceStatusResult['state'] {
  if (containers.length === 0) return 'not_found';
  if (containers.some((c) => c.state === 'restarting')) return 'restarting';
  const running = containers.filter((c) => c.state === 'running').length;
  if (running === containers.length) return 'running';
  return running === 0 ? 'stopped' : 'partial';
}

const parseTailscale = (stdout: string): TailscaleStatusResult => {
  const status = JSON.parse(stdout) as {
    BackendState?: string;
    Self?: { HostName?: string; DNSName?: string };
  };
  return {
    installed: true,
    backendState: status.BackendState ?? null,
    hostname: status.Self?.HostName ?? null,
    dnsName: status.Self?.DNSName?.replace(/\.$/, '') ?? null,
  };
};

export const handlers: Handlers = {
  ...serviceHandlers,
  ...storageHandlers,

  async 'agent.version'(_request, deps) {
    const data: AgentVersionResult = { version: pkg.version, dryRun: deps.dryRun };
    return { data };
  },

  async 'system.info'() {
    const [load, memory, disks, temperature] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature(),
    ]);
    const disk = disks.find((entry) => entry.mount === '/') ?? disks[0];
    const data: SystemInfoResult = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      memTotalBytes: memory.total,
      memFreeBytes: memory.available,
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg() as [number, number, number],
      cpuLoadPercent: Math.round(load.currentLoad * 10) / 10,
      diskTotalBytes: disk?.size ?? 0,
      diskFreeBytes: disk?.available ?? 0,
      temperatureCelsius: temperature.main ?? null,
    };
    return { data };
  },

  async 'confirm.issue'(request, deps) {
    const validTarget =
      request.kind === 'service.uninstall'
        ? serviceName.safeParse(request.target).success
        : deviceName.safeParse(request.target).success;
    if (!validTarget) throw new AgentError('invalid_request', 'Request arguments are not valid.');
    const data: ConfirmIssueResult = {
      token: deps.confirmTokens.issue(request.kind, request.target),
      expiresInSeconds: CONFIRM_TTL_MS / 1000,
    };
    return { data };
  },

  async 'service.status'(request, deps) {
    const containers = await deps.docker.listServiceContainers(request.service);
    const state = deriveServiceState(containers);
    const manifest = getManifest(request.service);
    const http =
      state === 'running' && manifest
        ? {
            ok: await deps.httpCheck(
              `http://127.0.0.1:${manifest.ports.lan}${manifest.health.path}`,
              manifest.health.expect,
            ),
          }
        : null;
    const folders = manifest?.libraryFolders.map((entry) => entry.folder) ?? [];
    const data: ServiceStatusResult = {
      service: request.service,
      state,
      containers,
      http,
      missingFolders: await missingFolders(deps, folders).catch(() => []),
      credentialsPending:
        state !== 'not_found' && manifest ? await credentialsPending(deps, manifest) : false,
    };
    return { data };
  },

  async 'tailscale.status'(_request, deps) {
    try {
      return { data: parseTailscale(await deps.run('tailscale', ['status', '--json'])) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const data: TailscaleStatusResult = {
          installed: false,
          backendState: null,
          hostname: null,
          dnsName: null,
        };
        return { data };
      }
      throw new AgentError('failed', 'Tailscale did not respond.');
    }
  },
};
