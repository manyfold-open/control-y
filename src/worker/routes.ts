/**
 * Ctrl+Y's API. Mounted under /api by index.ts, so the schema, origin and
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
import { advancePasses, linkFeedback, panelReady, startPass, startRetrospective } from './panel';
import { listConnectedAgents } from './connect';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  documentKey,
  formatLimit,
  presignUpload,
  uploadsConfigured,
} from './r2';
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

export const ctrlY = new Hono<{ Bindings: Env }>();

/* Workspace: everything the rail, People, Memory and Agents pages read. */
ctrlY.get('/workspace', async (c) => {
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
    uploadsEnabled: uploadsConfigured(c.env),
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
  return c.json(workspace);
});

/* ── people ── */

ctrlY.post('/people', async (c) => {
  const body = await readBody(c.req);
  const person = await store.createPerson(c.env, {
    name: required(body, 'name', 120),
    org: optional(body, 'org', 120) ?? '',
    role: optional(body, 'role', 120) ?? '',
    email: optional(body, 'email', 200) ?? '',
  });
  return c.json({ person }, 201);
});

ctrlY.patch('/people/:id', async (c) => {
  const body = await readBody(c.req);
  const person = await store.updatePerson(c.env, c.req.param('id'), {
    name: optional(body, 'name', 120),
    org: optional(body, 'org', 120),
    role: optional(body, 'role', 120),
    email: optional(body, 'email', 200),
  });
  return c.json({ person });
});

ctrlY.delete('/people/:id', async (c) => {
  await store.deletePerson(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── memory ── */

ctrlY.post('/memory', async (c) => {
  const body = await readBody(c.req);
  const entry = await store.createMemoryEntry(c.env, {
    kind: (enumeration(body, 'kind', MEMORY_KINDS) ?? 'Treatment') as MemoryKind,
    text: required(body, 'text', 2000),
    source: optional(body, 'source', 200) ?? 'Written by you',
    sourceReviewId: optional(body, 'sourceReviewId', 80) ?? null,
  });
  return c.json({ entry }, 201);
});

ctrlY.patch('/memory/:id', async (c) => {
  const body = await readBody(c.req);
  const entry = await store.updateMemoryEntry(c.env, c.req.param('id'), {
    kind: enumeration(body, 'kind', MEMORY_KINDS) as MemoryKind | undefined,
    text: optional(body, 'text', 2000),
    enabled: boolean(body, 'enabled'),
  });
  return c.json({ entry });
});

ctrlY.delete('/memory/:id', async (c) => {
  await store.deleteMemoryEntry(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── panel agents ── */

ctrlY.post('/panel-agents', async (c) => {
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
ctrlY.patch('/panel-agents/:key', async (c) => {
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

ctrlY.delete('/panel-agents/:key', async (c) => {
  await store.deletePanelAgent(c.env, c.req.param('key'));
  return c.json({ ok: true });
});

/* ── reviews ── */

/**
 * Reading a review moves its pass along first. The review page asks for this
 * every few seconds while a pass is running, so the pass advances at that
 * cadence with someone watching, and at the cron's without.
 */
ctrlY.get('/reviews/:id', async (c) => {
  await advancePasses(c.env);
  return c.json(await store.reviewDetail(c.env, c.req.param('id')));
});

ctrlY.post('/reviews', async (c) => {
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
ctrlY.patch('/reviews/:id', async (c) => {
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

ctrlY.delete('/reviews/:id', async (c) => {
  await store.deleteReview(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

/* ── documents ── */

/**
 * Step one of an upload: mint the id and hand back a URL the browser PUTs the
 * file to directly. Nothing is written to D1 yet — a row is only created once
 * the object is confirmed to exist, so an abandoned upload leaves no document.
 */
ctrlY.post('/reviews/:id/documents/upload-url', async (c) => {
  const reviewId = c.req.param('id');
  await store.getReviewSummary(c.env, reviewId);
  const body = await readBody(c.req);
  const name = required(body, 'name', 200);
  const mediaType = optional(body, 'mediaType', 200) || 'application/octet-stream';
  const bytes = body.bytes;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    bad('"bytes" must be the size of the file.');
  }
  if ((bytes as number) > MAX_UPLOAD_BYTES) {
    bad(`That file is larger than ${formatLimit(MAX_UPLOAD_BYTES)}. Upload a smaller file, or paste an extract as text.`);
  }

  const documentId = `d-${crypto.randomUUID()}`;
  const key = documentKey(reviewId, documentId);
  const uploadUrl = await presignUpload(c.env, key, mediaType);
  return c.json(
    {
      documentId,
      uploadUrl,
      mediaType,
      name,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    },
    201,
  );
});

/**
 * Two documents in one route, because they are one thing to the user.
 *
 * `content` is pasted text, held inline in D1 — it is prompt material, not a file.
 * `documentId` confirms an upload: the object is looked up through the binding to
 * prove it landed and to take its true size from R2, rather than trusting a
 * browser that could claim any size for a file it never sent.
 */
ctrlY.post('/reviews/:id/documents', async (c) => {
  const reviewId = c.req.param('id');
  await store.getReviewSummary(c.env, reviewId);
  const body = await readBody(c.req);
  const name = required(body, 'name', 200);
  const documentId = optional(body, 'documentId', 80);

  if (!documentId) {
    const document = await store.addTextDocument(c.env, reviewId, {
      name,
      content: required(body, 'content', DOCUMENT_MAX_CHARS),
    });
    return c.json({ document }, 201);
  }

  const key = documentKey(reviewId, documentId);
  const object = await c.env.DOCS.head(key);
  if (!object) bad('That upload did not complete. Choose the file again.');
  if (object!.size > MAX_UPLOAD_BYTES) {
    await c.env.DOCS.delete(key);
    bad(`That file is larger than ${formatLimit(MAX_UPLOAD_BYTES)}.`);
  }
  const document = await store.addUploadedDocument(c.env, reviewId, {
    id: documentId,
    name,
    key,
    mediaType: object!.httpMetadata?.contentType || optional(body, 'mediaType', 200) || 'application/octet-stream',
    bytes: object!.size,
  });
  return c.json({ document }, 201);
});

/** The file itself. Behind the admin gate like every other /api route. */
ctrlY.get('/reviews/:id/documents/:documentId/raw', async (c) => {
  const reviewId = c.req.param('id');
  const record = await store.documentObject(c.env, reviewId, c.req.param('documentId'));
  if (!record) throw new HttpError(404, 'not_found', 'That document has no stored file.');
  const object = await c.env.DOCS.get(record.key);
  if (!object) throw new HttpError(404, 'not_found', 'That file is no longer in storage.');
  return new Response(object.body, {
    headers: {
      'content-type': record.mediaType,
      'content-length': String(object.size),
      // The name is user-supplied, so it is quoted and stripped of anything that
      // could break out of the header value.
      'content-disposition': `attachment; filename="${record.name.replace(/[^\w.\- ]+/g, '_')}"`,
    },
  });
});

ctrlY.delete('/reviews/:id/documents/:documentId', async (c) => {
  await store.deleteDocument(c.env, c.req.param('id'), c.req.param('documentId'));
  return c.json({ ok: true });
});

/* ── roster and memory scope ── */

ctrlY.put('/reviews/:id/roster/:personId', async (c) => {
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

ctrlY.put('/reviews/:id/memory/:entryId', async (c) => {
  const body = await readBody(c.req);
  const inScope = boolean(body, 'inScope');
  if (inScope === undefined) bad('"inScope" is required.');
  await store.setMemoryScope(c.env, c.req.param('id'), c.req.param('entryId'), inScope as boolean);
  return c.json({ ok: true });
});

/* ── the pass ── */

/**
 * Starts a pass and returns it. The run itself is rows in D1 advanced by short
 * invocations — see `advancePasses` in panel.ts and the GET above — so nothing
 * here waits for an agent, and nothing depends on this response staying open.
 *
 * Anything that can fail before an agent is asked anything fails here, as an
 * ordinary HTTP error: `startPass` validates and claims the row before it sends.
 */
ctrlY.post('/reviews/:id/passes', async (c) =>
  c.json({ pass: await startPass(c.env, c.req.param('id')) }, 201),
);

/* ── issues ── */

ctrlY.patch('/issues/:id', async (c) => {
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
ctrlY.post('/issues/:id/remember', async (c) => {
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

ctrlY.post('/reviews/:id/feedback', async (c) => {
  const reviewId = c.req.param('id');
  await store.getReviewSummary(c.env, reviewId);
  const body = await readBody(c.req);
  const fromPersonId = nullable(body, 'fromPersonId', 80) ?? null;
  if (fromPersonId) await assertPerson(c.env, fromPersonId);
  if (!(await panelReady(c.env))) {
    throw new HttpError(
      400,
      'no_agent',
      'Connect a Manyfold agent under Connections before pasting replies: the panel links them.',
    );
  }
  const batchId = await store.createFeedbackBatch(c.env, reviewId, {
    fromPersonId,
    text: required(body, 'text', FEEDBACK_MAX_CHARS),
  });
  c.executionCtx.waitUntil(linkFeedback(c.env, reviewId, batchId));
  return c.json({ batchId }, 202);
});

ctrlY.delete('/reviews/:id/feedback/:batchId', async (c) => {
  await store.deleteFeedbackBatch(c.env, c.req.param('batchId'));
  return c.json({ ok: true });
});

ctrlY.patch('/feedback-links/:id', async (c) => {
  const body = await readBody(c.req);
  const decision = body.decision === null ? null : enumeration(body, 'decision', ['accept', 'reject'] as const);
  if (decision === undefined) bad('"decision" must be "accept", "reject" or null.');
  await store.setLinkDecision(c.env, c.req.param('id'), decision as 'accept' | 'reject' | null);
  return c.json({ ok: true });
});
