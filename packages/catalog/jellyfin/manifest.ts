import { serviceManifest } from '../src/manifest';

export const jellyfinManifest = serviceManifest.parse({
  name: 'jellyfin',
  displayName: 'Jellyfin',
  description: 'Stream your movies, shows and home videos to any device.',
  ports: { lan: 8096, remote: 8920 },
  images: [{ container: 'jellyfin', repository: 'jellyfin/jellyfin', tag: '10.10.7' }],
  libraryFolders: [
    { folder: 'movies', access: 'ro' },
    { folder: 'tv', access: 'ro' },
    { folder: 'home-videos', access: 'ro' },
  ],
  health: { path: '/health' },
  gpu: { intel: true },
  firstLoginTips: [
    'Open Jellyfin and create your admin account.',
    'Add libraries: Movies is /media/movies, Shows is /media/tv, Home videos is /media/home-videos.',
  ],
});
