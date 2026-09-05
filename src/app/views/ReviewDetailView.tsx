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

import { useCallback, useMemo, useState } from 'react';
import type {
  FeedbackBatch,
  Issue,
  MemoryKind,
  Pass,
  ReviewDetail,
  RosterEntry,
  ScopedMemoryEntry,
  Severity,
} from '../../shared/types';
import { composeLetter } from '../../shared/letter';
import { send } from '../api';
import { errorText, formatBytes, formatWhen, initials, useCopy, usePoll, useResource, type CopyLabel } from '../lib';
import { evidenceText } from '../../shared/evidence';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';
import RetrospectivePanel from '../components/RetrospectivePanel';

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

export default function ReviewDetailView({
  reviewId,
  onBack,
  reloadWorkspace,
}: {
  reviewId: string;
  onBack: () => void;
  reloadWorkspace: (quiet?: boolean) => Promise<void>;
}) {
  const resource = useResource<ReviewDetail>(`/api/reviews/${encodeURIComponent(reviewId)}`);
  const { data, reload } = resource;

  const [filter, setFilter] = useState<FilterKey>('open');
  const [selectedId, setSelectedId] = useState('');
  const [passOpen, setPassOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  if (!data) return <p className="empty-note">Loading…</p>;

  const { review, issues, passes, feedback, memory, roster, documents } = data;
  const selected = issues.find((issue) => issue.id === selectedId) ?? visible[0] ?? null;
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

  const runPass = () => act(() => send('POST', `/api/reviews/${review.id}/passes`));

  return (
    <div className="review">
      <header className="review-head">
        <div className="review-head-top">
          <div className="review-identity">
            <button className="crumb" type="button" onClick={onBack}>
              Reviews
            </button>
            <span className="crumb-sep">/</span>
            <h1 className="review-title">{review.name}</h1>
            {review.status === 'closed' && <span className="tag settled">closed</span>}
          </div>

          <div className="review-actions">
            <button className="button" type="button" onClick={() => setDrawerOpen(true)}>
              <Icon name="inbox" /> Paste replies
              {undecided > 0 && <span className="pip tnum">{undecided}</span>}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy || blockedReason !== ''}
              title={blockedReason || `Re-run the panel over every open issue`}
              onClick={() => void runPass()}
            >
              {running ? 'Pass running…' : `Run pass ${nextPass}`}
            </button>
          </div>
        </div>

        <div className="review-summary">
          <Convergence passes={review.passes} running={running} />
          <span className="summary-sep" />
          <p className="review-meta">
            {[review.counterparty, review.period].filter(Boolean).join(' · ')}
            {review.counterparty || review.period ? ' · ' : ''}
            <button className="link" type="button" onClick={() => setSettingsOpen(true)}>
              {documents.length} {documents.length === 1 ? 'document' : 'documents'}
            </button>
          </p>
          <button className="button ghost small" type="button" onClick={() => setPassOpen(!passOpen)}>
            {passOpen ? 'Hide panel' : 'Panel detail'}
          </button>
        </div>

        {passOpen && (
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
                Memory — {inScope} {inScope === 1 ? 'entry' : 'entries'} in scope
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
        {data.retrospective && (
          <RetrospectivePanel retro={data.retrospective} memory={data.memory} busy={busy} act={act} />
        )}
      </header>

      <div className="review-toolbar">
        <nav className="segmented" aria-label="Filter issues">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={filter === entry.key ? 'segment active' : 'segment'}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label} <span className="segment-count tnum">{counts[entry.key]}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="review-panes">
        <div className="issue-list" role="listbox" aria-label="Issues">
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
                    aria-selected={issue.id === selected?.id}
                    className={issue.id === selected?.id ? 'issue-row selected' : 'issue-row'}
                    onClick={() => setSelectedId(issue.id)}
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
                    onClick={() =>
                      copy(`letter-${group.key}`, composeLetter(group.person!, review.name, group.issues))
                    }
                  >
                    <Icon name="copy" />{' '}
                    {copyLabel(
                      `letter-${group.key}`,
                      `Compose ${group.issues.length} into one letter`,
                      'Letter copied',
                    )}
                  </button>
                </div>
              )}
            </section>
          ))}

          {groups.length === 0 && (
            <p className="empty-note">
              {issues.length === 0
                ? 'No issues yet. Run the first pass once the documents are in.'
                : 'Nothing under this filter.'}
            </p>
          )}
        </div>

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
          <div className="issue-detail empty" />
        )}
      </div>

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
              <span className="evidence-locator" title={issue.evidence.label}>
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
              <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                <option value="">Nobody yet</option>
                {roster.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                    {person.reviewTitle ? ` — ${person.reviewTitle}` : ''}
                  </option>
                ))}
              </select>
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
              {assignee ? initials(assignee.name) : '—'}
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
                  <label className="sent-check">
                    <input
                      type="checkbox"
                      checked={issue.sentAt !== null}
                      disabled={busy}
                      onChange={(event) => void patch({ sent: event.target.checked })}
                    />{' '}
                    Mark as sent
                  </label>
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
          <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
            {MEMORY_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
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

const TEXT_FILE = /\.(txt|csv|tsv|md|json|log|xml|yaml|yml|html|htm|css|js|jsx|ts|tsx|sql|rtf)$/i;
const VIDEO_FILE = /\.(3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogv|vob|webm|wmv)$/i;

const isVideoFile = (file: File): boolean => file.type.toLowerCase().startsWith('video/') || VIDEO_FILE.test(file.name);
const isTextFile = (file: File): boolean => file.type.toLowerCase().startsWith('text/') || TEXT_FILE.test(file.name);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function ReviewSettings({
  detail,
  busy,
  act,
  onClose,
  onDeleted,
}: {
  detail: ReviewDetail;
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
  const [docEncoding, setDocEncoding] = useState<'text' | 'base64'>('text');
  const [docMediaType, setDocMediaType] = useState('');
  const [binaryFile, setBinaryFile] = useState<{ name: string; bytes: number; mediaType: string } | null>(null);
  const [readError, setReadError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = name.trim() !== review.name || counterparty !== review.counterparty || period !== review.period;

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (isVideoFile(file)) {
      setReadError('Video files are not supported yet. Choose any other file type.');
      return;
    }
    try {
      setReadError('');
      setDocName(file.name);
      setDocMediaType(file.type || 'application/octet-stream');
      if (isTextFile(file)) {
        setDocEncoding('text');
        setBinaryFile(null);
        setDocContent(await file.text());
      } else {
        setDocEncoding('base64');
        setBinaryFile({ name: file.name, bytes: file.size, mediaType: file.type || 'application/octet-stream' });
        setDocContent(bytesToBase64(new Uint8Array(await file.arrayBuffer())));
      }
    } catch {
      setReadError('Could not read that file. Try choosing it again or paste its contents.');
    }
  };

  const clearDocumentDraft = () => {
    setDocName('');
    setDocContent('');
    setDocEncoding('text');
    setDocMediaType('');
    setBinaryFile(null);
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
                disabled={busy}
                onClick={() => void act(() => send('DELETE', `/api/reviews/${review.id}/documents/${document.id}`))}
              >
                Remove
              </button>
            </div>
          ))}

          <div className="doc-add">
            <Field label="Add a document">
              <input value={docName} onChange={(event) => setDocName(event.target.value)} placeholder="staging.xlsx (extract)" />
            </Field>
            {binaryFile ? (
              <div className="file-preview" aria-live="polite">
                <strong>{binaryFile.name}</strong>
                <span>{formatBytes(binaryFile.bytes)} · Ready to attach · {binaryFile.mediaType}</span>
              </div>
            ) : (
              <Field label="Its text" hint="Paste an extract, or load any non-video file.">
                <textarea rows={5} value={docContent} onChange={(event) => setDocContent(event.target.value)} />
              </Field>
            )}
            {readError && <div className="notice error">{readError}</div>}
            <div className="inline-form-foot">
              <label className="button small file-button">
                Load a file
                <input
                  type="file"
                  accept="*/*"
                  onChange={(event) => {
                    void pickFile(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <button
                className="button primary small"
                type="button"
                disabled={busy || !docName.trim() || !docContent.trim()}
                onClick={() =>
                  void act(() =>
                    send('POST', `/api/reviews/${review.id}/documents`, {
                      name: docName.trim(),
                      content: docContent,
                      contentEncoding: docEncoding,
                      ...(docMediaType ? { mediaType: docMediaType } : {}),
                    }),
                  ).then((ok) => {
                    if (!ok) return;
                    clearDocumentDraft();
                  })
                }
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
            <button
              className="button small"
              type="button"
              disabled={busy}
              title={
                review.status === 'open'
                  ? 'Closing runs the retrospective: it writes the close-out and proposes rules to carry forward, all switched off until you accept them.'
                  : 'Reopening leaves the existing retrospective in place.'
              }
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
  const [from, setFrom] = useState('');
  const [text, setText] = useState('');
  const undecided = countUndecided(feedback);
  const openIssues = issues.filter((issue) => issue.status === 'open').length;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Replies">
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title">Replies</h2>
            <p className="drawer-sub">
              {feedback.length === 0
                ? `Paste what came back. The panel links it to the ${openIssues} open issues.`
                : undecided > 0
                  ? `${undecided} proposed links to decide`
                  : 'Every link decided'}
            </p>
          </div>
          <button className="button icon" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        <div className="drawer-body">
          {feedback.map((batch) => (
            <section key={batch.id} className="detail-section">
              <h3 className="detail-label">
                From {batch.fromName}
                <span className="detail-label-note">{formatWhen(batch.receivedAt)}</span>
              </h3>
              <blockquote className="pasted">{batch.text}</blockquote>

              {batch.status === 'linking' && (
                <p className="drawer-note">The panel is reading it against the open issues…</p>
              )}
              {batch.status === 'failed' && <div className="notice error">{batch.error}</div>}
              {batch.status === 'ready' && batch.links.length === 0 && (
                <p className="drawer-note">The panel found nothing in this reply that touches an open issue.</p>
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
                          {issue.ref} — {issue.statement}
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

              <div className="inline-form-foot">
                <button
                  className="button subtle small"
                  type="button"
                  disabled={busy}
                  onClick={() => void act(() => send('DELETE', `/api/reviews/${reviewId}/feedback/${batch.id}`))}
                >
                  Discard this reply
                </button>
              </div>
            </section>
          ))}

          <section className="detail-section">
            <h3 className="detail-label">Paste a reply</h3>
            <Field label="Who wrote it">
              <select value={from} onChange={(event) => setFrom(event.target.value)}>
                <option value="">Not on the roster</option>
                {roster
                  .filter((person) => !person.isSelf)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="What they said" hint="Paste the message as it arrived. It is never sent anywhere.">
              <textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} />
            </Field>
            <div className="inline-form-foot">
              <button
                className="button primary small"
                type="button"
                disabled={busy || !text.trim() || openIssues === 0}
                title={openIssues === 0 ? 'There are no open issues to link a reply to.' : ''}
                onClick={() =>
                  void act(() =>
                    send('POST', `/api/reviews/${reviewId}/feedback`, {
                      text: text.trim(),
                      fromPersonId: from || null,
                    }),
                  ).then((ok) => ok && setText(''))
                }
              >
                Link it to the open issues
              </button>
            </div>
          </section>
        </div>

        <footer className="drawer-foot">
          <p className="drawer-note">
            {undecided > 0
              ? 'Every link has to be decided before the next pass. Rejected links are kept — they are how precision gets measured.'
              : 'The next pass will revisit each open issue with every accepted reply added.'}
          </p>
          <button
            className="button primary"
            type="button"
            disabled={busy || blockedReason !== ''}
            title={blockedReason}
            onClick={onRun}
          >
            Run pass {nextPass}
          </button>
        </footer>
      </aside>
    </>
  );
}
