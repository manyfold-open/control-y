/**
 * One review: the issue list, grouped by who has to answer, and the detail of
 * whichever issue is selected.
 *
 * Everything on this screen writes through to the API and re-reads the review —
 * a pass rewrites issues, drafts, memory effects and the convergence count in
 * one go, so there is nothing to be gained by patching state locally.
 *
 * While a pass is running, or while the panel is reading a pasted reply, the
 * review is polled. Nothing else here is live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FeedbackBatch,
  Issue,
  MemoryKind,
  Pass,
  PassEvent,
  ReviewDetail,
  RosterEntry,
  ScopedMemoryEntry,
  Severity,
  Workspace,
} from '../../shared/types';
import { composeLetter } from '../../shared/letter';
import { authHeaders, send } from '../api';
import { streamPass } from '../sse';
import {
  errorText,
  formatBytes,
  formatElapsed,
  formatWhen,
  initials,
  useCopy,
  useDialogChrome,
  useDragDismiss,
  useFileDrop,
  usePoll,
  useResource,
  type CopyLabel,
} from '../lib';
import { diffWords } from '../../shared/diff';
import { evidenceText } from '../../shared/evidence';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';
import { addFilesToReview, limitsOf, megabytes, rejectionFor } from '../upload';
import RetrospectivePanel from '../components/RetrospectivePanel';
import Select from '../components/Select';
import Skeleton from '../components/Skeleton';

type FilterKey = 'open' | 'mine' | 'resolved';

const FILTERS: { key: FilterKey; label: string; match: (issue: Issue, selfId: string) => boolean }[] = [
  { key: 'open', label: 'Open', match: (issue) => issue.status === 'open' },
  { key: 'mine', label: 'Only I can do', match: (issue, self) => issue.status === 'open' && issue.assigneeId === self },
  { key: 'resolved', label: 'Resolved', match: (issue) => issue.status !== 'open' },
];

const SEVERITY_RANK: Record<Severity, number> = { material: 0, presentational: 1, question: 2 };

const SEVERITY_TONE: Record<Severity, string> = {
  material: 'tag material',
  question: 'tag judgment',
  presentational: 'chip',
};

/** One label per row. A row carrying five of them stops being scannable, and the
 *  detail pane says everything anyway — so the list shows the most urgent fact. */
function rowTag(issue: Issue): { label: string; className: string } | null {
  if (issue.flags.includes('contradicts')) return { label: 'contradicts', className: 'tag judgment' };
  if (issue.conflict) return { label: 'panel disagreed', className: 'tag judgment' };
  if (issue.memory) return { label: 'memory', className: 'tag settled' };
  if (issue.flags.includes('revised')) return { label: 'revised', className: 'chip' };
  if (issue.flags.includes('new')) return { label: 'new', className: 'chip' };
  return null;
}

/** Runs one write and reloads; false means it failed and the error is on screen. */
type Act = (run: () => Promise<unknown>) => Promise<boolean>;

const lastDone = (passes: Pass[]): Pass | undefined =>
  [...passes].reverse().find((pass) => pass.status === 'done');

const countUndecided = (feedback: FeedbackBatch[]): number =>
  feedback
    .filter((batch) => batch.status === 'ready')
    .flatMap((batch) => batch.links)
    .filter((link) => !link.decision).length;

/* ── The panel at work ─────────────────────────────────────────────────────── */

/**
 * The run as it happens: which reviewers are reading, what each says it is doing,
 * and what it came back with.
 *
 * None of it is persisted, and none of it should be. A pass lives only as long as
 * the connection carrying it — leaving the page stops the run — so there would be
 * nothing to show after a reload, and the pass row, which is the record, already
 * says how it ended.
 */
interface LiveAgent {
  name: string;
  /** The A2A task state, verbatim. Empty until the agent has been asked at all. */
  state: string;
  /** The agent's own progress text, when it sent one. */
  note: string;
  findings: number | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

interface LiveRun {
  stage: 'reviewers' | 'consolidator';
  done: number;
  total: number;
  /** The reviewers in the order the pass listed them, then the consolidator. */
  order: string[];
  agents: Record<string, LiveAgent>;
}

const queued = (name: string): LiveAgent => ({
  name,
  state: '',
  note: '',
  findings: null,
  error: null,
  startedAt: null,
  finishedAt: null,
});

/** Folds one streamed event into the live view. Pure — the caller owns the state. */
export function applyPassEvent(live: LiveRun | null, event: PassEvent, atMs: number): LiveRun | null {
  if (event.type === 'start') {
    return {
      stage: 'reviewers',
      done: 0,
      total: event.pass.agents.length,
      order: event.pass.agents.map((agent) => agent.key),
      agents: Object.fromEntries(event.pass.agents.map((agent) => [agent.key, queued(agent.name)])),
    };
  }
  if (!live) return live;

  if (event.type === 'stage') {
    return { ...live, stage: event.stage, done: event.done, total: event.total };
  }
  if (event.type === 'progress' || event.type === 'agent') {
    // The consolidator is not in the roster the pass started with, so it joins the
    // order the first time it reports.
    const known = live.agents[event.key] ?? queued(event.name);
    const next: LiveAgent =
      event.type === 'progress'
        ? { ...known, state: event.state, note: event.note, startedAt: known.startedAt ?? atMs }
        : { ...known, findings: event.findings, error: event.error, finishedAt: atMs };
    return {
      ...live,
      order: live.order.includes(event.key) ? live.order : [...live.order, event.key],
      agents: { ...live.agents, [event.key]: next },
    };
  }
  return live;
}

/** What one row says of itself. One label, and only where it earns one. */
export function liveStatus(agent: LiveAgent): { label: string; className: string } {
  if (agent.findings !== null) {
    return agent.findings === 0
      ? { label: 'nothing found', className: 'nothing' }
      : { label: String(agent.findings), className: 'tnum panel-strip-count' };
  }
  if (agent.error) return { label: 'did not answer', className: 'nothing' };
  if (agent.state === 'working') return { label: 'reading', className: 'panel-strip-state' };
  if (agent.state === 'submitted') return { label: 'sent', className: 'panel-strip-state' };
  // Anything else an agent calls itself is shown as it said it, rather than guessed at.
  if (agent.state) return { label: agent.state, className: 'panel-strip-state' };
  return { label: 'queued', className: 'nothing' };
}

function PanelAtWork({ live }: { live: LiveRun }) {
  // One tick a second, and only while this is mounted: the elapsed figures are the
  // only thing on the page that moves by itself.
  const [, setTick] = useState(0);
  usePoll(true, 1000, () => setTick((count) => count + 1));
  const atMs = Date.now();

  return (
    <div className="panel-strip live">
      <p className="panel-strip-stage">
        {live.stage === 'consolidator'
          ? 'Consolidator — merging what the panel found'
          : `Reviewers — ${live.done} of ${live.total} answered`}
      </p>
      {live.order.map((key) => {
        const agent = live.agents[key];
        if (!agent) return null;
        const status = liveStatus(agent);
        const settled = agent.findings !== null || agent.error !== null;
        return (
          <div key={key} className="panel-strip-row">
            <span className="panel-strip-name">{agent.name}</span>
            <span className={status.className}>{status.label}</span>
            <span className="panel-strip-note">{settled ? '' : agent.note}</span>
            <span className="panel-strip-elapsed tnum">
              {agent.startedAt === null ? '' : formatElapsed((agent.finishedAt ?? atMs) - agent.startedAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReviewDetailView({
  reviewId,
  workspace,
  onBack,
  reloadWorkspace,
}: {
  reviewId: string;
  workspace: Workspace | null;
  onBack: () => void;
  reloadWorkspace: (quiet?: boolean) => Promise<void>;
}) {
  const resource = useResource<ReviewDetail>(`/api/reviews/${encodeURIComponent(reviewId)}`);
  const { data, reload } = resource;

  const [filter, setFilter] = useState<FilterKey>('open');
  const [selectedId, setSelectedId] = useState('');
  const [passOpen, setPassOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Only the gap between pressing Run and the pass existing; `running` takes over. */
  const [passStarting, setPassStarting] = useState(false);
  /** The pass as it happens, or null when this tab is not watching one. */
  const [live, setLive] = useState<LiveRun | null>(null);
  /** Whether the panel disclosure was open before a run forced it open. */
  const wasOpen = useRef(false);
  const [actionError, setActionError] = useState('');
  const [copyLabel, copy] = useCopy();

  /** Every mutation on this screen: run it, re-read the review, and report
   *  whether it worked — a form only closes over a write that actually landed. */
  const act = useCallback<Act>(
    async (run) => {
      setBusy(true);
      setActionError('');
      try {
        await run();
        await reload(true);
        await reloadWorkspace(true);
        return true;
      } catch (caught) {
        setActionError(errorText(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload, reloadWorkspace],
  );

  const running = data?.review.running ?? false;
  const linking = data?.feedback.some((batch) => batch.status === 'linking') ?? false;
  const retrospecting = data?.retrospective?.status === 'running';
  usePoll(running || linking || retrospecting, 2500, () => {
    void reload(true);
    void reloadWorkspace(true);
  });

  const selfId = useMemo(() => data?.roster.find((person) => person.isSelf)?.id ?? '', [data]);

  const counts = useMemo(() => {
    const issues = data?.issues ?? [];
    return Object.fromEntries(
      FILTERS.map((entry) => [entry.key, issues.filter((issue) => entry.match(issue, selfId)).length]),
    ) as Record<FilterKey, number>;
  }, [data, selfId]);

  const visible = useMemo(() => {
    const match = FILTERS.find((entry) => entry.key === filter)!.match;
    return (data?.issues ?? []).filter((issue) => match(issue, selfId));
  }, [data, filter, selfId]);

  /* Grouped by recipient, because the unit of work is one letter to one person.
     Severity is the sort inside each group and the dot on each row — it does not
     need a second grouping control of its own. */
  const groups = useMemo(() => {
    const roster = data?.roster ?? [];
    const ids = [...new Set(visible.map((issue) => issue.assigneeId ?? ''))].sort(
      (a, b) => (a === selfId ? 1 : 0) - (b === selfId ? 1 : 0),
    );
    return ids
      .map((id) => {
        const person = roster.find((entry) => entry.id === id);
        return {
          key: id || 'unassigned',
          person,
          label: person?.name ?? 'Nobody yet',
          sub: person?.org ?? 'Unassigned',
          issues: visible
            .filter((issue) => (issue.assigneeId ?? '') === id)
            .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
        };
      })
      .filter((group) => group.issues.length > 0);
  }, [visible, data, selfId]);

  /* Arrow keys walk the queue. Reaching for the mouse to advance would make
     this a list with extra steps. Typing into a field always wins, and so does
     anything layered over the queue. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (overlayOpen || drawerOpen || settingsOpen) return;

      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;

      const step =
        event.key === 'ArrowDown' || event.key === 'j'
          ? 1
          : event.key === 'ArrowUp' || event.key === 'k'
            ? -1
            : 0;
      if (step === 0 || visible.length === 0) return;

      event.preventDefault();
      setSelectedId((current) => {
        const at = visible.findIndex((issue) => issue.id === current);
        const from = at < 0 ? 0 : at;
        return visible[(from + step + visible.length) % visible.length].id;
      });
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, overlayOpen, drawerOpen, settingsOpen]);

  if (resource.error) {
    return (
      <div className="page">
        <div className="notice error">
          {resource.error}{' '}
          <button className="link" type="button" onClick={onBack}>
            Back to reviews
          </button>
        </div>
      </div>
    );
  }
  if (!data) return <Skeleton shape="review" />;

  const { review, issues, passes, feedback, memory, roster, documents } = data;
  const selected = issues.find((issue) => issue.id === selectedId) ?? visible[0] ?? null;
  const queueIndex = selected ? visible.findIndex((issue) => issue.id === selected.id) : -1;
  const queueTo = selected ? roster.find((person) => person.id === selected.assigneeId) : undefined;
  const undecided = countUndecided(feedback);
  const nextPass = passes.filter((pass) => pass.status === 'done').length + 1;
  const failedPass = passes[passes.length - 1]?.status === 'failed' ? passes[passes.length - 1] : null;
  const strip = lastDone(passes);
  const inScope = memory.filter((entry) => entry.enabled && entry.inScope).length;

  const blockedReason = running
    ? 'A pass is already running.'
    : documents.length === 0
      ? 'Add at least one document first.'
      : linking
        ? 'The panel is still reading a pasted reply.'
        : undecided > 0
          ? `${undecided} proposed links still need a decision.`
          : '';

  /**
   * Runs a pass and stays on the line until it ends.
   *
   * The connection is not decoration: the Worker running the pass lives only as
   * long as this response is open, so leaving the page part-way through stops the
   * run. It is marked as a failed pass shortly after, and the review stays runnable.
   *
   * The stream carries progress, not content — the poll re-reads the review, the
   * same as after any other write. The first event says the pass exists, which is
   * what starts that poll; the last says it finished, or says why it did not. What
   * arrives in between is the panel at work, held in `live` and dropped at the end:
   * the pass row is the record, and this is only the wait made legible.
   *
   * Deliberately not run through `act`: that holds `busy` for the whole call, and a
   * pass takes minutes. Assigning an issue or copying a letter must stay possible
   * while the panel is reading. Only the run button waits, and only until the pass
   * exists — after that `running` disables it.
   */
  const runPass = async (): Promise<boolean> => {
    setPassStarting(true);
    setActionError('');
    let failure = '';
    /** Takes the live view down and gives the disclosure back as it was found. */
    const endLive = () => {
      setLive(null);
      setPassOpen(wasOpen.current);
    };
    try {
      await streamPass(review.id, (event) => {
        if (event.type === 'start') {
          setPassStarting(false);
          // Opened for the run, and put back the way it was found afterwards: a
          // disclosure the user closed should not stay open because a pass ran.
          wasOpen.current = passOpen;
          setPassOpen(true);
          void reload(true);
          void reloadWorkspace(true);
        }
        if (event.type === 'error') failure = event.message;
        // `done` and `error` end the pass by contract, whatever the socket does
        // next. Taking the live view down when the stream closed instead left a
        // finished pass on screen still reading, seconds still counting, for as
        // long as the connection lingered — which was minutes.
        if (event.type === 'done' || event.type === 'error') endLive();
        else setLive((current) => applyPassEvent(current, event, Date.now()));
      });
    } catch (caught) {
      failure = errorText(caught);
    } finally {
      setPassStarting(false);
      // A stream that died without a terminal event still has to release the view.
      endLive();
    }
    await reload(true);
    await reloadWorkspace(true);
    if (failure) setActionError(failure);
    return !failure;
  };

  return (
    <div className="review">
      <header className="review-head">
        <div className="review-bar">
          <div className="review-identity">
            <button className="crumb" type="button" onClick={onBack}>
              Reviews
            </button>
            <span className="crumb-sep">/</span>
            <h1 className="review-title">{review.name}</h1>
            {review.status === 'closed' && <span className="tag settled">closed</span>}
          </div>

          {/* Counterparty, period and documents were a whole band. They are
              facts you check occasionally, not while deciding, so they sit
              behind the one control that can also change them. */}
          <button
            className="bar-meta"
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label={`${[review.counterparty, review.period].filter(Boolean).join(' · ')}${
              review.counterparty || review.period ? ' · ' : ''
            }${documents.length} ${documents.length === 1 ? 'document' : 'documents'}. Open the review's settings.`}
          >
            <Icon name="reviews" />
            <span className="tnum">{documents.length}</span>
          </button>

          {/* The product's only number, and the pass breakdown behind it. */}
          <button
            className={passOpen ? 'bar-count open' : 'bar-count'}
            type="button"
            aria-expanded={passOpen}
            aria-label={passOpen ? 'Hide what each agent reported' : 'Show what each agent reported'}
            onClick={() => setPassOpen(!passOpen)}
          >
            <Convergence passes={review.passes} running={running} />
          </button>

          <div className="review-actions">
            <button className="button" type="button" onClick={() => setDrawerOpen(true)}>
              <Icon name="inbox" /> Paste replies
              {undecided > 0 && <span className="pip tnum">{undecided}</span>}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy || passStarting || blockedReason !== ''}
              onClick={() => void runPass()}
            >
              {running || passStarting ? 'Pass running…' : `Run pass ${nextPass}`}
            </button>
          </div>
        </div>

        {blockedReason !== '' && <p className="blocked-note">{blockedReason}</p>}

        {passOpen && live && <PanelAtWork live={live} />}

        {passOpen && !live && (
          <div className="panel-strip">
            {strip ? (
              strip.agents.map((agent) => (
                <div key={agent.key} className="panel-strip-item">
                  <span className="panel-strip-name">{agent.name}</span>
                  {agent.error ? (
                    <span className="nothing">did not answer</span>
                  ) : agent.findings === 0 ? (
                    <span className="nothing">nothing found</span>
                  ) : (
                    <span className="tnum panel-strip-count">{agent.findings}</span>
                  )}
                </div>
              ))
            ) : (
              <div className="panel-strip-item">
                <span className="panel-strip-name">No pass has completed on this review yet.</span>
              </div>
            )}
            <div className="panel-strip-item memory">
              <span className="panel-strip-name">
                Memory: {inScope} {inScope === 1 ? 'entry' : 'entries'} in scope
              </span>
              {strip && strip.memoryEffects > 0 && (
                <span className="tnum panel-strip-count">
                  {strip.memoryEffects} {strip.memoryEffects === 1 ? 'effect' : 'effects'}
                </span>
              )}
            </div>
          </div>
        )}

        {actionError && <div className="notice error">{actionError}</div>}
        {!actionError && failedPass && (
          <div className="notice error">
            Pass {failedPass.number} did not complete. {failedPass.error} No issue was changed.
          </div>
        )}
      </header>

      {/* Content, not chrome. Inside the header it had no scroll container of
          its own, and .review is height:100% — so a retrospective longer than
          the band was simply unreachable. */}
      {data.retrospective && (
        <div className="review-retro">
          <RetrospectivePanel retro={data.retrospective} memory={data.memory} busy={busy} act={act} />
        </div>
      )}

      {/* What a 340px list pane was doing in 22px: severity spread, how far in
          you are, and a way back to any of them. It reads the same at four
          issues and at fifty. */}
      {visible.length > 0 && (
        <div className="queue-strip">
          <div className="queue-marks">
            {visible.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className={[
                  'queue-mark',
                  `sev-${issue.severity}`,
                  issue.status === 'open' ? '' : 'done',
                  issue.id === selected?.id ? 'current' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={`${issue.ref}: ${issue.statement}`}
                aria-current={issue.id === selected?.id}
                onClick={() => setSelectedId(issue.id)}
              />
            ))}
          </div>

          {queueIndex >= 0 && (
            <span className="queue-pos tnum">
              {queueIndex + 1} of {visible.length}
            </span>
          )}
          {queueTo && <span className="queue-to">to {queueTo.name}</span>}
          {filter !== 'open' && (
            <span className="queue-filter">
              {FILTERS.find((entry) => entry.key === filter)?.label}
            </span>
          )}

          <div className="queue-aside">
            <button className="button subtle small" type="button" onClick={() => setOverlayOpen(true)}>
              <Icon name="list" /> All issues
            </button>
            <span className="queue-keys" aria-hidden>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
            </span>
          </div>
        </div>
      )}

      {/* The issue is the page now. One column on the reading measure, one
          decision in front of you, and the rest of the queue one key away. */}
      <div className="review-stage">
        {selected ? (
          <IssueDetail
            key={selected.id}
            issue={selected}
            roster={roster}
            memory={memory}
            busy={busy}
            copyLabel={copyLabel}
            copy={copy}
            act={act}
          />
        ) : (
          <p className="empty-note">
            {issues.length === 0
              ? 'No issues yet. Run the first pass once the documents are in.'
              : 'Nothing under this filter.'}
          </p>
        )}
      </div>

      {overlayOpen && (
        <QueueOverlay
          groups={groups}
          filter={filter}
          counts={counts}
          selfId={selfId}
          selectedId={selected?.id ?? ''}
          reviewName={review.name}
          copyLabel={copyLabel}
          copy={copy}
          onFilter={setFilter}
          onSelect={(id) => {
            setSelectedId(id);
            setOverlayOpen(false);
          }}
          onClose={() => setOverlayOpen(false)}
        />
      )}

      {drawerOpen && (
        <FeedbackDrawer
          reviewId={review.id}
          feedback={feedback}
          issues={issues}
          roster={roster}
          busy={busy}
          nextPass={nextPass}
          blockedReason={blockedReason}
          act={act}
          onRun={() => void runPass().then((ok) => ok && setDrawerOpen(false))}
          onClose={() => setDrawerOpen(false)}
          onSelect={(id) => {
            setSelectedId(id);
            setDrawerOpen(false);
          }}
        />
      )}

      {settingsOpen && (
        <ReviewSettings
          detail={data}
          workspace={workspace}
          busy={busy}
          act={act}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            setSettingsOpen(false);
            void reloadWorkspace(true);
            onBack();
          }}
        />
      )}
    </div>
  );
}

/* ── Detail pane ───────────────────────────────────────────────────────────── */

function IssueDetail({
  issue,
  roster,
  memory,
  busy,
  copyLabel,
  copy,
  act,
}: {
  issue: Issue;
  roster: RosterEntry[];
  memory: ScopedMemoryEntry[];
  busy: boolean;
  copyLabel: CopyLabel;
  copy: (key: string, text: string) => void;
  act: Act;
}) {
  const [reassigning, setReassigning] = useState(false);
  const [assigneeId, setAssigneeId] = useState(issue.assigneeId ?? '');
  const [assigneeReason, setAssigneeReason] = useState(issue.assigneeReason);
  const [editingDraft, setEditingDraft] = useState(false);
  const [draft, setDraft] = useState(issue.draft ?? '');
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState('');
  const [remembering, setRemembering] = useState(false);

  const assignee = roster.find((person) => person.id === issue.assigneeId) ?? null;
  const entry = issue.memory ? memory.find((item) => item.id === issue.memory!.entryId) : null;
  const patch = (body: Record<string, unknown>) => act(() => send('PATCH', `/api/issues/${issue.id}`, body));

  return (
    <article className="issue-detail">
      <header className="detail-head">
        <div className="detail-head-row">
          <span className="issue-ref large">{issue.ref}</span>
          <span className={SEVERITY_TONE[issue.severity]}>{issue.severity}</span>
          {issue.status === 'dismissed' && <span className="chip">dismissed</span>}
        </div>
        <h2 className="detail-statement">{issue.statement}</h2>
        {issue.whyItMatters && <p className="detail-why">{issue.whyItMatters}</p>}
        {issue.raisedBy.length > 0 && (
          <p className="detail-provenance">
            Raised by <b>{issue.raisedBy.join(' and ')}</b>
            {issue.raisedBy.length > 1 && <span className="corroborated"> · corroborated</span>}
          </p>
        )}
      </header>

      {/* The `revised` chip on the row says something changed. This is the only
          place that says what. Kept above the settled/memory/conflict callouts
          because it is about the sentence directly above it — and kept in the
          plain neutral box, because the other three modifiers colour a callout
          that carries a verdict and this one carries only history. */}
      {issue.previous && (
        <div className="callout">
          <span className="callout-label">What the rewrite changed</span>
          <p className="diff">
            {diffWords(issue.previous.statement, issue.statement).map((part, index) =>
              part.kind === 'removed' ? (
                <del key={index}>{part.text}</del>
              ) : part.kind === 'added' ? (
                <ins key={index}>{part.text}</ins>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </p>
          <p className="callout-effect">
            {issue.previous.severity !== issue.severity && (
              <>
                <b>Severity.</b> {issue.previous.severity} → {issue.severity} ·{' '}
              </>
            )}
            {formatWhen(issue.previous.recordedAt)}
          </p>
        </div>
      )}

      {issue.resolution && (
        <div className="callout resolved">
          <span className="callout-label">How it was settled</span>
          <p>{issue.resolution}</p>
          <button className="button small accent" type="button" onClick={() => setRemembering(true)}>
            Remember this
          </button>
        </div>
      )}

      {issue.memory && entry && (
        <div className="callout memory">
          <span className="callout-label">From memory</span>
          <p className="callout-quote">{entry.text}</p>
          <p className="callout-effect">{issue.memory.effect}</p>
        </div>
      )}

      {issue.conflict && (
        <div className="callout conflict">
          <span className="callout-label">The panel disagreed</span>
          {issue.conflict.positions.map((position) => (
            <p key={position.agent} className="conflict-position">
              <span className="conflict-agent">{position.agent}</span>
              {position.verdict}
            </p>
          ))}
          <p className="callout-effect">
            <b>Ruling.</b> {issue.conflict.ruling}
          </p>
        </div>
      )}

      {issue.evidence && (
        <section className="detail-section">
          <h3 className="detail-label">Evidence</h3>
          <figure className="evidence">
            <figcaption className="evidence-source">
              <span className="evidence-locator">
                {issue.evidence.label}
              </span>
              <button
                className="button small"
                type="button"
                onClick={() => copy(`evidence-${issue.id}`, evidenceText(issue.evidence!))}
              >
                <Icon name="copy" /> {copyLabel(`evidence-${issue.id}`, 'Copy')}
              </button>
            </figcaption>

            {issue.evidence.quote && <blockquote className="evidence-quote">{issue.evidence.quote}</blockquote>}

            {issue.evidence.rows.length > 0 && (
              <dl className="evidence-record">
                {issue.evidence.rows.map((row, index) => (
                  /* Every row contributes all three cells, empty note included,
                     so the columns stay in step down the whole record. */
                  <div key={index} className="evidence-row">
                    <dt className="evidence-field">{row.field}</dt>
                    <dd className="evidence-value">{row.value}</dd>
                    <dd className="evidence-note">{row.note}</dd>
                  </div>
                ))}
              </dl>
            )}
          </figure>
        </section>
      )}

      <section className="detail-section">
        <h3 className="detail-label">Assigned to</h3>
        {reassigning ? (
          <div className="inline-form">
            <Field label="Who can answer this">
              <Select
                value={assigneeId}
                onChange={setAssigneeId}
                options={[
                  { value: '', label: 'Nobody yet' },
                  ...roster.map((person) => ({
                    value: person.id,
                    label: person.name,
                    note: person.reviewTitle || undefined,
                  })),
                ]}
              />
            </Field>
            <Field label="Why them">
              <input
                value={assigneeReason}
                onChange={(event) => setAssigneeReason(event.target.value)}
                placeholder="They own the staging load."
              />
            </Field>
            <div className="inline-form-foot">
              <button className="button small" type="button" onClick={() => setReassigning(false)}>
                Cancel
              </button>
              <button
                className="button primary small"
                type="button"
                disabled={busy}
                onClick={() =>
                  void patch({ assigneeId: assigneeId || null, assigneeReason }).then((ok) => ok && setReassigning(false))
                }
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="assignee">
            <span className={assignee?.isSelf ? 'avatar self' : 'avatar'}>
              {assignee ? initials(assignee.name) : ''}
            </span>
            <div className="assignee-body">
              <span className="assignee-name">
                {assignee?.name ?? 'Nobody yet'}
                {assignee?.org && <span className="assignee-org">{assignee.org}</span>}
              </span>
              {assignee?.reviewTitle && <span className="assignee-title">{assignee.reviewTitle}</span>}
              {issue.assigneeReason && <span className="assignee-reason">{issue.assigneeReason}</span>}
            </div>
            <button
              className="button subtle small"
              type="button"
              onClick={() => {
                setAssigneeId(issue.assigneeId ?? '');
                setAssigneeReason(issue.assigneeReason);
                setReassigning(true);
              }}
            >
              Reassign
            </button>
          </div>
        )}
      </section>

      {(issue.draft || editingDraft) && (
        <section className="detail-section">
          <h3 className="detail-label">Drafted message</h3>
          <div className="draft">
            {editingDraft ? (
              <>
                <textarea
                  className="draft-editor"
                  value={draft}
                  rows={12}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="draft-foot">
                  <button
                    className="button primary small"
                    type="button"
                    disabled={busy}
                    onClick={() => void patch({ draft }).then((ok) => ok && setEditingDraft(false))}
                  >
                    Save draft
                  </button>
                  <button
                    className="button small"
                    type="button"
                    onClick={() => {
                      setDraft(issue.draft ?? '');
                      setEditingDraft(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>{issue.draft}</p>
                <div className="draft-foot">
                  <button
                    className="button primary small"
                    type="button"
                    onClick={() => copy(`draft-${issue.id}`, issue.draft ?? '')}
                  >
                    <Icon name="copy" /> {copyLabel(`draft-${issue.id}`, 'Copy message')}
                  </button>
                  <button
                    className="button small"
                    type="button"
                    onClick={() => {
                      setDraft(issue.draft ?? '');
                      setEditingDraft(true);
                    }}
                  >
                    Edit draft
                  </button>
                  <span className="sent-check">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={issue.sentAt !== null}
                      aria-label="Mark this message as sent"
                      className={issue.sentAt !== null ? 'switch on' : 'switch'}
                      disabled={busy}
                      onClick={() => void patch({ sent: issue.sentAt === null })}
                    >
                      <span className="switch-thumb" />
                    </button>
                    Mark as sent
                  </span>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className="detail-section">
        {resolving ? (
          <div className="inline-form">
            <Field label="How was it settled" hint="This is what the next pass reads, and what memory can be made from.">
              <textarea
                rows={3}
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                placeholder="Counsel confirmed it belongs to the Fenwick mandate. Project code FNW-01 applied."
              />
            </Field>
            <div className="inline-form-foot">
              <button className="button small" type="button" onClick={() => setResolving(false)}>
                Cancel
              </button>
              <button
                className="button primary small"
                type="button"
                disabled={busy || !resolution.trim()}
                onClick={() =>
                  void patch({ status: 'resolved', resolution: resolution.trim() }).then((ok) => ok && setResolving(false))
                }
              >
                Mark resolved
              </button>
            </div>
          </div>
        ) : (
          <div className="detail-actions">
            {issue.status === 'open' ? (
              <>
                <button
                  className="button small"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setResolution(issue.resolution ?? '');
                    setResolving(true);
                  }}
                >
                  Mark resolved
                </button>
                <button
                  className="button subtle small"
                  type="button"
                  disabled={busy}
                  onClick={() => void patch({ status: 'dismissed' })}
                >
                  Dismiss
                </button>
                {!issue.draft && (
                  <button
                    className="button subtle small"
                    type="button"
                    onClick={() => {
                      setDraft('');
                      setEditingDraft(true);
                    }}
                  >
                    Write a message
                  </button>
                )}
              </>
            ) : (
              <button
                className="button small"
                type="button"
                disabled={busy}
                onClick={() => void patch({ status: 'open', resolution: null })}
              >
                Reopen
              </button>
            )}
          </div>
        )}
      </section>

      {remembering && (
        <RememberDialog
          issue={issue}
          busy={busy}
          act={act}
          onClose={() => setRemembering(false)}
        />
      )}
    </article>
  );
}

const MEMORY_KINDS: MemoryKind[] = ['Treatment', 'Pattern', 'Instruction', 'Fact'];

function RememberDialog({
  issue,
  busy,
  act,
  onClose,
}: {
  issue: Issue;
  busy: boolean;
  act: Act;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<MemoryKind>('Treatment');
  const [text, setText] = useState(issue.resolution ?? '');

  return (
    <Modal
      title="Remember this"
      sub="Written as a rule, it stops the panel raising the same thing next period."
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(next) => setKind(next as MemoryKind)}
            options={MEMORY_KINDS.map((value) => ({ value, label: value }))}
          />
        </Field>
        <Field label="The rule">
          <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        <div className="dialog-foot">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !text.trim()}
            onClick={() =>
              void act(() =>
                send('POST', `/api/issues/${issue.id}/remember`, { kind, text: text.trim() }),
              ).then((ok) => ok && onClose())
            }
          >
            Add to memory
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Review settings and documents ─────────────────────────────────────────── */

interface QueuedFile {
  key: string;
  file: File;
  failed: boolean;
  error: string;
}

function ReviewSettings({
  detail,
  workspace,
  busy,
  act,
  onClose,
  onDeleted,
}: {
  detail: ReviewDetail;
  workspace: Workspace | null;
  busy: boolean;
  act: Act;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { review, documents } = detail;
  const [name, setName] = useState(review.name);
  const [counterparty, setCounterparty] = useState(review.counterparty);
  const [period, setPeriod] = useState(review.period);
  const [docName, setDocName] = useState('');
  const [docContent, setDocContent] = useState('');
  /** Files still going up, and the ones that could not. Anything that lands
      leaves this list and reappears below as a document of the review. */
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [readError, setReadError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const dirty = name.trim() !== review.name || counterparty !== review.counterparty || period !== review.period;
  const limits = limitsOf(workspace);

  /**
   * The review already exists here, so there is nothing to wait for: a dropped
   * file is checked, sent, and either becomes a document row below or stays in
   * the queue saying why it did not.
   */
  const take = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const fresh: QueuedFile[] = Array.from(picked).map((file) => {
      const rejection = rejectionFor(file, limits);
      return {
        key: `${file.name}:${file.size}:${file.lastModified}`,
        file,
        failed: rejection !== '',
        error: rejection,
      };
    });
    setQueue((current) => [...current.filter((row) => !fresh.some((one) => one.key === row.key)), ...fresh]);

    const sending = fresh.filter((row) => !row.failed);
    if (sending.length === 0) return;
    setReadError('');
    await act(() =>
      addFilesToReview(
        review.id,
        sending.map(({ key, file }) => ({ key, file })),
        limits,
        (key, failure) =>
          setQueue((current) =>
            failure
              ? current.map((row) => (row.key === key ? { ...row, failed: true, error: failure } : row))
              : current.filter((row) => row.key !== key),
          ),
      ),
    );
  };

  const drop = useFileDrop((files) => void take(files));

  /** Pasted text is prompt material, not a file: it goes straight to the API. */
  const addExtract = async () => {
    const ok = await act(() =>
      send('POST', `/api/reviews/${review.id}/documents`, { name: docName.trim(), content: docContent }),
    );
    if (ok) {
      setDocName('');
      setDocContent('');
    }
  };

  /** The raw route is behind the admin gate, so a bare href would 401. */
  const download = async (documentId: string, fileName: string) => {
    try {
      const response = await fetch(`/api/reviews/${review.id}/documents/${documentId}/raw`, {
        headers: authHeaders(),
      });
      if (!response.ok) throw new Error(`Could not download that file (HTTP ${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = Object.assign(document.createElement('a'), { href: url, download: fileName });
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setReadError(errorText(caught));
    }
  };

  return (
    <Modal title={review.name} sub="Documents the panel reads, and the review itself." wide onClose={onClose}>
      <div className="dialog-form">
        <section className="detail-section">
          <h3 className="detail-label">
            Documents
            <span className="detail-label-note">{documents.length} in scope</span>
          </h3>
          {documents.length === 0 && <p className="dialog-note">Nothing yet. The panel needs something to read.</p>}
          {documents.map((document) => (
            <div key={document.id} className="doc-row">
              <span className="doc-name">{document.name}</span>
              <span className="doc-size tnum">{formatBytes(document.bytes)}</span>
              <button
                className="button subtle small"
                type="button"
                onClick={() => void download(document.id, document.name)}
              >
                Download
              </button>
              <button
                className="button subtle small"
                type="button"
                disabled={busy}
                onClick={() => void act(() => send('DELETE', `/api/reviews/${review.id}/documents/${document.id}`))}
              >
                Remove
              </button>
            </div>
          ))}

          <div className={drop.dragging ? 'doc-drop dragging' : 'doc-drop'} {...drop.handlers}>
            {queue.length === 0 ? (
              <button type="button" className="drop-zone" onClick={() => picker.current?.click()}>
                <Icon name="reviews" size={22} />
                <span className="drop-zone-line">Drop the documents the panel should read</span>
                <span className="drop-zone-note">
                  {limits.uploadsEnabled
                    ? `or choose files · up to ${megabytes(limits.maxBytes)} each`
                    : 'or choose files · text files only on this deployment'}
                </span>
              </button>
            ) : (
              <div className="doc-queue" aria-live="polite">
                {queue.map((row) => (
                  <div key={row.key} className={row.failed ? 'doc-queue-row failed' : 'doc-queue-row uploading'}>
                    <Icon name={row.failed ? 'alert' : 'reviews'} />
                    <span className="doc-name">{row.file.name}</span>
                    <span className="doc-queue-why">{row.failed ? row.error : 'uploading…'}</span>
                    {row.failed && (
                      <button
                        className="button icon ghost"
                        type="button"
                        aria-label={`Dismiss ${row.file.name}`}
                        onClick={() => setQueue((current) => current.filter((one) => one.key !== row.key))}
                      >
                        <Icon name="x" />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" className="doc-queue-add" onClick={() => picker.current?.click()}>
                  <Icon name="plus" /> Add more, or drop them here
                </button>
              </div>
            )}
          </div>

          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void take(event.target.files);
              event.currentTarget.value = '';
            }}
          />

          {readError && <div className="notice error">{readError}</div>}

          {/* Pasting is not a lesser way of loading a file: an extract out of a
              spreadsheet or the body of an email is often the only form the
              evidence comes in. It keeps its own name because it has no file to
              take one from. */}
          <div className="doc-add">
            <Field label="Or paste an extract">
              <input
                value={docName}
                onChange={(event) => setDocName(event.target.value)}
                placeholder="staging.xlsx (extract)"
              />
            </Field>
            <Field label="Its text">
              <textarea rows={4} value={docContent} onChange={(event) => setDocContent(event.target.value)} />
            </Field>
            <div className="inline-form-foot">
              <button
                className="button primary small"
                type="button"
                disabled={busy || !docName.trim() || !docContent.trim()}
                onClick={() => void addExtract()}
              >
                Add document
              </button>
            </div>
          </div>
        </section>

        <section className="detail-section">
          <h3 className="detail-label">The review</h3>
          <Field label="What is being reviewed">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Prepared by">
            <input value={counterparty} onChange={(event) => setCounterparty(event.target.value)} />
          </Field>
          <Field label="Period">
            <input value={period} onChange={(event) => setPeriod(event.target.value)} />
          </Field>
          <div className="inline-form-foot">
            <p className="foot-note">
              {review.status === 'open'
                ? 'Closing runs the retrospective: it writes the close-out and proposes rules to carry forward, all switched off until you accept them.'
                : 'Reopening leaves the existing retrospective in place.'}
            </p>
            <button
              className="button small"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  send('PATCH', `/api/reviews/${review.id}`, {
                    status: review.status === 'open' ? 'closed' : 'open',
                  }),
                )
              }
            >
              {review.status === 'open' ? 'Close review' : 'Reopen review'}
            </button>
            <button
              className="button primary small"
              type="button"
              disabled={busy || !dirty || !name.trim()}
              onClick={() =>
                void act(() =>
                  send('PATCH', `/api/reviews/${review.id}`, {
                    name: name.trim(),
                    counterparty: counterparty.trim(),
                    period: period.trim(),
                  }),
                )
              }
            >
              Save
            </button>
          </div>
        </section>

        <div className="dialog-foot danger-foot">
          {confirmDelete ? (
            <>
              <p className="dialog-note">
                Deleting removes {detail.issues.length} issues, {documents.length} documents and the pass history. It
                cannot be undone.
              </p>
              <button className="button small" type="button" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
              <button
                className="button danger small"
                type="button"
                disabled={busy}
                onClick={() => void act(() => send('DELETE', `/api/reviews/${review.id}`)).then((ok) => ok && onDeleted())}
              >
                Delete permanently
              </button>
            </>
          ) : (
            <button className="button danger-outline small" type="button" onClick={() => setConfirmDelete(true)}>
              Delete this review
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ── The whole queue, on demand ─────────────────────────────────────────────
   The queue moves you through one decision at a time, which costs you the
   glance across all of them. This is that glance, and the only place the
   filters live: scanning and filtering are the same act, and neither belongs
   in the way while you are deciding. */

function QueueOverlay({
  groups,
  filter,
  counts,
  selfId,
  selectedId,
  reviewName,
  copyLabel,
  copy,
  onFilter,
  onSelect,
  onClose,
}: {
  groups: { key: string; person?: RosterEntry; label: string; sub: string; issues: Issue[] }[];
  filter: FilterKey;
  counts: Record<FilterKey, number>;
  selfId: string;
  selectedId: string;
  reviewName: string;
  copyLabel: CopyLabel;
  copy: (key: string, text: string) => void;
  onFilter: (key: FilterKey) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  /* `container`: this is a scrolling list, and the first thing in it is the
     filter, which is where the reader is looking anyway. */
  useDialogChrome(box, onClose, 'container');

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        ref={box}
        className="queue-overlay"
        role="dialog"
        aria-label="All issues"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="queue-overlay-head">
          <nav className="segmented" aria-label="Filter issues">
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={filter === entry.key ? 'segment active' : 'segment'}
                onClick={() => onFilter(entry.key)}
              >
                {entry.label} <span className="segment-count tnum">{counts[entry.key]}</span>
              </button>
            ))}
          </nav>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>

        <div className="queue-overlay-body" role="listbox" aria-label="Issues">
          {groups.map((group) => (
            <section key={group.key} className="issue-group">
              <div className="issue-group-head">
                <span className="issue-group-label">{group.label}</span>
                {group.sub && <span className="issue-group-sub">{group.sub}</span>}
                <span className="issue-group-count tnum">{group.issues.length}</span>
              </div>

              {group.issues.map((issue) => {
                const tag = rowTag(issue);
                return (
                  <button
                    key={issue.id}
                    type="button"
                    role="option"
                    aria-selected={issue.id === selectedId}
                    className={issue.id === selectedId ? 'issue-row selected' : 'issue-row'}
                    onClick={() => onSelect(issue.id)}
                  >
                    <span className="issue-row-top">
                      <span className={`sev sev-${issue.severity}`} />
                      <span className="issue-ref">{issue.ref}</span>
                      {tag && <span className={tag.className}>{tag.label}</span>}
                      {issue.sentAt && <span className="chip">sent</span>}
                    </span>
                    <span className="issue-row-statement">{issue.statement}</span>
                    <span className="issue-row-foot">
                      {issue.location && <code>{issue.location}</code>}
                      {issue.raisedBy.length > 1 && <span className="corroborated">corroborated</span>}
                    </span>
                  </button>
                );
              })}

              {group.key !== selfId && group.key !== 'unassigned' && group.person && filter !== 'resolved' && (
                <div className="issue-group-action">
                  <button
                    className="button small"
                    type="button"
                    onClick={() => copy(`letter-${group.key}`, composeLetter(group.person!, reviewName, group.issues))}
                  >
                    <Icon name="copy" />{' '}
                    {copyLabel(`letter-${group.key}`, `Compose ${group.issues.length} into one letter`, 'Letter copied')}
                  </button>
                </div>
              )}
            </section>
          ))}

          {groups.length === 0 && <p className="empty-note">Nothing under this filter.</p>}
        </div>
      </div>
    </>
  );
}

/* ── Feedback drawer ───────────────────────────────────────────────────────── */

/** The effect of a reply, said in the reader's words. The wire values
 *  (RESOLVES, PARTIAL, …) needed a gloss underneath them to be understood, so
 *  the gloss became the label and the token went away. */
const EFFECT: Record<string, { label: string; className: string }> = {
  RESOLVES: { label: 'Closes this issue', className: 'tag settled' },
  PARTIAL: { label: 'Answers part of it', className: 'tag judgment' },
  CONTRADICTS: { label: 'Contradicts an earlier reply', className: 'tag judgment' },
  CONTEXT: { label: 'Context only', className: 'chip' },
};

/** Who is owed an answer, and whether it has come back. Built from the issues
 *  themselves: a person holding an open issue is a person you are waiting on. */
type Correspondent = {
  person: RosterEntry;
  issues: Issue[];
  batches: FeedbackBatch[];
  undecided: number;
  sent: boolean;
};

function FeedbackDrawer({
  reviewId,
  feedback,
  issues,
  roster,
  busy,
  nextPass,
  blockedReason,
  act,
  onRun,
  onClose,
  onSelect,
}: {
  reviewId: string;
  feedback: FeedbackBatch[];
  issues: Issue[];
  roster: RosterEntry[];
  busy: boolean;
  nextPass: number;
  blockedReason: string;
  act: Act;
  onRun: () => void;
  onClose: () => void;
  onSelect: (issueId: string) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const undecided = countUndecided(feedback);
  const openIssues = issues.filter((issue) => issue.status === 'open');

  const box = useRef<HTMLElement>(null);
  /* `container`, not `field`: the first control in here is a paste box at the
     foot of a long list, and focusing it would scroll the reader straight past
     every reply they opened the drawer to read. */
  useDialogChrome(box, onClose, 'container');
  /* Same ref: the hook moves the panel by writing to it directly, so a shove
     does not re-render the correspondent list on every pointer move. */
  const drag = useDragDismiss(box, onClose);

  /* The question the old drawer never answered: who have I not heard from?
     It is answerable from what is already on screen — an open issue assigned
     to someone is a question that person still owes an answer to. */
  const correspondents = useMemo<Correspondent[]>(() => {
    const selfId = roster.find((person) => person.isSelf)?.id ?? '';
    const ids = [...new Set(openIssues.map((issue) => issue.assigneeId ?? ''))].filter(
      (id) => id && id !== selfId,
    );
    return ids
      .map((id) => {
        const person = roster.find((entry) => entry.id === id);
        if (!person) return null;
        const mine = openIssues.filter((issue) => (issue.assigneeId ?? '') === id);
        const batches = feedback.filter((batch) => batch.fromPersonId === id);
        return {
          person,
          issues: mine,
          batches,
          undecided: countUndecided(batches),
          sent: mine.some((issue) => issue.sentAt),
        };
      })
      .filter((entry): entry is Correspondent => entry !== null)
      .sort((a, b) => b.undecided - a.undecided || a.person.name.localeCompare(b.person.name));
  }, [openIssues, roster, feedback]);

  /* Anything pasted from outside the roster, and anything from someone who no
     longer holds an open issue: it still has to be reachable. */
  const known = new Set(correspondents.map((entry) => entry.person.id));
  const loose = feedback.filter((batch) => !batch.fromPersonId || !known.has(batch.fromPersonId));

  const answered = correspondents.filter((entry) => entry.batches.length > 0).length;
  const waiting = correspondents.length - answered;

  const submit = (key: string, fromPersonId: string | null) => {
    const text = (drafts[key] ?? '').trim();
    if (!text) return;
    void act(() =>
      send('POST', `/api/reviews/${reviewId}/feedback`, { text, fromPersonId }),
    ).then((ok) => {
      if (ok) setDrafts((current) => ({ ...current, [key]: '' }));
    });
  };

  const summary =
    undecided > 0
      ? `${undecided} proposed ${undecided === 1 ? 'link' : 'links'} to decide`
      : correspondents.length === 0
        ? 'Nobody is waiting on an answer.'
        : waiting === 0
          ? 'Everyone has answered.'
          : `${answered} of ${correspondents.length} answered · waiting on ${waiting}`;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        ref={box}
        className={drag.dragging ? 'drawer dragging' : 'drawer'}
        role="dialog"
        aria-label="Replies"
        tabIndex={-1}
      >
        {/* Dragged by its header only. The body holds a paste textarea, and a
            drawer that listens for drags across its whole surface is a drawer
            you cannot select text in. */}
        <header className="drawer-head" {...drag.handle}>
          <div>
            <h2 className="drawer-title">Replies</h2>
            <p className="drawer-sub">{summary}</p>
          </div>
          <button className="button icon" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        <div className="drawer-body">
          {correspondents.map((entry) => {
            const key = entry.person.id;
            const isOpen = openKey === key;
            const draft = drafts[key] ?? '';
            return (
              <section
                key={key}
                className={entry.batches.length > 0 ? 'correspondent answered' : 'correspondent'}
              >
                <button
                  className="correspondent-head"
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenKey(isOpen ? null : key)}
                >
                  <span className="avatar">{initials(entry.person.name)}</span>
                  <span className="correspondent-id">
                    <span className="correspondent-name">{entry.person.name}</span>
                    <span className="correspondent-org">{entry.person.org}</span>
                  </span>
                  <span className="correspondent-state">
                    <span className="correspondent-owed tnum">
                      {entry.issues.length} {entry.issues.length === 1 ? 'issue' : 'issues'}
                    </span>
                    {entry.undecided > 0 ? (
                      <span className="tag judgment">{entry.undecided} to decide</span>
                    ) : entry.batches.length > 0 ? (
                      <span className="correspondent-done">answered</span>
                    ) : (
                      <span className="correspondent-wait">{entry.sent ? 'awaiting reply' : 'not sent yet'}</span>
                    )}
                  </span>
                  <Icon name="chevron" />
                </button>

                {isOpen && (
                  <div className="correspondent-body">
                    <p className="correspondent-owed-refs tnum">
                      {entry.issues.map((issue) => issue.ref).join(' · ')}
                    </p>

                    {entry.batches.map((batch) => (
                      <FeedbackBatchCard
                        key={batch.id}
                        batch={batch}
                        issues={issues}
                        reviewId={reviewId}
                        busy={busy}
                        act={act}
                        onSelect={onSelect}
                      />
                    ))}

                    {/* Pasting into a person answers "who wrote it" by where it
                        went, so the select that asked it is gone. */}
                    <textarea
                      className="paste-box"
                      rows={5}
                      value={draft}
                      placeholder={`Paste ${entry.person.name.split(' ')[0]}'s reply as it arrived. It is never sent anywhere.`}
                      onChange={(event) =>
                        setDrafts((current) => ({ ...current, [key]: event.target.value }))
                      }
                    />
                    <div className="inline-form-foot">
                      <span className="drawer-note">
                        The panel reads it against {entry.issues.length}{' '}
                        {entry.issues.length === 1 ? 'issue' : 'issues'} and proposes the links.
                      </span>
                      <button
                        className="button primary small"
                        type="button"
                        disabled={busy || !draft.trim()}
                        onClick={() => submit(key, key)}
                      >
                        Read it against {entry.issues.length}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            );
          })}

          <section className={openKey === 'loose' ? 'correspondent open' : 'correspondent'}>
            <button
              className="correspondent-head"
              type="button"
              aria-expanded={openKey === 'loose'}
              onClick={() => setOpenKey(openKey === 'loose' ? null : 'loose')}
            >
              <span className="avatar quiet">
                <Icon name="inbox" />
              </span>
              <span className="correspondent-id">
                <span className="correspondent-name">Someone else</span>
                <span className="correspondent-org">A reply from outside the roster</span>
              </span>
              <span className="correspondent-state">
                {loose.length > 0 && <span className="correspondent-done">{loose.length}</span>}
              </span>
              <Icon name="chevron" />
            </button>

            {openKey === 'loose' && (
              <div className="correspondent-body">
                {loose.map((batch) => (
                  <FeedbackBatchCard
                    key={batch.id}
                    batch={batch}
                    issues={issues}
                    reviewId={reviewId}
                    busy={busy}
                    act={act}
                    onSelect={onSelect}
                  />
                ))}

                <textarea
                  className="paste-box"
                  rows={5}
                  value={drafts.loose ?? ''}
                  placeholder="Paste the reply as it arrived. It is never sent anywhere."
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, loose: event.target.value }))
                  }
                />
                <div className="inline-form-foot">
                  <span className="drawer-note">
                    The panel reads it against all {openIssues.length} open{' '}
                    {openIssues.length === 1 ? 'issue' : 'issues'}.
                  </span>
                  <button
                    className="button primary small"
                    type="button"
                    disabled={busy || !(drafts.loose ?? '').trim() || openIssues.length === 0}
                    onClick={() => submit('loose', null)}
                  >
                    Read it against {openIssues.length}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="drawer-foot">
          {/* A disabled button that will not say why is the thing people file
              bugs about. It says why. */}
          <p className="drawer-note">
            {blockedReason !== ''
              ? blockedReason
              : undecided > 0
                ? 'Every link has to be decided before the next pass. Rejected links are kept: they are how precision gets measured.'
                : 'The next pass will revisit each open issue with every accepted reply added.'}
          </p>
          <button
            className="button primary"
            type="button"
            disabled={busy || blockedReason !== ''}
            onClick={onRun}
          >
            Run pass {nextPass}
          </button>
        </footer>
      </aside>
    </>
  );
}

/** One pasted reply and what the panel made of it. */
function FeedbackBatchCard({
  batch,
  issues,
  reviewId,
  busy,
  act,
  onSelect,
}: {
  batch: FeedbackBatch;
  issues: Issue[];
  reviewId: string;
  busy: boolean;
  act: Act;
  onSelect: (issueId: string) => void;
}) {
  return (
    <article className="batch">
      <div className="batch-head">
        <span className="batch-when">{formatWhen(batch.receivedAt)}</span>
        <button
          className="button subtle small"
          type="button"
          disabled={busy}
          onClick={() => void act(() => send('DELETE', `/api/reviews/${reviewId}/feedback/${batch.id}`))}
        >
          Discard
        </button>
      </div>

      <blockquote className="pasted">{batch.text}</blockquote>

      {batch.status === 'linking' && (
        <p className="drawer-note">The panel is reading it against the open issues…</p>
      )}
      {batch.status === 'failed' && <div className="notice error">{batch.error}</div>}
      {batch.status === 'ready' && batch.links.length === 0 && (
        <p className="drawer-note">Nothing in this reply touches an open issue.</p>
      )}

      {batch.links.map((link) => {
        const issue = issues.find((candidate) => candidate.id === link.issueId);
        const effect = EFFECT[link.effect];
        const decide = (decision: 'accept' | 'reject' | null) =>
          void act(() => send('PATCH', `/api/feedback-links/${link.id}`, { decision }));
        return (
          <article key={link.id} className={link.decision ? `link-card ${link.decision}` : 'link-card'}>
            <div className="link-head">
              <span className={effect.className}>{effect.label}</span>
              {issue && (
                <button className="link-issue" type="button" onClick={() => onSelect(issue.id)}>
                  {issue.ref}: {issue.statement}
                </button>
              )}
            </div>
            {link.quote && <blockquote className="link-quote">{link.quote}</blockquote>}
            <p className="link-reason">{link.reason}</p>
            <div className="link-foot">
              <span className="chip">{link.confidence} confidence</span>
              {link.decision ? (
                <span className={link.decision === 'accept' ? 'decided accepted' : 'decided rejected'}>
                  <Icon name={link.decision === 'accept' ? 'check' : 'x'} />
                  {link.decision === 'accept' ? 'Accepted' : 'Rejected'}
                  <button
                    className="link-undo"
                    type="button"
                    disabled={busy}
                    onClick={() => decide(link.decision === 'accept' ? 'reject' : 'accept')}
                  >
                    change
                  </button>
                </span>
              ) : (
                <span className="link-buttons">
                  <button className="button small" type="button" disabled={busy} onClick={() => decide('reject')}>
                    Reject
                  </button>
                  <button
                    className="button primary small"
                    type="button"
                    disabled={busy}
                    onClick={() => decide('accept')}
                  >
                    Accept
                  </button>
                </span>
              )}
            </div>
          </article>
        );
      })}
    </article>
  );
}
