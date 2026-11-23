import { serviceManifest } from '../src/manifest';

const NEXTCLOUD_TAG = '35.0.3-apache';

export const nextcloudManifest = serviceManifest.parse({
  name: 'nextcloud',
  displayName: 'Nextcloud',
  description: 'Keep your files in sync across your devices, with calendars and contacts.',
  ports: { lan: 8081, remote: 8444 },
  images: [
    { container: 'app', repository: 'nextcloud', tag: NEXTCLOUD_TAG },
    { container: 'database', repository: 'postgres', tag: '16.16-alpine' },
    { container: 'redis', repository: 'redis', tag: '8.8.4-alpine' },
  ],
  libraryFolders: [{ folder: 'nextcloud', access: 'rw' }],
  libraryOwnerUid: 33,
  configDirs: ['html', 'db', 'redis'],
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
