import type { ServiceName } from '@selfhost/shared';
import immich from '../immich/compose.yml.tmpl';
import jellyfin from '../jellyfin/compose.yml.tmpl';
import navidrome from '../navidrome/compose.yml.tmpl';
import nextcloud from '../nextcloud/compose.yml.tmpl';

const templates: Record<ServiceName, string> = { jellyfin, navidrome, immich, nextcloud };

export function loadComposeTemplate(name: ServiceName): string {
  const template = templates[name];
  if (template === undefined) throw new Error(`No compose template for ${name}`);
  return template;
}
