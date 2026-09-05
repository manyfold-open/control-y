import { useMemo, useState } from 'react';
import {
  AGENTS,
  FEEDBACK_LINKS,
  FEEDBACK_SOURCE,
  ISSUES,
  MEMORY,
  REVIEWS,
  initials,
  memoryById,
  personById,
  type Issue,
  type Severity,
} from '../mock/data';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';

type FilterKey = 'open' | 'mine' | 'contradictions' | 'resolved';
type GroupBy = 'recipient' | 'severity';

const FILTERS: { key: FilterKey; label: string; match: (i: Issue) => boolean }[] = [
  { key: 'open', label: 'Open', match: (i) => i.status === 'open' },
  { key: 'mine', label: 'Only I can do', match: (i) => i.status === 'open' && i.assigneeId === 'p-self' },
  { key: 'contradictions', label: 'Contradictions', match: (i) => i.flags.includes('contradicts') },
  { key: 'resolved', label: 'Resolved', match: (i) => i.status === 'resolved' },
];

const SEVERITY_RANK: Record<Severity, number> = { material: 0, presentational: 1, question: 2 };

export default function ReviewDetailView({ onBack }: { onBack: () => void }) {
  const review = REVIEWS[0];
  const [filter, setFilter] = useState<FilterKey>('open');
  const [groupBy, setGroupBy] = useState<GroupBy>('recipient');
  const [selectedId, setSelectedId] = useState('i7');
  const [passOpen, setPassOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'accept' | 'reject'>>({});

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, ISSUES.filter(f.match).length])) as Record<FilterKey, number>,
    [],
  );

  const visible = ISSUES.filter(FILTERS.find((f) => f.key === filter)!.match);

  const groups = useMemo(() => {
    if (groupBy === 'severity') {
      return (['material', 'presentational', 'question'] as Severity[])
        .map((s) => ({ key: s, label: s, sub: '', issues: visible.filter((i) => i.severity === s) }))
        .filter((g) => g.issues.length > 0);
    }
    const ids = [...new Set(visible.map((i) => i.assigneeId))].sort(
      (a, b) => (a === 'p-self' ? 1 : 0) - (b === 'p-self' ? 1 : 0),
    );
    return ids
      .map((id) => {
        const p = personById(id);
        return {
          key: id,
          label: p.name,
          sub: p.org,
          issues: visible
            .filter((i) => i.assigneeId === id)
            .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
        };
      })
      .filter((g) => g.issues.length > 0);
  }, [visible, groupBy]);

  const selected = ISSUES.find((i) => i.id === selectedId) ?? visible[0];
  const undecided = FEEDBACK_LINKS.filter((l) => !decisions[l.id]).length;

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
            <span className={`status status-${review.status}`}>{review.status}</span>
          </div>

          <div className="review-actions">
            <button className="button" type="button" onClick={() => setFeedbackOpen(true)}>
              <Icon name="inbox" /> Paste replies
              {undecided > 0 && <span className="pip tnum">{undecided}</span>}
            </button>
            <button
              className="button primary"
              type="button"
              disabled={undecided > 0}
              title={undecided > 0 ? `${undecided} proposed links still need a decision` : 'Re-run the panel over every open issue'}
            >
              Run pass 4
            </button>
          </div>
        </div>

        <p className="review-meta">
          {review.counterparty} · {review.period} · {review.documents} documents
        </p>

        <div className="review-summary">
          <Convergence passes={review.passes} />
          <span className="summary-sep" />
          <p className="summary-line">
            Consolidator merged <b>19 findings</b> into <b>12 issues</b> ·{' '}
            <span className="tone-mint">5 corroborated</span> · <span className="tone-amber">1 disagreement</span>
          </p>
          <button className="button ghost small" type="button" onClick={() => setPassOpen(!passOpen)}>
            {passOpen ? 'Hide panel' : 'Panel detail'}
          </button>
        </div>

        {passOpen && (
          <div className="panel-strip">
            {AGENTS.map((a) => (
              <div key={a.key} className="panel-strip-item">
                <span className="panel-strip-name">{a.name}</span>
                {a.findings === 0 ? (
                  <span className="nothing">nothing found</span>
                ) : (
                  <span className="tnum panel-strip-count">{a.findings}</span>
                )}
              </div>
            ))}
            <div className="panel-strip-item memory">
              <span className="panel-strip-name">Memory — {MEMORY.filter((m) => m.inScope && m.enabled).length} entries in scope</span>
              <span className="tnum panel-strip-count">2 effects</span>
            </div>
          </div>
        )}
      </header>

      <div className="review-toolbar">
        <nav className="segmented" aria-label="Filter issues">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? 'segment active' : 'segment'}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="segment-count tnum">{counts[f.key]}</span>
            </button>
          ))}
        </nav>

        <div className="toolbar-right">
          <span className="group-toggle">
            <span className="group-label">Group by</span>
            <button
              type="button"
              className={groupBy === 'recipient' ? 'mini active' : 'mini'}
              onClick={() => setGroupBy('recipient')}
            >
              Recipient
            </button>
            <button
              type="button"
              className={groupBy === 'severity' ? 'mini active' : 'mini'}
              onClick={() => setGroupBy('severity')}
            >
              Severity
            </button>
          </span>
        </div>
      </div>

      <div className="review-panes">
        <div className="issue-list" role="listbox" aria-label="Issues">
          {groups.map((g) => (
            <section key={g.key} className="issue-group">
              <div className="issue-group-head">
                <span className="issue-group-label">{g.label}</span>
                {g.sub && <span className="issue-group-sub">{g.sub}</span>}
                <span className="issue-group-count tnum">{g.issues.length}</span>
              </div>

              {g.issues.map((issue) => (
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
                    {issue.flags.includes('contradicts') && <span className="flag contradicts">contradicts</span>}
                    {issue.flags.includes('new') && <span className="flag">new</span>}
                    {issue.flags.includes('revised') && <span className="flag">revised</span>}
                    {issue.memory && <span className="flag mint">memory</span>}
                    {issue.conflict && <span className="flag amber">disagreed</span>}
                  </span>
                  <span className="issue-row-statement">{issue.statement}</span>
                  <span className="issue-row-foot">
                    <code>{issue.location}</code>
                    {issue.raisedBy.length > 1 && <span className="corroborated">{issue.raisedBy.length} agents</span>}
                  </span>
                </button>
              ))}

              {groupBy === 'recipient' && g.key !== 'p-self' && (
                <div className="issue-group-action">
                  <button className="button small" type="button">
                    <Icon name="copy" /> Compose {g.issues.length} into one letter
                  </button>
                </div>
              )}
            </section>
          ))}

          {groups.length === 0 && <p className="empty-note">Nothing under this filter.</p>}
        </div>

        {selected ? <IssueDetail issue={selected} /> : <div className="issue-detail empty" />}
      </div>

      {feedbackOpen && (
        <FeedbackDrawer
          decisions={decisions}
          onDecide={(id, d) => setDecisions((prev) => ({ ...prev, [id]: d }))}
          onClose={() => setFeedbackOpen(false)}
          onSelect={(id) => {
            setSelectedId(id);
            setFeedbackOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ── Detail pane ───────────────────────────────────────────────────────────── */

function IssueDetail({ issue }: { issue: Issue }) {
  const assignee = personById(issue.assigneeId);

  return (
    <article className="issue-detail">
      <header className="detail-head">
        <div className="detail-head-row">
          <span className="issue-ref large">{issue.ref}</span>
          <span className={`sev-pill sev-${issue.severity}`}>{issue.severity}</span>
          {issue.flags.includes('contradicts') && <span className="sev-pill contradicts">contradicts</span>}
          {issue.raisedBy.length > 1 && <span className="sev-pill corroborated">{issue.raisedBy.length} agents agree</span>}
          {issue.status === 'resolved' && <span className="sev-pill resolved">resolved</span>}
        </div>
        <h2 className="detail-statement">{issue.statement}</h2>
        <p className="detail-why">{issue.whyItMatters}</p>
      </header>

      {issue.resolution && (
        <div className="callout resolved">
          <span className="callout-label">How it was settled</span>
          <p>{issue.resolution}</p>
          <button className="button small accent" type="button">
            Remember this
          </button>
        </div>
      )}

      {issue.memory && (
        <div className="callout memory">
          <span className="callout-label">From memory</span>
          <p className="callout-quote">{memoryById(issue.memory.entryId).text}</p>
          <p className="callout-effect">{issue.memory.effect}</p>
        </div>
      )}

      {issue.conflict && (
        <div className="callout conflict">
          <span className="callout-label">The panel disagreed</span>
          {issue.conflict.positions.map((p) => (
            <p key={p.agent} className="conflict-position">
              <span className="conflict-agent">{p.agent}</span>
              {p.verdict}
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
          <div className="code-block">
            <div className="code-block-header">
              <span>{issue.evidence.label}</span>
              <button className="copy-code-button" type="button">
                Copy
              </button>
            </div>
            <pre>
              <code>{issue.evidence.lines.join('\n')}</code>
            </pre>
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3 className="detail-label">Raised by</h3>
        <div className="chip-row">
          {issue.raisedBy.map((a) => (
            <span key={a} className="chip mono">
              {a}
            </span>
          ))}
        </div>
      </section>

      <section className="detail-section">
        <h3 className="detail-label">Assigned to</h3>
        <div className="assignee-card">
          <span className={assignee.isSelf ? 'avatar self' : 'avatar'}>{initials(assignee.name)}</span>
          <div className="assignee-body">
            <span className="assignee-name">
              {assignee.name}
              <span className="assignee-org">{assignee.org}</span>
            </span>
            <span className="assignee-title">{assignee.reviewTitle}</span>
            <span className="assignee-reason">{issue.assigneeReason}</span>
          </div>
          <button className="button ghost small" type="button">
            Reassign
          </button>
        </div>
      </section>

      {issue.draft && (
        <section className="detail-section">
          <h3 className="detail-label">Drafted message</h3>
          <div className="draft">
            <p>{issue.draft}</p>
            <div className="draft-foot">
              <button className="button primary small" type="button">
                <Icon name="copy" /> Copy message
              </button>
              <button className="button small" type="button">
                Edit draft
              </button>
              <label className="sent-check">
                <input type="checkbox" /> Mark as sent
              </label>
            </div>
          </div>
        </section>
      )}

      <footer className="detail-actions">
        <button className="button small" type="button">
          Edit issue
        </button>
        <button className="button small" type="button">
          Change severity
        </button>
        <button className="button small subtle" type="button">
          Delete
        </button>
      </footer>
    </article>
  );
}

/* ── Feedback drawer ───────────────────────────────────────────────────────── */

const EFFECT_COPY: Record<string, string> = {
  RESOLVES: 'This issue can close',
  PARTIAL: 'Some of it lands — say what is still missing',
  CONTRADICTS: 'This reply disagrees with what you were told before',
  CONTEXT: 'Relevant, but does not move the issue',
};

function FeedbackDrawer({
  decisions,
  onDecide,
  onClose,
  onSelect,
}: {
  decisions: Record<string, 'accept' | 'reject'>;
  onDecide: (id: string, d: 'accept' | 'reject') => void;
  onClose: () => void;
  onSelect: (issueId: string) => void;
}) {
  const undecided = FEEDBACK_LINKS.filter((l) => !decisions[l.id]).length;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Feedback">
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title">Reply from {FEEDBACK_SOURCE.from}</h2>
            <p className="drawer-sub">{FEEDBACK_SOURCE.received}</p>
          </div>
          <button className="button icon" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        <div className="drawer-body">
          <section className="detail-section">
            <h3 className="detail-label">What you pasted</h3>
            <blockquote className="pasted">{FEEDBACK_SOURCE.excerpt}</blockquote>
          </section>

          <section className="detail-section">
            <h3 className="detail-label">
              Proposed links
              <span className="detail-label-note">
                {undecided > 0 ? `${undecided} still to decide` : 'all decided'}
              </span>
            </h3>

            {FEEDBACK_LINKS.map((link) => {
              const issue = ISSUES.find((i) => i.id === link.issueId)!;
              const decision = decisions[link.id];
              return (
                <article key={link.id} className={decision ? `link-card ${decision}` : 'link-card'}>
                  <div className="link-head">
                    <span className={`effect effect-${link.effect.toLowerCase()}`}>{link.effect}</span>
                    <button className="link-issue" type="button" onClick={() => onSelect(issue.id)}>
                      {issue.ref} — {issue.statement}
                    </button>
                  </div>
                  <p className="link-meaning">{EFFECT_COPY[link.effect]}</p>
                  <blockquote className="link-quote">{link.quote}</blockquote>
                  <p className="link-reason">{link.reason}</p>
                  <div className="link-foot">
                    <span className="chip">{link.confidence} confidence</span>
                    {decision ? (
                      <span className={decision === 'accept' ? 'decided accepted' : 'decided rejected'}>
                        <Icon name={decision === 'accept' ? 'check' : 'x'} />
                        {decision === 'accept' ? 'Accepted' : 'Rejected'}
                        <button className="link-undo" type="button" onClick={() => onDecide(link.id, decision === 'accept' ? 'reject' : 'accept')}>
                          change
                        </button>
                      </span>
                    ) : (
                      <span className="link-buttons">
                        <button className="button small" type="button" onClick={() => onDecide(link.id, 'reject')}>
                          Reject
                        </button>
                        <button className="button primary small" type="button" onClick={() => onDecide(link.id, 'accept')}>
                          Accept
                        </button>
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        </div>

        <footer className="drawer-foot">
          <p className="drawer-note">
            {undecided > 0
              ? 'Re-running is disabled until every link is decided. Rejected links are kept — they are how precision gets measured.'
              : 'Every link decided. The next pass will revisit each open issue with this reply added.'}
          </p>
          <button className="button primary" type="button" disabled={undecided > 0}>
            Run pass 4
          </button>
        </footer>
      </aside>
    </>
  );
}
