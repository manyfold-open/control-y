/**
 * Turn Zero's API. Mounted under /api by index.ts, so the schema, origin and
 * admin-password middleware there already ran by the time anything here does.
 *
 * Handlers validate the request body, call src/worker/store.ts, and return JSON.
 * No SQL, no A2A, no business rules beyond "is this input allowed" — the two
 * long-running operations (a pass, and linking a pasted reply) start here and
 * finish under waitUntil.
 */

import { Hono } from 'hono';
import type { MemoryKind, Severity, Workspace } from '../shared/types';
import { HttpError, type Env } from './types';
import { linkFeedback, panelReady, startPass, startRetrospective } from './panel';
import { listConnectedAgents } from './connect';
import * as store from './store';

const MEMORY_KINDS = ['Treatment', 'Pattern', 'Instruction', 'Fact'] as const;
const SEVERITIES = ['material', 'presentational', 'question'] as const;
const ISSUE_STATUSES = ['open', 'resolved', 'dismissed'] as const;
const REVIEW_STATUSES = ['open', 'closed'] as const;

const DOCUMENT_MAX_CHARS = 400_000;
const PROMPT_MAX_CHARS = 20_000;
const FEEDBACK_MAX_CHARS = 40_000;

/* ───────── request bodies ───────── */

type Body = Record<string, unknown>;

async function readBody(request: { json: () => Promise<unknown> }): Promise<Body> {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_request', 'Body must be a JSON object.');
  }
  return parsed as Body;
}

const bad = (message: string): never => {
  throw new HttpError(400, 'bad_request', message);
};

function required(body: Body, field: string, limit: number): string {
  const raw = body[field];
  if (typeof raw !== 'string' || !raw.trim()) bad(`"${field}" is required.`);
  const value = (raw as string).trim();
  if (value.length > limit) bad(`"${field}" is longer than ${limit} characters.`);
  return value;
}

function optional(body: Body, field: string, limit: number): string | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'string') bad(`"${field}" must be a string.`);
  const value = (body[field] as string).trim();
  if (value.length > limit) bad(`"${field}" is longer than ${limit} characters.`);
  return value;
}

/** Distinguishes "leave it alone" (undefined) from "clear it" (null). */
function nullable(body: Body, field: string, limit: number): string | null | undefined {
  if (body[field] === undefined) return undefined;
  if (body[field] === null) return null;
  const value = optional(body, field, limit);
  return value === '' ? null : value;
}

function boolean(body: Body, field: string): boolean | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'boolean') bad(`"${field}" must be true or false.`);
  return body[field] as boolean;
}

function enumeration<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (body[field] === undefined) return undefined;
  if (!allowed.includes(body[field] as T)) bad(`"${field}" must be one of: ${allowed.join(', ')}.`);
  return body[field] as T;
}

async function assertPerson(env: Env, id: string): Promise<void> {
  const people = await store.listPeople(env);
  if (!people.some((person) => person.id === id)) bad('That person is not in the directory.');
}

/* ───────── routes ───────── */

export const turnZero = new Hono<{ Bindings: Env }>();

/* Workspace: everything the rail, People, Memory and Agents pages read. */
turnZero.get('/workspace', async (c) => {
  const [people, memory, panelAgents, consolidator, retrospective, reviews, lastPass, connectedAgents] =
    await Promise.all([
      store.listPeople(c.env),
      store.listMemory(c.env),
      store.listPanelAgents(c.env),
      store.getConsolidator(c.env),
      store.getRetrospective(c.env),
      store.listReviews(c.env),
      store.latestPass(c.env),
      listConnectedAgents(c.env),
    ]);
  const workspace: Workspace = {
    people,
    memory,
    panelAgents,
    consolidator,
    retrospective,
    connectedAgents,
    reviews,
    openIssues: reviews.reduce((total, review) => total + review.openIssues, 0),
    lastPass,
    panelReady: connectedAgents.length > 0,
  };
  return c.json(workspace);
});

/* ── people ── */

turnZero.post('/people', async (c) => {
  const body = await readBody(c.req);
  const person = await store.createPerson(c.env, {
    name: required(body, 'name', 120),
    org: optional(body, 'org', 120) ?? '',
    role: optional(body, 'role', 120) ?? '',
    email: optional(body, 'email', 200) ?? '',
  });
  return c.json({ person }, 201);
});

turnZero.patch('/people/:id', async (c) => {
  const body = await readBody(c.req);
  const person = await store.updatePerson(c.env, c.req.param('id'), {
    name: optional(body, 'name', 120),
    org: optional(body, 'org', 120),
    role: optional(body, 'role', 120),
    email: optional(body, 'email', 200),
  });
  return c.json({ person });
});

turnZero.delete('/people/:id', async (c) => {
  await store.deletePerson(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── memory ── */

turnZero.post('/memory', async (c) => {
  const body = await readBody(c.req);
  const entry = await store.createMemoryEntry(c.env, {
    kind: (enumeration(body, 'kind', MEMORY_KINDS) ?? 'Treatment') as MemoryKind,
    text: required(body, 'text', 2000),
    source: optional(body, 'source', 200) ?? 'Written by you',
    sourceReviewId: optional(body, 'sourceReviewId', 80) ?? null,
  });
  return c.json({ entry }, 201);
});

turnZero.patch('/memory/:id', async (c) => {
  const body = await readBody(c.req);
  const entry = await store.updateMemoryEntry(c.env, c.req.param('id'), {
    kind: enumeration(body, 'kind', MEMORY_KINDS) as MemoryKind | undefined,
    text: optional(body, 'text', 2000),
    enabled: boolean(body, 'enabled'),
  });
  return c.json({ entry });
});

turnZero.delete('/memory/:id', async (c) => {
  await store.deleteMemoryEntry(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── panel agents ── */

turnZero.post('/panel-agents', async (c) => {
  const body = await readBody(c.req);
  const agent = await store.createPanelAgent(c.env, {
    name: required(body, 'name', 120),
    purpose: optional(body, 'purpose', 400) ?? '',
    prompt: required(body, 'prompt', PROMPT_MAX_CHARS),
  });
  return c.json({ agent }, 201);
});

/**
 * `agentId` pins this prompt to one connected Manyfold agent; null unpins it.
 * It is validated against the connected list here so a typo becomes a 400 now,
 * rather than a prompt that fails every pass from then on.
 */
turnZero.patch('/panel-agents/:key', async (c) => {
  const key = c.req.param('key');
  const body = await readBody(c.req);
  const agentId = nullable(body, 'agentId', 200);
  if (agentId) {
    const connected = await listConnectedAgents(c.env);
    if (!connected.some((agent) => agent.agentId === agentId)) {
      bad('That Manyfold agent is not connected.');
    }
  }
  // The update runs first because it 404s on an unknown key — pinning before that
  // check would leave a target row pointing at an agent that does not exist.
  const updated = await store.updatePanelAgent(c.env, key, {
    name: optional(body, 'name', 120),
    purpose: optional(body, 'purpose', 400),
    prompt: optional(body, 'prompt', PROMPT_MAX_CHARS),
    enabled: boolean(body, 'enabled'),
  });
  if (agentId === undefined) return c.json({ agent: updated });
  await store.setPanelAgentTarget(c.env, key, agentId);
  return c.json({ agent: { ...updated, agentId } });
});

turnZero.delete('/panel-agents/:key', async (c) => {
  await store.deletePanelAgent(c.env, c.req.param('key'));
  return c.json({ ok: true });
});

/* ── reviews ── */

turnZero.get('/reviews/:id', async (c) => c.json(await store.reviewDetail(c.env, c.req.param('id'))));

turnZero.post('/reviews', async (c) => {
  const body = await readBody(c.req);
  const review = await store.createReview(c.env, {
    name: required(body, 'name', 160),
    counterparty: optional(body, 'counterparty', 160) ?? '',
    period: optional(body, 'period', 160) ?? '',
  });
  return c.json({ review }, 201);
});

/**
 * Closing a review starts the retrospective. It runs under waitUntil like a pass,
 * so a slow or unreachable agent cannot fail the close — the outcome, including
 * any error, lands on the retrospective row that the review page reads.
 */
turnZero.patch('/reviews/:id', async (c) => {
  const id = c.req.param('id');
  const body = await readBody(c.req);
  const status = enumeration(body, 'status', REVIEW_STATUSES);
  const before = await store.getReviewSummary(c.env, id);
  const review = await store.updateReview(c.env, id, {
    name: optional(body, 'name', 160),
    counterparty: optional(body, 'counterparty', 160),
    period: optional(body, 'period', 160),
    status,
  });
  // Only on the open → closed edge: renaming a review that is already closed, or
  // closing one that is already closed, must not run it again.
  if (status === 'closed' && before.status !== 'closed') {
    await startRetrospective(c.env, id, (promise) => c.executionCtx.waitUntil(promise));
  }
  return c.json({ review });
});

turnZero.delete('/reviews/:id', async (c) => {
  await store.deleteReview(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── documents ── */

turnZero.post('/reviews/:id/documents', async (c) => {
  const reviewId = c.req.param('id');
  await store.getReviewSummary(c.env, reviewId);
  const body = await readBody(c.req);
  const document = await store.addDocument(c.env, reviewId, {
    name: required(body, 'name', 200),
    content: required(body, 'content', DOCUMENT_MAX_CHARS),
  });
  return c.json({ document }, 201);
});

turnZero.delete('/reviews/:id/documents/:documentId', async (c) => {
  await store.deleteDocument(c.env, c.req.param('id'), c.req.param('documentId'));
  return c.json({ ok: true });
});

/* ── roster and memory scope ── */

turnZero.put('/reviews/:id/roster/:personId', async (c) => {
  const body = await readBody(c.req);
  await assertPerson(c.env, c.req.param('personId'));
  await store.setRosterTitle(
    c.env,
    c.req.param('id'),
    c.req.param('personId'),
    optional(body, 'reviewTitle', 200) ?? '',
  );
  return c.json({ ok: true });
});

turnZero.put('/reviews/:id/memory/:entryId', async (c) => {
  const body = await readBody(c.req);
  const inScope = boolean(body, 'inScope');
  if (inScope === undefined) bad('"inScope" is required.');
  await store.setMemoryScope(c.env, c.req.param('id'), c.req.param('entryId'), inScope as boolean);
  return c.json({ ok: true });
});

/* ── the pass ── */

turnZero.post('/reviews/:id/passes', async (c) => {
  const pass = await startPass(c.env, c.req.param('id'), (promise) => c.executionCtx.waitUntil(promise));
  return c.json({ pass }, 202);
});

/* ── issues ── */

turnZero.patch('/issues/:id', async (c) => {
  const body = await readBody(c.req);
  const assigneeId = nullable(body, 'assigneeId', 80);
  if (assigneeId) await assertPerson(c.env, assigneeId);
  const sent = boolean(body, 'sent');
  const issue = await store.updateIssue(c.env, c.req.param('id'), {
    status: enumeration(body, 'status', ISSUE_STATUSES),
    severity: enumeration(body, 'severity', SEVERITIES) as Severity | undefined,
    assigneeId,
    assigneeReason: optional(body, 'assigneeReason', 400),
    draft: optional(body, 'draft', 8000),
    resolution: nullable(body, 'resolution', 2000),
    sentAt: sent === undefined ? undefined : sent ? new Date().toISOString() : null,
  });
  return c.json({ issue });
});

/** Turns a settled issue into a rule the workspace carries into the next review. */
turnZero.post('/issues/:id/remember', async (c) => {
  const body = await readBody(c.req);
  const { issue, reviewId } = await store.getIssue(c.env, c.req.param('id'));
  const [review, passes] = await Promise.all([
    store.getReviewSummary(c.env, reviewId),
    store.listPasses(c.env, reviewId),
  ]);
  const done = passes.filter((pass) => pass.status === 'done').length;
  const entry = await store.createMemoryEntry(c.env, {
    kind: (enumeration(body, 'kind', MEMORY_KINDS) ?? 'Treatment') as MemoryKind,
    text: optional(body, 'text', 2000) || issue.resolution || issue.statement,
    source: `${review.name}${done > 0 ? ` · pass ${done}` : ''}`,
    sourceReviewId: reviewId,
  });
  return c.json({ entry }, 201);
});

/* ── pasted replies ── */

turnZero.post('/reviews/:id/feedback', async (c) => {
  const reviewId = c.req.param('id');
  await store.getReviewSummary(c.env, reviewId);
  const body = await readBody(c.req);
  const fromPersonId = nullable(body, 'fromPersonId', 80) ?? null;
  if (fromPersonId) await assertPerson(c.env, fromPersonId);
  if (!(await panelReady(c.env))) {
    throw new HttpError(
      400,
      'no_agent',
      'Connect a Manyfold agent under Connections before pasting replies — the panel links them.',
    );
  }
  const batchId = await store.createFeedbackBatch(c.env, reviewId, {
    fromPersonId,
    text: required(body, 'text', FEEDBACK_MAX_CHARS),
  });
  c.executionCtx.waitUntil(linkFeedback(c.env, reviewId, batchId));
  return c.json({ batchId }, 202);
});

turnZero.delete('/reviews/:id/feedback/:batchId', async (c) => {
  await store.deleteFeedbackBatch(c.env, c.req.param('batchId'));
  return c.json({ ok: true });
});

turnZero.patch('/feedback-links/:id', async (c) => {
  const body = await readBody(c.req);
  const decision = body.decision === null ? null : enumeration(body, 'decision', ['accept', 'reject'] as const);
  if (decision === undefined) bad('"decision" must be "accept", "reject" or null.');
  await store.setLinkDecision(c.env, c.req.param('id'), decision as 'accept' | 'reject' | null);
  return c.json({ ok: true });
});
