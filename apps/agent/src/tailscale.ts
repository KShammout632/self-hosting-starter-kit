import { catalog } from '@selfhost/catalog';
import type { TailscaleServeResult, TailscaleStatusResult } from '@selfhost/shared';
import { AgentError } from './errors';
import type { Deps, Handlers } from './handlers';

const DASHBOARD_PORT = 8080;
const NEXTCLOUD_CONTAINER = 'selfhost-nextcloud';
const SAFE_DNS_NAME = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SECONDS = 1000;

interface RawStatus {
  BackendState?: string;
  AuthURL?: string;
  Self?: { HostName?: string; DNSName?: string };
  CurrentTailnet?: { MagicDNSEnabled?: boolean };
  CertDomains?: string[] | null;
}

const NOT_INSTALLED: TailscaleStatusResult = {
  installed: false,
  backendState: null,
  hostname: null,
  dnsName: null,
  authUrl: null,
  magicDnsEnabled: false,
  httpsEnabled: false,
};

function parseStatus(stdout: string): TailscaleStatusResult {
  const status = JSON.parse(stdout) as RawStatus;
  const authUrl = status.AuthURL?.startsWith('https://') ? status.AuthURL : null;
  return {
    installed: true,
    backendState: status.BackendState ?? null,
    hostname: status.Self?.HostName ?? null,
    dnsName: status.Self?.DNSName?.replace(/\.$/, '') || null,
    authUrl,
    magicDnsEnabled: status.CurrentTailnet?.MagicDNSEnabled === true,
    httpsEnabled: (status.CertDomains ?? []).length > 0,
  };
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Some Tailscale versions exit non-zero for "status --json" while signed out but still print the JSON.
export async function readStatus(deps: Deps): Promise<TailscaleStatusResult> {
  try {
    return parseStatus(await deps.run('tailscale', ['status', '--json']));
  } catch (error) {
    if (isMissing(error)) return NOT_INSTALLED;
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
      try {
        return parseStatus(stdout);
      } catch {
        throw new AgentError('failed', 'Tailscale did not respond.');
      }
    }
    throw new AgentError('failed', 'Tailscale did not respond.');
  }
}

function requireInstalled(status: TailscaleStatusResult): void {
  if (!status.installed) {
    throw new AgentError('not_installed', 'Tailscale is not installed on this server.');
  }
}

const composeExists = (deps: Deps, service: string) =>
  deps.fs.exists(`${deps.paths.servicesDir}/${service}/compose.yml`);

export const remoteUrl = (dnsName: string, port: number | null) =>
  port === null ? `https://${dnsName}` : `https://${dnsName}:${port}`;

// Nextcloud reads its trusted domains from the environment only on its first start, so a tailnet
// name that appears later has to be added through occ. Best effort: Nextcloud may still be starting.
async function trustTailnetName(deps: Deps, dnsName: string): Promise<void> {
  if (!SAFE_DNS_NAME.test(dnsName) || !(await composeExists(deps, 'nextcloud'))) return;
  const occ = (args: string[]) =>
    deps.run('docker', ['exec', '--user', 'www-data', NEXTCLOUD_CONTAINER, 'php', 'occ', ...args]);
  try {
    const listed = (await occ(['config:system:get', 'trusted_domains']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (listed.includes(dnsName)) return;
    await occ([
      'config:system:set',
      'trusted_domains',
      String(listed.length),
      `--value=${dnsName}`,
    ]);
  } catch {
    // The first start already includes the name when Tailscale was connected before the install.
  }
}

export const tailscaleHandlers: Handlers = {
  async 'tailscale.status'(_request, deps) {
    return { data: await readStatus(deps) };
  },

  // "tailscale up" waits for the owner to sign in, so it is given a short timeout. The sign-in
  // address stays available from the status afterwards, and the dashboard keeps asking for it.
  async 'tailscale.login'(request, deps) {
    const before = await readStatus(deps);
    requireInstalled(before);
    if (before.backendState === 'Running') return { data: before };
    try {
      await deps.run(
        'tailscale',
        ['up', `--hostname=${request.hostname}`, '--reset', '--timeout=8s'],
        { timeoutMs: 20 * SECONDS },
      );
    } catch (error) {
      if (isMissing(error)) throw new AgentError('not_installed', 'Tailscale is not installed.');
      // A timeout is expected while the owner has not signed in yet.
    }
    return { data: await readStatus(deps) };
  },

  async 'tailscale.logout'(_request, deps) {
    const before = await readStatus(deps);
    requireInstalled(before);
    await deps.run('tailscale', ['serve', 'reset']).catch(() => undefined);
    try {
      await deps.run('tailscale', ['logout']);
    } catch {
      // Signing out of a server that is not signed in fails, which is already the goal.
      if (before.backendState === 'Running') {
        throw new AgentError('failed', 'Could not sign out of Tailscale.');
      }
    }
    return { data: await readStatus(deps) };
  },

  // Safe to run any time: installed services are published, removed ones are unpublished.
  async 'tailscale.serve.apply'(_request, deps) {
    const status = await readStatus(deps);
    requireInstalled(status);
    if (status.backendState !== 'Running' || !status.dnsName) {
      throw new AgentError('refused', 'Sign in to Tailscale first.');
    }
    if (!status.magicDnsEnabled || !status.httpsEnabled) {
      throw new AgentError(
        'refused',
        'Turn on MagicDNS and HTTPS certificates in the Tailscale admin console first.',
      );
    }

    const publish = async (httpsPort: number, localPort: number) => {
      try {
        await deps.run('tailscale', [
          'serve',
          '--bg',
          `--https=${httpsPort}`,
          `http://127.0.0.1:${localPort}`,
        ]);
      } catch {
        throw new AgentError('failed', 'Tailscale could not publish an address.');
      }
    };

    const urls: TailscaleServeResult['urls'] = [];
    await publish(443, DASHBOARD_PORT);
    urls.push({ target: 'dashboard', url: remoteUrl(status.dnsName, null) });
    for (const manifest of catalog) {
      if (await composeExists(deps, manifest.name)) {
        await publish(manifest.ports.remote, manifest.ports.lan);
        urls.push({
          target: manifest.name,
          url: remoteUrl(status.dnsName, manifest.ports.remote),
        });
      } else {
        await deps
          .run('tailscale', ['serve', `--https=${manifest.ports.remote}`, 'off'])
          .catch(() => undefined);
      }
    }
    await trustTailnetName(deps, status.dnsName);
    const data: TailscaleServeResult = { urls };
    return { data };
  },
};
