import type { Db } from './db';

const KEEP_ROWS = 5000;

export interface AuditEntry {
  actor: 'admin' | 'anonymous' | 'system';
  event: string;
  target?: string;
  outcome: 'ok' | 'failed' | 'denied';
  detail?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  recent(limit: number): (AuditEntry & { ts: number })[];
}

export function createAuditLog(db: Db, now: () => number = Date.now): AuditLog {
  const insert = db.prepare(
    'INSERT INTO audit (ts, actor, event, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const prune = db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?');
  return {
    record(entry) {
      insert.run(
        now(),
        entry.actor,
        entry.event,
        entry.target ?? null,
        entry.outcome,
        entry.detail ?? null,
      );
      prune.run(KEEP_ROWS);
    },
    recent(limit) {
      return db
        .prepare(
          'SELECT ts, actor, event, target, outcome, detail FROM audit ORDER BY id DESC LIMIT ?',
        )
        .all(limit) as (AuditEntry & { ts: number })[];
    },
  };
}
