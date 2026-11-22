import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentResponse, ContainerSummary } from '@selfhost/shared';
import { parseConfig } from './config';
import { createDispatcher } from './dispatch';
import type { DockerClient } from './docker';
import { AgentError } from './errors';
import { createConfirmTokens } from './confirm';
import { dryRunRunner, dryRunStreamer } from './exec';
import { DEFAULT_PATHS, dryRunFs } from './host';
import { deriveServiceState, handlers, type Deps, type Handlers } from './handlers';
import { createAgentServer } from './server';

const container = (state: string, health: ContainerSummary['health'] = null) => ({
  name: 'c',
  state,
  health,
  startedAt: null,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  dryRun: true,
  docker: { listServiceContainers: async () => [container('running', 'healthy')] },
  run: dryRunRunner,
  paths: DEFAULT_PATHS,
  fs: dryRunFs,
  stream: dryRunStreamer,
  httpCheck: async () => true,
  confirmTokens: createConfirmTokens(),
  ...overrides,
});

const dispatcher = (h: Handlers = handlers, deps = makeDeps()) =>
  createDispatcher({ handlers: h, deps, log: () => {} });

async function collect(stream: AsyncGenerator<AgentResponse>): Promise<AgentResponse[]> {
  const out: AgentResponse[] = [];
  for await (const message of stream) out.push(message);
  return out;
}

const line = (value: unknown) => JSON.stringify(value);

describe('deriveServiceState', () => {
  it('maps container states to one service state', () => {
    expect(deriveServiceState([])).toBe('not_found');
    expect(deriveServiceState([container('running'), container('running')])).toBe('running');
    expect(deriveServiceState([container('exited'), container('exited')])).toBe('stopped');
    expect(deriveServiceState([container('running'), container('exited')])).toBe('partial');
    expect(deriveServiceState([container('running'), container('restarting')])).toBe('restarting');
  });
});

describe('config', () => {
  it('reads flags and environment', () => {
    expect(parseConfig([], {})).toEqual({ dryRun: false, socketPath: '/run/selfhost/agent.sock' });
    expect(parseConfig(['--dry-run', '--socket', '/tmp/a.sock'], {})).toEqual({
      dryRun: true,
      socketPath: '/tmp/a.sock',
    });
    expect(parseConfig([], { SELFHOST_DRY_RUN: '1' }).dryRun).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(() => parseConfig(['--shell'], {})).toThrow();
  });
});

describe('dispatcher', () => {
  it('answers agent.version', async () => {
    const [reply] = await collect(dispatcher()(line({ id: 'a1', action: 'agent.version' })));
    expect(reply).toMatchObject({ id: 'a1', ok: true, data: { dryRun: true } });
  });

  it('answers service.status from the Docker client', async () => {
    const [reply] = await collect(
      dispatcher()(line({ id: 'a1', action: 'service.status', service: 'jellyfin' })),
    );
    expect(reply).toMatchObject({
      ok: true,
      data: { service: 'jellyfin', state: 'running', containers: [{ health: 'healthy' }] },
    });
  });

  it('checks the health URL from the catalog only while all containers run', async () => {
    const urls: string[] = [];
    const httpCheck = async (url: string) => {
      urls.push(url);
      return false;
    };
    const status = (docker: DockerClient) =>
      collect(
        dispatcher(
          handlers,
          makeDeps({ docker, httpCheck }),
        )(line({ id: 'a', action: 'service.status', service: 'jellyfin' })),
      );

    const [running] = await status({ listServiceContainers: async () => [container('running')] });
    expect(running).toMatchObject({ data: { http: { ok: false } } });
    expect(urls).toEqual(['http://127.0.0.1:8096/health']);

    const [stopped] = await status({ listServiceContainers: async () => [container('exited')] });
    expect(stopped).toMatchObject({ data: { state: 'stopped', http: null } });
    expect(urls).toHaveLength(1);
  });

  it('reports Docker being unavailable', async () => {
    const docker: DockerClient = {
      listServiceContainers: async () => {
        throw new AgentError('docker_unavailable', 'Docker is not running or cannot be reached.');
      },
    };
    const [reply] = await collect(
      dispatcher(
        handlers,
        makeDeps({ docker }),
      )(line({ id: 'a1', action: 'service.status', service: 'jellyfin' })),
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'docker_unavailable' } });
  });

  it('answers system.info and tailscale.status in dry-run', async () => {
    const d = dispatcher();
    const [info] = await collect(d(line({ id: 'a', action: 'system.info' })));
    expect(info).toMatchObject({ ok: true, data: { cpuCount: expect.any(Number) } });
    const [tailscale] = await collect(d(line({ id: 'b', action: 'tailscale.status' })));
    expect(tailscale).toMatchObject({
      ok: true,
      data: { installed: true, backendState: 'Running', dnsName: 'selfhost-dev.example.ts.net' },
    });
  });

  it('says Tailscale is not installed when the binary is missing', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    };
    const [reply] = await collect(
      dispatcher(handlers, makeDeps({ run }))(line({ id: 'a', action: 'tailscale.status' })),
    );
    expect(reply).toMatchObject({ ok: true, data: { installed: false } });
  });

  it('rejects unknown actions and invalid arguments', async () => {
    const d = dispatcher();
    expect(await collect(d(line({ id: 'a', action: 'shell.exec' })))).toEqual([
      { id: 'a', ok: false, error: { code: 'unknown_action', message: 'Unknown action.' } },
    ]);
    const [bad] = await collect(d(line({ id: 'b', action: 'service.start', service: 'x' })));
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('returns not_implemented for valid actions without a handler', async () => {
    const [reply] = await collect(dispatcher()(line({ id: 'a', action: 'system.reboot' })));
    expect(reply).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
  });

  it('requires a confirm token for destructive actions', async () => {
    const [reply] = await collect(
      dispatcher()(line({ id: 'a', action: 'disk.format', uuid: 'ABCD-1234', label: 'media1' })),
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
  });

  it('does not leak internal error details', async () => {
    const h: Handlers = {
      'agent.version': async () => {
        throw new Error('secret path /etc/shadow');
      },
    };
    const [reply] = await collect(dispatcher(h)(line({ id: 'a', action: 'agent.version' })));
    expect(JSON.stringify(reply)).not.toContain('shadow');
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
  });

  it('runs one action per service at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h: Handlers = {
      'service.start': async () => {
        await gate;
        return { data: {} };
      },
    };
    const d = dispatcher(h);
    const start = (id: string, service: string) => line({ id, action: 'service.start', service });

    const first = collect(d(start('a', 'jellyfin')));
    const [second] = await collect(d(start('b', 'jellyfin')));
    expect(second).toMatchObject({ ok: false, error: { code: 'busy' } });

    release();
    expect(await first).toMatchObject([{ ok: true }]);
    const [after] = await collect(d(start('c', 'jellyfin')));
    expect(after).toMatchObject({ ok: true });
  });

  it('keeps the lock when a second action is rejected early', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h: Handlers = {
      'service.uninstall': async () => {
        await gate;
        return { data: {} };
      },
    };
    const uninstall = (id: string, deleteData: boolean, confirm?: string) =>
      line({ id, action: 'service.uninstall', service: 'immich', deleteData, confirm });

    const deps = makeDeps();
    const token = deps.confirmTokens.issue('service.uninstall', 'immich');
    const d = dispatcher(h, deps);
    const first = collect(d(uninstall('a', true, token)));
    // Rejected for the missing token. It must not free the lock held by the first action.
    await collect(d(uninstall('b', true)));
    const [busy] = await collect(d(uninstall('c', false)));
    expect(busy).toMatchObject({ error: { code: 'busy' } });
    release();
    await first;
  });

  it('streams chunks then end', async () => {
    const h: Handlers = {
      'logs.stream': async () => ({
        stream: (async function* () {
          yield { line: 'one' };
          yield { line: 'two' };
        })(),
      }),
    };
    const replies = await collect(
      dispatcher(h)(line({ id: 'a', action: 'logs.stream', service: 'jellyfin', tail: 10 })),
    );
    expect(replies).toEqual([
      { id: 'a', chunk: { line: 'one' } },
      { id: 'a', chunk: { line: 'two' } },
      { id: 'a', end: true },
    ]);
  });
});

describe('socket server', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  const socketPath = () => {
    const unique = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    return process.platform === 'win32'
      ? `\\\\.\\pipe\\selfhost-test-${unique}`
      : path.join(os.tmpdir(), `selfhost-test-${unique}.sock`);
  };

  async function start(maxLineBytes?: number) {
    const server = createAgentServer(dispatcher(), maxLineBytes);
    servers.push(server);
    const address = socketPath();
    await new Promise<void>((resolve) => server.listen(address, resolve));
    return address;
  }

  const exchange = (address: string, payload: string, expectedLines: number) =>
    new Promise<AgentResponse[]>((resolve, reject) => {
      const client = net.connect(address);
      let received = '';
      client.setEncoding('utf8');
      client.on('error', reject);
      client.on('data', (data: string) => {
        received += data;
        const lines = received.split('\n').filter(Boolean);
        if (lines.length >= expectedLines) {
          client.destroy();
          resolve(lines.map((l) => JSON.parse(l) as AgentResponse));
        }
      });
      client.write(payload);
    });

  it('answers several requests on one connection', async () => {
    const address = await start();
    const replies = await exchange(
      address,
      line({ id: 'a', action: 'agent.version' }) +
        '\n' +
        line({ id: 'b', action: 'service.status', service: 'jellyfin' }) +
        '\nnot json\n',
      3,
    );
    const byId = (id: string | null) => replies.find((r) => r.id === id);
    expect(byId('a')).toMatchObject({ ok: true });
    expect(byId('b')).toMatchObject({ ok: true, data: { state: 'running' } });
    expect(byId(null)).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
  });

  it('handles a request split across packets', async () => {
    const address = await start();
    const client = net.connect(address);
    const text = line({ id: 'a', action: 'agent.version' }) + '\n';
    const reply = new Promise<string>((resolve) => client.once('data', (d) => resolve(String(d))));
    client.write(text.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.write(text.slice(10));
    expect(JSON.parse(await reply)).toMatchObject({ id: 'a', ok: true });
    client.destroy();
  });

  it('closes the connection on an oversized request', async () => {
    const address = await start(100);
    const [reply] = await exchange(address, 'x'.repeat(500), 1);
    expect(reply).toMatchObject({ ok: false, error: { code: 'request_too_large' } });
  });
});
