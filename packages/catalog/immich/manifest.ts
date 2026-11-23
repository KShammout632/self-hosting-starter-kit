import { serviceManifest } from '../src/manifest';

// Versions follow the official release compose file for this Immich release. Immich ships
// breaking changes often, so move all of them together and run the install gate first.
const IMMICH_VERSION = 'v3.4.2';

export const immichManifest = serviceManifest.parse({
  name: 'immich',
  displayName: 'Immich',
  description: 'Back up and browse your photos and videos, with search and face recognition.',
  version: IMMICH_VERSION,
  releaseNotesUrl: 'https://github.com/immich-app/immich/releases',
  ports: { lan: 2283, remote: 2284 },
  images: [
    {
      container: 'immich-server',
      repository: 'ghcr.io/immich-app/immich-server',
      tag: IMMICH_VERSION,
      digest: 'sha256:fc880c1bf665b4aab1e74c15e56ab871225989cd546536e6b77e771869af06bd',
    },
    {
      container: 'immich-machine-learning',
      repository: 'ghcr.io/immich-app/immich-machine-learning',
      tag: IMMICH_VERSION,
      digest: 'sha256:739405742a79bd7447227c553bb62ed5491aa36acf00bc667af7f9c93b6fae91',
      gpuVariant: true,
    },
    {
      container: 'redis',
      repository: 'docker.io/valkey/valkey',
      tag: '9.0.8-alpine',
      digest: 'sha256:139d21c97b1a956e42e29b1e4ede4752a6ff52d1a0db9ef0ff4954a570f23976',
    },
    {
      container: 'database',
      repository: 'ghcr.io/immich-app/postgres',
      tag: '14-vectorchord0.4.3-pgvectors0.2.0',
      digest: 'sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23',
    },
  ],
  libraryFolders: [{ folder: 'photos', access: 'rw' }],
  configDirs: ['db', 'ml-cache', 'redis'],
  snapshot: {
    skipDirs: ['db', 'ml-cache', 'redis'],
    database: { container: 'database', user: 'immich', name: 'immich', dataDir: 'db' },
  },
  secrets: [{ name: 'DB_PASSWORD', aliases: ['POSTGRES_PASSWORD'] }],
  health: { path: '/api/server/ping', expect: 'pong' },
  gpu: { intel: true, imageSuffix: '-openvino' },
  firstLoginTips: [
    'Open Immich and create your admin account. The first account you make becomes the admin.',
    'Install the Immich app on your phone and turn on backup to start sending your photos.',
    'The first scan of a large library can take a long time while the server works through your photos.',
  ],
});
