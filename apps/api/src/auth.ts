import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { hash, verify } from '@node-rs/argon2';
import type { Db } from './db';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const REAUTH_AFTER_MS = 15 * 60_000;
export const MAX_FAILURES = 10;
export const LOCKOUT_MS = 15 * 60_000;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// Setup codes are shown as ABCD-EFGH. Ignore case, dashes and spaces when comparing.
export const normalizeSetupCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

export interface SessionRow {
  csrfToken: string;
  lastAuthAt: number;
}

export interface Auth {
  hasAdmin(): boolean;
  setupAvailable(): boolean;
  lockedForSeconds(): number;
  // Each check counts a wrong answer toward the lockout and clears the count on success.
  checkSetupCode(code: string): boolean;
  checkPassword(password: string): Promise<boolean>;
  setPassword(password: string): Promise<void>;
  finishSetup(): void;
  wizardComplete(): boolean;
  completeWizard(): void;
  createSession(): { token: string; csrfToken: string };
  getSession(token: string | undefined): SessionRow | null;
  touchAuth(token: string): void;
  deleteSession(token: string): void;
}

export function createAuth(options: { db: Db; setupCodeFile: string; now?: () => number }): Auth {
  const { db, setupCodeFile } = options;
  const now = options.now ?? Date.now;

  const getState = () =>
    db
      .prepare('SELECT failures, locked_until AS lockedUntil FROM auth_state WHERE id = 1')
      .get() as { failures: number; lockedUntil: number };
  const setState = db.prepare('UPDATE auth_state SET failures = ?, locked_until = ? WHERE id = 1');

  const recordFailure = () => {
    const state = getState();
    const failures = state.failures + 1;
    if (failures >= MAX_FAILURES) setState.run(0, now() + LOCKOUT_MS);
    else setState.run(failures, state.lockedUntil);
  };
  const recordSuccess = () => setState.run(0, 0);

  const expectedCodeHash = () =>
    existsSync(setupCodeFile) ? readFileSync(setupCodeFile, 'utf8').trim() : null;

  const safeEqual = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  return {
    hasAdmin: () => db.prepare('SELECT 1 FROM admin WHERE id = 1').get() !== undefined,
    setupAvailable: () => existsSync(setupCodeFile),

    lockedForSeconds() {
      const remaining = getState().lockedUntil - now();
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    },

    checkSetupCode(code) {
      const expected = expectedCodeHash();
      const ok = expected !== null && safeEqual(sha256(normalizeSetupCode(code)), expected);
      if (ok) recordSuccess();
      else recordFailure();
      return ok;
    },

    async checkPassword(password) {
      const row = db.prepare('SELECT password_hash AS hash FROM admin WHERE id = 1').get() as
        { hash: string } | undefined;
      const ok = row !== undefined && (await verify(row.hash, password).catch(() => false));
      if (ok) recordSuccess();
      else recordFailure();
      return ok;
    },

    async setPassword(password) {
      const passwordHash = await hash(password);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO admin (id, password_hash, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
        ).run(passwordHash, now());
        db.prepare('DELETE FROM sessions').run();
      })();
    },

    finishSetup() {
      rmSync(setupCodeFile, { force: true });
    },

    wizardComplete: () =>
      db.prepare("SELECT 1 FROM settings WHERE key = 'wizard_complete'").get() !== undefined,

    completeWizard() {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('wizard_complete', '1')",
      ).run();
    },

    createSession() {
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(24).toString('base64url');
      const time = now();
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(time);
      db.prepare(
        'INSERT INTO sessions (token_hash, csrf_token, created_at, last_auth_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(sha256(token), csrfToken, time, time, time + SESSION_TTL_MS);
      return { token, csrfToken };
    },

    getSession(token) {
      if (!token) return null;
      const row = db
        .prepare(
          'SELECT csrf_token AS csrfToken, last_auth_at AS lastAuthAt, expires_at AS expiresAt FROM sessions WHERE token_hash = ?',
        )
        .get(sha256(token)) as (SessionRow & { expiresAt: number }) | undefined;
      if (!row) return null;
      if (row.expiresAt <= now()) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
        return null;
      }
      return { csrfToken: row.csrfToken, lastAuthAt: row.lastAuthAt };
    },

    touchAuth(token) {
      db.prepare('UPDATE sessions SET last_auth_at = ? WHERE token_hash = ?').run(
        now(),
        sha256(token),
      );
    },

    deleteSession(token) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    },
  };
}
