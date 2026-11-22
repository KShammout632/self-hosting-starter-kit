import { LIBRARY_FOLDER_PATHS } from '@selfhost/shared';
import type { ServiceManifest } from './manifest';
import { imageVars, renderTemplate, type TemplateVars } from './render';
import { loadComposeTemplate } from './templates';

export interface ComposeContext {
  puid: number;
  pgid: number;
  tz: string;
  configDir: string;
  renderGid: number | null;
}

// Renders a service's compose file. Library folders become <FOLDER>_DIR variables, for example
// movies -> MOVIES_DIR and home-videos -> HOME_VIDEOS_DIR.
export function renderCompose(manifest: ServiceManifest, context: ComposeContext): string {
  const gpu = manifest.gpu.intel && context.renderGid !== null;
  const vars: TemplateVars = {
    ...imageVars(manifest),
    PUID: context.puid,
    PGID: context.pgid,
    TZ: context.tz,
    LAN_PORT: manifest.ports.lan,
    CONFIG_DIR: context.configDir,
    GPU: gpu,
  };
  if (gpu) vars.RENDER_GID = context.renderGid!;
  for (const { folder } of manifest.libraryFolders) {
    vars[`${folder.toUpperCase().replaceAll('-', '_')}_DIR`] = LIBRARY_FOLDER_PATHS[folder];
  }
  return renderTemplate(loadComposeTemplate(manifest.name), vars);
}
