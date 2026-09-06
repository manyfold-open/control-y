/**
 * Every review, newest first, with the count of turns beside it. Opening one is
 * the only thing this page does besides starting a new one.
 */

import { useRef, useState } from 'react';
import type { Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText, formatBytes, formatDay, useFileDrop } from '../lib';
import { addFilesToReview, limitsOf, megabytes, rejectionFor, titleFromFileName } from '../upload';
import Convergence from '../components/Convergence';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';
import Skeleton from '../components/Skeleton';

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

      {!workspace && loading && <Skeleton shape="table" />}

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
                <span className="panel-counts">
                  {review.agents} agents · {review.documents} docs
                </span>
                {review.memoryProduced > 0 && (
                  <span className="settled">{review.memoryProduced} remembered</span>
                )}
              </span>

              <span className="review-row-updated">{formatDay(review.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      {creating && (
        <NewReview
          workspace={workspace}
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

/* ── Starting one ──────────────────────────────────────────────────────────── */

type RowState = 'ready' | 'uploading' | 'done' | 'failed' | 'rejected';

interface Row {
  key: string;
  file: File;
  state: RowState;
  /** Why it was refused, or why it did not upload. */
  error: string;
}

/**
 * The documents first, and everything else follows from them.
 *
 * A review that exists with nothing to read cannot run a pass, so the old shape
 * of this dialog — three text fields, then a page, then a second dialog to add
 * the documents one at a time — asked for none of what the product needs and all
 * of what it can infer. The deliverable is a file the user already has in their
 * hand, and its name is the review's name.
 *
 * The order of operations is forced: the presigned upload URL is minted per
 * review, so the review has to exist before a single byte can be sent. Files are
 * therefore held here, checked on the spot, and uploaded the moment Create is
 * pressed — which is also why Cancel stops being offered once it has been. What
 * fails stays on screen against the review that now exists, to retry or to carry
 * over to the next screen.
 */
function NewReview({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const limits = limitsOf(workspace);
  const [rows, setRows] = useState<Row[]>([]);
  const [typed, setTyped] = useState('');
  /** Once the user has touched the name, the file stops writing it. */
  const [named, setNamed] = useState(false);
  const [counterparty, setCounterparty] = useState('');
  const [period, setPeriod] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set the moment the review exists. From here the dialog can only go forward. */
  const [reviewId, setReviewId] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const accepted = rows.filter((row) => row.state !== 'rejected');
  const uploaded = rows.filter((row) => row.state === 'done').length;
  const failed = rows.filter((row) => row.state === 'failed');
  const first = accepted[0];
  const name = named ? typed : first ? titleFromFileName(first.file.name) : '';
  const bytes = accepted.reduce((total, row) => total + row.file.size, 0);

  const add = (picked: FileList | null) => {
    if (!picked || busy) return;
    setRows((current) => {
      const next = [...current];
      for (const file of Array.from(picked)) {
        // Dropping the same folder twice is a slip, not an instruction to have
        // the panel read the document twice.
        if (next.some((row) => row.file.name === file.name && row.file.size === file.size)) continue;
        const rejection = rejectionFor(file, limits);
        next.push({
          key: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          state: rejection ? 'rejected' : 'ready',
          error: rejection,
        });
      }
      return next;
    });
  };

  const drop = useFileDrop(add);

  const settle = (key: string, failure: string) =>
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, state: failure ? 'failed' : 'done', error: failure } : row,
      ),
    );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');

    let id = reviewId;
    if (!id) {
      try {
        const created = await send<{ review: { id: string } }>('POST', '/api/reviews', {
          name: name.trim(),
          counterparty: counterparty.trim(),
          period: period.trim(),
        });
        id = created.review.id;
        setReviewId(id);
      } catch (caught) {
        setError(errorText(caught));
        setBusy(false);
        return;
      }
    }

    const pending = rows.filter((row) => row.state === 'ready' || row.state === 'failed');
    if (pending.length === 0) {
      onCreated(id);
      return;
    }

    setRows((current) =>
      current.map((row) =>
        pending.some((one) => one.key === row.key) ? { ...row, state: 'uploading', error: '' } : row,
      ),
    );

    let refused = 0;
    await addFilesToReview(
      id,
      pending.map(({ key, file }) => ({ key, file })),
      limits,
      (key, failure) => {
        if (failure) refused += 1;
        settle(key, failure);
      },
    );

    setBusy(false);
    if (refused === 0) {
      onCreated(id);
      return;
    }
    setError(
      `${refused} of ${pending.length} did not upload. The review exists either way: retry them, or open it and add them there.`,
    );
  };

  /**
   * Once the review exists the button can no longer offer to create it, and what
   * it does offer depends on what is left: the failures, or the way out.
   */
  const primaryLabel = busy
    ? reviewId
      ? `Uploading ${uploaded} of ${accepted.length}…`
      : 'Creating…'
    : failed.length > 0
      ? `Retry ${failed.length}`
      : reviewId
        ? 'Open the review'
        : accepted.length > 0
          ? `Create review · ${accepted.length} ${accepted.length === 1 ? 'document' : 'documents'}`
          : 'Create review';

  return (
    <Modal
      title="New review"
      sub="The documents first. Everything else follows from them."
      onClose={busy ? () => undefined : onClose}
    >
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className={drop.dragging ? 'doc-drop dragging' : 'doc-drop'} {...drop.handlers}>
          {rows.length === 0 ? (
            <button type="button" className="drop-zone" onClick={() => picker.current?.click()}>
              <Icon name="reviews" size={22} />
              <span className="drop-zone-line">Drop the deliverable and what it is checked against</span>
              <span className="drop-zone-note">
                {limits.uploadsEnabled
                  ? `or choose files · up to ${megabytes(limits.maxBytes)} each`
                  : 'or choose files · text files only on this deployment'}
              </span>
            </button>
          ) : (
            <div className="doc-queue" aria-live="polite">
              <div className="doc-queue-head">
                <span>
                  {accepted.length} {accepted.length === 1 ? 'document' : 'documents'}
                </span>
                <span className="tnum">{formatBytes(bytes)}</span>
              </div>

              {rows.map((row) => (
                <div key={row.key} className={`doc-queue-row ${row.state}`}>
                  <Icon name={row.state === 'rejected' || row.state === 'failed' ? 'alert' : 'reviews'} />
                  <span className="doc-name">{row.file.name}</span>

                  {row.error ? (
                    <span className="doc-queue-why">{row.error}</span>
                  ) : row.state === 'uploading' ? (
                    <span className="doc-queue-why">uploading…</span>
                  ) : row.state === 'done' ? (
                    <span className="doc-queue-done">
                      <Icon name="check" />
                    </span>
                  ) : (
                    <span className="doc-size tnum">{formatBytes(row.file.size)}</span>
                  )}

                  {row.state !== 'uploading' && row.state !== 'done' && (
                    <button
                      className="button icon ghost"
                      type="button"
                      aria-label={`Remove ${row.file.name}`}
                      onClick={() => setRows((current) => current.filter((one) => one.key !== row.key))}
                    >
                      <Icon name="x" />
                    </button>
                  )}
                </div>
              ))}

              {!busy && (
                <button type="button" className="doc-queue-add" onClick={() => picker.current?.click()}>
                  <Icon name="plus" /> Add more, or drop them here
                </button>
              )}
            </div>
          )}
        </div>

        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            add(event.target.files);
            event.currentTarget.value = '';
          }}
        />

        <Field
          label="What is being reviewed"
          hint={first && !named ? 'Taken from the first document. Change it if it is wrong.' : undefined}
        >
          <input
            value={name}
            disabled={busy || reviewId !== ''}
            onChange={(event) => {
              setNamed(true);
              setTyped(event.target.value);
            }}
            placeholder="Q2 2026 journal batch"
          />
        </Field>

        {/* Neither field decides whether a pass can run, and both can be filled
            in from the review's own settings later. They wait behind a
            disclosure rather than standing between the documents and Create. */}
        <button
          type="button"
          className="more-toggle"
          aria-expanded={more}
          disabled={busy || reviewId !== ''}
          onClick={() => setMore(!more)}
        >
          <Icon name="chevron" />
          Who prepared it, and the period
        </button>

        {more && (
          <>
            <Field label="Prepared by">
              <input
                value={counterparty}
                disabled={busy || reviewId !== ''}
                onChange={(event) => setCounterparty(event.target.value)}
                placeholder="Meridian Fund Services"
              />
            </Field>
            <Field label="Period">
              <input
                value={period}
                disabled={busy || reviewId !== ''}
                onChange={(event) => setPeriod(event.target.value)}
                placeholder="Period ending 30 June 2026"
              />
            </Field>
          </>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="dialog-foot">
          <p className="dialog-note">
            {accepted.length === 0
              ? 'A pass needs at least one document. You can add them on the next screen instead.'
              : 'Nothing runs yet. Pass 1 is ready on the next screen.'}
          </p>
          {!reviewId && (
            <button className="button" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          )}
          {reviewId !== '' && failed.length > 0 && (
            <button className="button" type="button" disabled={busy} onClick={() => onCreated(reviewId)}>
              Open it anyway
            </button>
          )}
          <button className="button primary" type="submit" disabled={busy || !name.trim()}>
            {primaryLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
