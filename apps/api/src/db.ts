import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS = [
  `CREATE TABLE admin (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     password_hash TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     csrf_token TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_auth_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE auth_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     failures INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO auth_state (id) VALUES (1);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     event TEXT NOT NULL,
     target TEXT,
     outcome TEXT NOT NULL,
     detail TEXT
   );`,
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = db.pragma('user_version', { simple: true }) as number;
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[next] as string);
      db.pragma(`user_version = ${next + 1}`);
    })();
  }
  return db;
}
