import type { Handlers } from './handlers';
import {
  assignFolder,
  diskSmart,
  folderUsage,
  formatDisk,
  listDisks,
  listMissing,
  mountVolume,
  unmountVolume,
} from './storage';

export const storageHandlers: Handlers = {
  async 'disk.list'(_request, deps) {
    const disks = await listDisks(deps);
    return { data: { disks, missing: await listMissing(deps, disks) } };
  },

  async 'disk.mount'(request, deps) {
    await mountVolume(deps, request.uuid, request.label);
    return { data: {} };
  },

  async 'disk.unmount'(request, deps) {
    await unmountVolume(deps, request.uuid);
    return { data: {} };
  },

  async 'disk.format'(request, deps) {
    return { data: await formatDisk(deps, request.device, request.diskId, request.label) };
  },

  async 'disk.smart'(request, deps) {
    return { data: await diskSmart(deps, request.uuid) };
  },

  async 'folder.assign'(request, deps) {
    await assignFolder(deps, request.folder, request.uuid, request.subpath, request.copyExisting);
    return { data: {} };
  },

  async 'folder.usage'(request, deps) {
    return { data: await folderUsage(deps, request.folder) };
  },
};
