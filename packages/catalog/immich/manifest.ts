import { serviceManifest } from '../src/manifest';

// Versions follow the official release compose file for this Immich release. Immich ships
// breaking changes often, so move all of them together and run the install gate first.
const IMMICH_VERSION = 'v3.4.2';

export const immichManifest = serviceManifest.parse({
  name: 'immich',
  displayName: 'Immich',
  description: 'Back up and browse your photos and videos, with search and face recognition.',
  ports: { lan: 2283, remote: 2284 },
  images: [
    {
      container: 'immich-server',
      repository: 'ghcr.io/immich-app/immich-server',
      tag: IMMICH_VERSION,
    },
    {
      container: 'immich-machine-learning',
      repository: 'ghcr.io/immich-app/immich-machine-learning',
      tag: IMMICH_VERSION,
    },
    { container: 'redis', repository: 'docker.io/valkey/valkey', tag: '9.0.8-alpine' },
    {
      container: 'database',
      repository: 'ghcr.io/immich-app/postgres',
      tag: '14-vectorchord0.4.3-pgvectors0.2.0',
    },
  ],
  libraryFolders: [{ folder: 'photos', access: 'rw' }],
  configDirs: ['db', 'ml-cache', 'redis'],
  secrets: [{ name: 'DB_PASSWORD', aliases: ['POSTGRES_PASSWORD'] }],
  health: { path: '/api/server/ping', expect: 'pong' },
  gpu: { intel: true, imageSuffix: '-openvino' },
  firstLoginTips: [
    'Open Immich and create your admin account. The first account you make becomes the admin.',
    'Install the Immich app on your phone and turn on backup to start sending your photos.',
    'The first scan of a large library can take a long time while the server works through your photos.',
  ],
});
