import { serviceManifest } from '../src/manifest';

const NEXTCLOUD_TAG = '35.0.3-apache';

export const nextcloudManifest = serviceManifest.parse({
  name: 'nextcloud',
  displayName: 'Nextcloud',
  description: 'Keep your files in sync across your devices, with calendars and contacts.',
  version: '35.0.3',
  releaseNotesUrl: 'https://github.com/nextcloud/server/releases',
  ports: { lan: 8081, remote: 8444 },
  images: [
    {
      container: 'app',
      repository: 'nextcloud',
      tag: NEXTCLOUD_TAG,
      digest: 'sha256:f22d1dd63844bd15bbf6c2019149653c3d1c775ba48b173b56c3c6ad5f386196',
    },
    {
      container: 'database',
      repository: 'postgres',
      tag: '16.16-alpine',
      digest: 'sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d',
    },
    {
      container: 'redis',
      repository: 'redis',
      tag: '8.8.4-alpine',
      digest: 'sha256:1273af45b299d2b8b60d0e400d90aa6c2c5b1794f01d6a7ca60ff3ba6e65efb5',
    },
  ],
  libraryFolders: [{ folder: 'nextcloud', access: 'rw' }],
  libraryOwnerUid: 33,
  configDirs: ['html', 'db', 'redis'],
  snapshot: {
    skipDirs: ['db', 'redis'],
    database: { container: 'database', user: 'nextcloud', name: 'nextcloud', dataDir: 'db' },
  },
  secrets: [{ name: 'POSTGRES_PASSWORD' }, { name: 'NEXTCLOUD_ADMIN_PASSWORD' }],
  credentials: [
    { label: 'Admin user name', value: 'admin' },
    { label: 'Admin password', secret: 'NEXTCLOUD_ADMIN_PASSWORD' },
  ],
  health: { path: '/status.php', expect: '"installed":true' },
  gpu: { intel: false },
  firstLoginTips: [
    'Sign in with the admin user name and password shown on this page. The password is shown only once, so write it down.',
    'The first start takes a few minutes while Nextcloud sets itself up.',
    'Install the Nextcloud app on your phone and sign in with the address of this server.',
  ],
});
