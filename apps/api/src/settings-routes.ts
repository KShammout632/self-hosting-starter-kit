import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  KIT_UPDATE_STATUS_FILE,
  REBOOT_TARGET,
  compareVersions,
  kitUpdateStatus,
  parseReleaseTag,
  type AgentVersionResult,
  type AuditEntryView,
  type ConfirmIssueResult,
  type KitSnapshot,
  type KitUpdateStatus,
  type SettingsJob,
  type SystemUpdatesApplyResult,
  type SystemUpdatesCheckResult,
  type SystemUpdatesSnapshot,
} from '@selfhost/shared';
import { AgentRequestError, type AgentClient } from './agent-client';
import type { AuditLog } from './audit';
import { REAUTH_AFTER_MS } from './auth';

export const RELEASE_REPO = 'KShammout632/self-hosting-starting-kit';
const DAY_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const MANUAL_CHECK_GAP_MS = 30_000;
const SYSTEM_CACHE_MS = 60_000;
const STALE_UPDATE_MS = 30 * 60_000;

export interface LatestRelease {
  version: string;
  url: string;
}

// Gets the version installed now, or null when the agent could not be asked.
export type FetchLatest = (installed: string | null) => Promise<LatestRelease>;

const FIRST_STABLE = '1.0.0';

// Versions before 1.0.0 are published as GitHub pre-releases, which GitHub never calls "latest". A
// server on a beta is offered newer betas; a server on 1.0.0 or later only full releases.
export function newestRelease(releases: unknown[], installed: string | null): string | null {
  const includePreReleases = installed !== null && compareVersions(installed, FIRST_STABLE) < 0;
  let newest: string | null = null;
  for (const entry of releases) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { tag_name: tag, draft, prerelease } = entry as Record<string, unknown>;
    if (draft === true || (prerelease === true && !includePreReleases)) continue;
    const version = typeof tag === 'string' ? parseReleaseTag(tag) : null;
    if (version && (newest === null || compareVersions(version, newest) > 0)) newest = version;
  }
  return newest;
}

export const fetchLatestFromGitHub: FetchLatest = async (installed) => {
  const response = await fetch(
    `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'selfhost-dashboard' },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = (await response.json()) as unknown;
  const version = newestRelease(Array.isArray(body) ? body : [], installed);
  if (!version) throw new Error('No release with a version tag');
  return { version, url: `https://github.com/${RELEASE_REPO}/releases/tag/v${version}` };
};

export function readKitUpdateStatus(path = KIT_UPDATE_STATUS_FILE): KitUpdateStatus | null {
  try {
    const parsed = kitUpdateStatus.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface SettingsRouteDeps {
  agent: AgentClient;
  audit: AuditLog;
  now: () => number;
  fetchLatest?: FetchLatest;
  readUpdateStatus?: () => KitUpdateStatus | null;
  sendError: (
    reply: FastifyReply,
    status: number,
    error: string,
    message: string,
    extra?: object,
  ) => unknown;
}

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

const failureMessage = (error: unknown, fallback: string): string => {
  if (error instanceof AgentRequestError) {
    if (['refused', 'busy', 'failed'].includes(error.code)) return error.message;
    if (['unreachable', 'timeout'].includes(error.code)) {
      return 'The dashboard could not reach the server helper.';
    }
  }
  return fallback;
};

const errorCode = (error: unknown) => (error instanceof AgentRequestError ? error.code : 'error');

export function registerSettingsRoutes(secured: FastifyInstance, deps: SettingsRouteDeps) {
  const { agent, audit, now, sendError } = deps;
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromGitHub;
  const readStatus = deps.readUpdateStatus ?? (() => readKitUpdateStatus());

  let latest: LatestRelease | null = null;
  let checkedAt: number | null = null;
  let failedAt: number | null = null;
  let kitJob: SettingsJob | null = null;
  let systemJob: SettingsJob | null = null;
  let systemCache: { at: number; value: SystemUpdatesCheckResult } | null = null;

  const needsRecentPassword = (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.session as NonNullable<FastifyRequest['session']>;
    if (now() - session.lastAuthAt <= REAUTH_AFTER_MS) return false;
    sendError(reply, 403, 'reauth_required', 'Enter your password to continue.');
    return true;
  };

  // Looks at most once a day, retries a failure after an hour, and a manual check waits 30 seconds
  // since the last look so the button cannot hammer GitHub.
  const lookForNewVersion = async (manual: boolean) => {
    const lastLook = Math.max(checkedAt ?? 0, failedAt ?? 0);
    const wait = manual
      ? MANUAL_CHECK_GAP_MS
      : failedAt !== null && failedAt >= (checkedAt ?? 0)
        ? RETRY_AFTER_FAILURE_MS
        : DAY_MS;
    if (lastLook !== 0 && now() - lastLook < wait) return;
    try {
      latest = await fetchLatest(await currentVersion());
      checkedAt = now();
      failedAt = null;
    } catch {
      failedAt = now();
    }
  };

  // A script that died halfway leaves "running" behind. After 30 minutes it counts as failed, so
  // it cannot block updates forever.
  const currentStatus = (): KitUpdateStatus | null => {
    const status = readStatus();
    if (status?.state !== 'running' || now() - Date.parse(status.at) < STALE_UPDATE_MS) {
      return status;
    }
    return { ...status, state: 'failed', message: 'The update stopped before it finished.' };
  };

  const currentVersion = (): Promise<string | null> =>
    agent
      .call<AgentVersionResult>({ action: 'agent.version' })
      .then((result) => result.version)
      .catch(() => null);

  const kitSnapshot = async (): Promise<KitSnapshot> => {
    const current = await currentVersion();
    return {
      currentVersion: current,
      latestVersion: latest?.version ?? null,
      updateAvailable:
        current !== null && latest !== null && compareVersions(latest.version, current) > 0,
      releaseNotesUrl: latest?.url ?? null,
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      checkFailed: failedAt !== null && failedAt >= (checkedAt ?? 0),
      job: kitJob,
      update: currentStatus(),
    };
  };

  secured.get('/api/settings/kit', async () => {
    await lookForNewVersion(false);
    return kitSnapshot();
  });

  secured.post('/api/settings/kit/check', async () => {
    await lookForNewVersion(true);
    return kitSnapshot();
  });

  secured.post('/api/settings/kit/update', async (request, reply) => {
    if (needsRecentPassword(request, reply)) return;
    if (kitJob?.state === 'running' || currentStatus()?.state === 'running') {
      return sendError(reply, 409, 'busy', 'An update is already in progress.');
    }
    await lookForNewVersion(false);
    const current = await currentVersion();
    if (!latest || !current || compareVersions(latest.version, current) <= 0) {
      return sendError(reply, 409, 'up_to_date', 'The kit is already up to date.');
    }
    const { version } = latest;
    kitJob = { state: 'running', message: null };
    void (async () => {
      try {
        await agent.call({ action: 'kit.update', version }, { timeoutMs: 12 * 60_000 });
        audit.record({ actor: 'admin', event: 'kit.update', target: version, outcome: 'ok' });
        kitJob = null;
      } catch (error) {
        audit.record({
          actor: 'admin',
          event: 'kit.update',
          target: version,
          outcome: 'failed',
          detail: errorCode(error),
        });
        kitJob = {
          state: 'failed',
          message: failureMessage(error, 'The update could not be started. Try again later.'),
        };
      }
    })();
    return reply.code(202).send({ started: true });
  });

  const systemSnapshot = async (refresh: boolean): Promise<SystemUpdatesSnapshot> => {
    if (refresh || !systemCache || now() - systemCache.at > SYSTEM_CACHE_MS) {
      const value = await agent.call<SystemUpdatesCheckResult>(
        { action: 'system.updates.check', refresh },
        { timeoutMs: refresh ? 7 * 60_000 : 30_000 },
      );
      systemCache = { at: now(), value };
    }
    return { ...systemCache.value, job: systemJob };
  };

  const checkFailed = (reply: FastifyReply, error: unknown) =>
    sendError(
      reply,
      502,
      'agent',
      failureMessage(error, 'Could not check for updates. Try again in a moment.'),
    );

  secured.get('/api/settings/system', async (_request, reply) => {
    try {
      return await systemSnapshot(false);
    } catch (error) {
      return checkFailed(reply, error);
    }
  });

  secured.post('/api/settings/system/check', async (_request, reply) => {
    try {
      return await systemSnapshot(true);
    } catch (error) {
      return checkFailed(reply, error);
    }
  });

  secured.post('/api/settings/system/apply', async (request, reply) => {
    if (needsRecentPassword(request, reply)) return;
    if (systemJob?.state === 'running') {
      return sendError(reply, 409, 'busy', 'Updates are already being installed.');
    }
    systemJob = { state: 'running', message: null };
    void (async () => {
      try {
        const result = await agent.call<SystemUpdatesApplyResult>(
          { action: 'system.updates.apply' },
          { timeoutMs: 50 * 60_000 },
        );
        audit.record({
          actor: 'admin',
          event: 'system.updates.apply',
          outcome: 'ok',
          detail: `${result.upgraded} packages`,
        });
        systemJob = null;
      } catch (error) {
        audit.record({
          actor: 'admin',
          event: 'system.updates.apply',
          outcome: 'failed',
          detail: errorCode(error),
        });
        systemJob = {
          state: 'failed',
          message: failureMessage(error, 'The updates did not finish. Try again in a few minutes.'),
        };
      }
      systemCache = null;
    })();
    return reply.code(202).send({ started: true });
  });

  secured.post('/api/settings/reboot', async (request, reply) => {
    if (needsRecentPassword(request, reply)) return;
    try {
      const { token } = await agent.call<ConfirmIssueResult>({
        action: 'confirm.issue',
        kind: 'system.reboot',
        target: REBOOT_TARGET,
      });
      await agent.call({ action: 'system.reboot', confirm: token });
      audit.record({ actor: 'admin', event: 'system.reboot', outcome: 'ok' });
      return reply.code(202).send({ started: true });
    } catch (error) {
      audit.record({
        actor: 'admin',
        event: 'system.reboot',
        outcome: 'failed',
        detail: errorCode(error),
      });
      const busy = error instanceof AgentRequestError && error.code === 'busy';
      return sendError(
        reply,
        busy ? 409 : 502,
        busy ? 'busy' : 'agent',
        failureMessage(error, 'The server could not be restarted.'),
      );
    }
  });

  secured.get('/api/settings/audit', async (request, reply) => {
    const query = auditQuery.safeParse(request.query);
    if (!query.success) return sendError(reply, 400, 'invalid_input', 'That request is not valid.');
    const entries: AuditEntryView[] = audit.recent(query.data.limit).map((entry) => ({
      ts: entry.ts,
      actor: entry.actor,
      event: entry.event,
      target: entry.target ?? null,
      outcome: entry.outcome,
      detail: entry.detail ?? null,
    }));
    return { entries };
  });
}
