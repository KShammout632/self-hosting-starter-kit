import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Runner = (file: string, args: readonly string[]) => Promise<string>;

// The only way the agent starts a process: fixed file, fixed argument array, no shell.
export const run: Runner = async (file, args) => {
  const { stdout } = await execFileAsync(file, [...args], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};

const DRY_RUN_FIXTURES: Record<string, string> = {
  tailscale: JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'selfhost-dev', DNSName: 'selfhost-dev.example.ts.net.' },
  }),
};

// In dry-run mode nothing is executed; known commands return canned output.
export const dryRunRunner: Runner = async (file, args) => {
  console.error(JSON.stringify({ event: 'dry-run', would: [file, ...args] }));
  const fixture = DRY_RUN_FIXTURES[file];
  if (fixture === undefined) throw new Error(`dry-run: no fixture for ${file}`);
  return fixture;
};
