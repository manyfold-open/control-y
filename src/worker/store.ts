/**
 * Ctrl+Y storage: every read and write the product does against D1.
 *
 * Rows are flat and JSON-free wherever a column can carry the value; the four
 * shapes that are genuinely nested (raised_by, flags, evidence, conflict) are
 * stored as JSON text and parsed defensively on the way out — a row written by
 * an older build must never crash a page.
 *
 * Route handlers call these functions and nothing else. They never see SQL.
 */

import type {
  AgentRole,
  Conflict,
  Evidence,
  FeedbackBatch,
  FeedbackLink,
  Issue,
  IssueFlag,
  IssueStatus,
  MemoryEntry,
  MemoryKind,
  PanelAgent,
  Pass,
  PassAgentResult,
  Person,
  Retrospective,
  RetrospectiveLesson,
  ReviewDetail,
  ReviewDocument,
  ReviewStatus,
  ReviewSummary,
  RosterEntry,
  ScopedMemoryEntry,
  Severity,
} from '../shared/types';
import { readEvidence } from '../shared/evidence';
import { HttpError, type Env } from './types';
import { now } from './db';
import { listReviewTurns, type TurnRow } from './turns';
import { deleteReviewObjects } from './r2';

/* ───────── parsing helpers ───────── */

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function parseArray<T>(raw: string | null | undefined): T[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? (value as T[]) : [];
}

const bool = (value: unknown): boolean => value === 1 || value === true;
const flag = (value: boolean): number => (value ? 1 : 0);

/* ───────── people ───────── */

interface PersonRow {
  id: string;
  name: string;
  org: string;
  role: string;
  email: string;
  is_self: number;
}

const toPerson = (row: PersonRow): Person => ({
  id: row.id,
  name: row.name,
  org: row.org,
  role: row.role,
  email: row.email,
  isSelf: bool(row.is_self),
});

/** Self first, then alphabetical: the roster is read top-down when assigning. */
const PEOPLE_ORDER = 'ORDER BY is_self DESC, name COLLATE NOCASE';

export async function listPeople(env: Env): Promise<Person[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, org, role, email, is_self FROM people ${PEOPLE_ORDER}`,
  ).all<PersonRow>();
  return (results ?? []).map(toPerson);
}

export async function createPerson(
  env: Env,
  fields: { name: string; org: string; role: string; email: string },
): Promise<Person> {
  const id = `p-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO people (id, name, org, role, email, is_self, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, fields.name, fields.org, fields.role, fields.email, now())
    .run();
  return { id, ...fields, isSelf: false };
}

export async function updatePerson(
  env: Env,
  id: string,
  fields: Partial<{ name: string; org: string; role: string; email: string }>,
): Promise<Person> {
  await patch(env, 'people', 'id', id, {
    name: fields.name,
    org: fields.org,
    role: fields.role,
    email: fields.email,
  });
  const row = await env.DB.prepare(
    'SELECT id, name, org, role, email, is_self FROM people WHERE id = ?',
  )
    .bind(id)
    .first<PersonRow>();
  if (!row) throw new HttpError(404, 'not_found', 'No such person.');
  return toPerson(row);
}

/** Removing a person unassigns their issues rather than orphaning a dead id. */
export async function deletePerson(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT is_self FROM people WHERE id = ?')
    .bind(id)
    .first<{ is_self: number }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such person.');
  if (bool(row.is_self)) throw new HttpError(400, 'bad_request', 'You cannot remove yourself.');
  await env.DB.batch([
    env.DB.prepare("UPDATE issues SET assignee_id = NULL, assignee_reason = '', updated_at = ? WHERE assignee_id = ?").bind(now(), id),
    env.DB.prepare('DELETE FROM review_people WHERE person_id = ?').bind(id),
    env.DB.prepare('DELETE FROM people WHERE id = ?').bind(id),
  ]);
}

/* ───────── memory ───────── */

interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  enabled: number;
  source: string;
  created_at: string;
}

const toMemory = (row: MemoryRow): MemoryEntry => ({
  id: row.id,
  kind: row.kind as MemoryKind,
  text: row.text,
  enabled: bool(row.enabled),
  source: row.source,
  createdAt: row.created_at,
});

export async function listMemory(env: Env): Promise<MemoryEntry[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, kind, text, enabled, source, created_at FROM memory_entries ORDER BY created_at DESC',
  ).all<MemoryRow>();
  return (results ?? []).map(toMemory);
}

/**
 * `enabled` defaults to true: an entry the user wrote by hand is meant to apply.
 * The retrospective passes false — a rule proposed by a model is listed on the
 * Memory page but applies to nothing until the user switches it on.
 */
export async function createMemoryEntry(
  env: Env,
  fields: {
    kind: MemoryKind;
    text: string;
    source: string;
    sourceReviewId?: string | null;
    enabled?: boolean;
  },
): Promise<MemoryEntry> {
  const id = `m-${crypto.randomUUID()}`;
  const createdAt = now();
  const enabled = fields.enabled ?? true;
  await env.DB.prepare(
    `INSERT INTO memory_entries (id, kind, text, enabled, source, source_review_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, fields.kind, fields.text, flag(enabled), fields.source, fields.sourceReviewId ?? null, createdAt)
    .run();
  return { id, kind: fields.kind, text: fields.text, enabled, source: fields.source, createdAt };
}

export async function updateMemoryEntry(
  env: Env,
  id: string,
  fields: Partial<{ kind: MemoryKind; text: string; enabled: boolean }>,
): Promise<MemoryEntry> {
  await patch(env, 'memory_entries', 'id', id, {
    kind: fields.kind,
    text: fields.text,
    enabled: fields.enabled === undefined ? undefined : flag(fields.enabled),
  });
  const row = await env.DB.prepare(
    'SELECT id, kind, text, enabled, source, created_at FROM memory_entries WHERE id = ?',
  )
    .bind(id)
    .first<MemoryRow>();
  if (!row) throw new HttpError(404, 'not_found', 'No such memory entry.');
  return toMemory(row);
}

export async function deleteMemoryEntry(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM review_memory WHERE entry_id = ?').bind(id),
    env.DB.prepare('DELETE FROM memory_entries WHERE id = ?').bind(id),
  ]);
}

/* ───────── panel agents ───────── */

interface PanelAgentRow {
  key: string;
  name: string;
  role: string;
  builtin: number;
  enabled: number;
  modified: number;
  purpose: string;
  prompt: string;
  agent_id: string | null;
}

/**
 * The reviewer role is stored as 'panel', the name it shipped under. Renaming the
 * stored value would need a migration, and there is no migration step (see db.ts),
 * so the mapping lives here instead and every row written before the rename keeps
 * working untouched. 'panel' is the DB spelling; 'reviewer' is the API spelling.
 */
const REVIEWER_DB_ROLE = 'panel';

const toRole = (stored: string): AgentRole =>
  stored === 'consolidator' || stored === 'retrospective' ? stored : 'reviewer';

const toPanelAgent = (row: PanelAgentRow): PanelAgent => ({
  key: row.key,
  name: row.name,
  role: toRole(row.role),
  builtin: bool(row.builtin),
  enabled: bool(row.enabled),
  modified: bool(row.modified),
  purpose: row.purpose,
  prompt: row.prompt,
  agentId: row.agent_id,
});

/** Always read through the target join, so `agentId` is never silently absent. */
const AGENT_SELECT = `SELECT p.key, p.name, p.role, p.builtin, p.enabled, p.modified, p.purpose, p.prompt,
                             t.agent_id AS agent_id
                      FROM panel_agents p
                      LEFT JOIN panel_agent_targets t ON t.key = p.key`;

/** The reviewers, in run order. The two singleton roles are fetched separately. */
export async function listPanelAgents(env: Env): Promise<PanelAgent[]> {
  const { results } = await env.DB.prepare(
    `${AGENT_SELECT} WHERE p.role = ? ORDER BY p.sort_order, p.created_at`,
  )
    .bind(REVIEWER_DB_ROLE)
    .all<PanelAgentRow>();
  return (results ?? []).map(toPanelAgent);
}

/** The one prompt holding a singleton role. Throws rather than running without it. */
async function getSingleton(env: Env, role: 'consolidator' | 'retrospective'): Promise<PanelAgent> {
  const row = await env.DB.prepare(`${AGENT_SELECT} WHERE p.role = ? LIMIT 1`)
    .bind(role)
    .first<PanelAgentRow>();
  if (!row) throw new HttpError(500, 'internal', `The ${role} prompt is missing.`);
  return toPanelAgent(row);
}

export const getConsolidator = (env: Env): Promise<PanelAgent> => getSingleton(env, 'consolidator');

export const getRetrospective = (env: Env): Promise<PanelAgent> => getSingleton(env, 'retrospective');

export async function createPanelAgent(
  env: Env,
  fields: { name: string; purpose: string; prompt: string },
): Promise<PanelAgent> {
  const key = `a-${crypto.randomUUID()}`;
  const order = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM panel_agents WHERE role = ?',
  )
    .bind(REVIEWER_DB_ROLE)
    .first<{ next: number }>();
  await env.DB.prepare(
    `INSERT INTO panel_agents (key, name, role, builtin, enabled, modified, purpose, prompt, sort_order, created_at)
     VALUES (?, ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
  )
    .bind(key, fields.name, REVIEWER_DB_ROLE, fields.purpose, fields.prompt, order?.next ?? 1, now())
    .run();
  return {
    key,
    name: fields.name,
    role: 'reviewer',
    builtin: false,
    enabled: true,
    modified: false,
    purpose: fields.purpose,
    prompt: fields.prompt,
    agentId: null,
  };
}

/** null clears the pin, restoring "whichever connected agent the workspace picks". */
export async function setPanelAgentTarget(
  env: Env,
  key: string,
  agentId: string | null,
): Promise<void> {
  await (agentId === null
    ? env.DB.prepare('DELETE FROM panel_agent_targets WHERE key = ?').bind(key).run()
    : env.DB.prepare(
        `INSERT INTO panel_agent_targets (key, agent_id) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET agent_id = excluded.agent_id`,
      )
        .bind(key, agentId)
        .run());
}

export async function updatePanelAgent(
  env: Env,
  key: string,
  fields: Partial<{ name: string; purpose: string; prompt: string; enabled: boolean }>,
): Promise<PanelAgent> {
  const existing = await env.DB.prepare(`${AGENT_SELECT} WHERE p.key = ?`)
    .bind(key)
    .first<PanelAgentRow>();
  if (!existing) throw new HttpError(404, 'not_found', 'No such agent.');
  // "modified" means the prompt no longer matches the one shipped with the product.
  const promptChanged = fields.prompt !== undefined && fields.prompt !== existing.prompt;
  await patch(env, 'panel_agents', 'key', key, {
    name: fields.name,
    purpose: fields.purpose,
    prompt: fields.prompt,
    enabled: fields.enabled === undefined ? undefined : flag(fields.enabled),
    modified: promptChanged && bool(existing.builtin) ? 1 : undefined,
  });
  const row = await env.DB.prepare(`${AGENT_SELECT} WHERE p.key = ?`)
    .bind(key)
    .first<PanelAgentRow>();
  return toPanelAgent(row ?? existing);
}

export async function deletePanelAgent(env: Env, key: string): Promise<void> {
  const row = await env.DB.prepare('SELECT builtin, role FROM panel_agents WHERE key = ?')
    .bind(key)
    .first<{ builtin: number; role: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such agent.');
  // The consolidator and the retrospective are singletons the run paths require:
  // deleting either would fail a pass or a close-out with a 500, not a message.
  if (bool(row.builtin) || toRole(row.role) !== 'reviewer') {
    throw new HttpError(400, 'bad_request', 'Built-in agents can be switched off, not deleted.');
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM panel_agent_targets WHERE key = ?').bind(key),
    env.DB.prepare('DELETE FROM panel_agents WHERE key = ?').bind(key),
  ]);
}

/* ───────── reviews ───────── */

interface ReviewRow {
  id: string;
  name: string;
  counterparty: string;
  period: string;
  status: string;
  updated_at: string;
}

interface PassRow {
  id: string;
  review_id: string;
  number: number;
  status: string;
  open_count: number | null;
  error: string | null;
  detail: string;
  started_at: string;
  finished_at: string | null;
}

const toPass = (row: PassRow): Pass => {
  const detail = parseJson<{ agents?: PassAgentResult[]; memoryEffects?: number }>(row.detail, {});
  return {
    id: row.id,
    number: row.number,
    status: row.status === 'running' || row.status === 'failed' ? row.status : 'done',
    openCount: row.open_count,
    error: row.error,
    agents: Array.isArray(detail.agents) ? detail.agents : [],
    memoryEffects: typeof detail.memoryEffects === 'number' ? detail.memoryEffects : 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
};

export async function listReviews(env: Env): Promise<ReviewSummary[]> {
  // Before reading `running` off any of these rows, settle the ones that are only
  // still running because the Worker that was running them no longer exists.
  await reapStaleRuns(env);
  const [reviews, docs, open, remembered, passes, enabled] = await Promise.all([
    env.DB.prepare(
      'SELECT id, name, counterparty, period, status, updated_at FROM reviews ORDER BY updated_at DESC',
    ).all<ReviewRow>(),
    env.DB.prepare('SELECT review_id, COUNT(*) AS n FROM documents GROUP BY review_id').all<{
      review_id: string;
      n: number;
    }>(),
    env.DB.prepare(
      "SELECT review_id, COUNT(*) AS n FROM issues WHERE status = 'open' GROUP BY review_id",
    ).all<{ review_id: string; n: number }>(),
    env.DB.prepare(
      'SELECT source_review_id AS review_id, COUNT(*) AS n FROM memory_entries WHERE source_review_id IS NOT NULL GROUP BY source_review_id',
    ).all<{ review_id: string; n: number }>(),
    env.DB.prepare(
      'SELECT id, review_id, number, status, open_count, error, detail, started_at, finished_at FROM passes ORDER BY review_id, number',
    ).all<PassRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM panel_agents WHERE role = 'panel' AND enabled = 1").first<{
      n: number;
    }>(),
  ]);

  const count = (rows: { review_id: string; n: number }[] | undefined) =>
    new Map((rows ?? []).map((r) => [r.review_id, r.n]));
  const documents = count(docs.results);
  const openIssues = count(open.results);
  const memoryProduced = count(remembered.results);
  const enabledAgents = enabled?.n ?? 0;

  const byReview = new Map<string, PassRow[]>();
  for (const row of passes.results ?? []) {
    const list = byReview.get(row.review_id) ?? [];
    list.push(row);
    byReview.set(row.review_id, list);
  }

  return (reviews.results ?? []).map((row) => {
    const history = byReview.get(row.id) ?? [];
    const done = history.filter((p) => p.status === 'done');
    const last = done[done.length - 1];
    return {
      id: row.id,
      name: row.name,
      counterparty: row.counterparty,
      period: row.period,
      status: row.status === 'closed' ? 'closed' : 'open',
      passes: done.map((p) => p.open_count ?? 0),
      documents: documents.get(row.id) ?? 0,
      // The panel that actually ran, once one has. Before that, the panel that would.
      agents: last ? toPass(last).agents.length || enabledAgents : enabledAgents,
      openIssues: openIssues.get(row.id) ?? 0,
      memoryProduced: memoryProduced.get(row.id) ?? 0,
      running: history.some((p) => p.status === 'running'),
      updatedAt: row.updated_at,
    };
  });
}

export async function getReviewSummary(env: Env, id: string): Promise<ReviewSummary> {
  const summary = (await listReviews(env)).find((r) => r.id === id);
  if (!summary) throw new HttpError(404, 'not_found', 'No such review.');
  return summary;
}

export async function createReview(
  env: Env,
  fields: { name: string; counterparty: string; period: string },
): Promise<ReviewSummary> {
  const id = `r-${crypto.randomUUID()}`;
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO reviews (id, name, counterparty, period, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
  )
    .bind(id, fields.name, fields.counterparty, fields.period, timestamp, timestamp)
    .run();
  // Everyone in the directory starts on the roster; a title is added per review.
  const people = await listPeople(env);
  if (people.length > 0) {
    await env.DB.batch(
      people.map((p) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO review_people (review_id, person_id, review_title) VALUES (?, ?, ?)',
        ).bind(id, p.id, ''),
      ),
    );
  }
  return getReviewSummary(env, id);
}

export async function updateReview(
  env: Env,
  id: string,
  fields: Partial<{ name: string; counterparty: string; period: string; status: ReviewStatus }>,
): Promise<ReviewSummary> {
  await patch(env, 'reviews', 'id', id, {
    name: fields.name,
    counterparty: fields.counterparty,
    period: fields.period,
    status: fields.status,
    updated_at: now(),
  });
  return getReviewSummary(env, id);
}

export async function deleteReview(env: Env, id: string): Promise<void> {
  // Before the rows, because the rows are what say which objects exist. Dropping
  // them first would leave every uploaded file in the bucket with nothing left
  // pointing at it.
  await deleteReviewObjects(env, id);
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM document_objects WHERE document_id IN (SELECT id FROM documents WHERE review_id = ?)',
    ).bind(id),
    env.DB.prepare(
      'DELETE FROM feedback_links WHERE batch_id IN (SELECT id FROM feedback_batches WHERE review_id = ?)',
    ).bind(id),
    env.DB.prepare('DELETE FROM feedback_batches WHERE review_id = ?').bind(id),
    // Before the issues, for the same reason as the two above: the subquery is
    // the only thing that knows which revisions belonged to this review.
    env.DB.prepare(
      'DELETE FROM issue_revisions WHERE issue_id IN (SELECT id FROM issues WHERE review_id = ?)',
    ).bind(id),
    env.DB.prepare('DELETE FROM issues WHERE review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM passes WHERE review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM retrospectives WHERE review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM documents WHERE review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM review_people WHERE review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM review_memory WHERE review_id = ?').bind(id),
    env.DB.prepare('UPDATE memory_entries SET source_review_id = NULL WHERE source_review_id = ?').bind(id),
    env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(id),
  ]);
}

export const touchReview = (env: Env, id: string): Promise<unknown> =>
  env.DB.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').bind(now(), id).run();

/* ───────── roster and memory scope ───────── */

export async function listRoster(env: Env, reviewId: string): Promise<RosterEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.org, p.role, p.email, p.is_self,
            COALESCE(rp.review_title, '') AS review_title
     FROM people p
     LEFT JOIN review_people rp ON rp.person_id = p.id AND rp.review_id = ?
     ORDER BY p.is_self DESC, p.name COLLATE NOCASE`,
  )
    .bind(reviewId)
    .all<PersonRow & { review_title: string }>();
  return (results ?? []).map((row) => ({ ...toPerson(row), reviewTitle: row.review_title }));
}

export async function setRosterTitle(
  env: Env,
  reviewId: string,
  personId: string,
  reviewTitle: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO review_people (review_id, person_id, review_title) VALUES (?, ?, ?)
     ON CONFLICT (review_id, person_id) DO UPDATE SET review_title = excluded.review_title`,
  )
    .bind(reviewId, personId, reviewTitle)
    .run();
}

export async function listScopedMemory(env: Env, reviewId: string): Promise<ScopedMemoryEntry[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.kind, m.text, m.enabled, m.source, m.created_at,
            COALESCE(rm.in_scope, 1) AS in_scope
     FROM memory_entries m
     LEFT JOIN review_memory rm ON rm.entry_id = m.id AND rm.review_id = ?
     ORDER BY m.created_at DESC`,
  )
    .bind(reviewId)
    .all<MemoryRow & { in_scope: number }>();
  return (results ?? []).map((row) => ({ ...toMemory(row), inScope: bool(row.in_scope) }));
}

export async function setMemoryScope(
  env: Env,
  reviewId: string,
  entryId: string,
  inScope: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO review_memory (review_id, entry_id, in_scope) VALUES (?, ?, ?)
     ON CONFLICT (review_id, entry_id) DO UPDATE SET in_scope = excluded.in_scope`,
  )
    .bind(reviewId, entryId, flag(inScope))
    .run();
}

/* ───────── documents ───────── */

export async function listDocuments(env: Env, reviewId: string): Promise<ReviewDocument[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, bytes, created_at FROM documents WHERE review_id = ? ORDER BY created_at',
  )
    .bind(reviewId)
    .all<{ id: string; name: string; bytes: number; created_at: string }>();
  return (results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    bytes: row.bytes,
    createdAt: row.created_at,
  }));
}

/**
 * What the panel reads. Never returned to the browser.
 *
 * Two shapes, because they reach the agent by two different routes: text is
 * inlined into the prompt under a character budget, a file is attached to the
 * message and fetched by the agent from R2.
 */
export type PanelDocument =
  | { kind: 'text'; name: string; content: string }
  | { kind: 'file'; name: string; mediaType: string; key: string };

/**
 * Files used to be base64'd into this column behind this prefix, before uploads
 * moved to R2. Rows written then are still read; none are written now.
 */
const LEGACY_BINARY_PREFIX = 'control-y-file-v1:';

/** The base64 of a legacy inline file, or null when the envelope is unreadable. */
export function readLegacyEnvelope(content: string): { base64: string; mediaType: string } | null {
  if (!content.startsWith(LEGACY_BINARY_PREFIX)) return null;
  try {
    const payload = JSON.parse(content.slice(LEGACY_BINARY_PREFIX.length)) as {
      content?: unknown;
      mediaType?: unknown;
    };
    if (typeof payload.content !== 'string') return null;
    return {
      base64: payload.content,
      mediaType: typeof payload.mediaType === 'string' ? payload.mediaType : 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

export const isLegacyBinary = (content: string): boolean => content.startsWith(LEGACY_BINARY_PREFIX);

/**
 * Documents for one pass.
 *
 * A row with a document_objects match is a file in R2. Everything else is inline
 * text — except a legacy envelope, which is skipped: it is base64 with a sentinel
 * glued to the front, and feeding that to a reviewer as prose would burn the
 * document budget on noise. Skipping loses one document, not the pass.
 */
export async function readDocuments(env: Env, reviewId: string): Promise<PanelDocument[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.name, d.content, o.r2_key, o.media_type
     FROM documents d
     LEFT JOIN document_objects o ON o.document_id = d.id
     WHERE d.review_id = ?
     ORDER BY d.created_at`,
  )
    .bind(reviewId)
    .all<{ name: string; content: string; r2_key: string | null; media_type: string | null }>();

  const documents: PanelDocument[] = [];
  for (const row of results ?? []) {
    if (row.r2_key) {
      documents.push({
        kind: 'file',
        name: row.name,
        mediaType: row.media_type ?? 'application/octet-stream',
        key: row.r2_key,
      });
    } else if (!isLegacyBinary(row.content)) {
      documents.push({ kind: 'text', name: row.name, content: row.content });
    }
  }
  return documents;
}

/** Pasted text, held inline. Small, and it is prompt material rather than a file. */
export async function addTextDocument(
  env: Env,
  reviewId: string,
  fields: { name: string; content: string },
): Promise<ReviewDocument> {
  const id = `d-${crypto.randomUUID()}`;
  const createdAt = now();
  const bytes = new TextEncoder().encode(fields.content).length;
  await env.DB.prepare(
    'INSERT INTO documents (id, review_id, name, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, reviewId, fields.name, fields.content, bytes, createdAt)
    .run();
  await touchReview(env, reviewId);
  return { id, name: fields.name, bytes, createdAt };
}

/**
 * Records a file the browser already uploaded to R2. `bytes` is R2's own count,
 * taken from the object rather than from the request, so the size shown is the
 * size stored. The id was minted when the upload URL was issued, so it matches
 * the key that was signed.
 */
export async function addUploadedDocument(
  env: Env,
  reviewId: string,
  fields: { id: string; name: string; key: string; mediaType: string; bytes: number },
): Promise<ReviewDocument> {
  const createdAt = now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO documents (id, review_id, name, content, bytes, created_at) VALUES (?, ?, ?, '', ?, ?)",
    ).bind(fields.id, reviewId, fields.name, fields.bytes, createdAt),
    env.DB.prepare(
      'INSERT INTO document_objects (document_id, r2_key, media_type) VALUES (?, ?, ?)',
    ).bind(fields.id, fields.key, fields.mediaType),
  ]);
  await touchReview(env, reviewId);
  return { id: fields.id, name: fields.name, bytes: fields.bytes, createdAt };
}

/** The R2 key for one document, or null when its content is inline. */
export async function documentObject(
  env: Env,
  reviewId: string,
  documentId: string,
): Promise<{ name: string; key: string; mediaType: string } | null> {
  const row = await env.DB.prepare(
    `SELECT d.name, o.r2_key, o.media_type
     FROM documents d
     JOIN document_objects o ON o.document_id = d.id
     WHERE d.id = ? AND d.review_id = ?`,
  )
    .bind(documentId, reviewId)
    .first<{ name: string; r2_key: string; media_type: string }>();
  return row ? { name: row.name, key: row.r2_key, mediaType: row.media_type } : null;
}

export async function deleteDocument(env: Env, reviewId: string, documentId: string): Promise<void> {
  const object = await documentObject(env, reviewId, documentId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM document_objects WHERE document_id = ?').bind(documentId),
    env.DB.prepare('DELETE FROM documents WHERE id = ? AND review_id = ?').bind(documentId, reviewId),
  ]);
  // After the rows: an orphaned object is recoverable, a row pointing at a
  // deleted object is a download that 404s.
  if (object) await env.DOCS.delete(object.key);
  await touchReview(env, reviewId);
}

/* ───────── issues ───────── */

interface IssueRow {
  id: string;
  ref: string;
  location: string;
  severity: string;
  status: string;
  statement: string;
  why: string;
  raised_by: string;
  assignee_id: string | null;
  assignee_reason: string;
  flags: string;
  evidence: string | null;
  memory_ref: string | null;
  conflict: string | null;
  draft: string | null;
  resolution: string | null;
  sent_at: string | null;
  prev_statement: string | null;
  prev_severity: string | null;
  prev_location: string | null;
  prev_recorded_at: string | null;
}

const ISSUE_COLUMNS =
  'i.id, i.ref, i.location, i.severity, i.status, i.statement, i.why, i.raised_by, i.assignee_id, ' +
  'i.assignee_reason, i.flags, i.evidence, i.memory_ref, i.conflict, i.draft, i.resolution, i.sent_at, ' +
  'r.statement AS prev_statement, r.severity AS prev_severity, r.location AS prev_location, ' +
  'r.recorded_at AS prev_recorded_at';

const ISSUE_FROM = 'FROM issues i LEFT JOIN issue_revisions r ON r.issue_id = i.id';

const toSeverity = (value: string | null): Severity =>
  (['material', 'presentational', 'question'].includes(value ?? '') ? value : 'question') as Severity;

const toIssue = (row: IssueRow): Issue => ({
  id: row.id,
  ref: row.ref,
  location: row.location,
  severity: toSeverity(row.severity),
  status: (['open', 'resolved', 'dismissed'].includes(row.status) ? row.status : 'open') as IssueStatus,
  statement: row.statement,
  whyItMatters: row.why,
  raisedBy: parseArray<string>(row.raised_by),
  assigneeId: row.assignee_id,
  assigneeReason: row.assignee_reason,
  flags: parseArray<IssueFlag>(row.flags),
  /* Rows written before evidence was structured still hold `lines`. */
  evidence: readEvidence(parseJson<unknown>(row.evidence, null)),
  memory: parseJson<{ entryId: string; effect: string } | null>(row.memory_ref, null),
  conflict: parseJson<Conflict | null>(row.conflict, null),
  draft: row.draft,
  resolution: row.resolution,
  sentAt: row.sent_at,
  previous:
    row.prev_statement === null || row.prev_recorded_at === null
      ? null
      : {
          statement: row.prev_statement,
          severity: toSeverity(row.prev_severity),
          location: row.prev_location ?? '',
          recordedAt: row.prev_recorded_at,
        },
});

export async function listIssues(env: Env, reviewId: string): Promise<Issue[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${ISSUE_COLUMNS} ${ISSUE_FROM} WHERE i.review_id = ? ORDER BY i.sort_order, i.ref`,
  )
    .bind(reviewId)
    .all<IssueRow>();
  return (results ?? []).map(toIssue);
}

export async function getIssue(env: Env, id: string): Promise<{ issue: Issue; reviewId: string }> {
  const row = await env.DB.prepare(`SELECT ${ISSUE_COLUMNS}, i.review_id ${ISSUE_FROM} WHERE i.id = ?`)
    .bind(id)
    .first<IssueRow & { review_id: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such issue.');
  return { issue: toIssue(row), reviewId: row.review_id };
}

/**
 * Keep what an issue said before this pass rewrote it, so the `revised` chip can
 * show the reader what actually changed rather than only that something did.
 *
 * One row per issue: writing again replaces the last version. A pass that
 * rewrites the same issue twice is one edit as far as the reader is concerned,
 * and a full history is a second thing to read on a screen whose whole job is to
 * be read quickly.
 */
export function recordIssueRevisionStatement(
  env: Env,
  issueId: string,
  passId: string | null,
  previous: { statement: string; severity: Severity; location: string },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO issue_revisions (issue_id, pass_id, statement, severity, location, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (issue_id) DO UPDATE SET
       pass_id = excluded.pass_id,
       statement = excluded.statement,
       severity = excluded.severity,
       location = excluded.location,
       recorded_at = excluded.recorded_at`,
  ).bind(issueId, passId, previous.statement, previous.severity, previous.location, now());
}

export interface IssueWrite {
  ref: string;
  location: string;
  severity: Severity;
  status: IssueStatus;
  statement: string;
  whyItMatters: string;
  raisedBy: string[];
  assigneeId: string | null;
  assigneeReason: string;
  flags: IssueFlag[];
  evidence: Evidence | null;
  memory: { entryId: string; effect: string } | null;
  conflict: Conflict | null;
  draft: string | null;
  resolution: string | null;
  sortOrder: number;
}

/** Insert or replace by (review, ref) — refs are how a pass carries an issue forward. */
export function upsertIssueStatement(env: Env, reviewId: string, issue: IssueWrite): D1PreparedStatement {
  const timestamp = now();
  return env.DB.prepare(
    `INSERT INTO issues (id, review_id, ref, location, severity, status, statement, why, raised_by,
       assignee_id, assignee_reason, flags, evidence, memory_ref, conflict, draft, resolution,
       sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_id, ref) DO UPDATE SET
       location = excluded.location,
       severity = excluded.severity,
       status = excluded.status,
       statement = excluded.statement,
       why = excluded.why,
       raised_by = excluded.raised_by,
       assignee_id = excluded.assignee_id,
       assignee_reason = excluded.assignee_reason,
       flags = excluded.flags,
       evidence = excluded.evidence,
       memory_ref = excluded.memory_ref,
       conflict = excluded.conflict,
       draft = COALESCE(excluded.draft, issues.draft),
       resolution = excluded.resolution,
       sort_order = excluded.sort_order,
       updated_at = excluded.updated_at`,
  ).bind(
    `i-${crypto.randomUUID()}`,
    reviewId,
    issue.ref,
    issue.location,
    issue.severity,
    issue.status,
    issue.statement,
    issue.whyItMatters,
    JSON.stringify(issue.raisedBy),
    issue.assigneeId,
    issue.assigneeReason,
    JSON.stringify(issue.flags),
    issue.evidence ? JSON.stringify(issue.evidence) : null,
    issue.memory ? JSON.stringify(issue.memory) : null,
    issue.conflict ? JSON.stringify(issue.conflict) : null,
    issue.draft,
    issue.resolution,
    issue.sortOrder,
    timestamp,
    timestamp,
  );
}

export async function updateIssue(
  env: Env,
  id: string,
  fields: Partial<{
    status: IssueStatus;
    severity: Severity;
    assigneeId: string | null;
    assigneeReason: string;
    draft: string;
    resolution: string | null;
    sentAt: string | null;
  }>,
): Promise<Issue> {
  await patch(env, 'issues', 'id', id, {
    status: fields.status,
    severity: fields.severity,
    assignee_id: fields.assigneeId,
    assignee_reason: fields.assigneeReason,
    draft: fields.draft,
    resolution: fields.resolution,
    sent_at: fields.sentAt,
    updated_at: now(),
  });
  const { issue, reviewId } = await getIssue(env, id);
  await touchReview(env, reviewId);
  return issue;
}

/* ───────── liveness of background runs ───────── */

/**
 * A pass, a close-out and a pasted reply all run outside the request that started
 * them, and all three latch a row to `running` / `linking` while they do. Every
 * failure they can *observe* is written to that row by a catch block. The failure
 * they cannot observe is the Worker itself going away mid-run — the client
 * disconnecting, a deploy rolling the isolate, or the ~30s ceiling on work that
 * outlives its response. Nothing runs after that, so the row stays latched, and a
 * latched row blocks every future run on that review. Forever, until now.
 *
 * So a run beats while it lives, and a beat that stops is read as a run that died.
 *
 * `HEARTBEAT_MS` is the beat; `STALE_MS` is how long a silence has to last before
 * it counts. The gap between them absorbs an ordinary slow write — a run is only
 * declared dead after several beats in a row fail to land.
 */
const HEARTBEAT_MS = 10_000;
const STALE_MS = 60_000;

/**
 * Marks a background run alive until it stops. Call the returned function in a
 * `finally`: a beat left running would keep declaring a finished run alive.
 *
 * Beats are written for their effect and never awaited — a run must not fail
 * because a liveness write was slow, and the reaper's tolerance already covers
 * one that is lost.
 */
export function beat(env: Env, id: string): () => void {
  const write = () => {
    void env.DB.prepare(
      `INSERT INTO run_heartbeats (id, beat_at) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at`,
    )
      .bind(id, now())
      .run()
      .catch(() => undefined);
  };
  write();
  const timer = setInterval(write, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/**
 * Fails every run that stopped beating, so the review it latched becomes runnable
 * again.
 *
 * `COALESCE(beat, started_at)` is what makes this safe on a run that has only just
 * claimed its row and not yet beaten, and on rows written by a build from before
 * heartbeats existed: with no beat, the row's own start time is the clock.
 *
 * Called on the read paths rather than on a schedule: the review page asks for
 * this review every few seconds while anything is running, so the recovery lands
 * within a beat of someone actually looking. The four statements below match
 * nothing on the ordinary path.
 */
export async function reapStaleRuns(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const finishedAt = now();
  // Passes are not reaped here any more: a pass is rows advanced by short
  // invocations (panel.ts), and nothing about it beats. A row left running by a
  // build from before that is settled by `advancePasses` instead.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE retrospectives SET status = 'failed', error = ?, finished_at = ?
        WHERE status = 'running'
          AND COALESCE((SELECT beat_at FROM run_heartbeats WHERE id = retrospectives.id), started_at) < ?`,
    ).bind(
      'The close-out stopped before it finished. Nothing was written to memory.',
      finishedAt,
      cutoff,
    ),
    env.DB.prepare(
      `UPDATE feedback_batches SET status = 'failed', error = ?
        WHERE status = 'linking'
          AND COALESCE((SELECT beat_at FROM run_heartbeats WHERE id = feedback_batches.id), received_at) < ?`,
    ).bind(
      'The panel stopped before it finished reading this reply. Paste it again, or delete it and run the pass without it.',
      cutoff,
    ),
    // Anything this old belongs to a run that has since finished or just been
    // failed above; a live run has written a newer beat by definition.
    env.DB.prepare('DELETE FROM run_heartbeats WHERE beat_at < ?').bind(cutoff),
  ]);
}

/* ───────── passes ───────── */

export async function listPasses(env: Env, reviewId: string): Promise<Pass[]> {
  const [{ results }, turns] = await Promise.all([
    env.DB.prepare(
      `SELECT id, review_id, number, status, open_count, error, detail, started_at, finished_at
       FROM passes WHERE review_id = ? ORDER BY number`,
    )
      .bind(reviewId)
      .all<PassRow>(),
    listReviewTurns(env, reviewId),
  ]);
  const byPass = new Map<string, TurnRow[]>();
  for (const turn of turns) {
    const list = byPass.get(turn.pass_id) ?? [];
    list.push(turn);
    byPass.set(turn.pass_id, list);
  }
  return (results ?? []).map((row) => {
    const pass = toPass(row);
    // A finished pass is its row: `detail` was written when it ended. A running
    // one is its turns, which is where the panel at work is read from.
    if (pass.status !== 'running') return pass;
    const own = byPass.get(row.id) ?? [];
    if (own.length === 0) return pass;
    return {
      ...pass,
      // The consolidator joins the list once the reviewers are in, the way it used
      // to join the live view the first time it reported.
      agents: own.filter((turn) => turn.state !== 'waiting').map(liveResult),
    };
  });
}

/** One turn of a running pass, as the browser is shown it. */
const liveResult = (turn: TurnRow): PassAgentResult => ({
  key: turn.key,
  name: turn.name,
  findings: turn.findings,
  error: turn.error,
  // Before the agent has been asked, it has no state to report; the browser
  // calls that queued.
  state: turn.state === 'queued' || turn.state === 'waiting' ? '' : turn.state,
  note: turn.note,
  startedAt: turn.sent_at,
  finishedAt: turn.finished_at,
});

/** The newest completed pass in the workspace, whichever review it belongs to. */
export async function latestPass(
  env: Env,
): Promise<{ reviewName: string; finishedAt: string; agents: PassAgentResult[] } | null> {
  const row = await env.DB.prepare(
    `SELECT p.detail, p.finished_at, r.name FROM passes p
     JOIN reviews r ON r.id = p.review_id
     WHERE p.status = 'done' AND p.finished_at IS NOT NULL
     ORDER BY p.finished_at DESC, p.number DESC LIMIT 1`,
  ).first<{ detail: string; finished_at: string; name: string }>();
  if (!row) return null;
  const detail = parseJson<{ agents?: PassAgentResult[] }>(row.detail, {});
  const agents = Array.isArray(detail.agents) ? detail.agents : [];
  return agents.length === 0
    ? null
    : { reviewName: row.name, finishedAt: row.finished_at, agents };
}

/* ───────── feedback ───────── */

interface BatchRow {
  id: string;
  from_person_id: string | null;
  received_at: string;
  text: string;
  status: string;
  error: string | null;
}

interface LinkRow {
  id: string;
  batch_id: string;
  issue_id: string;
  effect: string;
  quote: string;
  reason: string;
  confidence: string;
  decision: string | null;
}

const toLink = (row: LinkRow): FeedbackLink => ({
  id: row.id,
  issueId: row.issue_id,
  effect: (['RESOLVES', 'PARTIAL', 'CONTRADICTS', 'CONTEXT'].includes(row.effect)
    ? row.effect
    : 'CONTEXT') as FeedbackLink['effect'],
  quote: row.quote,
  reason: row.reason,
  confidence: (['high', 'medium', 'low'].includes(row.confidence)
    ? row.confidence
    : 'medium') as FeedbackLink['confidence'],
  decision: row.decision === 'accept' || row.decision === 'reject' ? row.decision : null,
});

/** Only batches not yet folded into a pass: decided ones stop being work. */
export async function listPendingFeedback(env: Env, reviewId: string): Promise<FeedbackBatch[]> {
  const [batches, people] = await Promise.all([
    env.DB.prepare(
      `SELECT id, from_person_id, received_at, text, status, error FROM feedback_batches
       WHERE review_id = ? AND applied_at IS NULL ORDER BY received_at`,
    )
      .bind(reviewId)
      .all<BatchRow>(),
    listPeople(env),
  ]);
  const rows = batches.results ?? [];
  if (rows.length === 0) return [];

  const { results: linkRows } = await env.DB.prepare(
    `SELECT l.id, l.batch_id, l.issue_id, l.effect, l.quote, l.reason, l.confidence, l.decision
     FROM feedback_links l
     WHERE l.batch_id IN (SELECT id FROM feedback_batches WHERE review_id = ? AND applied_at IS NULL)
     ORDER BY l.sort_order`,
  )
    .bind(reviewId)
    .all<LinkRow>();

  const byBatch = new Map<string, FeedbackLink[]>();
  for (const row of linkRows ?? []) {
    const list = byBatch.get(row.batch_id) ?? [];
    list.push(toLink(row));
    byBatch.set(row.batch_id, list);
  }
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  return rows.map((row) => ({
    id: row.id,
    fromPersonId: row.from_person_id,
    fromName: (row.from_person_id && nameOf.get(row.from_person_id)) || 'an unnamed sender',
    receivedAt: row.received_at,
    text: row.text,
    status: (['linking', 'ready', 'failed'].includes(row.status)
      ? row.status
      : 'ready') as FeedbackBatch['status'],
    error: row.error,
    links: byBatch.get(row.id) ?? [],
  }));
}

export async function createFeedbackBatch(
  env: Env,
  reviewId: string,
  fields: { fromPersonId: string | null; text: string },
): Promise<string> {
  const id = `f-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO feedback_batches (id, review_id, from_person_id, received_at, text, status)
     VALUES (?, ?, ?, ?, ?, 'linking')`,
  )
    .bind(id, reviewId, fields.fromPersonId, now(), fields.text)
    .run();
  await touchReview(env, reviewId);
  return id;
}

export async function setLinkDecision(
  env: Env,
  linkId: string,
  decision: 'accept' | 'reject' | null,
): Promise<void> {
  const result = await env.DB.prepare('UPDATE feedback_links SET decision = ? WHERE id = ?')
    .bind(decision, linkId)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'No such proposed link.');
}

export async function deleteFeedbackBatch(env: Env, batchId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM feedback_links WHERE batch_id = ?').bind(batchId),
    env.DB.prepare('DELETE FROM feedback_batches WHERE id = ?').bind(batchId),
  ]);
}

/* ───────── the retrospective ───────── */

interface RetrospectiveRow {
  id: string;
  review_id: string;
  status: string;
  summary: string;
  detail: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const RETRO_COLUMNS = 'id, review_id, status, summary, detail, error, started_at, finished_at';

const toRetrospective = (row: RetrospectiveRow): Retrospective => {
  const detail = parseJson<{
    wentWell?: unknown;
    toChange?: unknown;
    lessons?: unknown;
  }>(row.detail, {});
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: row.id,
    reviewId: row.review_id,
    status: row.status === 'running' || row.status === 'failed' ? row.status : 'done',
    summary: row.summary,
    wentWell: strings(detail.wentWell),
    toChange: strings(detail.toChange),
    lessons: Array.isArray(detail.lessons) ? (detail.lessons as RetrospectiveLesson[]) : [],
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
};

export async function getRetrospectiveFor(env: Env, reviewId: string): Promise<Retrospective | null> {
  const row = await env.DB.prepare(`SELECT ${RETRO_COLUMNS} FROM retrospectives WHERE review_id = ?`)
    .bind(reviewId)
    .first<RetrospectiveRow>();
  return row ? toRetrospective(row) : null;
}

/**
 * Claims the close-out slot for a review, replacing any earlier one.
 *
 * Returns null when a retrospective is already running on this review, so two
 * closes arriving together cannot both start a run. The unique index on
 * review_id makes the upsert the whole decision — SQLite settles it in the write.
 */
export async function claimRetrospective(env: Env, reviewId: string): Promise<string | null> {
  const id = `retro-${crypto.randomUUID()}`;
  const claimed = await env.DB.prepare(
    `INSERT INTO retrospectives (id, review_id, status, summary, detail, error, started_at, finished_at)
     VALUES (?, ?, 'running', '', '{}', NULL, ?, NULL)
     ON CONFLICT (review_id) DO UPDATE SET
       id = excluded.id, status = 'running', summary = '', detail = '{}',
       error = NULL, started_at = excluded.started_at, finished_at = NULL
     WHERE retrospectives.status <> 'running'`,
  )
    .bind(id, reviewId, now())
    .run();
  return claimed.meta.changes ? id : null;
}

export async function finishRetrospective(
  env: Env,
  id: string,
  outcome: {
    status: 'done' | 'failed';
    summary?: string;
    wentWell?: string[];
    toChange?: string[];
    lessons?: RetrospectiveLesson[];
    error?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    'UPDATE retrospectives SET status = ?, summary = ?, detail = ?, error = ?, finished_at = ? WHERE id = ?',
  )
    .bind(
      outcome.status,
      outcome.summary ?? '',
      JSON.stringify({
        wentWell: outcome.wentWell ?? [],
        toChange: outcome.toChange ?? [],
        lessons: outcome.lessons ?? [],
      }),
      outcome.error ?? null,
      now(),
      id,
    )
    .run();
}

/* ───────── the whole review ───────── */

export async function reviewDetail(env: Env, id: string): Promise<ReviewDetail> {
  const review = await getReviewSummary(env, id);
  const [issues, documents, roster, memory, passes, feedback, panelAgents, retrospective] =
    await Promise.all([
      listIssues(env, id),
      listDocuments(env, id),
      listRoster(env, id),
      listScopedMemory(env, id),
      listPasses(env, id),
      listPendingFeedback(env, id),
      listPanelAgents(env),
      getRetrospectiveFor(env, id),
    ]);
  return { review, issues, documents, roster, memory, passes, feedback, panelAgents, retrospective };
}

/* ───────── generic partial update ───────── */

/**
 * UPDATE with only the columns that were actually supplied. Column names come
 * from this module's own literals, never from request data — the values are the
 * only thing bound, and the only thing a caller controls.
 */
async function patch(
  env: Env,
  table: string,
  keyColumn: string,
  key: string,
  columns: Record<string, string | number | null | undefined>,
): Promise<void> {
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined) as [
    string,
    string | number | null,
  ][];
  if (entries.length === 0) return;
  const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
  const result = await env.DB.prepare(`UPDATE ${table} SET ${assignments} WHERE ${keyColumn} = ?`)
    .bind(...entries.map(([, value]) => value), key)
    .run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'No such record.');
}
