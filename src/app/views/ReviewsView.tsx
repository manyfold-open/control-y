/**
 * Every review, newest first, with the count of turns beside it. Opening one is
 * the only thing this page does besides starting a new one.
 */

import { useState } from 'react';
import type { Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText, formatDay } from '../lib';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';

export default function ReviewsView({
  workspace,
  loading,
  reload,
  onOpen,
}: {
  workspace: Workspace | null;
  loading: boolean;
  reload: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="page-title">Reviews</h1>
        <button className="button primary" type="button" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New review
        </button>
      </header>

      {!workspace && loading && <p className="empty-note">Loading…</p>}

      {workspace && workspace.reviews.length === 0 && (
        <p className="empty-note">No reviews yet. Start one and add the documents the panel should read against.</p>
      )}

      {workspace && workspace.reviews.length > 0 && (
        <div className="table-card">
          <div className="table-head">
            <span>Review</span>
            <span>Convergence</span>
            <span>Panel</span>
            <span>Updated</span>
          </div>

          {workspace.reviews.map((review) => (
            <button key={review.id} type="button" className="review-row" onClick={() => onOpen(review.id)}>
              <span className="review-row-main">
                <span className="review-row-title">{review.name}</span>
                <span className="review-row-meta">
                  {[review.counterparty, review.period].filter(Boolean).join(' · ') || 'No counterparty recorded'}
                </span>
              </span>

              <span className="review-row-convergence">
                <Convergence passes={review.passes} running={review.running} />
              </span>

              <span className="review-row-panel">
                {review.agents} agents · {review.documents} docs
                {review.memoryProduced > 0 && <span className="settled"> · {review.memoryProduced} remembered</span>}
              </span>

              <span className="review-row-updated">{formatDay(review.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewReview
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await reload();
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewReview({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { review } = await send<{ review: { id: string } }>('POST', '/api/reviews', {
        name: name.trim(),
        counterparty: counterparty.trim(),
        period: period.trim(),
      });
      onCreated(review.id);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  return (
    <Modal title="New review" sub="The deliverable you are signing off, and who prepared it." onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <Field label="What is being reviewed">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Q2 2026 journal batch" />
        </Field>
        <Field label="Prepared by">
          <input
            value={counterparty}
            onChange={(event) => setCounterparty(event.target.value)}
            placeholder="Meridian Fund Services"
          />
        </Field>
        <Field label="Period">
          <input
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            placeholder="Period ending 30 June 2026"
          />
        </Field>
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          <p className="dialog-note">Add the documents on the next screen, then run the first pass.</p>
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create review'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
