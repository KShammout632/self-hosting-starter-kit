import { chown, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';

export interface Paths {
  servicesDir: string;
  configDir: string;
  renderDevice: string;
}

export const DEFAULT_PATHS: Paths = {
  servicesDir: '/opt/selfhost/services',
  configDir: '/opt/selfhost/config',
  renderDevice: '/dev/dri/renderD128',
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
};
