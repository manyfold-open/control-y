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
  Pass,
  PassAgentResult,
  Severity,
} from '../shared/types';
import { HttpError, type AgentCredential, type Env } from './types';
import { A2AError, consumeA2AStream, safeErrorText } from './a2a';
import { credentialFor, listConnectedAgents } from './connect';
import { now } from './db';
import {
  getConsolidator,
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
} from './store';

const TURN_TIMEOUT_MS = 4 * 60_000;
const AGENT_CONCURRENCY = 3;
const DOC_CHARS_EACH = 24_000;
const DOC_CHARS_TOTAL = 60_000;
const MAX_ISSUES_PER_PASS = 200;

/* ───────── one A2A turn ───────── */

/** Which connected Manyfold agent the panel prompts run on. */
async function panelCredential(env: Env): Promise<AgentCredential> {
  const connected = await listConnectedAgents(env);
  const chosen = connected.find((agent) => agent.verified) ?? connected[0];
  if (!chosen) {
    throw new HttpError(
      400,
      'no_agent',
      'Connect a Manyfold agent under Connections before running the panel.',
    );
  }
  return credentialFor(env, chosen.agentId);
}

/**
 * One stateless turn: no contextId, so each prompt is read on its own and one
 * agent's reading cannot colour another's.
 *
 * messageId is fresh per call, unlike the chat's derived ids. A2A treats it as
 * an idempotency key, and every panel call is a distinct prompt sent exactly
 * once — a pass is never retried in place, only re-run as a new pass.
 */
async function ask(cred: AgentCredential, prompt: string): Promise<string> {
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
          parts: [{ kind: 'text', text: prompt }],
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

function documentsBlock(docs: { name: string; content: string }[]): string {
  let budget = DOC_CHARS_TOTAL;
  return docs
    .map((doc) => {
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
  // not the background run.
  const cred = await panelCredential(env);

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
    runPass(env, { passId: id, reviewId, cred }).catch(async (error) => {
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
  options: { passId: string; reviewId: string; cred: AgentCredential },
): Promise<void> {
  const { passId, reviewId, cred } = options;
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
      const reply = await ask(cred, buildAgentPrompt(agent.prompt, ctx));
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

  const reply = await ask(cred, buildConsolidatorPrompt(consolidator.prompt, ctx, rosterBlock, findingsBlock));
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

/* ───────── linking a pasted reply ───────── */

/** Proposes links from a pasted reply to the open issues. Never decides them. */
export async function linkFeedback(env: Env, reviewId: string, batchId: string): Promise<void> {
  try {
    const [cred, consolidator, issues, batches] = await Promise.all([
      panelCredential(env),
      getConsolidator(env),
      listIssues(env, reviewId),
      listPendingFeedback(env, reviewId),
    ]);
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
