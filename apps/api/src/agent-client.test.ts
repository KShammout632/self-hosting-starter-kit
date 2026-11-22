import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRequestError, createAgentClient } from './agent-client';

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const socketPath = () => {
  const unique = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\selfhost-api-test-${unique}`
    : path.join(os.tmpdir(), `selfhost-api-test-${unique}.sock`);
};

async function fakeAgent(
  onRequest: (request: Record<string, unknown>, socket: net.Socket) => void,
) {
  const address = socketPath();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (data: string) => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) onRequest(JSON.parse(buffer.slice(0, newline)), socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(address, resolve));
  return address;
}

const reply = (socket: net.Socket, message: unknown) =>
  socket.write(JSON.stringify(message) + '\n');

describe('agent client', () => {
  it('sends a request with an id and returns the data', async () => {
    let seen: Record<string, unknown> = {};
    const address = await fakeAgent((request, socket) => {
      seen = request;
      reply(socket, { id: request.id, ok: true, data: { version: '1.0.0' } });
    });
    const data = await createAgentClient(address).call({ action: 'agent.version' });
    expect(data).toEqual({ version: '1.0.0' });
    expect(seen).toMatchObject({ action: 'agent.version' });
    expect(typeof seen.id).toBe('string');
  });

  it('turns an error reply into an AgentRequestError with the code', async () => {
    const address = await fakeAgent((request, socket) =>
      reply(socket, { id: request.id, ok: false, error: { code: 'busy', message: 'Busy.' } }),
    );
    await expect(
      createAgentClient(address).call({ action: 'agent.version' }),
    ).rejects.toMatchObject({
      code: 'busy',
    });
  });

  it('reports an unreachable agent', async () => {
    const client = createAgentClient(socketPath());
    const error = await client.call({ action: 'agent.version' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRequestError);
    expect(error).toMatchObject({ code: 'unreachable' });
  });

  it('times out when the agent never answers', async () => {
    const address = await fakeAgent(() => {});
    await expect(
      createAgentClient(address).call({ action: 'agent.version' }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('yields chunks until end', async () => {
    const address = await fakeAgent((request, socket) => {
      reply(socket, { id: request.id, chunk: { line: 'one' } });
      reply(socket, { id: request.id, chunk: { line: 'two' } });
      reply(socket, { id: request.id, end: true });
    });
    const lines: unknown[] = [];
    for await (const chunk of createAgentClient(address).stream({
      action: 'logs.stream',
      service: 'jellyfin',
      tail: 5,
    })) {
      lines.push(chunk);
    }
    expect(lines).toEqual([{ line: 'one' }, { line: 'two' }]);
  });

  it('closes the connection when the caller aborts a followed stream', async () => {
    let closed!: () => void;
    const agentSawClose = new Promise<void>((resolve) => (closed = resolve));
    const address = await fakeAgent((request, socket) => {
      socket.on('close', closed);
      reply(socket, { id: request.id, chunk: { line: 'only' } });
    });
    const controller = new AbortController();
    const lines: unknown[] = [];
    for await (const chunk of createAgentClient(address).stream(
      { action: 'logs.stream', service: 'jellyfin', tail: 5, follow: true },
      controller.signal,
    )) {
      lines.push(chunk);
      controller.abort();
    }
    expect(lines).toEqual([{ line: 'only' }]);
    await agentSawClose;
  });
});
