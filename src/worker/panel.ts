/**
 * The panel: what happens when the fund manager presses "Run pass N".
 *
 * A pass is two stages. Every enabled agent reads the deliverable against the
 * documents on its own — one A2A turn each, no shared context, so one agent's
 * reading cannot colour another's. Then the consolidator receives all of their
 * findings at once and returns the merged, assigned, drafted issue list.
 *
 * The run happens under waitUntil, not in the request: a pass takes minutes and
 * the browser polls the review while it runs. Everything that can fail before
 * the first agent call is checked in `startPass`, so the button gets a real
 * error instead of a pass row that dies silently.
 *
 * Model output is untrusted. `parsePayload` never throws, every field is
 * validated against the roster and the enums, and an issue the consolidator
 * carried in but did not return is left exactly as it was.
 */

import type {
  Conflict,
  Evidence,
  Issue,
  IssueFlag,
  IssueStatus,
  MemoryKind,
  Pass,
  PassAgentResult,
  RetrospectiveLesson,
  Severity,
} from '../shared/types';
import { MEMORY_KINDS } from '../shared/types';
import { HttpError, type AgentCredential, type Env } from './types';
import { A2AError, consumeA2AStream, safeErrorText } from './a2a';
import { credentialFor, listConnectedAgents } from './connect';
import { now } from './db';
import {
  claimRetrospective,
  createMemoryEntry,
  finishRetrospective,
  getConsolidator,
  getRetrospective,
  getReviewSummary,
  listIssues,
  listPanelAgents,
  listPasses,
  listPendingFeedback,
  listRoster,
  listScopedMemory,
  readDocuments,
  upsertIssueStatement,
  type IssueWrite,
  type PanelDocument,
} from './store';

const TURN_TIMEOUT_MS = 4 * 60_000;
const AGENT_CONCURRENCY = 3;
const DOC_CHARS_EACH = 24_000;
const DOC_CHARS_TOTAL = 60_000;
const MAX_ISSUES_PER_PASS = 200;

/* ───────── one A2A turn ───────── */

/** Resolves the connected Manyfold agent one prompt runs on. */
type CredentialFor = (agent: { name: string; agentId: string | null }) => Promise<AgentCredential>;

/**
 * Builds that resolver once per run, so the connected list is read once rather
 * than per prompt.
 *
 * A prompt with no pin runs on whichever agent the workspace picks, which is what
 * every prompt did before pinning existed. A prompt pinned to an agent that is no
 * longer connected fails — running it somewhere else would silently discard a
 * choice the user made deliberately, and the two agents need not be alike.
 *
 * Throws when nothing at all is connected, so the button fails rather than the
 * background run.
 */
async function credentialResolver(env: Env): Promise<CredentialFor> {
  const connected = await listConnectedAgents(env);
  const fallback = connected.find((agent) => agent.verified) ?? connected[0];
  if (!fallback) {
    throw new HttpError(
      400,
      'no_agent',
      'Connect a Manyfold agent under Connections before running the panel.',
    );
  }
  return async (agent) => {
    if (!agent.agentId) return credentialFor(env, fallback.agentId);
    const pinned = connected.find((candidate) => candidate.agentId === agent.agentId);
    if (!pinned) {
      throw new Error(
        `${agent.name} is set to run on a Manyfold agent that is no longer connected. Pick another under Agents.`,
      );
    }
    return credentialFor(env, pinned.agentId);
  };
}

/**
 * One stateless turn: no contextId, so each prompt is read on its own and one
 * agent's reading cannot colour another's.
 *
 * messageId is fresh per call, unlike the chat's derived ids. A2A treats it as
 * an idempotency key, and every panel call is a distinct prompt sent exactly
 * once — a pass is never retried in place, only re-run as a new pass.
 */
async function ask(cred: AgentCredential, prompt: string, documents: PanelDocument[] = []): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const snapshot = await consumeA2AStream({
      cred,
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: `turnzero-${crypto.randomUUID()}`,
          parts: [
            { kind: 'text', text: prompt },
            ...documents
              .filter((document) => document.encoding === 'base64')
              .map((document) => ({
                kind: 'file',
                file: {
                  bytes: document.content,
                  mimeType: document.mediaType,
                  name: document.name,
                },
              })),
          ],
        },
        configuration: { acceptedOutputModes: ['text/plain'] },
      },
      signal: controller.signal,
    });
    const text = snapshot.text.trim();
    if (!text) throw new A2AError(`${cred.label} answered with no text.`, true);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the JSON object out of a reply. Agents wrap it in prose or a code fence
 * often enough that insisting on a bare object would fail passes for no reason.
 */
export function parsePayload<T>(text: string): T | null {
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      // An object, specifically: every caller reads a named key off it.
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ───────── validation of model output ───────── */

const text = (value: unknown, limit = 2000): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

function asEvidence(value: unknown): Evidence | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { label?: unknown; lines?: unknown };
  const lines = Array.isArray(raw.lines)
    ? raw.lines.map((line) => text(line, 300)).filter(Boolean).slice(0, 40)
    : [];
  const label = text(raw.label, 160);
  if (!label && lines.length === 0) return null;
  return { label: label || 'Evidence', lines };
}

function asConflict(value: unknown): Conflict | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { positions?: unknown; ruling?: unknown };
  const positions = Array.isArray(raw.positions)
    ? raw.positions
        .map((entry) => {
          const p = (entry ?? {}) as { agent?: unknown; verdict?: unknown };
          return { agent: text(p.agent, 120), verdict: text(p.verdict, 600) };
        })
        .filter((p) => p.agent && p.verdict)
        .slice(0, 6)
    : [];
  const ruling = text(raw.ruling, 800);
  if (positions.length < 2 || !ruling) return null;
  return { positions, ruling };
}

const SEVERITY_RANK: Record<Severity, number> = { material: 0, presentational: 1, question: 2 };

/** TZ-001, TZ-002, … The number is the order the issue was first raised in. */
function refMinter(existing: string[]): () => string {
  let highest = 0;
  for (const ref of existing) {
    const match = /(\d+)\s*$/.exec(ref);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return () => `TZ-${String(++highest).padStart(3, '0')}`;
}

/* ───────── prompt building ───────── */

const bullet = (lines: string[]): string => lines.map((line) => `- ${line}`).join('\n');

function documentsBlock(docs: PanelDocument[]): string {
  let budget = DOC_CHARS_TOTAL;
  return docs
    .map((doc) => {
      if (doc.encoding === 'base64') {
        return `### ${doc.name}\n[attached to the message as a ${doc.mediaType} file]`;
      }
      const room = Math.min(DOC_CHARS_EACH, budget);
      budget -= room;
      if (room <= 0) return `### ${doc.name}\n[not included — document budget reached]`;
      const body =
        doc.content.length > room ? `${doc.content.slice(0, room)}\n[truncated]` : doc.content;
      return `### ${doc.name}\n${body}`;
    })
    .join('\n\n');
}

interface PassContext {
  header: string;
  memory: string;
  documents: string;
  carried: string;
  replies: string;
}

const JSON_ONLY = 'Reply with JSON and nothing else. No preamble, no explanation, no code fence.';

export function buildAgentPrompt(agentPrompt: string, ctx: PassContext): string {
  return [
    agentPrompt,
    '───────────────────────────────────────',
    ctx.header,
    ctx.memory,
    `DOCUMENTS UNDER REVIEW\n${ctx.documents}`,
    ctx.carried,
    ctx.replies,
    '───────────────────────────────────────',
    `${JSON_ONLY}

{"findings":[{"location":"where in the deliverable, e.g. staging!row 47","severity":"material|presentational|question","statement":"one sentence saying what is wrong","whyItMatters":"why it matters to the fund manager","evidence":{"label":"file and location","lines":["quoted lines that prove it"]}}]}

Return {"findings":[]} when you find nothing. Nothing found is a real result and is worth stating.
Raise only what you can anchor to the documents above.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildConsolidatorPrompt(
  consolidatorPrompt: string,
  ctx: PassContext,
  roster: string,
  findings: string,
): string {
  return [
    consolidatorPrompt,
    '───────────────────────────────────────',
    ctx.header,
    `THE REVIEW ROSTER — assign every issue to exactly one of these ids\n${roster}`,
    ctx.memory,
    ctx.carried,
    ctx.replies,
    `WHAT THE PANEL FOUND\n${findings}`,
    '───────────────────────────────────────',
    `${JSON_ONLY}

{"issues":[{"ref":"the ref of an issue carried in, or null when new","status":"open|resolved|dismissed","severity":"material|presentational|question","location":"where in the deliverable","statement":"one sentence saying what is wrong","whyItMatters":"why it matters","raisedBy":["the exact name of each agent that found it"],"assigneeId":"an id from the roster","assigneeReason":"why this person and not another, in one sentence","flags":["new","revised","contradicts"],"evidence":{"label":"...","lines":["..."]},"memory":{"entryId":"the id of the memory entry that changed this issue","effect":"what it changed, in one line"},"conflict":{"positions":[{"agent":"name","verdict":"its position"}],"ruling":"your ruling and why"},"draft":"the message to send to the assignee, signed by nobody","resolution":"how it was settled — only when status is resolved"}]}

Rules:
- Return EVERY issue carried in above, with its status updated by the replies, AND every new issue. Keep the ref of a carried issue exactly. Use null for the ref of a new one.
- assigneeId must be one of the roster ids. "You" is a legitimate assignee.
- Set fields you have nothing to say about to null. Omit flags that do not apply.
- Draft a message only for an issue that is open and assigned to someone other than the fund manager.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* ───────── turning the consolidator's answer into rows ───────── */

export interface ConsolidationContext {
  /** Every issue already on the review, so a carried-forward ref keeps its history. */
  existing: Issue[];
  /** Ids an issue may be assigned to. Anything else keeps the previous assignee. */
  personIds: string[];
  memoryIds: string[];
  agentNames: string[];
}

/**
 * Validates the consolidator's issue list into rows.
 *
 * The model is untrusted: this never throws, drops anything without a statement,
 * de-duplicates refs, and refuses ids and enum values it was not given. Where a
 * field is unreadable on an issue that already exists, the existing value wins —
 * a garbled reply must not quietly downgrade or unassign live work.
 *
 * An issue that was carried in and is simply absent from the reply is not
 * returned here at all, and so is left exactly as it was.
 */
export function consolidateIssues(raw: unknown[], ctx: ConsolidationContext): IssueWrite[] {
  const byRef = new Map(ctx.existing.map((issue) => [issue.ref, issue]));
  const personIds = new Set(ctx.personIds);
  const memoryIds = new Set(ctx.memoryIds);
  const agentNames = new Set(ctx.agentNames);
  const mintRef = refMinter(ctx.existing.map((issue) => issue.ref));
  const seen = new Set<string>();
  const writes: IssueWrite[] = [];

  for (const entry of raw.slice(0, MAX_ISSUES_PER_PASS)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const statement = text(value.statement, 600);
    if (!statement) continue;

    const claimed = text(value.ref, 40);
    const existing = claimed ? byRef.get(claimed) : undefined;
    const ref = existing?.ref ?? mintRef();
    if (seen.has(ref)) continue;
    seen.add(ref);

    const status = oneOf<IssueStatus>(value.status, ['open', 'resolved', 'dismissed'], 'open');
    // An unreadable severity must never quietly downgrade an issue that is already
    // on the list: keep what it had, and only a brand-new issue defaults.
    const severity = oneOf<Severity>(
      value.severity,
      ['material', 'presentational', 'question'],
      existing?.severity ?? 'question',
    );
    const claimedAssignee = text(value.assigneeId, 80);
    const assigneeId = personIds.has(claimedAssignee) ? claimedAssignee : existing?.assigneeId ?? null;
    const raisedBy = Array.isArray(value.raisedBy)
      ? [...new Set(value.raisedBy.map((name) => text(name, 120)).filter((name) => agentNames.has(name)))]
      : [];
    const flags = Array.isArray(value.flags)
      ? (value.flags
          .map((entry) => text(entry, 20).toLowerCase())
          .filter((entry) => entry === 'new' || entry === 'revised' || entry === 'contradicts') as IssueFlag[])
      : [];
    const memory = (() => {
      const raw = (value.memory ?? null) as { entryId?: unknown; effect?: unknown } | null;
      if (!raw || typeof raw !== 'object') return null;
      const entryId = text(raw.entryId, 80);
      const effect = text(raw.effect, 300);
      return memoryIds.has(entryId) && effect ? { entryId, effect } : null;
    })();

    writes.push({
      ref,
      location: text(value.location, 160),
      severity,
      status,
      statement,
      whyItMatters: text(value.whyItMatters, 1200),
      raisedBy: raisedBy.length > 0 ? raisedBy : existing?.raisedBy ?? [],
      assigneeId,
      assigneeReason: text(value.assigneeReason, 400),
      // A brand-new issue is marked new even when the model forgot to say so.
      flags: existing ? flags : [...new Set<IssueFlag>([...flags, 'new'])],
      evidence: asEvidence(value.evidence) ?? existing?.evidence ?? null,
      memory,
      conflict: asConflict(value.conflict),
      draft: text(value.draft, 4000) || null,
      resolution: status === 'resolved' ? text(value.resolution, 800) || null : null,
      sortOrder: SEVERITY_RANK[severity] * 1000 + writes.length,
    });
  }
  return writes;
}

/* ───────── running a pass ───────── */

export async function startPass(
  env: Env,
  reviewId: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Pass> {
  const review = await getReviewSummary(env, reviewId);
  if (review.running) {
    throw new HttpError(409, 'pass_running', 'A pass is already running on this review.');
  }

  const [documents, agents, feedback] = await Promise.all([
    readDocuments(env, reviewId),
    listPanelAgents(env),
    listPendingFeedback(env, reviewId),
  ]);
  if (documents.length === 0) {
    throw new HttpError(400, 'no_documents', 'Add at least one document before running the panel.');
  }
  const enabled = agents.filter((agent) => agent.enabled);
  if (enabled.length === 0) {
    throw new HttpError(400, 'no_agents', 'Switch on at least one agent before running the panel.');
  }
  if (feedback.some((batch) => batch.status === 'linking')) {
    throw new HttpError(
      400,
      'feedback_linking',
      'The panel is still reading a pasted reply. Wait for its proposed links.',
    );
  }
  const undecided = feedback
    .filter((batch) => batch.status === 'ready')
    .flatMap((batch) => batch.links)
    .filter((link) => !link.decision).length;
  if (undecided > 0) {
    throw new HttpError(
      400,
      'feedback_undecided',
      `${undecided} proposed links still need a decision.`,
    );
  }

  // Resolves the credential — a missing or unusable agent must fail the button,
  // not the background run. Per-reviewer pins are resolved inside the run, where
  // one broken pin costs that reviewer rather than the whole pass.
  await credentialResolver(env);

  const history = await listPasses(env, reviewId);
  const number = history.reduce((max, pass) => Math.max(max, pass.number), 0) + 1;
  const id = `pass-${crypto.randomUUID()}`;
  const startedAt = now();
  // Conditional insert: two clicks that arrive together must not both start a
  // pass. SQLite evaluates the NOT EXISTS as part of the write, so exactly one
  // of them writes a row and the other is told a pass is already running.
  const claimed = await env.DB.prepare(
    `INSERT INTO passes (id, review_id, number, status, detail, started_at)
     SELECT ?, ?, ?, 'running', '[]', ?
     WHERE NOT EXISTS (SELECT 1 FROM passes WHERE review_id = ? AND status = 'running')`,
  )
    .bind(id, reviewId, number, startedAt, reviewId)
    .run();
  if (!claimed.meta.changes) {
    throw new HttpError(409, 'pass_running', 'A pass is already running on this review.');
  }

  waitUntil(
    runPass(env, { passId: id, reviewId }).catch(async (error) => {
      await finish(env, id, 'failed', null, safeErrorText(error instanceof Error ? error.message : error), []);
    }),
  );

  return {
    id,
    number,
    status: 'running',
    openCount: null,
    error: null,
    agents: enabled.map((agent) => ({ key: agent.key, name: agent.name, findings: null, error: null })),
    memoryEffects: 0,
    startedAt,
    finishedAt: null,
  };
}

async function finish(
  env: Env,
  passId: string,
  status: 'done' | 'failed',
  openCount: number | null,
  error: string | null,
  agents: PassAgentResult[],
  memoryEffects = 0,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE passes SET status = ?, open_count = ?, error = ?, detail = ?, finished_at = ? WHERE id = ?',
  )
    .bind(status, openCount, error, JSON.stringify({ agents, memoryEffects }), now(), passId)
    .run();
}

async function runPass(
  env: Env,
  options: { passId: string; reviewId: string },
): Promise<void> {
  const { passId, reviewId } = options;
  const credentialOf = await credentialResolver(env);
  const [review, documents, agents, consolidator, roster, memory, issues, feedback] =
    await Promise.all([
      getReviewSummary(env, reviewId),
      readDocuments(env, reviewId),
      listPanelAgents(env),
      getConsolidator(env),
      listRoster(env, reviewId),
      listScopedMemory(env, reviewId),
      listIssues(env, reviewId),
      listPendingFeedback(env, reviewId),
    ]);

  const enabled = agents.filter((agent) => agent.enabled);
  const applied = memory.filter((entry) => entry.enabled && entry.inScope);
  const carriedIn = issues.filter((issue) => issue.status === 'open');
  const acceptedLinks = feedback.flatMap((batch) =>
    batch.links
      .filter((link) => link.decision === 'accept')
      .map((link) => ({ batch, link, issue: issues.find((i) => i.id === link.issueId) })),
  );

  const ctx: PassContext = {
    header: `THE REVIEW\n${review.name} — prepared by ${review.counterparty || 'a third party'} — ${review.period || 'no period stated'}`,
    memory: applied.length
      ? `WHAT THIS WORKSPACE ALREADY KNOWS — apply every line\n${bullet(
          applied.map((entry) => `[${entry.id}] [${entry.kind}] ${entry.text}`),
        )}`
      : '',
    documents: documentsBlock(documents),
    carried: carriedIn.length
      ? `ISSUES CARRIED IN FROM THE LAST PASS\n${bullet(
          carriedIn.map(
            (issue) =>
              `${issue.ref} · ${issue.severity} · ${issue.location} · assigned to ${issue.assigneeId ?? 'nobody'} · ${issue.statement}`,
          ),
        )}`
      : '',
    replies: acceptedLinks.length
      ? `REPLIES RECEIVED SINCE THE LAST PASS — the fund manager has accepted each of these links\n${bullet(
          acceptedLinks.map(
            ({ batch, link, issue }) =>
              `${link.effect} on ${issue?.ref ?? 'an issue'} — ${batch.fromName} wrote: "${link.quote}" — ${link.reason}`,
          ),
        )}`
      : '',
  };

  const results = await mapLimit(enabled, AGENT_CONCURRENCY, async (agent) => {
    try {
      const reply = await ask(await credentialOf(agent), buildAgentPrompt(agent.prompt, ctx), documents);
      const payload = parsePayload<{ findings?: unknown }>(reply);
      const raw = Array.isArray(payload?.findings) ? payload.findings : null;
      if (!raw) {
        return {
          agent,
          findings: [] as Record<string, unknown>[],
          result: { key: agent.key, name: agent.name, findings: null, error: 'Reply was not the expected JSON.' },
        };
      }
      const findings = raw.slice(0, 60).filter((f): f is Record<string, unknown> => !!f && typeof f === 'object');
      return {
        agent,
        findings,
        result: { key: agent.key, name: agent.name, findings: findings.length, error: null },
      };
    } catch (error) {
      return {
        agent,
        findings: [] as Record<string, unknown>[],
        result: {
          key: agent.key,
          name: agent.name,
          findings: null,
          error: safeErrorText(error instanceof Error ? error.message : error),
        },
      };
    }
  });

  const agentResults = results.map((entry) => entry.result);
  if (agentResults.every((result) => result.findings === null)) {
    const first = agentResults.find((result) => result.error)?.error ?? 'No agent returned findings.';
    await finish(env, passId, 'failed', null, `Every agent failed. ${first}`, agentResults);
    return;
  }

  const findingsBlock =
    results
      .filter((entry) => entry.result.findings !== null)
      .map((entry) => {
        if (entry.findings.length === 0) return `### ${entry.agent.name}\nNothing found.`;
        const lines = entry.findings.map((finding, index) => {
          const evidence = asEvidence(finding.evidence);
          return [
            `${index + 1}. [${text(finding.severity, 20) || 'question'}] ${text(finding.location, 160)}`,
            `   ${text(finding.statement, 600)}`,
            `   Why: ${text(finding.whyItMatters, 600)}`,
            evidence ? `   Evidence (${evidence.label}): ${evidence.lines.join(' | ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        });
        return `### ${entry.agent.name}\n${lines.join('\n')}`;
      })
      .join('\n\n') || 'No agent reported anything.';

  const rosterBlock = bullet(
    roster.map(
      (person) =>
        `${person.id} — ${person.name}${person.isSelf ? ' (the fund manager, who signs in)' : ''}, ${person.org || 'no organisation'} — title on this review: ${person.reviewTitle || 'none recorded'} — directory role: ${person.role || 'none'}`,
    ),
  );

  const reply = await ask(
    await credentialOf(consolidator),
    buildConsolidatorPrompt(consolidator.prompt, ctx, rosterBlock, findingsBlock),
  );
  const payload = parsePayload<{ issues?: unknown }>(reply);
  if (!Array.isArray(payload?.issues)) {
    await finish(
      env,
      passId,
      'failed',
      null,
      'The consolidator did not return an issue list. No issue was changed.',
      agentResults,
    );
    return;
  }

  const writes = consolidateIssues(payload.issues, {
    existing: issues,
    personIds: roster.map((person) => person.id),
    memoryIds: memory.map((entry) => entry.id),
    agentNames: agents.map((agent) => agent.name),
  });

  if (writes.length > 0) {
    await env.DB.batch(writes.map((issue) => upsertIssueStatement(env, reviewId, issue)));
  }
  // Replies folded into this pass stop being pending work. A batch the panel
  // could not read is left alone: it holds nothing, and the user decides whether
  // to paste it again or discard it.
  const folded = feedback.filter((batch) => batch.status === 'ready');
  if (folded.length > 0) {
    await env.DB.batch(
      folded.map((batch) =>
        env.DB.prepare('UPDATE feedback_batches SET applied_at = ? WHERE id = ?').bind(now(), batch.id),
      ),
    );
  }
  await env.DB.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').bind(now(), reviewId).run();

  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM issues WHERE review_id = ? AND status = 'open'",
  )
    .bind(reviewId)
    .first<{ n: number }>();

  await finish(
    env,
    passId,
    'done',
    open?.n ?? 0,
    null,
    agentResults,
    writes.filter((issue) => issue.memory).length,
  );
}

/* ───────── the retrospective ───────── */

const MAX_LESSONS = 12;

export interface LessonContext {
  /** Refs that exist on this review. A lesson may only cite these. */
  refs: string[];
}

/**
 * Validates the retrospective's proposed rules.
 *
 * Same contract as `consolidateIssues`: the model is untrusted, this never throws,
 * and anything unreadable is dropped rather than guessed at. A lesson that cites
 * no issue on this review is dropped outright — the prompt asks for rules tied to
 * evidence, and an untethered rule would be applied to every future review.
 */
export function parseLessons(raw: unknown[], ctx: LessonContext): Omit<RetrospectiveLesson, 'memoryId'>[] {
  const refs = new Set(ctx.refs);
  const seen = new Set<string>();
  const lessons: Omit<RetrospectiveLesson, 'memoryId'>[] = [];

  for (const entry of raw.slice(0, MAX_LESSONS * 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const body = text(value.text, 2000);
    if (!body) continue;
    // Two lessons that say the same thing would become two memory entries the
    // user has to switch off separately.
    const fingerprint = body.toLowerCase();
    if (seen.has(fingerprint)) continue;

    const basis = Array.isArray(value.basis)
      ? [...new Set(value.basis.map((ref) => text(ref, 40)).filter((ref) => refs.has(ref)))].slice(0, 8)
      : [];
    if (basis.length === 0) continue;

    seen.add(fingerprint);
    lessons.push({ kind: oneOf<MemoryKind>(value.kind, MEMORY_KINDS, 'Treatment'), text: body, basis });
    if (lessons.length >= MAX_LESSONS) break;
  }
  return lessons;
}

interface RetrospectiveContext {
  header: string;
  history: string;
  issues: string;
  known: string;
  replies: string;
}

export function buildRetrospectivePrompt(agentPrompt: string, ctx: RetrospectiveContext): string {
  return [
    agentPrompt,
    '───────────────────────────────────────',
    ctx.header,
    ctx.history,
    ctx.issues,
    ctx.known,
    ctx.replies,
    '───────────────────────────────────────',
    `${JSON_ONLY}

{"summary":"how this review went, in a short paragraph addressed to the fund manager","wentWell":["something the panel got right, one line each"],"toChange":["something to do differently next period, one line each"],"lessons":[{"kind":"Treatment|Pattern|Instruction|Fact","text":"the rule, phrased so the panel can apply it next period","basis":["the refs of the issues this is drawn from"]}]}

Rules:
- Every lesson must cite at least one ref from the issues above in "basis". A lesson citing nothing is dropped.
- Do not propose a rule that merely restates something under WHAT THIS WORKSPACE ALREADY KNOWS.
- Treatment: already agreed with the counterparty, so stop re-raising it. Pattern: a defect that recurs, so look there first. Instruction: a standing rule of the fund manager's. Fact: something true about the fund the deliverable does not reflect.
- Return {"lessons":[]} when nothing this period is worth carrying forward. That is a real answer.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Closes out a review: one A2A turn that looks back at every pass and issue, then
 * writes the summary and mints the proposed rules as memory entries.
 *
 * Every entry is written switched OFF. The retrospective is the only thing in the
 * product that writes to memory without the user typing it, and memory is injected
 * into every reviewer prompt on every future review — so a rule it gets wrong must
 * be inert until someone reads it and switches it on.
 *
 * Nothing here can fail the close: `startRetrospective` runs under waitUntil and
 * every error lands on the retrospective row, where the review page shows it.
 */
export async function startRetrospective(
  env: Env,
  reviewId: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  const id = await claimRetrospective(env, reviewId);
  if (!id) return; // One is already running on this review.
  waitUntil(
    runRetrospective(env, id, reviewId).catch(async (error) => {
      await finishRetrospective(env, id, {
        status: 'failed',
        error: safeErrorText(error instanceof Error ? error.message : error),
      });
    }),
  );
}

async function runRetrospective(env: Env, id: string, reviewId: string): Promise<void> {
  const [review, agent, issues, passes, memory, roster, feedback] = await Promise.all([
    getReviewSummary(env, reviewId),
    getRetrospective(env),
    listIssues(env, reviewId),
    listPasses(env, reviewId),
    listScopedMemory(env, reviewId),
    listRoster(env, reviewId),
    listPendingFeedback(env, reviewId),
  ]);

  if (issues.length === 0) {
    await finishRetrospective(env, id, {
      status: 'done',
      summary: 'This review was closed without a single issue on it, so there is nothing to look back at.',
    });
    return;
  }

  // Resolved after the empty-review check: a review with nothing on it should
  // close cleanly even with no agent connected.
  const cred = await (await credentialResolver(env))(agent);
  const byId = new Map(roster.map((person) => [person.id, person.name]));
  const done = passes.filter((pass) => pass.status === 'done');

  const ctx: RetrospectiveContext = {
    header: `THE REVIEW, NOW CLOSED\n${review.name} — prepared by ${review.counterparty || 'a third party'} — ${review.period || 'no period stated'}`,
    history: done.length
      ? `HOW IT CONVERGED — open issues after each pass\n${bullet(
          done.map(
            (pass) =>
              `pass ${pass.number}: ${pass.openCount ?? 0} open — ${pass.agents
                .map((result) => `${result.name}: ${result.error ? 'did not answer' : `${result.findings} findings`}`)
                .join(', ')}`,
          ),
        )}`
      : '',
    issues: `EVERY ISSUE RAISED ON THIS REVIEW\n${bullet(
      issues.map((issue) =>
        [
          `${issue.ref} · ${issue.severity} · ${issue.status}`,
          `assigned to ${issue.assigneeId ? byId.get(issue.assigneeId) ?? issue.assigneeId : 'nobody'}`,
          `raised by ${issue.raisedBy.length ? issue.raisedBy.join(' + ') : 'unrecorded'}`,
          issue.statement,
          issue.resolution ? `settled: ${issue.resolution}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    )}`,
    known: memory.filter((entry) => entry.enabled).length
      ? `WHAT THIS WORKSPACE ALREADY KNOWS — do not propose these again\n${bullet(
          memory.filter((entry) => entry.enabled).map((entry) => `[${entry.kind}] ${entry.text}`),
        )}`
      : '',
    replies: feedback.length
      ? `REPLIES RECEIVED DURING THIS REVIEW\n${bullet(
          feedback.map((batch) => `${batch.fromName}: "${batch.text.slice(0, 600)}"`),
        )}`
      : '',
  };

  const payload = parsePayload<{
    summary?: unknown;
    wentWell?: unknown;
    toChange?: unknown;
    lessons?: unknown;
  }>(await ask(cred, buildRetrospectivePrompt(agent.prompt, ctx)));

  if (!payload) {
    await finishRetrospective(env, id, {
      status: 'failed',
      error: 'The retrospective did not return the expected JSON. Nothing was written to memory.',
    });
    return;
  }

  const lines = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((line) => text(line, 400)).filter(Boolean).slice(0, 8) : [];

  const proposed = parseLessons(Array.isArray(payload.lessons) ? payload.lessons : [], {
    refs: issues.map((issue) => issue.ref),
  });

  // Written one at a time rather than batched: createMemoryEntry mints the id, and
  // a lesson whose entry fails to write should cost that lesson, not the close-out.
  const lessons: RetrospectiveLesson[] = [];
  for (const lesson of proposed) {
    try {
      const entry = await createMemoryEntry(env, {
        kind: lesson.kind,
        text: lesson.text,
        source: `${review.name} · retrospective`,
        sourceReviewId: reviewId,
        enabled: false,
      });
      lessons.push({ ...lesson, memoryId: entry.id });
    } catch {
      lessons.push({ ...lesson, memoryId: null });
    }
  }

  await finishRetrospective(env, id, {
    status: 'done',
    summary: text(payload.summary, 4000),
    wentWell: lines(payload.wentWell),
    toChange: lines(payload.toChange),
    lessons,
  });
  await env.DB.prepare('UPDATE reviews SET updated_at = ? WHERE id = ?').bind(now(), reviewId).run();
}

/* ───────── linking a pasted reply ───────── */

/** Proposes links from a pasted reply to the open issues. Never decides them. */
export async function linkFeedback(env: Env, reviewId: string, batchId: string): Promise<void> {
  try {
    const [credentialOf, consolidator, issues, batches] = await Promise.all([
      credentialResolver(env),
      getConsolidator(env),
      listIssues(env, reviewId),
      listPendingFeedback(env, reviewId),
    ]);
    const cred = await credentialOf(consolidator);
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return;
    const open = issues.filter((issue) => issue.status === 'open');
    if (open.length === 0) {
      await env.DB.prepare("UPDATE feedback_batches SET status = 'ready' WHERE id = ?")
        .bind(batchId)
        .run();
      return;
    }

    const prompt = [
      consolidator.prompt,
      '───────────────────────────────────────',
      `A reply arrived from ${batch.fromName}. Say which open issues it touches, and how.`,
      `OPEN ISSUES\n${bullet(open.map((issue) => `${issue.ref} — ${issue.statement}`))}`,
      `THE REPLY, VERBATIM\n"""\n${batch.text.slice(0, 20_000)}\n"""`,
      '───────────────────────────────────────',
      `${JSON_ONLY}

{"links":[{"ref":"TZ-047","effect":"RESOLVES|PARTIAL|CONTRADICTS|CONTEXT","quote":"the sentence from the reply, copied exactly","reason":"why it has that effect on that issue","confidence":"high|medium|low"}]}

RESOLVES answers the issue outright. PARTIAL answers some of it. CONTRADICTS conflicts with the issue or an earlier reply. CONTEXT is useful but settles nothing.
Return {"links":[]} if the reply touches none of them. Quote only text that appears in the reply.`,
    ].join('\n\n');

    const payload = parsePayload<{ links?: unknown }>(await ask(cred, prompt));
    const raw = Array.isArray(payload?.links) ? payload.links : null;
    if (!raw) {
      await env.DB.prepare(
        "UPDATE feedback_batches SET status = 'failed', error = ? WHERE id = ?",
      )
        .bind('The panel did not return a link list. Paste the reply again, or run the pass without it.', batchId)
        .run();
      return;
    }

    const byRef = new Map(open.map((issue) => [issue.ref, issue]));
    const statements = raw
      .slice(0, 40)
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object') return null;
        const link = entry as Record<string, unknown>;
        const issue = byRef.get(text(link.ref, 40));
        if (!issue) return null;
        return env.DB.prepare(
          `INSERT INTO feedback_links (id, batch_id, issue_id, effect, quote, reason, confidence, decision, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).bind(
          `fl-${crypto.randomUUID()}`,
          batchId,
          issue.id,
          oneOf(link.effect, ['RESOLVES', 'PARTIAL', 'CONTRADICTS', 'CONTEXT'] as const, 'CONTEXT'),
          text(link.quote, 800),
          text(link.reason, 600),
          oneOf(link.confidence, ['high', 'medium', 'low'] as const, 'medium'),
          index,
        );
      })
      .filter((statement): statement is D1PreparedStatement => statement !== null);

    if (statements.length > 0) await env.DB.batch(statements);
    await env.DB.prepare("UPDATE feedback_batches SET status = 'ready', error = NULL WHERE id = ?")
      .bind(batchId)
      .run();
  } catch (error) {
    await env.DB.prepare("UPDATE feedback_batches SET status = 'failed', error = ? WHERE id = ?")
      .bind(safeErrorText(error instanceof Error ? error.message : error), batchId)
      .run();
  }
}

/** Is there a connected agent for the panel to run on at all? */
export async function panelReady(env: Env): Promise<boolean> {
  const connected = await listConnectedAgents(env);
  return connected.length > 0;
}
