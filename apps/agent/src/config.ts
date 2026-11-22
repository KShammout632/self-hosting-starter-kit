import { parseArgs } from 'node:util';

export interface Config {
  dryRun: boolean;
  socketPath: string;
}

export const DEFAULT_SOCKET_PATH = '/run/selfhost/agent.sock';

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, socket: { type: 'string' } },
    strict: true,
  });
  return {
    dryRun: values['dry-run'] ?? env.SELFHOST_DRY_RUN === '1',
    socketPath: values.socket ?? env.SELFHOST_AGENT_SOCKET ?? DEFAULT_SOCKET_PATH,
  };
}
