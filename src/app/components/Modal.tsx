/**
 * The one dialog. Everything the product creates or edits away from the page —
 * a review, a person, a memory entry, an agent prompt — opens in this.
 *
 * Escape closes, a click on the scrim closes, and focus moves into the dialog on
 * open so the keyboard lands somewhere useful.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={wide ? 'dialog wide' : 'dialog'} role="dialog" aria-modal="true" aria-label={title} ref={box}>
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
