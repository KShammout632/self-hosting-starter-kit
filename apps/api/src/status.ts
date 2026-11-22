import type { ContainerSummary, ServiceStatus, ServiceStatusResult } from '@selfhost/shared';

export const STARTING_WINDOW_MS = 3 * 60_000;

export interface StatusInput {
  containerState: ServiceStatusResult['state'];
  containers: ContainerSummary[];
  // Null when the check was not run because the containers are not all running.
  httpOk: boolean | null;
  now: number;
  // Plain-English reason the last install, start or update failed, if it did.
  lastFailure: string | null;
}

export interface StatusResult {
  status: ServiceStatus;
  message: string | null;
}

function newestStart(containers: ContainerSummary[]): number | null {
  const times = containers
    .map((container) => (container.startedAt ? Date.parse(container.startedAt) : Number.NaN))
    .filter((time) => !Number.isNaN(time));
  return times.length > 0 ? Math.max(...times) : null;
}

export function computeStatus(input: StatusInput): StatusResult {
  const { containerState, containers, httpOk, now, lastFailure } = input;

  switch (containerState) {
    case 'not_found':
      return lastFailure
        ? { status: 'error', message: lastFailure }
        : { status: 'not_installed', message: null };

    case 'restarting':
      return { status: 'error', message: 'It keeps restarting, which means something is wrong.' };

    case 'stopped':
      return lastFailure
        ? { status: 'error', message: lastFailure }
        : { status: 'offline', message: null };

    case 'partial':
      return { status: 'degraded', message: 'Part of this service is not running.' };

    case 'running': {
      if (containers.some((container) => container.health === 'unhealthy')) {
        return { status: 'degraded', message: 'It is running but reports a problem.' };
      }
      if (httpOk) return { status: 'online', message: null };
      const started = newestStart(containers);
      if (started !== null && now - started < STARTING_WINDOW_MS) {
        return { status: 'starting', message: null };
      }
      return { status: 'degraded', message: 'It is running but is not answering requests.' };
    }
  }
}
