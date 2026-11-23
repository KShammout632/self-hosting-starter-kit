import type { ServiceName } from '@selfhost/shared';
import { immichManifest } from '../immich/manifest';
import { jellyfinManifest } from '../jellyfin/manifest';
import { navidromeManifest } from '../navidrome/manifest';
import { nextcloudManifest } from '../nextcloud/manifest';
import type { ServiceManifest } from './manifest';

export * from './compose';
export * from './manifest';
export * from './render';
export { loadComposeTemplate } from './templates';

export const catalog: readonly ServiceManifest[] = [
  jellyfinManifest,
  navidromeManifest,
  immichManifest,
  nextcloudManifest,
];

export function getManifest(name: ServiceName): ServiceManifest | undefined {
  return catalog.find((manifest) => manifest.name === name);
}
