/**
 * Reading whatever arrived into the one shape the product renders.
 *
 * Evidence has two sources and they do not agree. A model answering this pass
 * returns the structured shape the prompt asks for — a quote, and rows of
 * field / value / note. A row already in D1 from before that change holds the
 * shape the prompt used to ask for: `lines`, a list of text the agent had
 * hand-aligned with spaces to be poured into a `<pre>`.
 *
 * There is no migration step in this app, so the old shape is read rather than
 * rewritten. `fromLines` below recovers the columns the spaces stood for. It is
 * a salvage of a lossy format, not a format: the trimming in `asEvidence` had
 * already taken the leading indentation off every such line before it was
 * stored, so a continuation line cannot be told from a new field and prints
 * whole. New evidence never goes through it.
 *
 * Pure string work — it sits in shared because both the worker (reading D1 and
 * a model's answer) and the browser depend on the same reading.
 */

import type { Evidence, EvidenceRow } from './types';

/** What the panel wrote into the margin, arrow and all. */
const MARGIN = /\s(->|<-)\s/;

/** Two spaces or more is a column break — the convention the old format used. */
const GUTTER = /\s{2,}/;

const str = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

const FIELD_MAX = 120;
const VALUE_MAX = 300;
const NOTE_MAX = 300;
const QUOTE_MAX = 2000;
const ROWS_MAX = 40;

function asRow(value: unknown): EvidenceRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { field?: unknown; value?: unknown; note?: unknown };
  const field = str(raw.field, FIELD_MAX);
  const rowValue = str(raw.value, VALUE_MAX);
  const note = str(raw.note, NOTE_MAX);
  if (!field && !rowValue && !note) return null;
  return { field, value: rowValue, note: note || null };
}

/**
 * One line of the old format, read back into a row. A line with no column break
 * has no field to recover, so it becomes a value on its own and renders as the
 * prose it probably always was.
 */
function fromLine(line: string): EvidenceRow | null {
  if (!line.trim()) return null;

  const margin = MARGIN.exec(line);
  const quoted = margin ? line.slice(0, margin.index) : line;
  const note = margin ? line.slice(margin.index + margin[0].length) : '';

  const gutter = GUTTER.exec(quoted.trim());
  const trimmed = quoted.trim();

  return {
    field: gutter ? trimmed.slice(0, gutter.index).trim() : '',
    value: (gutter ? trimmed.slice(gutter.index) : trimmed).trim().slice(0, VALUE_MAX),
    note: note.trim().slice(0, NOTE_MAX) || null,
  };
}

const fromLines = (lines: unknown[]): EvidenceRow[] =>
  lines
    .map((line) => (typeof line === 'string' ? fromLine(line) : null))
    .filter((row): row is EvidenceRow => row !== null);

/**
 * Both shapes in, one shape out. Returns null when there is nothing to show —
 * a label alone is a citation with no excerpt under it, which is worse than no
 * evidence section at all.
 */
export function readEvidence(value: unknown): Evidence | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { label?: unknown; quote?: unknown; rows?: unknown; lines?: unknown };

  const rows = Array.isArray(raw.rows)
    ? raw.rows.map(asRow).filter((row): row is EvidenceRow => row !== null)
    : Array.isArray(raw.lines)
      ? fromLines(raw.lines)
      : [];

  const quote = str(raw.quote, QUOTE_MAX);
  if (!quote && rows.length === 0) return null;

  return {
    label: str(raw.label, 160) || 'Evidence',
    quote: quote || null,
    rows: rows.slice(0, ROWS_MAX),
  };
}

/** The excerpt as one block of text — for the clipboard and for the prompt. */
export const evidenceText = (evidence: Evidence): string =>
  [
    evidence.quote,
    ...evidence.rows.map((row) =>
      [row.field, row.value, row.note && `— ${row.note}`].filter(Boolean).join('  '),
    ),
  ]
    .filter(Boolean)
    .join('\n');
