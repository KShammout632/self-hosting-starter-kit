import { randomBytes } from 'node:crypto';
import type { ConfirmKind } from '@selfhost/shared';

export const CONFIRM_TTL_MS = 5 * 60_000;
const MAX_TOKENS = 200;

export interface ConfirmTokens {
  issue(kind: ConfirmKind, target: string): string;
  verify(token: string, kind: ConfirmKind, target: string): boolean;
  consume(token: string): void;
}

// Tokens live only in memory: an agent restart cancels any confirmation in progress, which is safe.
export function createConfirmTokens(now: () => number = Date.now): ConfirmTokens {
  const tokens = new Map<string, { kind: ConfirmKind; target: string; expires: number }>();

  const prune = () => {
    for (const [token, entry] of tokens) if (entry.expires <= now()) tokens.delete(token);
  };

  return {
    issue(kind, target) {
      prune();
      if (tokens.size >= MAX_TOKENS) {
        const oldest = tokens.keys().next().value;
        if (oldest !== undefined) tokens.delete(oldest);
      }
      const token = randomBytes(32).toString('base64url');
      tokens.set(token, { kind, target, expires: now() + CONFIRM_TTL_MS });
      return token;
    },
    verify(token, kind, target) {
      const entry = tokens.get(token);
      return (
        entry !== undefined &&
        entry.expires > now() &&
        entry.kind === kind &&
        entry.target === target
      );
    },
    consume(token) {
      tokens.delete(token);
    },
  };
}
