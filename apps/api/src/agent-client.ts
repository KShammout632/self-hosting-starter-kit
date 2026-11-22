import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { z } from 'zod';
import type { agentRequest, ErrorCode } from '@selfhost/shared';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AgentCall = DistributiveOmit<z.input<typeof agentRequest>, 'id'>;

export class AgentRequestError extends Error {
  constructor(
    readonly code: ErrorCode | 'unreachable' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export interface AgentClient {
  call<T = unknown>(request: AgentCall, options?: { timeoutMs?: number }): Promise<T>;
  stream(request: AgentCall, signal?: AbortSignal): AsyncGenerator<unknown>;
}

interface Reply {
  ok?: boolean;
  data?: unknown;
  error?: { code: ErrorCode; message: string };
  chunk?: unknown;
  end?: boolean;
}

// One connection per request keeps this simple: closing the connection also tells the agent to
// stop a followed log.
function open(socketPath: string, request: AgentCall) {
  const socket = net.connect(socketPath);
  socket.setEncoding('utf8');
  const id = randomBytes(8).toString('hex');
  socket.once('connect', () => socket.write(JSON.stringify({ id, ...request }) + '\n'));
  return socket;
}

export function createAgentClient(socketPath: string): AgentClient {
  const unreachable = (error: NodeJS.ErrnoException) =>
    new AgentRequestError(
      'unreachable',
      ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code ?? '')
        ? 'The server helper is not running.'
        : 'Could not talk to the server helper.',
    );

  async function* replies(
    request: AgentCall,
    signal: AbortSignal | undefined,
    timeoutMs: number | null,
  ): AsyncGenerator<Reply> {
    const socket = open(socketPath, request);
    const queue: Reply[] = [];
    let failure: Error | null = null;
    let closed = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };

    let buffer = '';
    socket.on('data', (data: string) => {
      buffer += data;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (text) queue.push(JSON.parse(text) as Reply);
      }
      notify();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      failure = unreachable(error);
      notify();
    });
    socket.on('close', () => {
      closed = true;
      notify();
    });
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            failure = new AgentRequestError(
              'timeout',
              'The server helper took too long to answer.',
            );
            socket.destroy();
            notify();
          }, timeoutMs);
    const onAbort = () => socket.destroy();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        const reply = queue.shift();
        if (reply) {
          yield reply;
          if (reply.ok !== undefined || reply.end) return;
          continue;
        }
        if (failure) throw failure;
        if (closed) {
          if (signal?.aborted) return;
          throw new AgentRequestError('unreachable', 'The server helper closed the connection.');
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
    }
  }

  const toError = (reply: Reply) =>
    new AgentRequestError(
      reply.error?.code ?? 'failed',
      reply.error?.message ?? 'The action failed.',
    );

  return {
    async call<T>(request: AgentCall, options: { timeoutMs?: number } = {}) {
      for await (const reply of replies(request, undefined, options.timeoutMs ?? 30_000)) {
        if (reply.ok === false) throw toError(reply);
        if (reply.ok) return reply.data as T;
      }
      return undefined as T;
    },

    async *stream(request, signal) {
      for await (const reply of replies(request, signal, null)) {
        if (reply.ok === false) throw toError(reply);
        if ('chunk' in reply) yield reply.chunk;
      }
    },
  };
}
