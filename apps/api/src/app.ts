import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  serviceName,
  type BusyAction,
  type ConfirmIssueResult,
  type ServiceCredentialsResult,
  type ServiceName,
  type SessionInfo,
} from '@selfhost/shared';
import { AgentRequestError, type AgentCall, type AgentClient } from './agent-client';
import type { AuditLog } from './audit';
import { REAUTH_AFTER_MS, SESSION_TTL_MS, type Auth } from './auth';
import type { StatusMonitor } from './monitor';
import { registerStorageRoutes } from './storage-routes';

const COOKIE = 'selfhost_session';
const ACTION_TIMEOUT_MS = 25 * 60_000;

export interface AppDeps {
  agent: AgentClient;
  auth: Auth;
  audit: AuditLog;
  monitor: StatusMonitor;
  webDir: string | null;
  now?: () => number;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: { token: string; csrfToken: string; lastAuthAt: number } | null;
  }
}

const setupBody = z.object({
  code: z.string().min(1).max(32),
  password: z.string().min(10).max(200),
});
const loginBody = z.object({ password: z.string().min(1).max(200) });
const uninstallBody = z.object({
  deleteData: z.boolean(),
  confirmName: z.string().max(64).optional(),
});
const logsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(1000).default(200),
  follow: z.enum(['0', '1']).default('0'),
});

const SIMPLE_ACTIONS = {
  install: { busy: 'installing', action: 'service.install' },
  start: { busy: 'starting', action: 'service.start' },
  stop: { busy: 'stopping', action: 'service.stop' },
  restart: { busy: 'restarting', action: 'service.restart' },
  update: { busy: 'updating', action: 'service.update' },
} as const satisfies Record<string, { busy: BusyAction; action: AgentCall['action'] }>;

export function describeAgentError(error: unknown): string {
  if (error instanceof AgentRequestError) {
    switch (error.code) {
      case 'busy':
        return 'Something else is already happening with this service. Try again in a moment.';
      case 'docker_unavailable':
        return 'Docker is not running on the server.';
      case 'not_installed':
        return 'This service is not installed yet.';
      case 'not_implemented':
        return 'This service is not available yet.';
      case 'refused':
        return 'That was already shown once and cannot be shown again.';
      case 'unreachable':
      case 'timeout':
        return 'The dashboard could not reach the server helper.';
      default:
        return 'That did not work. Open the logs to see what went wrong.';
    }
  }
  return 'That did not work. Open the logs to see what went wrong.';
}

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function buildApp(deps: AppDeps) {
  const { agent, auth, audit, monitor } = deps;
  const now = deps.now ?? Date.now;

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: true,
    bodyLimit: 16 * 1024,
  });
  app.decorateRequest('session', null);
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  const sendError = (
    reply: FastifyReply,
    status: number,
    error: string,
    message: string,
    extra: object = {},
  ) => reply.code(status).send({ error, message, ...extra });

  const sendLocked = (reply: FastifyReply, seconds: number) =>
    sendError(
      reply,
      429,
      'locked',
      `Too many wrong attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`,
      { retryAfterSeconds: seconds },
    );

  const startSession = (request: FastifyRequest, reply: FastifyReply) => {
    const { token, csrfToken } = auth.createSession();
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: request.protocol === 'https',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return csrfToken;
  };

  const loadSession = (request: FastifyRequest) => {
    const token = request.cookies[COOKIE];
    const row = auth.getSession(token);
    request.session = token && row ? { token, ...row } : null;
  };

  const sessionInfo = (request: FastifyRequest): SessionInfo => {
    loadSession(request);
    if (!auth.hasAdmin()) return { state: 'setup_required' };
    if (!request.session) return { state: 'logged_out', setupAvailable: auth.setupAvailable() };
    return {
      state: 'logged_in',
      csrfToken: request.session.csrfToken,
      reauthRequired: now() - request.session.lastAuthAt > REAUTH_AFTER_MS,
    };
  };

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async (request) => sessionInfo(request));

  const strictLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/api/setup', strictLimit, async (request, reply) => {
    const body = setupBody.safeParse(request.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        'invalid_input',
        'The code is needed, and the password must be at least 10 characters.',
      );
    }
    if (!auth.setupAvailable()) {
      return sendError(
        reply,
        403,
        'setup_unavailable',
        'Setup is not open. On the server, run "sudo selfhost reset-password" to get a new setup code.',
      );
    }
    const locked = auth.lockedForSeconds();
    if (locked > 0) return sendLocked(reply, locked);

    if (!auth.checkSetupCode(body.data.code)) {
      audit.record({ actor: 'anonymous', event: 'setup', outcome: 'denied' });
      const nowLocked = auth.lockedForSeconds();
      if (nowLocked > 0) return sendLocked(reply, nowLocked);
      return sendError(
        reply,
        401,
        'invalid_code',
        'That setup code is not right. Check the code the installer printed.',
      );
    }

    const reset = auth.hasAdmin();
    await auth.setPassword(body.data.password);
    auth.finishSetup();
    audit.record({ actor: 'admin', event: reset ? 'password.reset' : 'setup', outcome: 'ok' });
    return {
      state: 'logged_in',
      csrfToken: startSession(request, reply),
      reauthRequired: false,
    } satisfies SessionInfo;
  });

  app.post('/api/login', strictLimit, async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_input', 'Enter your password.');
    if (!auth.hasAdmin()) return sendError(reply, 409, 'setup_required', 'Finish setup first.');
    const locked = auth.lockedForSeconds();
    if (locked > 0) return sendLocked(reply, locked);

    if (!(await auth.checkPassword(body.data.password))) {
      audit.record({ actor: 'anonymous', event: 'login', outcome: 'denied' });
      const nowLocked = auth.lockedForSeconds();
      if (nowLocked > 0) return sendLocked(reply, nowLocked);
      return sendError(reply, 401, 'invalid_credentials', 'That password is not right.');
    }
    audit.record({ actor: 'admin', event: 'login', outcome: 'ok' });
    return {
      state: 'logged_in',
      csrfToken: startSession(request, reply),
      reauthRequired: false,
    } satisfies SessionInfo;
  });

  await app.register(async (secured) => {
    secured.addHook('preHandler', async (request, reply) => {
      loadSession(request);
      if (!request.session) {
        return sendError(reply, 401, 'unauthenticated', 'Please sign in.');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const header = request.headers['x-csrf-token'];
        if (typeof header !== 'string' || !safeEqual(header, request.session.csrfToken)) {
          return sendError(
            reply,
            403,
            'csrf',
            'Your session expired. Reload the page and try again.',
          );
        }
      }
    });

    secured.post('/api/logout', async (request, reply) => {
      if (request.session) auth.deleteSession(request.session.token);
      reply.clearCookie(COOKIE, { path: '/' });
      audit.record({ actor: 'admin', event: 'logout', outcome: 'ok' });
      return { ok: true };
    });

    secured.post('/api/session/reauth', strictLimit, async (request, reply) => {
      const body = loginBody.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'invalid_input', 'Enter your password.');
      const locked = auth.lockedForSeconds();
      if (locked > 0) return sendLocked(reply, locked);
      if (!(await auth.checkPassword(body.data.password))) {
        audit.record({ actor: 'admin', event: 'reauth', outcome: 'denied' });
        const nowLocked = auth.lockedForSeconds();
        if (nowLocked > 0) return sendLocked(reply, nowLocked);
        return sendError(reply, 401, 'invalid_credentials', 'That password is not right.');
      }
      auth.touchAuth((request.session as NonNullable<FastifyRequest['session']>).token);
      return { ok: true };
    });

    secured.get('/api/services', async () => monitor.snapshot());

    const parseService = (request: FastifyRequest, reply: FastifyReply): ServiceName | null => {
      const parsed = serviceName.safeParse((request.params as { name?: string }).name);
      if (!parsed.success || !monitor.isAvailable(parsed.data)) {
        sendError(reply, 404, 'not_available', 'This service is not available yet.');
        return null;
      }
      return parsed.data;
    };

    // Long actions (an install can pull gigabytes) run in the background. The page follows
    // progress through the status stream instead of holding a request open.
    const runInBackground = (
      reply: FastifyReply,
      service: ServiceName,
      busy: BusyAction,
      event: string,
      task: () => Promise<void>,
    ) => {
      if (!monitor.beginAction(service, busy)) {
        return sendError(
          reply,
          409,
          'busy',
          'Something else is already happening with this service.',
        );
      }
      void (async () => {
        try {
          await task();
          audit.record({ actor: 'admin', event, target: service, outcome: 'ok' });
          await monitor.endAction(service);
        } catch (error) {
          audit.record({
            actor: 'admin',
            event,
            target: service,
            outcome: 'failed',
            detail: error instanceof AgentRequestError ? error.code : 'error',
          });
          await monitor.endAction(service, describeAgentError(error));
        }
      })();
      return reply.code(202).send({ started: true });
    };

    for (const [path, { busy, action }] of Object.entries(SIMPLE_ACTIONS)) {
      secured.post(`/api/services/:name/${path}`, async (request, reply) => {
        const service = parseService(request, reply);
        if (!service) return;
        return runInBackground(reply, service, busy, action, async () => {
          await agent.call({ action, service }, { timeoutMs: ACTION_TIMEOUT_MS });
        });
      });
    }

    // The agent returns these once and then refuses, so the page must show them straight away.
    secured.post('/api/services/:name/credentials', async (request, reply) => {
      const service = parseService(request, reply);
      if (!service) return;
      try {
        const result = await agent.call<ServiceCredentialsResult>({
          action: 'service.credentials',
          service,
        });
        audit.record({
          actor: 'admin',
          event: 'service.credentials',
          target: service,
          outcome: 'ok',
        });
        await monitor.refresh(service);
        return result;
      } catch (error) {
        audit.record({
          actor: 'admin',
          event: 'service.credentials',
          target: service,
          outcome: 'failed',
          detail: error instanceof AgentRequestError ? error.code : 'error',
        });
        const refused = error instanceof AgentRequestError && error.code === 'refused';
        return sendError(
          reply,
          refused ? 409 : 502,
          refused ? 'already_shown' : 'agent',
          describeAgentError(error),
        );
      }
    });

    secured.post('/api/services/:name/uninstall', async (request, reply) => {
      const service = parseService(request, reply);
      if (!service) return;
      const body = uninstallBody.safeParse(request.body);
      if (!body.success)
        return sendError(reply, 400, 'invalid_input', 'Something is missing from that request.');

      const session = request.session as NonNullable<FastifyRequest['session']>;
      if (now() - session.lastAuthAt > REAUTH_AFTER_MS) {
        return sendError(reply, 403, 'reauth_required', 'Enter your password to continue.');
      }
      if (body.data.deleteData && body.data.confirmName !== service) {
        return sendError(reply, 400, 'confirmation_mismatch', `Type "${service}" to confirm.`);
      }

      const { deleteData } = body.data;
      return runInBackground(reply, service, 'removing', 'service.uninstall', async () => {
        const confirm = deleteData
          ? (
              await agent.call<ConfirmIssueResult>({
                action: 'confirm.issue',
                kind: 'service.uninstall',
                target: service,
              })
            ).token
          : undefined;
        await agent.call(
          { action: 'service.uninstall', service, deleteData, confirm },
          { timeoutMs: ACTION_TIMEOUT_MS },
        );
      });
    });

    registerStorageRoutes(secured, { agent, audit, monitor, now, sendError });

    const openEventStream = (request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      const closed = new AbortController();
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        closed.abort();
      });
      return {
        signal: closed.signal,
        send: (event: string, data: unknown) => {
          if (!closed.signal.aborted)
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end: () => {
          clearInterval(heartbeat);
          reply.raw.end();
        },
      };
    };

    secured.get('/api/status/stream', async (request, reply) => {
      const stream = openEventStream(request, reply);
      stream.send('status', monitor.snapshot());
      const unsubscribe = monitor.subscribe((snapshot) => stream.send('status', snapshot));
      stream.signal.addEventListener('abort', unsubscribe);
    });

    secured.get('/api/services/:name/logs', async (request, reply) => {
      const service = parseService(request, reply);
      if (!service) return;
      const query = logsQuery.safeParse(request.query);
      if (!query.success)
        return sendError(reply, 400, 'invalid_input', 'That log request is not valid.');

      const stream = openEventStream(request, reply);
      stream.send('ready', {});
      try {
        for await (const line of agent.stream(
          {
            action: 'logs.stream',
            service,
            tail: query.data.tail,
            follow: query.data.follow === '1',
          },
          stream.signal,
        )) {
          stream.send('line', line);
        }
        stream.send('end', {});
      } catch (error) {
        stream.send('problem', { message: describeAgentError(error) });
      }
      stream.end();
    });

    secured.get('/api/services/:name/logs/download', async (request, reply) => {
      const service = parseService(request, reply);
      if (!service) return;
      const lines: string[] = [];
      try {
        for await (const chunk of agent.stream({ action: 'logs.download', service })) {
          const entry = chunk as { ts: string | null; line: string };
          lines.push(entry.ts ? `${entry.ts} ${entry.line}` : entry.line);
        }
      } catch (error) {
        return sendError(reply, 502, 'agent', describeAgentError(error));
      }
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${service}-logs.txt"`)
        .send(lines.join('\n') + '\n');
    });
  });

  const serveWeb = deps.webDir !== null && existsSync(deps.webDir);

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] as string;
    // A missing file must be a real 404. Answering with the page would make the browser reject it
    // as a script with the wrong type and show a blank screen.
    const looksLikeFile = /\.[A-Za-z0-9]+$/.test(path);
    if (path.startsWith('/api/') || !serveWeb || request.method !== 'GET' || looksLikeFile) {
      return sendError(reply, 404, 'not_found', 'Not found.');
    }
    return reply.sendFile('index.html');
  });

  if (serveWeb) {
    await app.register(fastifyStatic, { root: deps.webDir as string, wildcard: false });
  }

  return app;
}
