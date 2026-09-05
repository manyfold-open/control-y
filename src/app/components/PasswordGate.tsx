/**
 * Shown when the deployment has ADMIN_PASSWORD set and this browser has not
 * provided it (or provided a wrong one). The password lives in sessionStorage —
 * gone when the tab closes, never in a cookie, never in a URL.
 */

import { useState } from 'react';
import { setStoredPassword } from '../api';

export default function PasswordGate(props: { onSubmitted: () => Promise<void> }) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setStoredPassword(value.trim());
    await props.onSubmitted();
    setSubmitting(false);
    setTouched(true);
  };

  return (
    <div className="overlay">
      <form className="dialog" onSubmit={(event) => void submit(event)}>
        <h2>Admin password required</h2>
        <p className="muted">
          This deployment is locked with the <code>ADMIN_PASSWORD</code> secret. Enter it to
          continue.
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Admin password"
          aria-label="Admin password"
        />
        {touched && <div className="notice error">That password was not accepted.</div>}
        <button className="button primary" type="submit" disabled={submitting || !value.trim()}>
          {submitting ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
