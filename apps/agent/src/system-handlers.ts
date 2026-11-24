import {
  KIT_UPDATE_STATUS_FILE,
  compareVersions,
  kitUpdateStatus,
  type KitUpdateResult,
  type SystemUpdatesApplyResult,
  type SystemUpdatesCheckResult,
} from '@selfhost/shared';
import pkg from '../package.json' with { type: 'json' };
import { AgentError } from './errors';
import { RELEASE_PUBLIC_KEY, signatureMatches } from './release-key';
import type { Deps, Handlers } from './handlers';

export const RELEASE_REPO = 'KShammout632/self-hosting-starting-kit';
const RELEASES_DIR = '/opt/selfhost/releases';
const REBOOT_REQUIRED_FILE = '/var/run/reboot-required';
const UPDATE_UNIT = 'selfhost-kit-update';
const MINUTE = 60_000;
const STALE_UPDATE_MS = 30 * MINUTE;
const MAX_DOWNLOAD_BYTES = 300_000_000;

// A config-file question from a package would wait forever for an answer nobody can give.
const APT_ENV = {
  DEBIAN_FRONTEND: 'noninteractive',
  NEEDRESTART_MODE: 'l',
  APT_LISTCHANGES_FRONTEND: 'none',
} as const;
const APT_LOCK_WAIT = ['-o', 'DPkg::Lock::Timeout=120'] as const;

function countUpgrades(simulation: string): { packages: number; security: number } {
  const lines = simulation.split('\n').filter((line) => line.startsWith('Inst '));
  return { packages: lines.length, security: lines.filter((l) => l.includes('-security')).length };
}

async function aptGetUpdate(deps: Deps): Promise<void> {
  try {
    await deps.run('apt-get', ['--quiet=2', ...APT_LOCK_WAIT, 'update'], {
      timeoutMs: 5 * MINUTE,
      env: APT_ENV,
    });
  } catch {
    throw new AgentError(
      'failed',
      'Could not look for updates. Check that the server is online and try again.',
    );
  }
}

async function simulateUpgrade(deps: Deps) {
  const output = await deps.run('apt-get', ['--simulate', '--quiet=2', 'upgrade'], {
    timeoutMs: 2 * MINUTE,
    maxBufferBytes: 8 * 1024 * 1024,
    env: APT_ENV,
  });
  return countUpgrades(output);
}

async function rebootRequired(deps: Deps): Promise<boolean> {
  return deps.fs.exists(REBOOT_REQUIRED_FILE);
}

async function readUpdateStatus(deps: Deps) {
  const text = await deps.fs.readFile(KIT_UPDATE_STATUS_FILE);
  if (text === null) return null;
  try {
    const parsed = kitUpdateStatus.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function statusJson(state: 'running' | 'failed', version: string, message: string): string {
  return JSON.stringify({ state, version, message, at: new Date().toISOString() }) + '\n';
}

function downloadArgs(deps: Deps, url: string, destination: string): string[] {
  const local = deps.releaseBase !== undefined;
  return [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--proto',
    local ? '=http' : '=https',
    '--proto-redir',
    '=https',
    '--max-filesize',
    String(MAX_DOWNLOAD_BYTES),
    '--max-time',
    '600',
    '--output',
    destination,
    url,
  ];
}

export const systemHandlers: Handlers = {
  async 'system.updates.check'(request, deps) {
    if (request.refresh) await aptGetUpdate(deps);
    const { packages, security } = await simulateUpgrade(deps).catch(() => {
      throw new AgentError('failed', 'Could not work out which updates are waiting.');
    });
    const data: SystemUpdatesCheckResult = {
      packages,
      security,
      rebootRequired: await rebootRequired(deps),
    };
    return { data };
  },

  async 'system.updates.apply'(_request, deps) {
    await aptGetUpdate(deps);
    const { packages } = await simulateUpgrade(deps).catch(() => ({ packages: 0 }));
    try {
      await deps.run(
        'apt-get',
        [
          '--yes',
          '--quiet=2',
          ...APT_LOCK_WAIT,
          '-o',
          'Dpkg::Options::=--force-confdef',
          '-o',
          'Dpkg::Options::=--force-confold',
          'upgrade',
        ],
        { timeoutMs: 45 * MINUTE, maxBufferBytes: 8 * 1024 * 1024, env: APT_ENV },
      );
    } catch {
      throw new AgentError(
        'failed',
        'The updates did not finish. Nothing is lost; try again in a few minutes.',
      );
    }
    const data: SystemUpdatesApplyResult = {
      upgraded: packages,
      rebootRequired: await rebootRequired(deps),
    };
    return { data };
  },

  async 'system.reboot'(_request, deps) {
    // Delayed a few seconds so the reply gets back before the machine goes down.
    await deps.run('systemd-run', [
      '--on-active=5',
      '--unit=selfhost-reboot',
      '--collect',
      '--quiet',
      '/usr/bin/systemctl',
      'reboot',
    ]);
    return { data: {} };
  },

  async 'kit.update'(request, deps) {
    const { version } = request;
    if (compareVersions(version, pkg.version) <= 0) {
      throw new AgentError(
        'refused',
        version === pkg.version
          ? 'The kit is already on that version.'
          : 'Going back to an older version is not supported.',
      );
    }

    const releaseKey = deps.releaseKey ?? RELEASE_PUBLIC_KEY;
    if (!deps.dryRun && releaseKey === '') {
      throw new AgentError(
        'refused',
        'This version of the kit cannot check downloads, so it cannot update itself.',
      );
    }

    const previous = await readUpdateStatus(deps);
    if (previous?.state === 'running' && Date.now() - Date.parse(previous.at) < STALE_UPDATE_MS) {
      throw new AgentError('busy', 'An update is already in progress.');
    }

    const name = `selfhost-kit-${version}-linux-x64.tar.gz`;
    const base = deps.releaseBase ?? `https://github.com/${RELEASE_REPO}/releases/download`;
    const stage = `${RELEASES_DIR}/${version}`;
    const bundle = `${stage}/bundle`;

    await deps.fs.removeDir(stage);
    await deps.fs.ensureDir(bundle);
    try {
      for (const file of [name, `${name}.sha256`, `${name}.sha256.sig`]) {
        await deps.run(
          'curl',
          downloadArgs(deps, `${base}/v${version}/${file}`, `${stage}/${file}`),
          {
            timeoutMs: 11 * MINUTE,
          },
        );
      }
    } catch {
      await deps.fs.removeDir(stage);
      throw new AgentError('failed', 'Could not download that version. Try again later.');
    }

    if (!deps.dryRun) {
      // The checksum file is trusted only once its signature checks out: the release that serves the
      // tarball also serves the checksum, so on its own the checksum only catches a broken download.
      const checksumFile = (await deps.fs.readFile(`${stage}/${name}.sha256`)) ?? '';
      const signature = (await deps.fs.readFile(`${stage}/${name}.sha256.sig`)) ?? '';
      const signed = signatureMatches(releaseKey, checksumFile, signature);
      const expected = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/m.exec(checksumFile);
      const actual = signed
        ? (await deps.run('sha256sum', [`${stage}/${name}`])).split(/\s+/)[0]
        : undefined;
      if (!signed || !expected || expected[2] !== name || expected[1] !== actual) {
        await deps.fs.removeDir(stage);
        throw new AgentError(
          'failed',
          'The download failed its safety check, so it was not installed.',
        );
      }
    }

    await deps.run('tar', [
      '--extract',
      '--gzip',
      '--no-same-owner',
      '--file',
      `${stage}/${name}`,
      '--directory',
      bundle,
    ]);

    if (!deps.dryRun) {
      const inside = (await deps.fs.readFile(`${bundle}/VERSION`))?.trim();
      if (inside !== version || !(await deps.fs.exists(`${bundle}/apply-update.sh`))) {
        await deps.fs.removeDir(stage);
        throw new AgentError('failed', 'That download is not the version it says it is.');
      }
    }

    await deps.fs.writeFile(
      KIT_UPDATE_STATUS_FILE,
      statusJson('running', version, 'Starting the update.'),
      0o644,
    );
    try {
      await deps.run('systemd-run', [
        `--unit=${UPDATE_UNIT}`,
        '--collect',
        '--quiet',
        '/bin/bash',
        `${bundle}/apply-update.sh`,
        bundle,
        version,
      ]);
    } catch {
      await deps.fs.writeFile(
        KIT_UPDATE_STATUS_FILE,
        statusJson('failed', version, 'The update could not be started.'),
        0o644,
      );
      throw new AgentError('busy', 'The update could not be started. Is one already running?');
    }

    const data: KitUpdateResult = { started: true, version };
    return { data };
  },
};
