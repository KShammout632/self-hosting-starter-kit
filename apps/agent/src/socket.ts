import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function findGroupId(group: string, groupFile = '/etc/group'): number | null {
  for (const line of fs.readFileSync(groupFile, 'utf8').split('\n')) {
    const [name, , gid] = line.split(':');
    if (name === group && gid !== undefined) return Number(gid);
  }
  return null;
}

const listen = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

// Listens on a Unix socket owned root:<group> with mode 0660. Pass group null to skip the chown (dev).
export async function listenOnSocket(
  server: net.Server,
  socketPath: string,
  group: string | null,
): Promise<void> {
  // Windows uses named pipes, which have no file permissions. Only used for local development.
  if (process.platform === 'win32') return listen(server, socketPath);

  const gid = group === null ? null : findGroupId(group);
  if (group !== null && gid === null) {
    throw new Error(`Group "${group}" does not exist. Run the installer first.`);
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  fs.rmSync(socketPath, { force: true });

  // The mask is applied when the socket is created, so it is never briefly more open than 0660.
  const previousMask = process.umask(0o117);
  try {
    await listen(server, socketPath);
  } finally {
    process.umask(previousMask);
  }

  fs.chmodSync(socketPath, 0o660);
  if (gid !== null) fs.chownSync(socketPath, 0, gid);
}
