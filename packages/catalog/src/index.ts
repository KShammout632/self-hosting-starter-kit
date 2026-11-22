import { readFileSync } from 'node:fs';
import type { ServiceName } from '@selfhost/shared';
import { jellyfinManifest } from '../jellyfin/manifest';
import type { ServiceManifest } from './manifest';

export * from './manifest';
export * from './render';

// Services not listed here are not in the catalog yet (Navidrome, Immich and Nextcloud arrive in M4).
export const catalog: readonly ServiceManifest[] = [jellyfinManifest];

export function getManifest(name: ServiceName): ServiceManifest | undefined {
  return catalog.find((manifest) => manifest.name === name);
}

// Reads from disk next to the source. How the agent bundle ships templates is decided in M1.
export function loadComposeTemplate(name: ServiceName): string {
  return readFileSync(new URL(`../${name}/compose.yml.tmpl`, import.meta.url), 'utf8');
}
