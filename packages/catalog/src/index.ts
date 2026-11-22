import type { ServiceName } from '@selfhost/shared';
import { jellyfinManifest } from '../jellyfin/manifest';
import type { ServiceManifest } from './manifest';

export * from './compose';
export * from './manifest';
export * from './render';
export { loadComposeTemplate } from './templates';

// Services not listed here are not in the catalog yet (Navidrome, Immich and Nextcloud arrive in M4).
export const catalog: readonly ServiceManifest[] = [jellyfinManifest];

export function getManifest(name: ServiceName): ServiceManifest | undefined {
  return catalog.find((manifest) => manifest.name === name);
}
