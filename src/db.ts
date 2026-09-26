// SPDX-License-Identifier: AGPL-3.0-only
// The database: one SQLite file. Migrations are numbered and run once each, in order, inside a transaction.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

export const ENTRY_TYPES = ["decision", "action", "result", "finding", "milestone", "question"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const LINK_KINDS = ["led_to", "answers", "supersedes", "relates"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LEVELS = ["view", "comment", "edit"] as const;
export type Level = (typeof LEVELS)[number];

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    sub TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    groups_json TEXT NOT NULL DEFAULT '[]',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE timelines (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id),
    now_md TEXT NOT NULL DEFAULT '',
    next_md TEXT NOT NULL DEFAULT '',
    waiting_md TEXT NOT NULL DEFAULT '',
    picture_by_hand INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE grants (
    timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'group', 'all')),
    name TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('view', 'comment', 'edit')),
    PRIMARY KEY (timeline_id, kind, name)
  );
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    source_key TEXT,
    type TEXT NOT NULL CHECK (type IN ('decision', 'action', 'result', 'finding', 'milestone', 'question')),
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body_md TEXT NOT NULL DEFAULT '',
    fields_json TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT '' CHECK (status IN ('', 'open', 'closed')),
    by_hand INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (timeline_id, source_key)
  );
  CREATE INDEX entries_by_date ON entries(timeline_id, date);
  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('led_to', 'answers', 'supersedes', 'relates')),
    imported INTEGER NOT NULL DEFAULT 0,
    UNIQUE (from_id, to_id, kind)
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES comments(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    body_md TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    resolved_at TEXT,
    resolved_by INTEGER REFERENCES users(id),
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX comments_by_entry ON comments(entry_id, created_at);
  CREATE TABLE mentions (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (comment_id, user_id)
  );
  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    unchanged INTEGER NOT NULL,
    kept INTEGER NOT NULL,
    stale INTEGER NOT NULL,
    redactions INTEGER NOT NULL
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let v = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (v < MIGRATIONS.length) {
    const sql = MIGRATIONS[v] as string;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(v + 1);
    })();
    v++;
  }
}

export function now(): string {
  return new Date().toISOString();
}

/** The account the importer writes as. It never signs in: its `sub` cannot be produced by a provider. */
export function systemUser(db: DB): number {
  const row = db.prepare("SELECT id FROM users WHERE sub = ?").get("munin:system") as
    | { id: number }
    | undefined;
  if (row) return row.id;
  const t = now();
  return Number(
    db
      .prepare(
        "INSERT INTO users (sub, username, name, created_at, last_seen) VALUES ('munin:system', 'munin', 'Munin importer', ?, ?)",
      )
      .run(t, t).lastInsertRowid,
  );
}
