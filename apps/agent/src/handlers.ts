import os from 'node:os';
import type {
  AgentAction,
  AgentRequest,
  AgentVersionResult,
  ContainerSummary,
  ServiceStatusResult,
  SystemInfoResult,
  TailscaleStatusResult,
} from '@selfhost/shared';
import pkg from '../package.json' with { type: 'json' };
import type { DockerClient } from './docker';
import { AgentError } from './errors';
import type { Runner } from './exec';
import type { HostFs, Paths } from './host';
import { serviceHandlers } from './service-handlers';

export interface Deps {
  dryRun: boolean;
  docker: DockerClient;
  run: Runner;
  paths: Paths;
  fs: HostFs;
}

// A handler either returns data for one reply, or a stream that becomes chunk messages then end.
export type HandlerResult = { data?: unknown } | { stream: AsyncIterable<unknown> };

export type Handler<A extends AgentAction> = (
  request: Extract<AgentRequest, { action: A }>,
  deps: Deps,
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

  async 'agent.version'(_request, deps) {
    const data: AgentVersionResult = { version: pkg.version, dryRun: deps.dryRun };
    return { data };
  },

  async 'system.info'() {
    const data: SystemInfoResult = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      memTotalBytes: os.totalmem(),
      memFreeBytes: os.freemem(),
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg() as [number, number, number],
    };
    return { data };
  },

  async 'service.status'(request, deps) {
    const containers = await deps.docker.listServiceContainers(request.service);
    const data: ServiceStatusResult = {
      service: request.service,
      state: deriveServiceState(containers),
      containers,
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
