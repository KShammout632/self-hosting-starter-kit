import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

describe('kit version', () => {
  it('is the same in the agent package and install.sh', () => {
    const script = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8');
    const match = /^KIT_VERSION="(.+)"$/m.exec(script);
    expect(match?.[1]).toBe(pkg.version);
  });
});
