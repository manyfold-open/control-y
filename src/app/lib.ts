/**
 * Client-side plumbing: one fetch hook, clipboard, and the date formats.
 *
 * No state library. Every page reads one resource, mutates through the API and
 * reloads it — a pass changes issues, memory and the review at once, so a
 * client-side cache would only be a second source of truth to keep honest.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

export const errorText = (error: unknown): string =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

export interface Resource<T> {
  data: T | null;
  error: string;
  loading: boolean;
  /** `quiet` skips the loading flag — used by the poll while a pass runs. */
  reload: (quiet?: boolean) => Promise<void>;
}

export function useResource<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(path !== null);
  // Responses can land out of order once the path changes; only the newest wins.
  const ticket = useRef(0);

  const reload = useCallback(
    async (quiet = false) => {
      if (!path) return;
      const mine = ++ticket.current;
      if (!quiet) setLoading(true);
      try {
        const next = await api<T>(path);
        if (ticket.current !== mine) return;
        setData(next);
        setError('');
      } catch (caught) {
        if (ticket.current !== mine) return;
        setError(errorText(caught));
      } finally {
        if (ticket.current === mine) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Runs `tick` on an interval while `active`, and once immediately after it turns on. */
export function usePoll(active: boolean, ms: number, tick: () => void): void {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
}

/** Renders a copy button's label from what the last copy attempt did. */
export type CopyLabel = (key: string, idle: string, done?: string, failed?: string) => string;

/**
 * Copy, and say what happened.
 *
 * The async clipboard API rejects when the document is not focused or the
 * permission is refused, so a rejection falls through to the old selection copy.
 * If both fail the button says so: everything this product produces leaves as
 * pasted text, and a copy that silently did nothing is the worst outcome.
 */
export function useCopy(): [CopyLabel, (key: string, text: string) => void] {
  const [state, setState] = useState<{ key: string; ok: boolean }>({ key: '', ok: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback((key: string, text: string) => {
    const settle = (ok: boolean) => {
      setState({ key, ok });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState({ key: '', ok: false }), ok ? 1600 : 3000);
    };

    const selectionCopy = (): boolean => {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      } finally {
        area.remove();
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => settle(true),
        () => settle(selectionCopy()),
      );
      return;
    }
    settle(selectionCopy());
  }, []);

  const label: CopyLabel = (key, idle, done = 'Copied', failed = 'Copy blocked') =>
    state.key !== key ? idle : state.ok ? done : failed;

  return [label, copy];
}

/* ───────── dates ───────── */

const DAY_MS = 86_400_000;

const startOfDay = (value: Date): number =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

/** "Today", "Yesterday", then "14 Jan 2026". Financial dates, not "3d ago". */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${formatDay(iso)}, ${time}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** YOU for the fund manager, initials for everyone else. */
export const initials = (name: string): string =>
  name === 'You'
    ? 'YOU'
    : name
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
