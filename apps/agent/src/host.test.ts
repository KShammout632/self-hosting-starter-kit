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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realFs } from './host';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'selfhost-host-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Windows only allows symlinks with Developer Mode or as an administrator. CI runs on Ubuntu.
function canSymlink(): boolean {
  const probe = path.join(dir, 'probe');
  try {
    symlinkSync(path.join(dir, 'nowhere'), probe);
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

describe('realFs.writeFile', () => {
  it('writes the content and leaves no temporary file behind', async () => {
    const file = path.join(dir, 'status.json');
    await realFs.writeFile(file, 'one\n', 0o644);
    await realFs.writeFile(file, 'two\n', 0o644);
    expect(readFileSync(file, 'utf8')).toBe('two\n');
    expect(readdirSync(dir)).toEqual(['status.json']);
  });

  it('does not write through a symlink planted at the old temporary name', async (context) => {
    if (!canSymlink()) context.skip();
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'untouched');
    const file = path.join(dir, 'status.json');
    symlinkSync(victim, `${file}.tmp`);
    await realFs.writeFile(file, 'new', 0o644);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('replaces a symlink at the final name instead of writing through it', async (context) => {
    if (!canSymlink()) context.skip();
    const victim = path.join(dir, 'victim');
    writeFileSync(victim, 'untouched');
    const file = path.join(dir, 'status.json');
    symlinkSync(victim, file);
    await realFs.writeFile(file, 'new', 0o644);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });
});

describe('realFs.realPath', () => {
  it('returns null for a path that does not exist', async () => {
    expect(await realFs.realPath(path.join(dir, 'missing'))).toBeNull();
  });

  it('resolves a symlinked folder to where it points', async (context) => {
    if (!canSymlink()) context.skip();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'selfhost-elsewhere-'));
    try {
      symlinkSync(elsewhere, path.join(dir, 'link'), 'dir');
      expect(await realFs.realPath(path.join(dir, 'link'))).toBe(await realFs.realPath(elsewhere));
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
