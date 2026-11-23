import { serviceManifest } from '../src/manifest';

export const navidromeManifest = serviceManifest.parse({
  name: 'navidrome',
  displayName: 'Navidrome',
  description: 'Stream your music collection to your phone or browser.',
  ports: { lan: 4533, remote: 4534 },
  images: [{ container: 'navidrome', repository: 'deluan/navidrome', tag: '0.64.2' }],
  libraryFolders: [{ folder: 'music', access: 'ro' }],
  configDirs: ['data'],
  health: { path: '/ping' },
  gpu: { intel: false },
  firstLoginTips: [
    'Open Navidrome and create your admin account. The first account you make becomes the admin.',
    'Your music is found automatically in /music. New files appear within an hour.',
    'For your phone, use any Subsonic app such as Symfonium, Substreamer or play:Sub.',
  ],
});
