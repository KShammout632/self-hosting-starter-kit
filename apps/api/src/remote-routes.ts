import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { catalog } from '@selfhost/catalog';
import {
  tailscaleHostname,
  type RemoteLink,
  type RemoteSnapshot,
  type RemoteState,
  type SystemInfoResult,
  type TailscaleServeResult,
  type TailscaleStatusResult,
} from '@selfhost/shared';
import { AgentRequestError, type AgentClient } from './agent-client';
import type { AuditLog } from './audit';
import { REAUTH_AFTER_MS } from './auth';
import type { StatusMonitor } from './monitor';

const SETTINGS_URL = 'https://login.tailscale.com/admin/dns';
const RETRY_AFTER_MS = 30_000;
const PASS_THROUGH = new Set(['refused', 'busy', 'not_installed']);

export interface RemoteRouteDeps {
  agent: AgentClient;
  audit: AuditLog;
  monitor: StatusMonitor;
  now: () => number;
  sendError: (
    reply: FastifyReply,
    status: number,
    error: string,
    message: string,
    extra?: object,
  ) => unknown;
}

const connectBody = z.object({ name: tailscaleHostname.optional() });

export function suggestName(hostname: string): string {
  const name = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return name || 'selfhost';
}

function stateOf(status: TailscaleStatusResult): RemoteState {
  if (!status.installed) return 'not_installed';
  if (status.backendState === 'Running') {
    return status.magicDnsEnabled && status.httpsEnabled ? 'ready' : 'needs_settings';
  }
  return status.authUrl ? 'waiting_for_sign_in' : 'signed_out';
}

export function registerRemoteRoutes(secured: FastifyInstance, deps: RemoteRouteDeps) {
  const { agent, audit, monitor, now, sendError } = deps;
  let publishedKey: string | null = null;
  let failedAt = 0;
  let problem: string | null = null;

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof AgentRequestError && PASS_THROUGH.has(error.code)) {
      return sendError(reply, 409, error.code, error.message);
    }
    if (error instanceof AgentRequestError && ['unreachable', 'timeout'].includes(error.code)) {
      return sendError(reply, 502, 'agent', 'The dashboard could not reach the server helper.');
    }
    return sendError(reply, 502, 'agent', 'That did not work. Try again in a moment.');
  };

  const installedServices = () =>
    monitor
      .snapshot()
      .services.filter((service) => service.status !== 'not_installed')
      .map((service) => service.name);

  const linksFor = (dnsName: string): RemoteLink[] => {
    const installed = new Set(installedServices());
    return [
      { target: 'dashboard' as const, label: 'Dashboard', url: `https://${dnsName}` },
      ...catalog
        .filter((manifest) => installed.has(manifest.name))
        .map((manifest) => ({
          target: manifest.name,
          label: manifest.displayName,
          url: `https://${dnsName}:${manifest.ports.remote}`,
        })),
    ];
  };

  const defaultName = async () => {
    const info = await agent.call<SystemInfoResult>({ action: 'system.info' }).catch(() => null);
    return suggestName(info?.hostname ?? '');
  };

  // Publishes installed services on the tailnet. Runs again whenever the set of installed
  // services or the tailnet name changes, so the owner never has to press a button for it.
  const publish = async (status: TailscaleStatusResult): Promise<void> => {
    const key = `${status.dnsName}|${installedServices().join(',')}`;
    if (publishedKey === key || now() - failedAt < RETRY_AFTER_MS) return;
    try {
      await agent.call<TailscaleServeResult>({ action: 'tailscale.serve.apply' });
      publishedKey = key;
      problem = null;
      failedAt = 0;
    } catch (error) {
      failedAt = now();
      problem =
        error instanceof AgentRequestError && error.code === 'refused'
          ? error.message
          : 'The addresses for away from home could not be set up yet. This page will try again.';
    }
  };

  const snapshot = async (status?: TailscaleStatusResult): Promise<RemoteSnapshot> => {
    const current =
      status ?? (await agent.call<TailscaleStatusResult>({ action: 'tailscale.status' }));
    const state = stateOf(current);
    if (state === 'ready') await publish(current);
    const ready = state === 'ready' && current.dnsName;
    return {
      state,
      name: current.hostname ?? (await defaultName()),
      signInUrl: state === 'waiting_for_sign_in' ? current.authUrl : null,
      magicDnsEnabled: current.magicDnsEnabled,
      httpsEnabled: current.httpsEnabled,
      settingsUrl: SETTINGS_URL,
      links: ready && current.dnsName ? linksFor(current.dnsName) : [],
      message: state === 'ready' ? problem : null,
    };
  };

  secured.get('/api/remote', async (_request, reply) => {
    try {
      return await snapshot();
    } catch (error) {
      return fail(reply, error);
    }
  });

  secured.post('/api/remote/connect', async (request, reply) => {
    const body = connectBody.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(
        reply,
        400,
        'invalid_input',
        'Use only lowercase letters, numbers and dashes for the name.',
      );
    }
    try {
      const name = body.data.name ?? (await defaultName());
      const status = await agent.call<TailscaleStatusResult>(
        { action: 'tailscale.login', hostname: name },
        { timeoutMs: 40_000 },
      );
      audit.record({ actor: 'admin', event: 'tailscale.login', outcome: 'ok' });
      return await snapshot(status);
    } catch (error) {
      audit.record({
        actor: 'admin',
        event: 'tailscale.login',
        outcome: 'failed',
        detail: error instanceof AgentRequestError ? error.code : 'error',
      });
      return fail(reply, error);
    }
  });

  secured.post('/api/remote/disconnect', async (request, reply) => {
    const session = request.session as NonNullable<FastifyRequest['session']>;
    if (now() - session.lastAuthAt > REAUTH_AFTER_MS) {
      return sendError(reply, 403, 'reauth_required', 'Enter your password to continue.');
    }
    try {
      const status = await agent.call<TailscaleStatusResult>(
        { action: 'tailscale.logout' },
        { timeoutMs: 40_000 },
      );
      publishedKey = null;
      problem = null;
      audit.record({ actor: 'admin', event: 'tailscale.logout', outcome: 'ok' });
      return await snapshot(status);
    } catch (error) {
      audit.record({
        actor: 'admin',
        event: 'tailscale.logout',
        outcome: 'failed',
        detail: error instanceof AgentRequestError ? error.code : 'error',
      });
      return fail(reply, error);
    }
  });

  // Called after an install or removal so the new service gets its address without a page visit.
  return {
    async sync(): Promise<void> {
      const status = await agent.call<TailscaleStatusResult>({ action: 'tailscale.status' });
      if (stateOf(status) === 'ready') await publish(status);
    },
  };
}
