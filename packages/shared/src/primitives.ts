import { z } from 'zod';

export const SERVICE_NAMES = ['jellyfin', 'navidrome', 'immich', 'nextcloud'] as const;
export const serviceName = z.enum(SERVICE_NAMES);
export type ServiceName = z.infer<typeof serviceName>;

export const LIBRARY_FOLDERS = [
  'movies',
  'tv',
  'home-videos',
  'music',
  'photos',
  'nextcloud',
] as const;
export const libraryFolder = z.enum(LIBRARY_FOLDERS);
export type LibraryFolder = z.infer<typeof libraryFolder>;

export const LIBRARY_FOLDER_PATHS: Record<LibraryFolder, string> = {
  movies: '/srv/media/movies',
  tv: '/srv/media/tv',
  'home-videos': '/srv/media/home-videos',
  music: '/srv/media/music',
  photos: '/srv/photos',
  nextcloud: '/srv/nextcloud',
};

export const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// Filesystem UUIDs are not always RFC 4122: ext4 uses one, NTFS uses 16 hex digits, exFAT uses "ABCD-1234".
export const filesystemUuid = z.string().regex(/^[A-Za-z0-9-]{4,40}$/);

// Becomes /mnt/<label> and a systemd unit name, so keep it to a safe subset.
export const volumeLabel = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const tailscaleHostname = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

// Relative folder on a volume. Every segment starts with a letter or digit, so "." and ".." cannot appear.
export const folderSubpath = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}){0,3}$/);

export const CONFIRM_KINDS = ['service.uninstall', 'disk.format'] as const;
export const confirmKind = z.enum(CONFIRM_KINDS);
export type ConfirmKind = z.infer<typeof confirmKind>;
// A service name or a filesystem UUID, checked against the kind by the agent.
export const confirmTarget = z.string().regex(/^[A-Za-z0-9-]{2,40}$/);

export const confirmToken = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

// Snapshot ids are UTC timestamps, for example 20261122T093000Z.
export const snapshotId = z.string().regex(/^\d{8}T\d{6}Z$/);

export const kitVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);

export const logTail = z.number().int().min(1).max(5000);
