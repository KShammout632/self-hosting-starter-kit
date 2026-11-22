import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LIBRARY_FOLDER_PATHS } from '@selfhost/shared';
import {
  catalog,
  getManifest,
  imageVars,
  loadComposeTemplate,
  renderTemplate,
  serviceManifest,
} from './index';

const jellyfinVars = {
  PUID: 1001,
  PGID: 1001,
  TZ: 'Europe/Berlin',
  LAN_PORT: 8096,
  CONFIG_DIR: '/opt/selfhost/config/jellyfin',
  MOVIES_DIR: LIBRARY_FOLDER_PATHS.movies,
  TV_DIR: LIBRARY_FOLDER_PATHS.tv,
  HOME_VIDEOS_DIR: LIBRARY_FOLDER_PATHS['home-videos'],
  RENDER_GID: 105,
};

describe('catalog', () => {
  it('has valid manifests with unique ports', () => {
    const ports = catalog.flatMap((m) => [m.ports.lan, m.ports.remote]);
    expect(new Set(ports).size).toBe(ports.length);
    for (const manifest of catalog) expect(serviceManifest.safeParse(manifest).success).toBe(true);
  });

  it('rejects floating image tags', () => {
    const jellyfin = getManifest('jellyfin')!;
    const floating = { ...jellyfin, images: [{ ...jellyfin.images[0]!, tag: 'latest' }] };
    expect(serviceManifest.safeParse(floating).success).toBe(false);
  });
});

describe('jellyfin template', () => {
  const manifest = getManifest('jellyfin')!;
  const template = loadComposeTemplate('jellyfin');
  const vars = { ...imageVars(manifest), ...jellyfinVars };

  it('renders valid compose YAML from the manifest pin', () => {
    const compose = parse(renderTemplate(template, { ...vars, GPU: false }));
    const service = compose.services.jellyfin;
    expect(service.image).toBe('jellyfin/jellyfin:12.4');
    expect(service.user).toBe('1001:1001');
    expect(service.ports).toEqual(['8096:8096']);
    expect(service.devices).toBeUndefined();
  });

  it('adds GPU devices only when asked', () => {
    const compose = parse(renderTemplate(template, { ...vars, GPU: true }));
    expect(compose.services.jellyfin.devices).toEqual(['/dev/dri:/dev/dri']);
    expect(compose.services.jellyfin.group_add).toEqual(['105']);
  });

  it('mounts media folders read-only', () => {
    const compose = parse(renderTemplate(template, { ...vars, GPU: false }));
    const media = compose.services.jellyfin.volumes.filter((v: string) => v.includes('/media/'));
    expect(media).toHaveLength(3);
    for (const volume of media) expect(volume.endsWith(':ro')).toBe(true);
  });
});

describe('renderTemplate', () => {
  it('fails on missing variables', () => {
    expect(() => renderTemplate('a: {{X}}', {})).toThrow('Missing template variable X');
  });

  it('refuses values that could inject YAML', () => {
    expect(() => renderTemplate('a: {{X}}', { X: 'ok\nevil: true' })).toThrow('unsafe');
    expect(() => renderTemplate('a: {{X}}', { X: '$(id)' })).toThrow('unsafe');
  });

  it('refuses unsupported syntax', () => {
    expect(() => renderTemplate('a: {{ X }}', { X: '1' })).toThrow('unsupported');
    expect(() => renderTemplate('a: {{lower}}', {})).toThrow('unsupported');
  });

  it('requires flags to be booleans', () => {
    expect(() => renderTemplate('{{#if F}}\nx\n{{/if}}\n', { F: 'yes' })).toThrow('boolean');
  });
});
