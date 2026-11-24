import { parseArgs } from 'node:util';

export interface Config {
  dryRun: boolean;
  socketPath: string;
  releaseBase: string | null;
}

export const DEFAULT_SOCKET_PATH = '/run/selfhost/agent.sock';

// Lets the install tests serve a release from this machine. Only a loopback address is accepted, and
// only in a dry run or a test build, so a real agent always downloads from GitHub.
const LOOPBACK_BASE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv, testBuild = false): Config {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, socket: { type: 'string' } },
    strict: true,
  });
  const dryRun = values['dry-run'] ?? env.SELFHOST_DRY_RUN === '1';
  const requested = env.SELFHOST_RELEASE_BASE;
  const allowed = (dryRun || testBuild) && requested !== undefined && LOOPBACK_BASE.test(requested);
  return {
    dryRun,
    socketPath: values.socket ?? env.SELFHOST_AGENT_SOCKET ?? DEFAULT_SOCKET_PATH,
    releaseBase: allowed ? requested : null,
  };
}
