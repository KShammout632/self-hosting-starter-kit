import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<string>;

// The only way the agent starts a process: fixed file, fixed argument array, no shell.
export const run: Runner = async (file, args, options = {}) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};

const DRY_RUN_FIXTURES: Record<string, string> = {
  tailscale: JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'selfhost-dev', DNSName: 'selfhost-dev.example.ts.net.' },
  }),
  docker: 'selfhost-jellyfin-1  | 2026-11-22T09:30:00.000000000Z dry-run log line\n',
  id: '1001\n',
};

export const dryRunRunner: Runner = async (file, args) => {
  console.error(JSON.stringify({ event: 'dry-run', would: [file, ...args] }));
  const fixture = DRY_RUN_FIXTURES[file];
  if (fixture === undefined) throw new Error(`dry-run: no fixture for ${file}`);
  return fixture;
};
