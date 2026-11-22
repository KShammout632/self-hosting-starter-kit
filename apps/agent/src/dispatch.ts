import {
  confirmBinding,
  lockKey as lockKeyFor,
  parseRequest,
  type AgentRequest,
  type AgentResponse,
  type ErrorCode,
} from '@selfhost/shared';
import { AgentError } from './errors';
import type { Deps, HandlerContext, HandlerResult, Handlers } from './handlers';

type AnyHandler = (
  request: AgentRequest,
  deps: Deps,
  context: HandlerContext,
) => Promise<HandlerResult>;

export type Dispatch = (line: string, signal?: AbortSignal) => AsyncGenerator<AgentResponse>;

export interface DispatchOptions {
  handlers: Handlers;
  deps: Deps;
  log?: (entry: Record<string, unknown>) => void;
}

const fail = (id: string | null, code: ErrorCode, message: string): AgentResponse => ({
  id,
  ok: false,
  error: { code, message },
});

export function createDispatcher({
  handlers,
  deps,
  log = (entry) => console.error(JSON.stringify(entry)),
}: DispatchOptions): Dispatch {
  // One mutating action per service at a time, and one disk change at a time.
  const busyServices = new Set<string>();

  async function* execute(
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentResponse> {
    const handler = handlers[request.action] as AnyHandler | undefined;
    if (!handler) throw new AgentError('not_implemented', 'This action is not available yet.');

    const result = await handler(request, deps, { signal });
    if ('stream' in result) {
      for await (const chunk of result.stream) yield { id: request.id, chunk };
      yield { id: request.id, end: true };
    } else {
      yield { id: request.id, ok: true, data: result.data };
    }
  }

  return async function* dispatch(line, signal = new AbortController().signal) {
    const parsed = parseRequest(line);
    if (!parsed.ok) {
      log({ event: 'rejected', code: parsed.code });
      yield fail(parsed.id, parsed.code, parsed.message);
      return;
    }

    const { request } = parsed;
    const started = Date.now();
    const lockKey = lockKeyFor(request);
    const service = 'service' in request ? request.service : undefined;
    let outcome = 'ok';
    let holdsLock = false;

    try {
      const binding = confirmBinding(request);
      const token = 'confirm' in request ? request.confirm : undefined;
      if (binding && !token) {
        throw new AgentError('confirm_required', 'This action needs a confirmation token.');
      }
      if (binding && token && !deps.confirmTokens.verify(token, binding.kind, binding.target)) {
        throw new AgentError('confirm_required', 'The confirmation is invalid or has expired.');
      }
      if (lockKey !== null) {
        if (busyServices.has(lockKey)) {
          throw new AgentError('busy', 'Another action is already running for this service.');
        }
        busyServices.add(lockKey);
        holdsLock = true;
      }
      if (binding && token) deps.confirmTokens.consume(token);
      yield* execute(request, signal);
    } catch (error) {
      if (error instanceof AgentError) {
        outcome = error.code;
        yield fail(request.id, error.code, error.message);
      } else {
        outcome = 'failed';
        log({ event: 'error', id: request.id, message: String(error) });
        yield fail(request.id, 'failed', 'The action failed.');
      }
    } finally {
      if (holdsLock && lockKey !== null) busyServices.delete(lockKey);
      log({
        event: 'action',
        id: request.id,
        action: request.action,
        service,
        outcome,
        ms: Date.now() - started,
      });
    }
  };
}
