import { serviceManifest } from '../src/manifest';

export const jellyfinManifest = serviceManifest.parse({
  name: 'jellyfin',
  displayName: 'Jellyfin',
  description: 'Stream your movies, shows and home videos to any device.',
  version: '12.4',
  releaseNotesUrl: 'https://github.com/jellyfin/jellyfin/releases',
  ports: { lan: 8096, remote: 8920 },
  images: [
    {
      container: 'jellyfin',
      repository: 'jellyfin/jellyfin',
      tag: '12.4',
      digest: 'sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771',
    },
  ],
  libraryFolders: [
    { folder: 'movies', access: 'ro' },
    { folder: 'tv', access: 'ro' },
    { folder: 'home-videos', access: 'ro' },
  ],
  configDirs: ['config', 'cache'],
  snapshot: { skipDirs: ['cache'] },
  health: { path: '/health' },
  gpu: { intel: true },
  firstLoginTips: [
    'Open Jellyfin and create your admin account.',
    'Add libraries: Movies is /media/movies, Shows is /media/tv, Home videos is /media/home-videos.',
  ],
});
