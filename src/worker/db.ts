/**
 * D1 access: the schema and the settings key/value store.
 *
 * The schema lives here as a string and is applied on the first request rather than
 * through migrations, because the "Deploy to Cloudflare" button provisions the database
 * but never runs a migration command — and because `npm run dev` should work with no
 * setup at all. Every statement is idempotent, so applying it repeatedly is free.
 *
 * This module deliberately imports nothing from crypto.ts: crypto.ts reads its key
 * material from `settings` through here, and one direction keeps that simple.
 */

import type { Env } from './types';

export const now = (): string => new Date().toISOString();

/* ───────── schema ───────── */

/**
 * Database schema. Add your own tables here — they are created on the next request.
 * Keep semicolons out of statement bodies: the splitter below treats every semicolon
 * as a statement boundary. Exported so a test can hold that rule.
 */
export const SCHEMA = `
-- Generic key/value store. The starter keeps its generated encryption key here;
-- the rest of the namespace is yours.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One in-flight Manyfold authorization handshake. device_code_* is the only thing that
-- can redeem agent tokens, so it is stored encrypted and never leaves the server; the
-- browser only ever sees the row id.
CREATE TABLE IF NOT EXISTS connect_sessions (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL,
  user_code      TEXT NOT NULL,
  auth_url       TEXT NOT NULL,
  device_code_ct TEXT NOT NULL,
  device_code_iv TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- Agents the user authorized. token_* is AES-GCM encrypted and never returned by the API.
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  rpc_url      TEXT NOT NULL,
  card_url     TEXT,
  token_ct     TEXT NOT NULL,
  token_iv     TEXT NOT NULL,
  expires_at   TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,
  warning      TEXT,
  connected_at TEXT NOT NULL
);

-- One conversation per agent. context_id / active_task_id give the agent multi-turn
-- memory across requests; both are cleared when the conversation is reset.
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL UNIQUE,
  context_id     TEXT,
  active_task_id TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);

-- ── Turn Zero ──────────────────────────────────────────────────────────────
-- The workspace directory. is_self marks the one person who signs in.
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  org        TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  is_self    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- The panel. Each row is a prompt with a job, run against a connected Manyfold
-- agent. role='panel' is a reviewer (the API calls it that; the stored value is
-- the original name and is mapped in store.ts so existing rows keep working).
-- role='consolidator' is the single merge/assign prompt and role='retrospective'
-- the single close-out prompt — neither is a panellist.
CREATE TABLE IF NOT EXISTS panel_agents (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'panel',
  builtin    INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  modified   INTEGER NOT NULL DEFAULT 0,
  purpose    TEXT NOT NULL DEFAULT '',
  prompt     TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Which connected Manyfold agent a prompt runs on. A missing row means "whichever
-- one the workspace picks", which is what every prompt did before this existed —
-- so this is a separate table rather than a column, there being no migration step.
CREATE TABLE IF NOT EXISTS panel_agent_targets (
  key      TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
);

-- What the workspace carries between reviews. source_review_id records which
-- review minted it, which is what the "N remembered" count reads.
CREATE TABLE IF NOT EXISTS memory_entries (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  text             TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  source           TEXT NOT NULL DEFAULT '',
  source_review_id TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  period       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Assignment uses the title for THIS review, not the directory role.
CREATE TABLE IF NOT EXISTS review_people (
  review_id    TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  review_title TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (review_id, person_id)
);

-- Absence means in scope. Only exclusions are stored.
CREATE TABLE IF NOT EXISTS review_memory (
  review_id TEXT NOT NULL,
  entry_id  TEXT NOT NULL,
  in_scope  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (review_id, entry_id)
);

-- Source documents the panel reads. Text is held inline; binary files are stored as
-- a marked JSON envelope containing base64 bytes and a MIME type.
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passes (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL,
  number      INTEGER NOT NULL,
  status      TEXT NOT NULL,
  open_count  INTEGER,
  error       TEXT,
  detail      TEXT NOT NULL DEFAULT '[]',
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY,
  review_id       TEXT NOT NULL,
  ref             TEXT NOT NULL,
  location        TEXT NOT NULL DEFAULT '',
  severity        TEXT NOT NULL DEFAULT 'question',
  status          TEXT NOT NULL DEFAULT 'open',
  statement       TEXT NOT NULL,
  why             TEXT NOT NULL DEFAULT '',
  raised_by       TEXT NOT NULL DEFAULT '[]',
  assignee_id     TEXT,
  assignee_reason TEXT NOT NULL DEFAULT '',
  flags           TEXT NOT NULL DEFAULT '[]',
  evidence        TEXT,
  memory_ref      TEXT,
  conflict        TEXT,
  draft           TEXT,
  resolution      TEXT,
  sent_at         TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One paste of replies from one recipient, plus the links the panel proposed.
CREATE TABLE IF NOT EXISTS feedback_batches (
  id             TEXT PRIMARY KEY,
  review_id      TEXT NOT NULL,
  from_person_id TEXT,
  received_at    TEXT NOT NULL,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'linking',
  error          TEXT,
  applied_at     TEXT
);

-- The close-out of one review, written when it is closed. At most one row per
-- review survives: closing again replaces it. detail holds the lessons as JSON,
-- the same way passes.detail holds its agent results.
CREATE TABLE IF NOT EXISTS retrospectives (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS feedback_links (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL,
  issue_id   TEXT NOT NULL,
  effect     TEXT NOT NULL,
  quote      TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',
  decision   TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_issues_review ON issues (review_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_ref ON issues (review_id, ref);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents (review_id);
CREATE INDEX IF NOT EXISTS idx_passes_review ON passes (review_id, number);
CREATE INDEX IF NOT EXISTS idx_feedback_review ON feedback_batches (review_id);
CREATE INDEX IF NOT EXISTS idx_feedback_links_batch ON feedback_links (batch_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrospectives_review ON retrospectives (review_id);
`;

/**
 * Split SQL into statements: drop `--` comments first, then split on ';'.
 * Comments go first because they are allowed to contain punctuation that would
 * otherwise split a statement in half. Statement bodies are not.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

let initialized: Promise<void> | null = null;

/** Idempotent; runs at most once per isolate, and retries on the next request if it fails. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!initialized) {
    initialized = db
      .batch(schemaStatements(SCHEMA).map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        initialized = null;
        throw error;
      });
  }
  return initialized;
}

/* ───────── settings ───────── */

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now())
    .run();
}

/** Writes only if the key is unset. Used for the generated encryption key, where
 *  concurrent first requests must converge on a single winner. */
export async function setSettingIfAbsent(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, now())
    .run();
}
