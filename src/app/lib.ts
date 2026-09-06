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

/* ───────── the dialog keyboard contract ───────── */

/**
 * What every surface carrying role="dialog" owes a keyboard: Escape closes it,
 * focus moves inside on open, Tab cycles within it rather than walking off into
 * the page behind, and focus goes back where it came from on close.
 *
 * Modal had the first two and the replies drawer had none, which made the drawer
 * the one dialog in the product a keyboard could open but not leave.
 *
 * Two details worth keeping:
 *
 * · Escape is answered by the innermost dialog only. Each of these hooks listens
 *   on `document`, so without the stack a single press would close a dialog and
 *   whatever it was opened from.
 * · A defaultPrevented Escape has already been spent. Select calls
 *   preventDefault() when it closes its own list, and before this guard existed
 *   dismissing a dropdown inside a dialog dismissed the dialog with it.
 */

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Innermost last. Only the last entry answers Escape. */
const dialogStack: symbol[] = [];

export function useDialogChrome(
  box: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  /** `field` lands on the first input — right for a form. `container` lands on
   *  the dialog itself, for a long scrolling panel whose first field is far
   *  enough down that focusing it would scroll the reader past the heading. */
  initialFocus: 'field' | 'container' = 'field',
): void {
  // Read through a ref so the effect runs once per open. Call sites pass an
  // inline arrow, and re-running would re-steal focus on every parent render —
  // which, while a pass polls, means every couple of seconds.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const mine = Symbol('dialog');
    dialogStack.push(mine);
    const opener = document.activeElement as HTMLElement | null;

    // A file input is a transparent overlay or a hidden sibling wherever it
    // appears in this product, so focusing it would put the keyboard somewhere
    // the user cannot see. The first control they can actually read gets it.
    const target =
      initialFocus === 'field'
        ? box.current?.querySelector<HTMLElement>(
            'input:not([type=file]), textarea, select, .select-trigger',
          )
        : null;
    (target ?? box.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== mine || event.defaultPrevented) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !box.current) return;

      // getClientRects rather than offsetParent: the drawer is position:fixed,
      // where offsetParent answers for the wrong reason.
      const stops = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.getClientRects().length > 0,
      );
      if (stops.length === 0) {
        event.preventDefault();
        box.current.focus();
        return;
      }
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      const wrap = event.shiftKey ? stops[stops.length - 1] : stops[0];
      if (!box.current.contains(document.activeElement) || document.activeElement === edge) {
        event.preventDefault();
        wrap.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      dialogStack.splice(dialogStack.indexOf(mine), 1);
      // No-op if the opener left with the dialog — closing a review from its own
      // settings, for one.
      opener?.focus?.();
    };
  }, [box, initialFocus]);
}

/* ───────── drag to dismiss ───────── */

interface Drag {
  id: number;
  /** Where the gesture began. The whole travel is measured from here. */
  startX: number;
  /** The latest pointer position, and when it arrived. */
  x: number;
  at: number;
  /** A position from ~80ms back, so a pause before release reads as a pause
   *  rather than as whatever the last two pixels happened to be. */
  markX: number;
  markAt: number;
}

/**
 * Shove a right-hand drawer off the right edge to close it.
 *
 * Hand-rolled on pointer events rather than pulled from an animation library:
 * this is the only draggable surface in the product, and a runtime dependency
 * that exists for one gesture is one every later reader has to account for.
 *
 * Two things it does not do, both on purpose:
 *
 * · No React state per frame. The transform is written straight to `panel`, so a
 *   drag does not re-render the drawer's whole correspondent list sixty times a
 *   second. `dragging` changes twice per gesture and is only there for a cursor.
 * · No `transition: none` class. The inline `transition` is cleared before the
 *   inline `transform` on release, in that order, so the stylesheet's transition
 *   is live at the moment the value changes and the panel springs back rather
 *   than snapping.
 *
 * Pointer capture rather than listeners on `document` — a drag that leaves the
 * window still belongs to the element that started it, and the browser releases
 * the capture for us when it cancels the gesture.
 */
export function useDragDismiss(
  panel: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
): {
  dragging: boolean;
  /** Spread onto the handle — the header, not the whole panel. */
  handle: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  const live = useRef<Drag | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  const finish = (commit: boolean) => {
    const drag = live.current;
    live.current = null;
    setDragging(false);
    if (panel.current) {
      panel.current.style.transition = '';
      panel.current.style.transform = '';
    }
    if (!drag || !commit) return;
    // Either a long shove or a fast flick. A throw that only travelled 40px
    // means the same thing as a slow push past halfway.
    const speed = ((drag.x - drag.markX) / Math.max(1, drag.at - drag.markAt)) * 1000;
    if (drag.x - drag.startX > 140 || speed > 480) dismiss.current();
  };

  return {
    dragging,
    handle: {
      onPointerDown: (event) => {
        // The close button lives in the header. A press on it is a click.
        if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        live.current = {
          id: event.pointerId,
          startX: event.clientX,
          x: event.clientX,
          at: event.timeStamp,
          markX: event.clientX,
          markAt: event.timeStamp,
        };
        if (panel.current) panel.current.style.transition = 'none';
        setDragging(true);
      },
      onPointerMove: (event) => {
        const drag = live.current;
        if (!drag || drag.id !== event.pointerId) return;
        if (event.timeStamp - drag.markAt > 80) {
          drag.markX = drag.x;
          drag.markAt = drag.at;
        }
        drag.x = event.clientX;
        drag.at = event.timeStamp;
        // Rightwards is the way out, so the panel follows. Leftwards is into the
        // page behind it, so it does not move at all.
        const offset = Math.max(0, event.clientX - drag.startX);
        if (panel.current) panel.current.style.transform = `translateX(${offset}px)`;
      },
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
    },
  };
}

/* ───────── file drops ───────── */

/**
 * Drag files anywhere onto `handlers`' element and they are taken; drag them
 * anywhere else and nothing happens — including the browser's own default,
 * which is to navigate to the file and take the half-filled form with it.
 * Suppressing that is the reason this is a hook and not four inline props.
 *
 * The whole drop is handed over rather than its first file: a reader dragging
 * the documents for a review drags all of them at once, and silently keeping
 * one of five is worse than refusing the drop outright.
 */
export function useFileDrop(onFiles: (files: FileList) => void): {
  dragging: boolean;
  handlers: {
    onDragOver: (event: React.DragEvent) => void;
    onDragLeave: (event: React.DragEvent) => void;
    onDrop: (event: React.DragEvent) => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(onFiles);
  latest.current = onFiles;

  useEffect(() => {
    const swallow = (event: DragEvent) => event.preventDefault();
    document.addEventListener('dragover', swallow);
    document.addEventListener('drop', swallow);
    return () => {
      document.removeEventListener('dragover', swallow);
      document.removeEventListener('drop', swallow);
    };
  }, []);

  return {
    dragging,
    handlers: {
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      },
      // dragleave fires for every child crossed on the way in, so the only
      // leave that counts is one whose destination is outside the zone.
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        setDragging(false);
        const files = event.dataTransfer.files;
        if (files && files.length > 0) latest.current(files);
      },
    },
  };
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

/** How long an agent has been at it: "8s", then "1m 04s". Seconds, never "a while". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
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
