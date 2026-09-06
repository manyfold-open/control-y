/**
 * The panel: what happens when the fund manager presses "Run pass N".
 *
 * A pass is two stages. Every enabled agent reads the deliverable against the
 * documents on its own — one A2A turn each, no shared context, so one agent's
 * reading cannot colour another's. Then the consolidator receives all of their
 * findings at once and returns the merged, assigned, drafted issue list.
 *
 * A pass is rows in D1, advanced a step at a time by short invocations: the
 * review page's poll while someone is watching, the minute cron when nobody is.
 * Turns are sent with message/send and followed with tasks/get, so nothing here
 * holds a connection while an agent thinks. Everything that can fail before the
 * first agent call is checked in `startPass`, so the button gets a real error
 * instead of a pass row that dies silently.
 *
 * Model output is untrusted. `parsePayload` never throws, every field is
 * validated against the roster and the enums, and an issue the consolidator
 * carried in but did not return is left exactly as it was.
 */

import type {
  Conflict,
  Issue,
  IssueFlag,
  IssueStatus,
  MemoryKind,
  PanelAgent,
  Pass,
  PassAgentResult,
  RetrospectiveLesson,
  ReviewSummary,
  Severity,
} from '../shared/types';
import { evidenceText, readEvidence } from '../shared/evidence';
import { MEMORY_KINDS } from '../shared/types';
import { HttpError, type AgentCredential, type Env } from './types';
import {
  A2AError,
  cancelTask,
  consumeA2AStream,
  getTask,
  safeErrorText,
  sendTask,
  type StreamSnapshot,
} from './a2a';
import {
  claimTurn,
  inFlight,
  insertTurns,
  listRunningPasses,
  listTurns,
  loadPassContext,
  markPolled,
  markSent,
  savePassContext,
  setTurnPrompt,
  settled,
  settleTurn,
  type RunningPass,
  type TurnRow,
} from './turns';
import { credentialFor, listConnectedAgents } from './connect';
import { presignFetch } from './r2';
import { now } from './db';
import {
  beat,
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
  recordIssueRevisionStatement,
  upsertIssueStatement,
  type IssueWrite,
  type PanelDocument,
} from './store';

/**
 * The ceiling on one turn, and the silence that ends it early.
 *
 * MEASURED on FY2025, whose deliverable is a 656 KB spreadsheet: these agents do
 * not stream as they think. Four of five reviewers sent nothing at all for well
 * over a minute and then answered in one burst, so silence is a poor signal for
 * a dead turn — a 90s idle bound cut off four turns that a flat four-minute
 * budget had let three of five finish.
 *
 * The idle bound therefore has to clear the longest honest think, and earns its
 * keep only against a stream that dies outright. The ceiling is what actually
 * bounds a pass. Both are generous because the alternative is throwing away a
 * turn that was about to answer, and a turn costs real money.
 */
const TURN_TIMEOUT_MS = 12 * 60_000;
const TURN_IDLE_MS = 6 * 60_000;
const AGENT_CONCURRENCY = 3;
/** Floor between two progress events from the same agent. Same figure as the chat. */
const PROGRESS_INTERVAL_MS = 150;
const PROGRESS_NOTE_CHARS = 200;
const DOC_CHARS_EACH = 24_000;
const DOC_CHARS_TOTAL = 60_000;
const MAX_ISSUES_PER_PASS = 200;

/* ───────── one A2A turn ───────── */

/**
 * One uploaded file, as the agent is offered it.
 *
 * MEASURED, 5 Sept 2026: Manyfold agents do not receive A2A `file` parts at all.
 * Asked to review a PDF stating a 1.95% fee against a 1.25% cap in the same
 * document, every reviewer returned nothing found, and one said so outright —
 * "I can't actually see any content from Q3 2026 fee schedule.pdf — the message
 * only contains a placeholder tag". That was true of `bytes` and of `uri`
 * alike, and was equally true before uploads moved to R2.
 *
 * The part is still sent, as a `uri`: it costs a couple of hundred bytes and
 * starts working by itself the day agents honour attachments, whereas inlining
 * `bytes` would put megabytes into every reviewer's request body for nothing.
 * What the reviewer is TOLD about the file is the honest part — see
 * `documentsBlock`, which must not claim the contents are available.
 */
interface Attachment {
  uri: string;
  mediaType: string;
  name: string;
}

/**
 * Signed once per pass, not once per reviewer, and returned two ways: as the A2A
 * file parts, and as a key -> url map for `documentsBlock` to write into the
 * prompt text. The same URL serves both, so a reviewer sees one link, not two.
 */
async function attachmentsFor(
  env: Env,
  documents: PanelDocument[],
): Promise<{ attachments: Attachment[]; urls: Map<string, string> }> {
  const files = documents.filter((document) => document.kind === 'file');
  const signed = await Promise.all(
    files.map(async (document) => ({
      key: document.key,
      uri: await presignFetch(env, document.key),
      mediaType: document.mediaType,
      name: document.name,
    })),
  );
  return {
    attachments: signed.map(({ uri, mediaType, name }) => ({ uri, mediaType, name })),
    urls: new Map(signed.map(({ key, uri }) => [key, uri])),
  };
}

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

/** What was last said about one agent, so the next snapshot can be judged against it. */
export interface ProgressState {
  state: string;
  note: string;
  /** When that was sent, in ms. */
  at: number;
}

/**
 * Whether a mid-turn snapshot is worth telling the browser about, and in what words.
 *
 * A turn emits many snapshots and three turns run at once, so most are dropped: a
 * terminal one is the `agent` event's business, and one that repeats what was
 * already said is nothing. A state change always goes through — `submitted` to
 * `working` is the whole point — while note churn under an unchanged state is rate
 * limited, since the state is the fact and the note is only prose about it.
 *
 * The note is the agent's own text on its way to a browser, so it goes through
 * `safeErrorText` like everything else that crosses out of the Worker.
 */
export function progressUpdate(
  last: ProgressState,
  snapshot: { state: string; progressText: string; terminal: boolean },
  atMs: number,
): { state: string; note: string } | null {
  if (snapshot.terminal || !snapshot.state) return null;
  const note = safeErrorText(snapshot.progressText).slice(0, PROGRESS_NOTE_CHARS);
  if (snapshot.state === last.state) {
    if (note === last.note) return null;
    if (atMs - last.at < PROGRESS_INTERVAL_MS) return null;
  }
  return { state: snapshot.state, note };
}

/**
 * One stateless turn: no contextId, so each prompt is read on its own and one
 * agent's reading cannot colour another's.
 *
 * messageId is fresh per call, unlike the chat's derived ids. A2A treats it as
 * an idempotency key, and every panel call is a distinct prompt sent exactly
 * once — a pass is never retried in place, only re-run as a new pass.
 *
 * `onProgress` is how a turn says what it is doing while it does it. It is only
 * ever a report, so the callers below keep it to an `emit` — which already gives
 * up on a browser that went away rather than throwing a UI detail into a run.
 */
async function ask(
  cred: AgentCredential,
  prompt: string,
  options: {
    attachments?: Attachment[];
    onProgress?: (update: { state: string; note: string }) => Promise<void> | void;
  } = {},
): Promise<string> {
  const { attachments = [], onProgress } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  let last: ProgressState = { state: '', note: '', at: 0 };
  try {
    const snapshot = await consumeA2AStream({
      cred,
      onSnapshot: onProgress
        ? async (current) => {
            const update = progressUpdate(last, current, Date.now());
            if (!update) return;
            last = { ...update, at: Date.now() };
            await onProgress(update);
          }
        : undefined,
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: `turnzero-${crypto.randomUUID()}`,
          parts: [
            { kind: 'text', text: prompt },
            ...attachments.map((attachment) => ({
              kind: 'file',
              file: {
                uri: attachment.uri,
                mimeType: attachment.mediaType,
                name: attachment.name,
              },
            })),
          ],
        },
        configuration: { acceptedOutputModes: ['text/plain'] },
      },
      signal: controller.signal,
      idleMs: TURN_IDLE_MS,
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

/* ───────── validation of model output ───────── */

const text = (value: unknown, limit = 2000): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

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
const indent = (block: string, by: number): string =>
  block
    .split('\n')
    .map((line) => `${' '.repeat(by)}${line}`)
    .join('\n');

/**
 * The documents, as prose in the prompt.
 *
 * A file gets its download URL written into the text. The A2A `file` part is
 * dropped before the model ever sees it, but the text part plainly is not — an
 * agent quoted our placeholder back at us — so the text is the only channel that
 * reaches it. An agent that can fetch a URL can now read the document; one that
 * cannot is told so in the same breath, and told not to report clean over it.
 *
 * The URL is a bearer capability, and putting it in the prompt puts it wherever
 * the agent's transcript goes. It expires in an hour and grants read on one
 * object, which is the same grant the `file` part carried — only now somewhere
 * it can actually be used.
 */
function documentsBlock(docs: PanelDocument[], urls: Map<string, string>): string {
  let budget = DOC_CHARS_TOTAL;
  return docs
    .map((doc) => {
      if (doc.kind === 'file') {
        const url = urls.get(doc.key);
        return url
          ? `### ${doc.name}\nA ${doc.mediaType} file. Its contents are not inlined here, so download it yourself:\n${url}\nThe link works for one hour and needs no credentials. If you cannot fetch it, say so and do not report this document as reviewed.`
          : `### ${doc.name}\n[a ${doc.mediaType} file is held with this review, but its contents are NOT available to you. Do not treat it as reviewed, and say so if a finding would depend on it.]`;
      }
      const room = Math.min(DOC_CHARS_EACH, budget);
      budget -= room;
      if (room <= 0) return `### ${doc.name}\n[not included: document budget reached]`;
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

/**
 * Every prose field a prompt returns is rendered verbatim in the app, so the
 * house style has to reach the model. Stripping em dashes on the way out would
 * mean rewriting a sentence the model built around one; asking for the sentence
 * it would have written instead costs a line.
 */
const HOUSE_STYLE =
  'House style: never use an em dash in any string you return. Use a comma, a colon, or a new sentence instead.';

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
${HOUSE_STYLE}

{"findings":[{"location":"where in the deliverable, e.g. staging!row 47","severity":"material|presentational|question","statement":"one sentence saying what is wrong","whyItMatters":"why it matters to the fund manager","evidence":{"label":"file and location","quote":"a passage quoted from the document, when the proof is prose, otherwise null","rows":[{"field":"the field or line item","value":"what it holds, exactly as the document has it","note":"what does not resolve about it, or null"}]}}]}

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
    `THE REVIEW ROSTER: assign every issue to exactly one of these ids\n${roster}`,
    ctx.memory,
    ctx.carried,
    ctx.replies,
    `WHAT THE PANEL FOUND\n${findings}`,
    '───────────────────────────────────────',
    `${JSON_ONLY}
${HOUSE_STYLE}

{"issues":[{"ref":"the ref of an issue carried in, or null when new","status":"open|resolved|dismissed","severity":"material|presentational|question","location":"where in the deliverable","statement":"one sentence saying what is wrong","whyItMatters":"why it matters","raisedBy":["the exact name of each agent that found it"],"assigneeId":"an id from the roster","assigneeReason":"why this person and not another, in one sentence","flags":["new","revised","contradicts"],"evidence":{"label":"...","quote":"...","rows":[{"field":"...","value":"...","note":"..."}]},"memory":{"entryId":"the id of the memory entry that changed this issue","effect":"what it changed, in one line"},"conflict":{"positions":[{"agent":"name","verdict":"its position"}],"ruling":"your ruling and why"},"draft":"the message to send to the assignee, signed by nobody","resolution":"how it was settled, only when status is resolved"}]}

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
      evidence: readEvidence(value.evidence) ?? existing?.evidence ?? null,
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

/**
 * A pass is rows, not a stream.
 *
 * `startPass` validates, claims the row, writes one turn per enabled reviewer and
 * one for the consolidator, sends the first reviewers, and returns — in well under
 * a second. Everything after that happens in `advancePasses`, which any short
 * invocation may call: the review page's poll does, every few seconds while a pass
 * is running, and so does the minute cron, so a pass finishes whether or not anyone
 * is watching it.
 *
 * It used to be one invocation that waited, and it died three different ways: the
 * idle stream to the browser was dropped at 60s, its subrequest allowance ran out
 * at ~210s, and a closed tab took it with it. Every time, `tasks/list` on the agent
 * showed the reviewers had finished anyway, with nobody left to collect. This shape
 * has no connection to lose, spends a handful of subrequests per invocation, and can
 * cancel a turn that has gone quiet instead of leaving it holding one of the
 * account's eight delegation slots.
 */

/** Ask after an in-flight turn no more often than this. A poll is a subrequest. */
const TURN_POLL_MS = 10_000;
/** Fetches one advance may make: well under the invocation's allowance, with D1 left over. */
const ADVANCE_FETCH_BUDGET = 12;
/**
 * A running row with no turns belongs to a build that ran passes as one long
 * invocation. That invocation went with the build, so nothing else will ever settle
 * the row; after this long, this does.
 */
const LEGACY_STALE_MS = 60_000;

/** The fetches one advance has left. Shared by everything it does. */
interface FetchBudget {
  remaining: number;
}

const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const resultsOf = (turns: TurnRow[]): PassAgentResult[] =>
  turns.map((turn) => ({ key: turn.key, name: turn.name, findings: turn.findings, error: turn.error }));

const due = (turn: TurnRow, nowMs: number): boolean =>
  turn.polled_at === null || nowMs - Date.parse(turn.polled_at) >= TURN_POLL_MS;

/**
 * Validates and claims a pass, plans its turns, and sends the first reviewers.
 *
 * Everything that can fail before an agent is asked anything fails here, as an
 * HTTP error the button can show. What comes back is the pass as it now stands:
 * running, with each reviewer either sent or waiting its turn.
 */
export async function startPass(env: Env, reviewId: string): Promise<Pass> {
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

  // A missing or unusable agent must fail the button, not the run. Per-reviewer
  // pins are resolved when each turn is sent, where one broken pin costs that
  // reviewer rather than the whole pass.
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

  try {
    await planPass(env, { id, reviewId, review, documents, enabled, startedAt });
  } catch (error) {
    // The row is claimed, so it has to be settled here or it blocks the review.
    const message = safeErrorText(error instanceof Error ? error.message : error);
    await finish(env, id, 'failed', null, message, []);
    throw error instanceof HttpError ? error : new HttpError(502, 'pass_failed', message);
  }

  const pass = (await listPasses(env, reviewId)).find((candidate) => candidate.id === id);
  if (!pass) throw new HttpError(500, 'internal', 'The pass was started but could not be read back.');
  return pass;
}

/**
 * Writes the turns and sends the first reviewers. The context every prompt is built
 * from is written down too, so the consolidator's prompt, written minutes from now,
 * reads from the same facts the reviewers did.
 */
async function planPass(
  env: Env,
  options: {
    id: string;
    reviewId: string;
    review: ReviewSummary;
    documents: PanelDocument[];
    enabled: PanelAgent[];
    startedAt: string;
  },
): Promise<void> {
  const { id, reviewId, review, documents, enabled } = options;
  const [consolidator, memory, issues, feedback] = await Promise.all([
    getConsolidator(env),
    listScopedMemory(env, reviewId),
    listIssues(env, reviewId),
    listPendingFeedback(env, reviewId),
  ]);

  const applied = memory.filter((entry) => entry.enabled && entry.inScope);
  const carriedIn = issues.filter((issue) => issue.status === 'open');
  const acceptedLinks = feedback.flatMap((batch) =>
    batch.links
      .filter((link) => link.decision === 'accept')
      .map((link) => ({ batch, link, issue: issues.find((i) => i.id === link.issueId) })),
  );

  // Signed before the context is built: the links go into the prompt text, which
  // is the only channel that reaches the model.
  const { attachments, urls } = await attachmentsFor(env, documents);

  const ctx: PassContext = {
    header: `THE REVIEW\n${review.name} · prepared by ${review.counterparty || 'a third party'} · ${review.period || 'no period stated'}`,
    memory: applied.length
      ? `WHAT THIS WORKSPACE ALREADY KNOWS, apply every line\n${bullet(
          applied.map((entry) => `[${entry.id}] [${entry.kind}] ${entry.text}`),
        )}`
      : '',
    documents: documentsBlock(documents, urls),
    carried: carriedIn.length
      ? `ISSUES CARRIED IN FROM THE LAST PASS\n${bullet(
          carriedIn.map(
            (issue) =>
              `${issue.ref} · ${issue.severity} · ${issue.location} · assigned to ${issue.assigneeId ?? 'nobody'} · ${issue.statement}`,
          ),
        )}`
      : '',
    replies: acceptedLinks.length
      ? `REPLIES RECEIVED SINCE THE LAST PASS, the fund manager has accepted each of these links\n${bullet(
          acceptedLinks.map(
            ({ batch, link, issue }) =>
              `${link.effect} on ${issue?.ref ?? 'an issue'} · ${batch.fromName} wrote: "${link.quote}" · ${link.reason}`,
          ),
        )}`
      : '',
  };

  await savePassContext(env, id, ctx);
  await insertTurns(env, [
    ...enabled.map((agent) => ({
      pass_id: id,
      review_id: reviewId,
      key: agent.key,
      name: agent.name,
      role: 'reviewer' as const,
      agent_id: agent.agentId,
      prompt: buildAgentPrompt(agent.prompt, ctx),
      attachments,
      state: 'queued',
    })),
    {
      pass_id: id,
      review_id: reviewId,
      key: consolidator.key,
      name: consolidator.name,
      role: 'consolidator' as const,
      agent_id: consolidator.agentId,
      // Written when the reviewers are in: it is made of what they found.
      prompt: '',
      attachments: [],
      state: 'waiting',
    },
  ]);

  await advancePass(env, { id, review_id: reviewId, started_at: options.startedAt });
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
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE passes SET status = ?, open_count = ?, error = ?, detail = ?, finished_at = ? WHERE id = ?',
    ).bind(status, openCount, error, JSON.stringify({ agents, memoryEffects }), now(), passId),
    env.DB.prepare('DELETE FROM pass_contexts WHERE pass_id = ?').bind(passId),
  ]);
}

/**
 * Moves every running pass along by one step. Safe to call from anywhere, as often
 * as you like: it asks after a turn no more than once per TURN_POLL_MS, spends at
 * most ADVANCE_FETCH_BUDGET fetches, and every transition that must happen exactly
 * once is a conditional write.
 */
export async function advancePasses(env: Env): Promise<void> {
  for (const pass of await listRunningPasses(env)) {
    try {
      await advancePass(env, pass);
    } catch (error) {
      // One pass's trouble must not stop the read that triggered this, nor the
      // other passes. The next advance will try again.
      console.error('advance', safeErrorText(error instanceof Error ? error.message : error));
    }
  }
}

async function advancePass(env: Env, pass: RunningPass): Promise<void> {
  let turns = await listTurns(env, pass.id);
  if (turns.length === 0 || !turns.some((turn) => turn.role === 'consolidator')) {
    if (Date.now() - Date.parse(pass.started_at) > LEGACY_STALE_MS) {
      await finish(
        env,
        pass.id,
        'failed',
        null,
        'The pass stopped before it finished, so nothing was written. Run it again.',
        [],
      );
    }
    return;
  }

  let credentialOf: CredentialFor;
  try {
    credentialOf = await credentialResolver(env);
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    await finish(env, pass.id, 'failed', null, message, resultsOf(turns.filter((t) => t.role === 'reviewer')));
    return;
  }

  const budget: FetchBudget = { remaining: ADVANCE_FETCH_BUDGET };
  const nowMs = Date.now();

  // 0. A consolidator that landed a while ago on a pass still marked running means
  // the advance that settled it died before it could finish the pass. Finish it now
  // — after a pause long enough that a live `completePass` is not still at work.
  const landed = turns.find((turn) => turn.role === 'consolidator' && settled(turn));
  if (landed && nowMs - Date.parse(landed.finished_at!) > LEGACY_STALE_MS) {
    const reviewers = turns.filter((turn) => turn.role === 'reviewer');
    await completePass(env, pass, { settled: true, reply: landed.reply, error: landed.error }, resultsOf(reviewers));
    return;
  }

  // 1. Follow what is in flight. Whoever settles the consolidator finishes the pass.
  for (const turn of turns) {
    if (!inFlight(turn) || !due(turn, nowMs) || budget.remaining <= 0) continue;
    const outcome = await followTurn(env, turn, pass, credentialOf, budget);
    if (turn.role === 'consolidator' && outcome.settled) {
      const reviewers = (await listTurns(env, pass.id)).filter((t) => t.role === 'reviewer');
      await completePass(env, pass, outcome, resultsOf(reviewers));
      return;
    }
  }

  turns = await listTurns(env, pass.id);
  const reviewers = turns.filter((turn) => turn.role === 'reviewer');
  const consolidator = turns.find((turn) => turn.role === 'consolidator')!;

  // 2. Send reviewers that are still waiting for room. AGENT_CONCURRENCY is how
  // many the pass has out at once; the account's delegation cap is shared with
  // everything else the team runs, so a refused send is left queued and simply
  // sent again next time, with the same messageId.
  let room = AGENT_CONCURRENCY - reviewers.filter(inFlight).length;
  for (const turn of reviewers) {
    if (turn.state !== 'queued' || settled(turn)) continue;
    if (nowMs - Date.parse(pass.started_at) > TURN_TIMEOUT_MS) {
      await settleTurn(env, turn.id, {
        state: 'failed',
        reply: null,
        findings: null,
        error: `Could not be sent. ${turn.error ?? 'The agent kept refusing the turn.'}`,
      });
      continue;
    }
    if (room <= 0 || budget.remaining <= 0) break;
    if ((await sendTurn(env, turn, credentialOf, budget)).accepted) room -= 1;
  }

  turns = await listTurns(env, pass.id);
  const reviewersNow = turns.filter((turn) => turn.role === 'reviewer');
  if (!reviewersNow.every(settled)) return;

  // 3. The reviewers are in. Either nobody answered, or it is the consolidator's turn.
  const agentResults = resultsOf(reviewersNow);
  if (agentResults.every((result) => result.findings === null)) {
    const first = agentResults.find((result) => result.error)?.error ?? 'No agent returned findings.';
    await finish(env, pass.id, 'failed', null, `Every agent failed. ${first}`, agentResults);
    return;
  }

  if (consolidator.state === 'waiting') {
    if (budget.remaining <= 0) return;
    // Exactly one advance writes the consolidator's prompt and sends it.
    if (!(await claimTurn(env, consolidator.id, 'waiting', 'queued'))) return;
    const prompt = await consolidatorPromptFor(env, pass, reviewersNow);
    if (!prompt) {
      await finish(env, pass.id, 'failed', null, 'The pass lost the context it was built with. Run it again.', agentResults);
      return;
    }
    await setTurnPrompt(env, consolidator.id, prompt);
    const sent = await sendTurn(env, { ...consolidator, state: 'queued', prompt }, credentialOf, budget);
    // An agent that answers in the same breath has settled the turn already, and
    // no later follow will see it in flight — so the pass is finished here.
    if (sent.outcome?.settled) await completePass(env, pass, sent.outcome, agentResults);
    return;
  }
  if (consolidator.state === 'queued' && !settled(consolidator) && budget.remaining > 0) {
    // Its send was refused last time. Same messageId, so this is not a second turn.
    const sent = await sendTurn(env, consolidator, credentialOf, budget);
    if (sent.outcome?.settled) await completePass(env, pass, sent.outcome, agentResults);
  }
}

/** How one turn landed, for the caller that has to act on it. */
interface TurnOutcome {
  /** True only for the call that ended the turn. */
  settled: boolean;
  reply: string | null;
  error: string | null;
}

/** What a send did: whether the agent took the turn, and how it landed if it landed at once. */
interface SendResult {
  accepted: boolean;
  outcome: TurnOutcome | null;
}

/**
 * Sends one turn. `accepted` when the agent took it (or answered it outright, in
 * which case `outcome` says how).
 *
 * A refusal the agent calls transient — the delegation cap, most often — leaves the
 * turn queued with the reason on it; the next advance sends it again, and because
 * the messageId is the same the agent will not start a second turn if the first
 * did in fact begin. Anything the agent calls permanent fails the turn.
 */
async function sendTurn(
  env: Env,
  turn: TurnRow,
  credentialOf: CredentialFor,
  budget: FetchBudget,
): Promise<SendResult> {
  const refused: SendResult = { accepted: false, outcome: null };
  let cred: AgentCredential;
  try {
    cred = await credentialOf({ name: turn.name, agentId: turn.agent_id });
  } catch (error) {
    await settleTurn(env, turn.id, {
      state: 'failed',
      reply: null,
      findings: null,
      error: safeErrorText(error instanceof Error ? error.message : error),
    });
    return refused;
  }

  budget.remaining -= 1;
  const attachments = parseJson<Attachment[]>(turn.attachments, []);
  try {
    const snapshot = await sendTask(cred, {
      kind: 'message',
      role: 'user',
      messageId: turn.message_id,
      parts: [
        { kind: 'text', text: turn.prompt },
        ...attachments.map((attachment) => ({
          kind: 'file',
          file: { uri: attachment.uri, mimeType: attachment.mediaType, name: attachment.name },
        })),
      ],
    });
    if (snapshot.terminal) {
      // Answered in the same breath: a fast agent, or one that blocks regardless.
      await markSent(env, turn.id, { taskId: snapshot.taskId, state: snapshot.state, agentId: turn.agent_id });
      return { accepted: true, outcome: await settleFromSnapshot(env, turn, cred, snapshot) };
    }
    if (!snapshot.taskId) {
      await settleTurn(env, turn.id, {
        state: 'failed',
        reply: null,
        findings: null,
        error: `${cred.label} accepted the turn without returning a task to follow.`,
      });
      return refused;
    }
    await markSent(env, turn.id, {
      taskId: snapshot.taskId,
      state: snapshot.state || 'submitted',
      agentId: turn.agent_id,
    });
    return { accepted: true, outcome: null };
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    if (error instanceof A2AError && !error.retryable) {
      await settleTurn(env, turn.id, { state: 'failed', reply: null, findings: null, error: message });
      return refused;
    }
    await markPolled(env, turn.id, { error: message });
    return refused;
  }
}

/**
 * Asks after one in-flight turn and records the answer. Settles it when the task
 * has ended, or when it has been out longer than a turn is allowed — in which case
 * it is cancelled first, so it stops holding a delegation slot.
 */
async function followTurn(
  env: Env,
  turn: TurnRow,
  pass: RunningPass,
  credentialOf: CredentialFor,
  budget: FetchBudget,
): Promise<TurnOutcome> {
  let cred: AgentCredential;
  try {
    cred = await credentialOf({ name: turn.name, agentId: turn.agent_id });
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    const settledNow = await settleTurn(env, turn.id, { state: 'failed', reply: null, findings: null, error: message });
    return { settled: settledNow, reply: null, error: message };
  }

  budget.remaining -= 1;
  let snapshot: StreamSnapshot;
  try {
    snapshot = await getTask(cred, turn.task_id!);
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    if (error instanceof A2AError && !error.retryable) {
      const settledNow = await settleTurn(env, turn.id, { state: 'failed', reply: null, findings: null, error: message });
      return { settled: settledNow, reply: null, error: message };
    }
    // Could not ask this time. The task is still there; ask again next time.
    await markPolled(env, turn.id, { error: message });
    return { settled: false, reply: null, error: null };
  }

  if (!snapshot.terminal) {
    if (Date.now() - Date.parse(turn.sent_at ?? pass.started_at) > TURN_TIMEOUT_MS) {
      if (budget.remaining > 0) {
        budget.remaining -= 1;
        await cancelTask(cred, turn.task_id!);
      }
      const error = `${cred.label} did not answer within ${Math.round(TURN_TIMEOUT_MS / 60_000)} minutes.`;
      const settledNow = await settleTurn(env, turn.id, { state: 'canceled', reply: null, findings: null, error });
      return { settled: settledNow, reply: null, error };
    }
    await markPolled(env, turn.id, {
      state: snapshot.state || undefined,
      note: safeErrorText(snapshot.progressText).slice(0, PROGRESS_NOTE_CHARS),
      error: null,
    });
    return { settled: false, reply: null, error: null };
  }
  return settleFromSnapshot(env, turn, cred, snapshot);
}

/** Ends a turn from a terminal task, reading the reply the way the pass needs it. */
async function settleFromSnapshot(
  env: Env,
  turn: TurnRow,
  cred: AgentCredential,
  snapshot: StreamSnapshot,
): Promise<TurnOutcome> {
  const text = snapshot.text.trim();
  const end = async (fields: { state: string; reply: string | null; findings: number | null; error: string | null }) => ({
    settled: await settleTurn(env, turn.id, fields),
    reply: fields.reply,
    error: fields.error,
  });

  if (snapshot.state !== 'completed') {
    const said = text ? ` It said: "${safeErrorText(text).slice(0, 240)}"` : '';
    return end({ state: snapshot.state, reply: text || null, findings: null, error: `${cred.label} stopped at "${snapshot.state}".${said}` });
  }
  if (!text) {
    return end({ state: 'completed', reply: null, findings: null, error: `${cred.label} answered with no text.` });
  }
  if (turn.role !== 'reviewer') {
    return end({ state: 'completed', reply: text, findings: null, error: null });
  }

  const payload = parsePayload<{ findings?: unknown }>(text);
  const raw = Array.isArray(payload?.findings) ? payload.findings : null;
  if (!raw) {
    // Carry an excerpt of what it actually said. An agent that answers in prose is
    // usually explaining itself — that it could not read a document, or is
    // refusing — and "did not answer" is the least useful true thing to report.
    const excerpt = safeErrorText(text).replace(/\s+/g, ' ').trim().slice(0, 240);
    return end({
      state: 'completed',
      reply: text,
      findings: null,
      error: excerpt ? `Reply was not the expected JSON. It said: "${excerpt}"` : 'Reply was not the expected JSON.',
    });
  }
  const findings = raw.slice(0, 60).filter((f) => !!f && typeof f === 'object').length;
  return end({ state: 'completed', reply: text, findings, error: null });
}

/** The reviewers' findings, as the consolidator is shown them. */
function findingsBlockOf(reviewers: TurnRow[]): string {
  return (
    reviewers
      .filter((turn) => turn.findings !== null)
      .map((turn) => {
        const payload = parsePayload<{ findings?: unknown }>(turn.reply ?? '');
        const findings = (Array.isArray(payload?.findings) ? payload.findings : [])
          .slice(0, 60)
          .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object');
        if (findings.length === 0) return `### ${turn.name}\nNothing found.`;
        const lines = findings.map((finding, index) => {
          const evidence = readEvidence(finding.evidence);
          return [
            `${index + 1}. [${text(finding.severity, 20) || 'question'}] ${text(finding.location, 160)}`,
            `   ${text(finding.statement, 600)}`,
            `   Why: ${text(finding.whyItMatters, 600)}`,
            evidence ? `   Evidence (${evidence.label}):\n${indent(evidenceText(evidence), 5)}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        });
        return `### ${turn.name}\n${lines.join('\n')}`;
      })
      .join('\n\n') || 'No agent reported anything.'
  );
}

async function consolidatorPromptFor(env: Env, pass: RunningPass, reviewers: TurnRow[]): Promise<string | null> {
  const ctx = await loadPassContext<PassContext>(env, pass.id);
  if (!ctx) return null;
  const [consolidator, roster] = await Promise.all([getConsolidator(env), listRoster(env, pass.review_id)]);
  const rosterBlock = bullet(
    roster.map(
      (person) =>
        `${person.id} · ${person.name}${person.isSelf ? ' (the fund manager, who signs in)' : ''}, ${person.org || 'no organisation'} · title on this review: ${person.reviewTitle || 'none recorded'} · directory role: ${person.role || 'none'}`,
    ),
  );
  return buildConsolidatorPrompt(consolidator.prompt, ctx, rosterBlock, findingsBlockOf(reviewers));
}

/**
 * The consolidator has landed: turn its issue list into rows and close the pass.
 * Everything that can go wrong here is reported with the reviewers' results
 * attached, because what the panel found is worth showing even on a pass that
 * could not be finished.
 */
async function completePass(
  env: Env,
  pass: RunningPass,
  outcome: TurnOutcome,
  agentResults: PassAgentResult[],
): Promise<void> {
  const { id: passId, review_id: reviewId } = pass;
  try {
    if (outcome.error || !outcome.reply) {
      await finish(env, passId, 'failed', null, outcome.error ?? 'The consolidator answered with no text.', agentResults);
      return;
    }
    const payload = parsePayload<{ issues?: unknown }>(outcome.reply);
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

    const [issues, roster, memory, agents, feedback] = await Promise.all([
      listIssues(env, reviewId),
      listRoster(env, reviewId),
      listScopedMemory(env, reviewId),
      listPanelAgents(env),
      listPendingFeedback(env, reviewId),
    ]);
    const writes = consolidateIssues(payload.issues, {
      existing: issues,
      personIds: roster.map((person) => person.id),
      memoryIds: memory.map((entry) => entry.id),
      agentNames: agents.map((agent) => agent.name),
    });

    // What each rewritten issue said before this pass. Read off `issues`, which is
    // the state as it was loaded at the top of the run, and written in the same
    // batch as the rewrite — so the row can never be recorded against a statement
    // that failed to land.
    //
    // Keyed on the text actually differing rather than on the `revised` flag: the
    // consolidator sets that flag itself, and an issue it flags but returns
    // verbatim would otherwise leave the reader a diff of nothing.
    const byRef = new Map(issues.map((issue) => [issue.ref, issue]));
    const revisions = writes.flatMap((write) => {
      const before = byRef.get(write.ref);
      if (!before || before.statement === write.statement) return [];
      return [
        recordIssueRevisionStatement(env, before.id, passId, {
          statement: before.statement,
          severity: before.severity,
          location: before.location,
        }),
      ];
    });

    if (writes.length > 0) {
      await env.DB.batch([
        ...writes.map((issue) => upsertIssueStatement(env, reviewId, issue)),
        ...revisions,
      ]);
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
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    await finish(env, passId, 'failed', null, message, agentResults);
  }
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
${HOUSE_STYLE}

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
 *
 * It stays on waitUntil, unlike a pass, because it is a single turn and closing a
 * review should not depend on the user waiting on the page. A single turn usually
 * fits in the time work gets after its response — and when it does not, the beat
 * below stops with the Worker and the run is reaped rather than left running.
 */
export async function startRetrospective(
  env: Env,
  reviewId: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  const id = await claimRetrospective(env, reviewId);
  if (!id) return; // One is already running on this review.
  const stopBeating = beat(env, id);
  waitUntil(
    runRetrospective(env, id, reviewId)
      .catch(async (error) => {
        await finishRetrospective(env, id, {
          status: 'failed',
          error: safeErrorText(error instanceof Error ? error.message : error),
        });
      })
      .finally(stopBeating),
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
    header: `THE REVIEW, NOW CLOSED\n${review.name} · prepared by ${review.counterparty || 'a third party'} · ${review.period || 'no period stated'}`,
    history: done.length
      ? `HOW IT CONVERGED, open issues after each pass\n${bullet(
          done.map(
            (pass) =>
              `pass ${pass.number}: ${pass.openCount ?? 0} open · ${pass.agents
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
      ? `WHAT THIS WORKSPACE ALREADY KNOWS, do not propose these again\n${bullet(
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

/**
 * Proposes links from a pasted reply to the open issues. Never decides them.
 *
 * A batch left at `linking` blocks every pass on the review, so this beats for as
 * long as it runs: if the Worker goes before the batch is settled, the beat stops
 * with it and `reapStaleRuns` fails the batch rather than leaving the review stuck.
 */
export async function linkFeedback(env: Env, reviewId: string, batchId: string): Promise<void> {
  const stopBeating = beat(env, batchId);
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
      `OPEN ISSUES\n${bullet(open.map((issue) => `${issue.ref}: ${issue.statement}`))}`,
      `THE REPLY, VERBATIM\n"""\n${batch.text.slice(0, 20_000)}\n"""`,
      '───────────────────────────────────────',
      `${JSON_ONLY}
${HOUSE_STYLE}

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
  } finally {
    stopBeating();
  }
}

/** Is there a connected agent for the panel to run on at all? */
export async function panelReady(env: Env): Promise<boolean> {
  const connected = await listConnectedAgents(env);
  return connected.length > 0;
}
