import { serviceManifest } from '../src/manifest';

export const navidromeManifest = serviceManifest.parse({
  name: 'navidrome',
  displayName: 'Navidrome',
  description: 'Stream your music collection to your phone or browser.',
  version: '0.64.2',
  releaseNotesUrl: 'https://github.com/navidrome/navidrome/releases',
  ports: { lan: 4533, remote: 4534 },
  images: [
    {
      container: 'navidrome',
      repository: 'deluan/navidrome',
      tag: '0.64.2',
      digest: 'sha256:38dc2727bfcfd5ede290f8ada114fc90368146f265ae4701ddddbcbe2a44ee52',
    },
  ],
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
