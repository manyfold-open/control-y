/**
 * The directory, and each person's title on the review currently in progress.
 *
 * Assignment reads the title, not the directory role, so the title is editable
 * here and nowhere else. Everything is scoped to the most recently worked review.
 */

import { useState } from 'react';
import type { Person, ReviewDetail, Workspace } from '../../shared/types';
import { send } from '../api';
import { errorText, initials, useResource } from '../lib';
import Icon from '../components/Icon';
import Modal, { Field } from '../components/Modal';

/** The review the titles on this page belong to: the newest open one. */
const activeReview = (workspace: Workspace | null): string | null =>
  workspace?.reviews.find((review) => review.status === 'open')?.id ?? workspace?.reviews[0]?.id ?? null;

export default function PeopleView({
  workspace,
  reload,
}: {
  workspace: Workspace | null;
  reload: (quiet?: boolean) => Promise<void>;
}) {
  const reviewId = activeReview(workspace);
  const detail = useResource<ReviewDetail>(reviewId ? `/api/reviews/${encodeURIComponent(reviewId)}` : null);
  const [editing, setEditing] = useState<Person | 'new' | null>(null);

  const review = detail.data?.review ?? null;
  const roster = detail.data?.roster ?? [];
  const issues = detail.data?.issues ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">People</h1>
          <p className="page-sub">
            Assignment uses the review title, not the directory role. Who can answer a question is a fact about this
            period’s work, not about the person in general.
          </p>
        </div>
        <button className="button primary" type="button" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add people
        </button>
      </header>

      {!workspace && <p className="empty-note">Loading…</p>}

      {workspace && (
        <div className="table-card">
          <div className="table-head people">
            <span>Person</span>
            <span>Directory role</span>
            <span>{review ? `Title on ${review.name}` : 'Title on this review'}</span>
            <span>Open</span>
          </div>

          {workspace.people.map((person) => {
            const title = roster.find((entry) => entry.id === person.id)?.reviewTitle ?? '';
            const count = issues.filter(
              (issue) => issue.assigneeId === person.id && issue.status === 'open',
            ).length;
            return (
              <button key={person.id} type="button" className="people-row" onClick={() => setEditing(person)}>
                <span className="person">
                  <span className={person.isSelf ? 'avatar self' : 'avatar'}>{initials(person.name)}</span>
                  <span className="person-name">
                    <span className="person-line">{person.name}</span>
                    <span className="person-org">{person.org}</span>
                  </span>
                </span>
                <span className="people-cell">{person.role || '—'}</span>
                <span className="people-cell emphasis">{title || 'none recorded'}</span>
                <span className="people-cell tnum">{count > 0 ? count : '—'}</span>
              </button>
            );
          })}
        </div>
      )}

      <p className="page-note">
        Counterparty staff and external counsel never sign in. They appear here so an issue can be addressed to one of
        them, and everything they see leaves as pasted text.
      </p>

      {editing && (
        <PersonDialog
          person={editing === 'new' ? null : editing}
          title={editing === 'new' ? '' : roster.find((entry) => entry.id === editing.id)?.reviewTitle ?? ''}
          reviewId={reviewId}
          reviewName={review?.name ?? ''}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload(true);
            await detail.reload(true);
          }}
        />
      )}
    </div>
  );
}

function PersonDialog({
  person,
  title,
  reviewId,
  reviewName,
  onClose,
  onSaved,
}: {
  person: Person | null;
  title: string;
  reviewId: string | null;
  reviewName: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [org, setOrg] = useState(person?.org ?? '');
  const [role, setRole] = useState(person?.role ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [reviewTitle, setReviewTitle] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await onSaved();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const fields = { name: name.trim(), org: org.trim(), role: role.trim(), email: email.trim() };
      const saved = person
        ? await send<{ person: Person }>('PATCH', `/api/people/${person.id}`, fields)
        : await send<{ person: Person }>('POST', '/api/people', fields);
      if (reviewId) {
        await send('PUT', `/api/reviews/${reviewId}/roster/${saved.person.id}`, {
          reviewTitle: reviewTitle.trim(),
        });
      }
    });

  return (
    <Modal
      title={person ? person.name : 'Add someone'}
      sub={person ? 'Their directory entry, and their title on this review.' : 'Somebody who can answer a question on a review.'}
      onClose={onClose}
    >
      <div className="dialog-form">
        <Field label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Anneke Roos" />
        </Field>
        <Field label="Organisation">
          <input value={org} onChange={(event) => setOrg(event.target.value)} placeholder="Meridian Fund Services" />
        </Field>
        <Field label="Directory role">
          <input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Fund accountant" />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="a.roos@meridianfs.com" />
        </Field>
        {reviewId && (
          <Field
            label={reviewName ? `Title on ${reviewName}` : 'Title on this review'}
            hint="What they did on this period's work. This is what the panel assigns against."
          >
            <input
              value={reviewTitle}
              onChange={(event) => setReviewTitle(event.target.value)}
              placeholder="Prepared the Q1 journal batch"
            />
          </Field>
        )}
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          {person && !person.isSelf && (
            <button
              className={confirmRemove ? 'button danger small' : 'button danger-outline small'}
              type="button"
              disabled={busy}
              onClick={() =>
                confirmRemove ? void run(() => send('DELETE', `/api/people/${person.id}`)) : setConfirmRemove(true)
              }
            >
              {confirmRemove ? 'Remove — their issues become unassigned' : 'Remove'}
            </button>
          )}
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
            {person ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
