import type { ServiceName } from '@selfhost/shared';
import jellyfin from '../jellyfin/compose.yml.tmpl';

const templates: Partial<Record<ServiceName, string>> = { jellyfin };

export function loadComposeTemplate(name: ServiceName): string {
  const template = templates[name];
  if (template === undefined) throw new Error(`No compose template for ${name}`);
  return template;
}
