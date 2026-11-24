const PARTS = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

// Returns a negative number when a is older than b, zero when equal, positive when newer.
export function compareVersions(a: string, b: string): number {
  const left = PARTS.exec(a);
  const right = PARTS.exec(b);
  if (!left || !right) throw new Error('Not a version like 1.2.3.');
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Accepts "v1.2.3" or "1.2.3" and returns "1.2.3", or null for anything else (pre-releases, junk).
export function parseReleaseTag(tag: string): string | null {
  const match = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(tag);
  return match ? match[1]! : null;
}
