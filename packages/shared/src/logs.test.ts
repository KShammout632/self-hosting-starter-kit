import { describe, expect, it } from 'vitest';
import { hintsForLines, isErrorLine } from './logs';

describe('isErrorLine', () => {
  it('flags error, fatal and exception lines', () => {
    expect(isErrorLine('[ERR] Failed to open database')).toBe(true);
    expect(isErrorLine('FATAL: password authentication failed')).toBe(true);
    expect(isErrorLine('System.IO.IOException: Exception thrown')).toBe(true);
    expect(isErrorLine('container exited with code 137')).toBe(true);
  });

  it('leaves normal lines alone', () => {
    expect(isErrorLine('[INF] Server startup complete')).toBe(false);
    expect(isErrorLine('Scanned 0 errors')).toBe(false);
    expect(isErrorLine('exited with code 0')).toBe(false);
  });
});

describe('hintsForLines', () => {
  it('maps known problems to plain-English hints, once each', () => {
    const hints = hintsForLines([
      'mkdir: Permission denied on /srv/media/movies',
      'open /srv/media/tv: permission denied',
      'write failed: No space left on device',
    ]);
    expect(hints).toHaveLength(2);
    expect(hints.join(' ')).toMatch(/not allowed/);
    expect(hints.join(' ')).toMatch(/disk is full/);
  });

  it('returns nothing when no rule matches', () => {
    expect(hintsForLines(['all good'])).toEqual([]);
  });
});
