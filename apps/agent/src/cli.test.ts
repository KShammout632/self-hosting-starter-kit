import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type ReplaceFileSafely = (
  file: string,
  content: string,
  uid: number,
  gid: number,
  mode: number,
) => void;

// A computed specifier, so the type checker does not look for types for the plain JavaScript file.
const cliUrl = pathToFileURL(path.resolve(__dirname, '../../../deploy/selfhost-cli.mjs')).href;
const { replaceFileSafely } = (await import(cliUrl)) as { replaceFileSafely: ReplaceFileSafely };

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'selfhost-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function canSymlink(): boolean {
  try {
    symlinkSync(path.join(dir, 'nowhere'), path.join(dir, 'probe'));
    rmSync(path.join(dir, 'probe'));
    return true;
  } catch {
    return false;
  }
}

describe('selfhost reset-password writes the setup code safely', () => {
  it('writes the file and leaves nothing else behind', () => {
    const file = path.join(dir, 'setup-code');
    replaceFileSafely(file, 'hash\n', uid, gid, 0o640);
    expect(readFileSync(file, 'utf8')).toBe('hash\n');
    expect(readdirSync(dir)).toEqual(['setup-code']);
  });

  it('replaces a symlink at the setup code path instead of writing through it', (context) => {
    if (!canSymlink()) context.skip();
    const victim = path.join(dir, 'passwd');
    writeFileSync(victim, 'root:x:0:0');
    const file = path.join(dir, 'setup-code');
    symlinkSync(victim, file);
    replaceFileSafely(file, 'hash\n', uid, gid, 0o640);
    expect(readFileSync(victim, 'utf8')).toBe('root:x:0:0');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
  });

  it('does not create the target of a dangling symlink', (context) => {
    if (!canSymlink()) context.skip();
    const target = path.join(dir, 'created-by-root');
    const file = path.join(dir, 'setup-code');
    symlinkSync(target, file);
    replaceFileSafely(file, 'hash\n', uid, gid, 0o640);
    expect(() => lstatSync(target)).toThrow();
  });
});
