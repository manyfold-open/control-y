import { REVIEWS, ISSUES, PEOPLE, MEMORY } from '../mock/data';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';

export default function ReviewsView({ onOpen }: { onOpen: (id: string) => void }) {
  const open = ISSUES.filter((i) => i.status === 'open');
  const mine = open.filter((i) => i.assigneeId === 'p-self');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Reviews</h1>
          <p className="page-sub">Every deliverable you have put through the panel, and how fast each one converged.</p>
        </div>
        <button className="button primary" type="button">
          <Icon name="plus" /> New review
        </button>
      </header>

      <div className="stat-strip">
        <div className="stat">
          <span className="stat-value tnum">{open.length}</span>
          <span className="stat-label">Open issues</span>
        </div>
        <div className="stat">
          <span className="stat-value tnum accent">{mine.length}</span>
          <span className="stat-label">Only you can answer</span>
        </div>
        <div className="stat">
          <span className="stat-value tnum">{MEMORY.filter((m) => m.enabled).length}</span>
          <span className="stat-label">Memory entries live</span>
        </div>
        <div className="stat">
          <span className="stat-value tnum">{PEOPLE.length}</span>
          <span className="stat-label">People in the directory</span>
        </div>
      </div>

      <div className="table-card">
        <div className="table-head">
          <span>Review</span>
          <span>Convergence</span>
          <span>Panel</span>
          <span>Updated</span>
        </div>

        {REVIEWS.map((r) => (
          <button key={r.id} type="button" className="review-row" onClick={() => onOpen(r.id)}>
            <span className="review-row-main">
              <span className="review-row-title">
                {r.name}
                <span className={`status status-${r.status}`}>{r.status}</span>
              </span>
              <span className="review-row-meta">
                {r.counterparty} · {r.period}
              </span>
            </span>

            <span className="review-row-convergence">
              <Convergence passes={r.passes} />
            </span>

            <span className="review-row-panel">
              <span className="chip">{r.agents} agents</span>
              <span className="chip">{r.documents} docs</span>
              {r.memoryProduced > 0 && <span className="chip mint">{r.memoryProduced} remembered</span>}
            </span>

            <span className="review-row-updated">{r.updated}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
