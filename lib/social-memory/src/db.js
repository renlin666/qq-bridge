import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ALIASES_SCHEMA = `
CREATE TABLE IF NOT EXISTS person_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'display',
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (person_id, normalized, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_aliases_normalized ON person_aliases(normalized);
`;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  bot_account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (platform, bot_account_id, user_id)
);

${ALIASES_SCHEMA}

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  bot_account_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('private', 'group')),
  scope_id TEXT NOT NULL,
  subject_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'experience', 'group_event')),
  content TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'forgotten', 'superseded')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  confidence REAL NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'manual',
  source_message_id TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  derived_from_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  deleted_at INTEGER,
  forget_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(platform, bot_account_id, scope_type, scope_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject_person_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(bot_account_id, source_message_id);

CREATE TABLE IF NOT EXISTS memory_people (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('speaker', 'mentioned', 'quoted', 'participant', 'subject')),
  PRIMARY KEY (memory_id, person_id, role)
);

CREATE TABLE IF NOT EXISTS memory_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL,
  author_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  quote TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  UNIQUE (memory_id, source_message_id, content_hash)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  status TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  bot_account_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  evidence TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('applied', 'ignored')),
  ignore_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_person ON interaction_events(person_id, occurred_at);

CREATE TABLE IF NOT EXISTS relationships (
  person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  closeness REAL NOT NULL,
  familiarity REAL NOT NULL,
  trust REAL NOT NULL,
  boundary REAL NOT NULL,
  tier TEXT NOT NULL,
  mood_label TEXT,
  mood_intensity REAL,
  mood_expires_at INTEGER,
  maintenance_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS relationship_ledger (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES interaction_events(id) ON DELETE SET NULL,
  memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  source_message_id TEXT,
  kind TEXT NOT NULL,
  deltas_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'reverted')),
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ledger_person ON relationship_ledger(person_id, created_at, status);
CREATE INDEX IF NOT EXISTS idx_ledger_memory ON relationship_ledger(memory_id, status);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON sync_outbox(status, next_attempt_at, id);
`;

export function openDatabase(filePath = ':memory:') {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    const metadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").get();
    const version = metadata ? Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value ?? 1) : 0;
    if (version > 2) throw new Error('记忆库版本高于当前程序，拒绝降级打开');
    transaction(db, () => {
      db.exec(SCHEMA);
      const columns = db.prepare('PRAGMA table_info(person_aliases)').all();
      if (!columns.some((column) => column.name === 'scope_type')) {
        db.exec('DROP INDEX IF EXISTS idx_aliases_normalized; ALTER TABLE person_aliases RENAME TO person_aliases_v1;');
        db.exec(ALIASES_SCHEMA);
        // v1 未记录采集范围，无法安全推断；保留审计数据，但不对会话展示。
        db.exec(`INSERT INTO person_aliases
          (person_id, alias, normalized, source, scope_type, scope_id, first_seen_at, last_seen_at)
          SELECT person_id, alias, normalized, source, 'legacy', '', first_seen_at, last_seen_at FROM person_aliases_v1;
          DROP TABLE person_aliases_v1;`);
      }
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export function parseJson(value, fallback = null) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}
