import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@selfhost/shared';
import { createConfirmTokens } from './confirm';
import { createDispatcher } from './dispatch';
import { dryRunStreamer } from './exec';
import { handlers, type Deps } from './handlers';
import type { HostFs, Paths } from './host';

const paths: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  backupsDir: '/opt/selfhost/backups',
  renderDevice: '/dev/dri/renderD128',
  unitDir: '/etc/systemd/system',
  mountRoot: '/mnt',
};

const RUNNING = {
  BackendState: 'Running',
  Self: { HostName: 'box', DNSName: 'box.tail1234.ts.net.' },
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: ['box.tail1234.ts.net'],
};

interface Options {
  status?: object | (() => object);
  installed?: string[];
  failOn?: (args: readonly string[]) => boolean;
  trusted?: string[];
}

function setup(options: Options = {}) {
  const commands: string[][] = [];
  const trusted = options.trusted ?? ['localhost'];
  const installed = new Set(options.installed ?? []);
  const fs = {
    exists: async (path: string) =>
      [...installed].some((name) => path === `${paths.servicesDir}/${name}/compose.yml`),
  } as unknown as HostFs;

  const run: Deps['run'] = async (file, args) => {
    commands.push([file, ...args]);
    if (file === 'docker') {
      if (args.includes('config:system:get')) return trusted.join('\n') + '\n';
      return '';
    }
    if (file !== 'tailscale') throw new Error(`unexpected command ${file}`);
    if (options.failOn?.(args)) throw new Error('boom');
    if (args[0] === 'status') {
      const status = options.status ?? RUNNING;
      return JSON.stringify(typeof status === 'function' ? status() : status);
    }
    return '';
  };

  const deps = {
    dryRun: false,
    run,
    fs,
    paths,
    stream: dryRunStreamer,
    confirmTokens: createConfirmTokens(),
  } as unknown as Deps;
  return { deps, commands };
}

async function ask(deps: Deps, request: Record<string, unknown>): Promise<AgentResponse> {
  const dispatch = createDispatcher({ handlers, deps, log: () => {} });
  const out: AgentResponse[] = [];
  for await (const message of dispatch(JSON.stringify({ id: 'r1', ...request }))) out.push(message);
  return out[0]!;
}

describe('tailscale.status', () => {
  it('reports readiness from MagicDNS and certificate domains', async () => {
    const ready = await ask(setup().deps, { action: 'tailscale.status' });
    expect(ready).toMatchObject({
      ok: true,
      data: { dnsName: 'box.tail1234.ts.net', magicDnsEnabled: true, httpsEnabled: true },
    });

    const notReady = await ask(
      setup({ status: { ...RUNNING, CurrentTailnet: {}, CertDomains: null } }).deps,
      { action: 'tailscale.status' },
    );
    expect(notReady).toMatchObject({
      data: { magicDnsEnabled: false, httpsEnabled: false },
    });
  });

  it('returns the sign-in address only when it is an https address', async () => {
    const waiting = { BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' };
    expect(
      await ask(setup({ status: waiting }).deps, { action: 'tailscale.status' }),
    ).toMatchObject({ data: { authUrl: 'https://login.tailscale.com/a/abc' } });
    const odd = { BackendState: 'NeedsLogin', AuthURL: 'javascript:alert(1)' };
    expect(await ask(setup({ status: odd }).deps, { action: 'tailscale.status' })).toMatchObject({
      data: { authUrl: null },
    });
  });
});

describe('tailscale.login', () => {
  it('starts the sign-in with a fixed argument list and returns the address', async () => {
    let signedIn = false;
    const host = setup({
      status: () =>
        signedIn
          ? { BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/xyz' }
          : { BackendState: 'NeedsLogin' },
      failOn: (args) => {
        if (args[0] === 'up') signedIn = true;
        return args[0] === 'up';
      },
    });
    const reply = await ask(host.deps, { action: 'tailscale.login', hostname: 'my-server' });
    expect(reply).toMatchObject({
      ok: true,
      data: { authUrl: 'https://login.tailscale.com/a/xyz' },
    });
    expect(host.commands).toContainEqual([
      'tailscale',
      'up',
      '--hostname=my-server',
      '--reset',
      '--timeout=8s',
    ]);
  });

  it('does nothing when the server is already signed in', async () => {
    const host = setup();
    expect(await ask(host.deps, { action: 'tailscale.login', hostname: 'box' })).toMatchObject({
      ok: true,
    });
    expect(host.commands.some((c) => c[1] === 'up')).toBe(false);
  });

  it('rejects a hostname that is not a plain name', async () => {
    const reply = await ask(setup().deps, {
      action: 'tailscale.login',
      hostname: 'x --authkey=tskey',
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('tailscale.logout', () => {
  it('removes the published addresses and signs out', async () => {
    const host = setup();
    await ask(host.deps, { action: 'tailscale.logout' });
    expect(host.commands.slice(1)).toEqual([
      ['tailscale', 'serve', 'reset'],
      ['tailscale', 'logout'],
      ['tailscale', 'status', '--json'],
    ]);
  });
});

describe('tailscale.logout when not signed in', () => {
  it('succeeds without failing on the sign out', async () => {
    const host = setup({
      status: { BackendState: 'NeedsLogin' },
      failOn: (args) => args[0] === 'logout',
    });
    expect(await ask(host.deps, { action: 'tailscale.logout' })).toMatchObject({ ok: true });
  });

  it('reports a failed sign out of a signed in server', async () => {
    const host = setup({ failOn: (args) => args[0] === 'logout' });
    expect(await ask(host.deps, { action: 'tailscale.logout' })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
  });
});

describe('tailscale.serve.apply', () => {
  it('publishes the dashboard and each installed service, and removes the others', async () => {
    const host = setup({ installed: ['jellyfin', 'nextcloud'] });
    const reply = await ask(host.deps, { action: 'tailscale.serve.apply' });
    expect(reply).toMatchObject({
      ok: true,
      data: {
        urls: [
          { target: 'dashboard', url: 'https://box.tail1234.ts.net' },
          { target: 'jellyfin', url: 'https://box.tail1234.ts.net:8920' },
          { target: 'nextcloud', url: 'https://box.tail1234.ts.net:8444' },
        ],
      },
    });
    const serve = host.commands.filter((c) => c[1] === 'serve').map((c) => c.slice(2).join(' '));
    expect(serve).toEqual([
      '--bg --https=443 http://127.0.0.1:8080',
      '--bg --https=8920 http://127.0.0.1:8096',
      '--https=4534 off',
      '--https=2284 off',
      '--bg --https=8444 http://127.0.0.1:8081',
    ]);
  });

  it('adds the tailnet name to Nextcloud once, without a shell', async () => {
    const host = setup({ installed: ['nextcloud'] });
    await ask(host.deps, { action: 'tailscale.serve.apply' });
    expect(host.commands).toContainEqual([
      'docker',
      'exec',
      '--user',
      'www-data',
      'selfhost-nextcloud',
      'php',
      'occ',
      'config:system:set',
      'trusted_domains',
      '1',
      '--value=box.tail1234.ts.net',
    ]);

    const again = setup({
      installed: ['nextcloud'],
      trusted: ['localhost', 'box.tail1234.ts.net'],
    });
    await ask(again.deps, { action: 'tailscale.serve.apply' });
    expect(again.commands.some((c) => c.includes('config:system:set'))).toBe(false);
  });

  it('does not touch Nextcloud when it is not installed', async () => {
    const host = setup({ installed: ['jellyfin'] });
    await ask(host.deps, { action: 'tailscale.serve.apply' });
    expect(host.commands.some((c) => c[0] === 'docker')).toBe(false);
  });

  it('refuses until the server is signed in and both Tailscale settings are on', async () => {
    const signedOut = await ask(setup({ status: { BackendState: 'NeedsLogin' } }).deps, {
      action: 'tailscale.serve.apply',
    });
    expect(signedOut).toMatchObject({ ok: false, error: { code: 'refused' } });

    const noHttps = await ask(setup({ status: { ...RUNNING, CertDomains: [] } }).deps, {
      action: 'tailscale.serve.apply',
    });
    expect(noHttps).toMatchObject({
      ok: false,
      error: { code: 'refused', message: expect.stringContaining('HTTPS') },
    });
  });

  it('reports a failed publish in plain words', async () => {
    const host = setup({ failOn: (args) => args[0] === 'serve' });
    expect(await ask(host.deps, { action: 'tailscale.serve.apply' })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
  });

  it('runs one Tailscale change at a time', async () => {
    const host = setup();
    const dispatch = createDispatcher({ handlers, deps: host.deps, log: () => {} });
    const first = dispatch(JSON.stringify({ id: 'a', action: 'tailscale.serve.apply' }));
    const pending = first.next();
    const second = await dispatch(JSON.stringify({ id: 'b', action: 'tailscale.logout' })).next();
    expect(second.value).toMatchObject({ ok: false, error: { code: 'busy' } });
    await pending;
  });
});
