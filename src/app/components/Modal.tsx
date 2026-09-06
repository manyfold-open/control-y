/**
 * The one dialog. Everything the product creates or edits away from the page —
 * a review, a person, a memory entry, an agent prompt — opens in this.
 *
 * A click on the scrim closes it. Everything the keyboard is owed — Escape,
 * focus in on open, Tab kept inside, focus back to the opener on close — comes
 * from useDialogChrome, which the replies drawer shares.
 */

import { useRef, type ReactNode } from 'react';
import Icon from './Icon';
import { useDialogChrome } from '../lib';

export default function Modal({
  title,
  sub,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDialogChrome(box, onClose);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* tabIndex so focus has somewhere to land in a dialog with no field in
          it, and somewhere to wrap back to when Tab reaches the last control. */}
      <div
        className={wide ? 'dialog wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={box}
      >
        <header className="dialog-head">
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <button className="button icon" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
