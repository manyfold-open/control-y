/**
 * What the workspace carries between reviews.
 *
 * An entry applies when it is switched on AND in scope on the review being run,
 * so both are controls here — the scope pill toggles against the review the
 * panel would run next.
 */

import { useState } from 'react';
import type { MemoryEntry, MemoryKind, ReviewDetail, Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText, formatDay, useResource } from '../lib';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';

const ORDER: MemoryKind[] = ['Treatment', 'Pattern', 'Instruction', 'Fact'];

const BLURB: Record<MemoryKind, string> = {
  Treatment: 'Something you and the counterparty have already agreed. Stops the panel re-raising it.',
  Pattern: 'A defect that recurs. Tells the panel where to look first.',
  Instruction: 'A standing rule of yours. Outranks a built-in agent’s judgement.',
  Fact: 'Something true about the fund that the deliverable may not reflect.',
};

export default function MemoryView({
  workspace,
  reload,
}: {
  workspace: Workspace | null;
  reload: (quiet?: boolean) => Promise<void>;
}) {
  const reviewId =
    workspace?.reviews.find((review) => review.status === 'open')?.id ?? workspace?.reviews[0]?.id ?? null;
  const detail = useResource<ReviewDetail>(reviewId ? `/api/reviews/${encodeURIComponent(reviewId)}` : null);
  const [editing, setEditing] = useState<MemoryEntry | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const review = detail.data?.review ?? null;
  const scope = detail.data?.memory ?? [];

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await run();
      await reload(true);
      await detail.reload(true);
      return true;
    } catch (caught) {
      setError(errorText(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const entries = workspace?.memory ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Memory</h1>
          <p className="page-sub">
            What the workspace carries between reviews, so the same thing is not re-litigated every period. Written as
            rules, not notes.
          </p>
        </div>
        <button className="button primary" type="button" onClick={() => setEditing('new')}>
          <Icon name="plus" /> New entry
        </button>
      </header>

      {error && <div className="notice error">{error}</div>}
      {!workspace && <p className="empty-note">Loading…</p>}
      {workspace && entries.length === 0 && (
        <p className="empty-note">Nothing remembered yet. Settle an issue and press “Remember this”, or write a rule.</p>
      )}

      {ORDER.map((kind) => {
        const group = entries.filter((entry) => entry.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} className="memory-section">
            <div className="memory-section-head">
              <h2 className="section-title">{kind}</h2>
              <p className="section-blurb">{BLURB[kind]}</p>
            </div>

            <div className="table-card">
              {group.map((entry) => {
                const inScope = scope.find((item) => item.id === entry.id)?.inScope ?? true;
                return (
                  <article key={entry.id} className={entry.enabled ? 'memory-row' : 'memory-row off'}>
                    <button className="memory-text" type="button" onClick={() => setEditing(entry)}>
                      {entry.text}
                    </button>
                    <div className="memory-foot">
                      <span className="memory-source">
                        {entry.source} · {formatDay(entry.createdAt)}
                      </span>
                      <div className="memory-switches">
                        {review && (
                          <button
                            type="button"
                            className={entry.enabled && inScope ? 'memory-scope live' : 'memory-scope'}
                            disabled={busy}
                            title={`Switch this entry ${inScope ? 'out of' : 'into'} scope on ${review.name}`}
                            onClick={() =>
                              void act(() =>
                                send('PUT', `/api/reviews/${review.id}/memory/${entry.id}`, { inScope: !inScope }),
                              )
                            }
                          >
                            {inScope ? 'In scope' : 'Out of scope'} on {review.name}
                          </button>
                        )}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={entry.enabled}
                          aria-label={`Use this entry — ${entry.text}`}
                          className={entry.enabled ? 'switch on' : 'switch'}
                          disabled={busy}
                          onClick={() =>
                            void act(() => send('PATCH', `/api/memory/${entry.id}`, { enabled: !entry.enabled }))
                          }
                        >
                          <span className="switch-thumb" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <p className="page-note">
        An entry applies when it is switched on <b>and</b> in scope on the review being run. Switching one off and
        re-running is how you prove what a rule was actually doing.
      </p>

      {editing && (
        <EntryDialog
          entry={editing === 'new' ? null : editing}
          busy={busy}
          act={act}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EntryDialog({
  entry,
  busy,
  act,
  onClose,
}: {
  entry: MemoryEntry | null;
  busy: boolean;
  act: (run: () => Promise<unknown>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? 'Treatment');
  const [text, setText] = useState(entry?.text ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () =>
    void act(() =>
      entry
        ? send('PATCH', `/api/memory/${entry.id}`, { kind, text: text.trim() })
        : send('POST', '/api/memory', { kind, text: text.trim() }),
    ).then((ok) => ok && onClose());

  return (
    <Modal
      title={entry ? 'Edit entry' : 'New entry'}
      sub={BLURB[kind]}
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field label="Kind">
          <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
            {ORDER.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="The rule" hint="One sentence, phrased as a rule the panel can apply.">
          <textarea
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Bank charges carry no counterparty by convention — do not raise them as unmatched."
          />
        </Field>
        {entry && <p className="dialog-note">From {entry.source} · {formatDay(entry.createdAt)}</p>}
        <div className="dialog-foot">
          {entry && (
            <button
              className={confirmDelete ? 'button danger small' : 'button danger-outline small'}
              type="button"
              disabled={busy}
              onClick={() =>
                confirmDelete
                  ? void act(() => send('DELETE', `/api/memory/${entry.id}`)).then((ok) => ok && onClose())
                  : setConfirmDelete(true)
              }
            >
              {confirmDelete ? 'Forget it permanently' : 'Forget this'}
            </button>
          )}
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="button" disabled={busy || !text.trim()} onClick={save}>
            {entry ? 'Save' : 'Add entry'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
