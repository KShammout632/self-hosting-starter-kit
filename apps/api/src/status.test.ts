import { describe, expect, it } from 'vitest';
import type { ContainerSummary } from '@selfhost/shared';
import { computeStatus, STARTING_WINDOW_MS, type StatusInput } from './status';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const container = (overrides: Partial<ContainerSummary> = {}): ContainerSummary => ({
  name: 'c',
  state: 'running',
  health: null,
  startedAt: new Date(NOW - 10 * 60_000).toISOString(),
  ...overrides,
});

const input = (overrides: Partial<StatusInput>): StatusInput => ({
  containerState: 'running',
  containers: [container()],
  httpOk: true,
  now: NOW,
  lastFailure: null,
  ...overrides,
});

describe('computeStatus', () => {
  it('is online when containers run and the HTTP check passes', () => {
    expect(computeStatus(input({}))).toEqual({ status: 'online', message: null });
  });

  it('is starting while the check fails shortly after a start', () => {
    const recent = container({ startedAt: new Date(NOW - 60_000).toISOString() });
    expect(computeStatus(input({ httpOk: false, containers: [recent] })).status).toBe('starting');
  });

  it('is degraded when the check keeps failing after the starting window', () => {
    const old = container({ startedAt: new Date(NOW - STARTING_WINDOW_MS - 1).toISOString() });
    expect(computeStatus(input({ httpOk: false, containers: [old] })).status).toBe('degraded');
  });

  it('is degraded when the start time is unknown and the check fails', () => {
    const unknown = container({ startedAt: null });
    expect(computeStatus(input({ httpOk: false, containers: [unknown] })).status).toBe('degraded');
  });

  it('is degraded when a container reports unhealthy, even if HTTP answers', () => {
    const unhealthy = container({ health: 'unhealthy' });
    expect(computeStatus(input({ containers: [unhealthy, container()] })).status).toBe('degraded');
  });

  it('is degraded when only some containers run', () => {
    expect(computeStatus(input({ containerState: 'partial', httpOk: null })).status).toBe(
      'degraded',
    );
  });

  it('is offline when stopped, and not installed when there is nothing', () => {
    expect(computeStatus(input({ containerState: 'stopped', httpOk: null })).status).toBe(
      'offline',
    );
    expect(computeStatus(input({ containerState: 'not_found', containers: [] })).status).toBe(
      'not_installed',
    );
  });

  it('is an error when crash looping', () => {
    expect(computeStatus(input({ containerState: 'restarting' })).status).toBe('error');
  });

  it('turns a failed install or start into an error with the reason', () => {
    const failure = 'That did not work.';
    expect(
      computeStatus(input({ containerState: 'not_found', containers: [], lastFailure: failure })),
    ).toEqual({ status: 'error', message: failure });
    expect(computeStatus(input({ containerState: 'stopped', lastFailure: failure })).status).toBe(
      'error',
    );
  });

  it('ignores an old failure once the service is running', () => {
    expect(computeStatus(input({ lastFailure: 'old' })).status).toBe('online');
  });

  it('is an error when a running service has lost its drive, and names what is missing', () => {
    const result = computeStatus(input({ missingFolders: ['movies', 'home-videos'] }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('movies and home videos');
  });

  it('leaves a stopped service alone when its drive is missing', () => {
    expect(
      computeStatus(input({ containerState: 'stopped', missingFolders: ['movies'] })).status,
    ).toBe('offline');
  });
});
