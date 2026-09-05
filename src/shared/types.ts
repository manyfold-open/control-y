/**
 * Types shared between the Worker (src/worker) and the browser app (src/app).
 * Everything here is part of the JSON API surface, so keep it serializable
 * and free of runtime imports from either side.
 */

/** A Manyfold agent the user authorized, as exposed to the browser (never the token). */
export interface ConnectedAgent {
  agentId: string;
  name: string;
  description: string;
  rpcUrl: string;
  expiresAt: string | null;
  /** Did the non-billing auth probe succeed at connect / last verify time? */
  verified: boolean;
  warning: string | null;
  connectedAt: string;
}

/** An in-flight Manyfold authorization handshake, as exposed to the browser. */
export interface ConnectSession {
  connectId: string;
  /** Shown to the user to compare against Manyfold's consent page (anti-phishing). */
  userCode: string;
  authUrl: string;
  expiresAt: string;
}

export type PollStatus = 'pending' | 'denied' | 'expired' | 'approved';

export interface PollOutcome {
  status: PollStatus;
  userEmail?: string | null;
  agents?: ConnectedAgent[];
  failed?: { name: string; error: string }[];
}

/** Bootstrap payload: everything the SPA needs to render its first frame. */
export interface AppState {
  service: string;
  /** Is ADMIN_PASSWORD set on the deployment? */
  adminRequired: boolean;
  /** Did this request carry a valid x-admin-password header (or none is needed)? */
  adminOk: boolean;
  connect: { session: ConnectSession | null };
  agents: ConnectedAgent[];
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  content: string;
  status: 'complete' | 'error' | 'input-required';
  error: string | null;
  createdAt: string;
}

export interface ConversationInfo {
  contextId: string | null;
  activeTaskId: string | null;
}

/**
 * Events the Worker streams to the browser during a chat turn (SSE `data:` payloads).
 * `text` always carries the FULL accumulated reply — the client replaces, never appends,
 * so A2A artifact append/lastChunk semantics stay entirely server-side.
 */
export type ChatEvent =
  | { type: 'status'; state: string; taskId: string | null; contextId: string | null }
  | { type: 'text'; text: string }
  | { type: 'done'; state: string; text: string }
  | { type: 'error'; message: string };

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Ctrl+Y domain.

   Everything below is served by the Worker from D1 and rendered by the SPA.
   Dates are ISO strings; the browser does the formatting.
   ═══════════════════════════════════════════════════════════════════════════ */

export type Severity = 'material' | 'presentational' | 'question';
export type IssueStatus = 'open' | 'resolved' | 'dismissed';
export type IssueFlag = 'new' | 'revised' | 'contradicts';
export type MemoryKind = 'Treatment' | 'Pattern' | 'Instruction' | 'Fact';
export type LinkEffect = 'RESOLVES' | 'PARTIAL' | 'CONTRADICTS' | 'CONTEXT';
export type LinkDecision = 'accept' | 'reject';
export type ReviewStatus = 'open' | 'closed';

export const MEMORY_KINDS: MemoryKind[] = ['Treatment', 'Pattern', 'Instruction', 'Fact'];
export const SEVERITIES: Severity[] = ['material', 'presentational', 'question'];

export interface Person {
  id: string;
  name: string;
  org: string;
  role: string;
  email: string;
  isSelf: boolean;
}

/** A person as they appear on one review: the title that drives assignment. */
export interface RosterEntry extends Person {
  reviewTitle: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  enabled: boolean;
  source: string;
  createdAt: string;
}

/** A memory entry seen from one review: does it apply to this one? */
export interface ScopedMemoryEntry extends MemoryEntry {
  inScope: boolean;
}

export interface PanelAgent {
  key: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  modified: boolean;
  purpose: string;
  prompt: string;
  role: 'panel' | 'consolidator';
}

export interface ReviewDocument {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
}

/**
 * One line of a record quoted out of the deliverable: what the field is called,
 * what it holds as written, and what the panel found wrong with it — separate
 * fields, because they are three different voices and only the value is the
 * document's own.
 */
export interface EvidenceRow {
  field: string;
  value: string;
  note: string | null;
}

/**
 * The excerpt that proves an issue, and where it came from. A passage quoted
 * from a document, a record read out of a sheet, or both — a side letter is
 * quoted and then set against the figure actually used.
 *
 * Not a block of pre-aligned text: columns are laid out by the renderer, so the
 * panel states what it found instead of typesetting it with spaces.
 */
export interface Evidence {
  label: string;
  quote: string | null;
  rows: EvidenceRow[];
}

export interface Conflict {
  positions: { agent: string; verdict: string }[];
  ruling: string;
}

export interface Issue {
  id: string;
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
  sentAt: string | null;
}

/** What one agent reported on one pass. `findings: 0` is a real result. */
export interface PassAgentResult {
  key: string;
  name: string;
  findings: number | null;
  error: string | null;
}

export interface Pass {
  id: string;
  number: number;
  status: 'running' | 'done' | 'failed';
  openCount: number | null;
  error: string | null;
  agents: PassAgentResult[];
  memoryEffects: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReviewSummary {
  id: string;
  name: string;
  counterparty: string;
  period: string;
  status: ReviewStatus;
  /** Open-issue count after each completed pass — the only number that matters. */
  passes: number[];
  documents: number;
  agents: number;
  openIssues: number;
  memoryProduced: number;
  running: boolean;
  updatedAt: string;
}

export interface FeedbackLink {
  id: string;
  issueId: string;
  effect: LinkEffect;
  quote: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  decision: LinkDecision | null;
}

export interface FeedbackBatch {
  id: string;
  fromPersonId: string | null;
  fromName: string;
  receivedAt: string;
  text: string;
  status: 'linking' | 'ready' | 'failed';
  error: string | null;
  links: FeedbackLink[];
}

export interface ReviewDetail {
  review: ReviewSummary;
  issues: Issue[];
  documents: ReviewDocument[];
  roster: RosterEntry[];
  memory: ScopedMemoryEntry[];
  passes: Pass[];
  feedback: FeedbackBatch[];
  panelAgents: PanelAgent[];
}

export interface Workspace {
  people: Person[];
  memory: MemoryEntry[];
  panelAgents: PanelAgent[];
  consolidator: PanelAgent;
  reviews: ReviewSummary[];
  openIssues: number;
  /** The most recent completed pass anywhere, so Agents can report real counts. */
  lastPass: { reviewName: string; finishedAt: string; agents: PassAgentResult[] } | null;
  /** Is there a connected Manyfold agent the panel can actually run on? */
  panelReady: boolean;
}
