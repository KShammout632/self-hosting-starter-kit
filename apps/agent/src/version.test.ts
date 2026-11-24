import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { RELEASE_PUBLIC_KEY } from './release-key';

const script = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8');
const setting = (name: string) => new RegExp(`^${name}="(.*)"$`, 'm').exec(script)?.[1];

describe('install.sh', () => {
  it('has the same kit version as the agent package', () => {
    expect(setting('KIT_VERSION')).toBe(pkg.version);
  });

  it('has the same release signing key as the agent', () => {
    expect(setting('RELEASE_PUBLIC_KEY')).toBe(RELEASE_PUBLIC_KEY);
  });

  it('pins the Node download by its checksum', () => {
    expect(setting('NODE_SHA256')).toMatch(/^[0-9a-f]{64}$/);
  });
});
