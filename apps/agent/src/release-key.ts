import { createPublicKey, verify } from 'node:crypto';

// The Ed25519 public key that signs releases: base64 of the DER (SPKI) form, as printed by
// scripts/new-release-key.sh. install.sh holds the same value; a unit test checks they match.
// Empty means no key has been made yet, and then nothing can be installed or updated.
export const RELEASE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAMaipbJAreKa3ZSIx9zLx3/N4aE7BNaN0k6Hcb5FmKJY=';

export const RELEASE_KEY_PATTERN = /^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

export function signatureMatches(key: string, data: string, signature: string): boolean {
  const trimmed = signature.trim();
  if (!RELEASE_KEY_PATTERN.test(key) || !SIGNATURE_PATTERN.test(trimmed)) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(data, 'utf8'), publicKey, Buffer.from(trimmed, 'base64'));
  } catch {
    return false;
  }
}
