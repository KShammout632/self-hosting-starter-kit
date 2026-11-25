import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentResponse } from '@selfhost/shared';
import { createConfirmTokens } from './confirm';
import { createDispatcher } from './dispatch';
import { dryRunStreamer } from './exec';
import { handlers, type Deps } from './handlers';
import { DEFAULT_PATHS, type HostFs } from './host';
import pkg from '../package.json' with { type: 'json' };

const NEXT = '9.9.9';
const TARBALL = `selfhost-kit-${NEXT}-linux-x64.tar.gz`;
const STAGE = `/opt/selfhost/releases/${NEXT}`;
const HASH = 'a'.repeat(64);

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (data: string) => sign(null, Buffer.from(data), privateKey).toString('base64') + '\n',
  };
}
const KEY = makeKey();
const OTHER_KEY = makeKey();

interface Options {
  checksum?: string;
  signature?: 'good' | 'missing' | 'garbage' | 'other key' | 'for another file';
  releaseKey?: string;
  insideVersion?: string;
  failCommand?: string;
  rebootRequired?: boolean;
  releaseBase?: string;
}

function makeHost(options: Options = {}) {
  const files = new Map<string, string>();
  const commands: { file: string; args: readonly string[]; env?: Record<string, string> }[] = [];
  if (options.rebootRequired) files.set('/var/run/reboot-required', '*** System restart required');

  const fs: HostFs = {
    async ensureDir(path) {
      if (path.endsWith('/bundle')) {
        files.set(`${path}/VERSION`, `${options.insideVersion ?? NEXT}\n`);
        files.set(`${path}/apply-update.sh`, '#!/bin/bash');
      }
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async removeDir(path) {
      for (const key of [...files.keys()]) if (key.startsWith(path + '/')) files.delete(key);
    },
    async exists(path) {
      return files.has(path);
    },
    async gidOf() {
      return null;
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async removeFile(path) {
      files.delete(path);
    },
    async listDir() {
      return [];
    },
    async setOwner() {},
    async realPath(path) {
      return path;
    },
  };

  const deps: Deps = {
    dryRun: false,
    docker: { listServiceContainers: async () => [] },
    run: async (file, args, runOptions) => {
      commands.push({ file, args, env: runOptions?.env as Record<string, string> | undefined });
      if (options.failCommand === file) throw new Error('failed');
      if (file === 'curl') {
        const destination = args[args.indexOf('--output') + 1]!;
        const checksum = options.checksum ?? `${HASH}  ${TARBALL}\n`;
        if (destination.endsWith('.sha256')) files.set(destination, checksum);
        if (destination.endsWith('.sig')) {
          const kind = options.signature ?? 'good';
          if (kind === 'good') files.set(destination, KEY.sign(checksum));
          if (kind === 'garbage') files.set(destination, 'not a signature\n');
          if (kind === 'other key') files.set(destination, OTHER_KEY.sign(checksum));
          if (kind === 'for another file') files.set(destination, KEY.sign(`${HASH}  x\n`));
        }
      }
      if (file === 'sha256sum') return `${HASH}  ${args[0]}\n`;
      if (file === 'apt-get' && args.includes('--simulate')) {
        return [
          'Inst a [1] (2 Ubuntu:24.04/noble-security [amd64])',
          'Inst b [1] (2 Ubuntu:24.04/noble-updates [amd64])',
          '',
        ].join('\n');
      }
      return '';
    },
    paths: DEFAULT_PATHS,
    fs,
    stream: dryRunStreamer,
    httpCheck: async () => true,
    confirmTokens: createConfirmTokens(),
    releaseKey: options.releaseKey ?? KEY.publicKey,
    ...(options.releaseBase ? { releaseBase: options.releaseBase } : {}),
  };
  return { deps, commands, files, dispatch: createDispatcher({ handlers, deps, log: () => {} }) };
}

async function ask(host: ReturnType<typeof makeHost>, request: object) {
  const out: AgentResponse[] = [];
  for await (const message of host.dispatch(JSON.stringify({ id: 'a', ...request }))) {
    out.push(message);
  }
  return out[0]!;
}

describe('system updates', () => {
  it('counts waiting updates and security updates, and reports a pending reboot', async () => {
    const host = makeHost({ rebootRequired: true });
    const reply = await ask(host, { action: 'system.updates.check' });
    expect(reply).toMatchObject({
      ok: true,
      data: { packages: 2, security: 1, rebootRequired: true },
    });
  });

  it('only asks apt for new package lists when told to', async () => {
    const quick = makeHost();
    await ask(quick, { action: 'system.updates.check' });
    expect(quick.commands.some((c) => c.args.includes('update'))).toBe(false);

    const fresh = makeHost();
    await ask(fresh, { action: 'system.updates.check', refresh: true });
    expect(fresh.commands[0]!.args).toContain('update');
  });

  it('upgrades without ever waiting for an answer to a config file question', async () => {
    const host = makeHost();
    const reply = await ask(host, { action: 'system.updates.apply' });
    expect(reply).toMatchObject({ ok: true, data: { upgraded: 2, rebootRequired: false } });

    const upgrade = host.commands.find(
      (c) => c.file === 'apt-get' && c.args.includes('upgrade') && !c.args.includes('--simulate'),
    )!;
    expect(upgrade.args).toContain('Dpkg::Options::=--force-confold');
    expect(upgrade.args).toContain('--yes');
    expect(upgrade.env).toMatchObject({ DEBIAN_FRONTEND: 'noninteractive' });
  });

  it('reports a failed upgrade in plain words', async () => {
    const host = makeHost();
    host.deps.run = async (file, args) => {
      if (file === 'apt-get' && args.includes('--yes')) throw new Error('dpkg exploded');
      return '';
    };
    const reply = await ask(host, { action: 'system.updates.apply' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(JSON.stringify(reply)).not.toContain('dpkg');
  });
});

describe('reboot', () => {
  it('needs a confirm token', async () => {
    const host = makeHost();
    const reply = await ask(host, { action: 'system.reboot' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'confirm_required' } });
    expect(host.commands).toEqual([]);
  });

  it('reboots after a few seconds once confirmed, and the token works only once', async () => {
    const host = makeHost();
    const issued = await ask(host, {
      action: 'confirm.issue',
      kind: 'system.reboot',
      target: 'server',
    });
    const token = (issued as { data: { token: string } }).data.token;

    expect(await ask(host, { action: 'system.reboot', confirm: token })).toMatchObject({
      ok: true,
    });
    const command = host.commands[0]!;
    expect(command.file).toBe('systemd-run');
    expect(command.args).toContain('--on-active=5');
    expect(command.args.slice(-2)).toEqual(['/usr/bin/systemctl', 'reboot']);

    expect(await ask(host, { action: 'system.reboot', confirm: token })).toMatchObject({
      ok: false,
      error: { code: 'confirm_required' },
    });
  });

  it('refuses a reboot token issued for something else', async () => {
    const host = makeHost();
    const reply = await ask(host, {
      action: 'confirm.issue',
      kind: 'system.reboot',
      target: 'sdb',
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('kit.update', () => {
  it('downloads, checks, unpacks and starts the update as its own unit', async () => {
    const host = makeHost();
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: true, data: { started: true, version: NEXT } });

    const curls = host.commands.filter((c) => c.file === 'curl');
    expect(curls.map((c) => c.args.at(-1))).toEqual([
      `https://github.com/KShammout632/self-hosting-starter-kit/releases/download/v${NEXT}/${TARBALL}`,
      `https://github.com/KShammout632/self-hosting-starter-kit/releases/download/v${NEXT}/${TARBALL}.sha256`,
      `https://github.com/KShammout632/self-hosting-starter-kit/releases/download/v${NEXT}/${TARBALL}.sha256.sig`,
    ]);
    expect(curls[0]!.args).toEqual(expect.arrayContaining(['--proto', '=https']));

    const start = host.commands.at(-1)!;
    expect(start.file).toBe('systemd-run');
    expect(start.args).toEqual([
      '--unit=selfhost-kit-update',
      '--collect',
      '--quiet',
      '/bin/bash',
      `${STAGE}/bundle/apply-update.sh`,
      `${STAGE}/bundle`,
      NEXT,
    ]);
    expect(host.files.get('/var/lib/selfhost/kit-update.json')).toContain('"running"');
  });

  it('uses the test release address only when the agent was given one', async () => {
    const host = makeHost({ releaseBase: 'http://127.0.0.1:9000' });
    await ask(host, { action: 'kit.update', version: NEXT });
    const curl = host.commands.find((c) => c.file === 'curl')!;
    expect(curl.args.at(-1)).toBe(`http://127.0.0.1:9000/v${NEXT}/${TARBALL}`);
    expect(curl.args).toEqual(expect.arrayContaining(['--proto', '=http']));
  });

  it('cannot be given an address in the request', async () => {
    const host = makeHost();
    const reply = await ask(host, {
      action: 'kit.update',
      version: NEXT,
      url: 'http://127.0.0.1:9000',
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(host.commands).toEqual([]);
  });

  it('does not install a download whose checksum does not match', async () => {
    const host = makeHost({ checksum: `${'b'.repeat(64)}  ${TARBALL}\n` });
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(host.commands.some((c) => c.file === 'tar' || c.file === 'systemd-run')).toBe(false);
  });

  it('does not install a checksum file that names a different file', async () => {
    const host = makeHost({ checksum: `${HASH}  other.tar.gz\n` });
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(host.commands.some((c) => c.file === 'systemd-run')).toBe(false);
  });

  it.each(['missing', 'garbage', 'other key', 'for another file'] as const)(
    'does not install a release whose signature is %s',
    async (signature) => {
      const host = makeHost({ signature });
      const reply = await ask(host, { action: 'kit.update', version: NEXT });
      expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
      expect(host.commands.some((c) => c.file === 'tar' || c.file === 'systemd-run')).toBe(false);
      expect(host.files.has(`${STAGE}/${TARBALL}.sha256`)).toBe(false);
    },
  );

  it('refuses to update at all when the build has no signing key', async () => {
    const host = makeHost({ releaseKey: '' });
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(host.commands).toEqual([]);
  });

  it('does not install a release that contains a different version', async () => {
    const host = makeHost({ insideVersion: '9.9.8' });
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(host.commands.some((c) => c.file === 'systemd-run')).toBe(false);
  });

  it('refuses the same or an older version', async () => {
    const host = makeHost();
    for (const version of [pkg.version, '0.0.1']) {
      const reply = await ask(host, { action: 'kit.update', version });
      expect(reply).toMatchObject({ ok: false, error: { code: 'refused' } });
    }
    expect(host.commands).toEqual([]);
  });

  it('refuses while another update is still running', async () => {
    const host = makeHost();
    host.files.set(
      '/var/lib/selfhost/kit-update.json',
      JSON.stringify({
        state: 'running',
        version: NEXT,
        message: 'Installing',
        at: new Date().toISOString(),
      }),
    );
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  it('reports a failed start and records it', async () => {
    const host = makeHost({ failCommand: 'systemd-run' });
    const reply = await ask(host, { action: 'kit.update', version: NEXT });
    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(host.files.get('/var/lib/selfhost/kit-update.json')).toContain('"failed"');
  });
});

describe('server-wide changes and the lock', () => {
  async function runWhileBusy(blocker: object, request: object) {
    const host = makeHost();
    host.files.set('/opt/selfhost/services/jellyfin/compose.yml', 'x');
    let release = () => {};
    host.deps.run = (file) =>
      file === 'docker'
        ? new Promise<string>((resolve) => {
            release = () => resolve('');
          })
        : Promise.resolve('');
    const running = host.dispatch(JSON.stringify({ id: 'b', ...blocker })).next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = await ask(host, request);
    release();
    await running;
    return reply;
  }

  it('does not apply system updates while a service is being changed', async () => {
    const reply = await runWhileBusy(
      { action: 'service.start', service: 'jellyfin' },
      { action: 'system.updates.apply' },
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  it('does not start a kit update while a service is being changed', async () => {
    const reply = await runWhileBusy(
      { action: 'service.start', service: 'jellyfin' },
      { action: 'kit.update', version: NEXT },
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  it('does not change a service while system updates run', async () => {
    const host = makeHost();
    let release = () => {};
    let held = false;
    host.deps.run = (file) => {
      if (file !== 'apt-get' || held) return Promise.resolve('');
      held = true;
      return new Promise<string>((resolve) => {
        release = () => resolve('');
      });
    };
    const running = host
      .dispatch(JSON.stringify({ id: 'b', action: 'system.updates.apply' }))
      .next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = await ask(host, { action: 'service.start', service: 'jellyfin' });
    release();
    await running;
    expect(reply).toMatchObject({ ok: false, error: { code: 'busy' } });
  });
});
