import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCS, KIT_VERSION } from './docs';

const installer = readFileSync(new URL('../../../../install.sh', import.meta.url), 'utf8');

describe('docs links', () => {
  it('point at the tag of the kit version, like the installer does', () => {
    expect(KIT_VERSION).toBe(/^KIT_VERSION="(.*)"$/m.exec(installer)?.[1]);
    expect(DOCS.userGuide).toBe(
      `https://github.com/KShammout632/self-hosting-starting-kit/blob/v${KIT_VERSION}/docs/user-guide.md`,
    );
    expect(installer).toContain(
      'HELP_URL="https://github.com/${REPO}/blob/v${KIT_VERSION}/docs/troubleshooting.md"',
    );
  });
});
