import {
  chmod,
  chown,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

export interface Paths {
  servicesDir: string;
  configDir: string;
  backupsDir: string;
  renderDevice: string;
  unitDir: string;
  mountRoot: string;
}

export const DEFAULT_PATHS: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  backupsDir: '/opt/selfhost/backups',
  renderDevice: '/dev/dri/renderD128',
  unitDir: '/etc/systemd/system',
  mountRoot: '/mnt',
};

export interface Owner {
  uid: number;
  gid: number;
}

export interface HostFs {
  ensureDir(path: string, owner?: Owner): Promise<void>;
  writeFile(path: string, content: string, mode: number): Promise<void>;
  removeDir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  gidOf(path: string): Promise<number | null>;
  readFile(path: string): Promise<string | null>;
  removeFile(path: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  setOwner(path: string, owner: Owner, mode: number): Promise<void>;
}

export const realFs: HostFs = {
  async ensureDir(path, owner) {
    await mkdir(path, { recursive: true });
    if (owner) await chown(path, owner.uid, owner.gid);
  },
  async writeFile(path, content, mode) {
    // Write then rename, so a crash never leaves a half-written compose file behind.
    const temp = `${path}.tmp`;
    await writeFile(temp, content, { mode });
    await rename(temp, path);
  },
  async removeDir(path) {
    await rm(path, { recursive: true, force: true });
  },
  async exists(path) {
    return stat(path).then(
      () => true,
      () => false,
    );
  },
  async gidOf(path) {
    return stat(path).then(
      (info) => info.gid,
      () => null,
    );
  },
  async readFile(path) {
    return readFile(path, 'utf8').catch(() => null);
  },
  async removeFile(path) {
    await rm(path, { force: true });
  },
  async listDir(path) {
    return readdir(path).catch(() => []);
  },
  async setOwner(path, owner, mode) {
    await chown(path, owner.uid, owner.gid);
    await chmod(path, mode);
  },
};

export const dryRunFs: HostFs = {
  async ensureDir(path) {
    console.error(JSON.stringify({ event: 'dry-run', would: ['mkdir', path] }));
  },
  async writeFile(path) {
    console.error(JSON.stringify({ event: 'dry-run', would: ['write', path] }));
  },
  async removeDir(path) {
    console.error(JSON.stringify({ event: 'dry-run', would: ['remove', path] }));
  },
  async exists() {
    return true;
  },
  async gidOf() {
    return null;
  },
  async readFile() {
    return null;
  },
  async removeFile(path) {
    console.error(JSON.stringify({ event: 'dry-run', would: ['remove', path] }));
  },
  async listDir() {
    return [];
  },
  async setOwner(path) {
    console.error(JSON.stringify({ event: 'dry-run', would: ['chown', path] }));
  },
};
