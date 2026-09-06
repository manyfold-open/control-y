/**
 * A word-level diff, for the one place that needs one: an issue the panel
 * rewrote, where the `revised` chip says something changed and nothing on the
 * screen says what.
 *
 * Words, not characters. A character diff of "£1.2m" against "£1.4m" picks out
 * the digit, which looks clever and reads as noise; a reader comparing two
 * statements wants the phrase that moved.
 *
 * Pure string work, no runtime dependencies — in shared for the same reason
 * letter.ts is: it is about the shape of an issue, not about the browser.
 */

export interface DiffPart {
  text: string;
  kind: 'same' | 'added' | 'removed';
}

/** Words and the gaps between them, so re-joining the pieces reproduces the input. */
const tokenize = (value: string): string[] => value.split(/(\s+)/).filter((piece) => piece !== '');

/**
 * Above this the table stops being cheap — and a statement this long is not one
 * anybody reads word by word anyway, so it falls back to "all of that became all
 * of this". The consolidator caps statements at 600 characters, so this is a
 * guard against pasted text arriving here one day, not a case that happens now.
 */
const MAX_TOKENS = 400;

/** Adjacent pieces of the same kind become one, so a run of deleted words is one `<del>`. */
function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);

  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return merge([
      ...a.map((text): DiffPart => ({ text, kind: 'removed' })),
      ...b.map((text): DiffPart => ({ text, kind: 'added' })),
    ]);
  }

  // Longest common subsequence, filled back to front so the walk below can go
  // forward and come out in reading order.
  const lcs: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      parts.push({ text: a[i], kind: 'same' });
      i += 1;
      j += 1;
      // The tie goes to the deletion, so a replaced phrase reads old-then-new
      // rather than new-then-old.
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      parts.push({ text: a[i], kind: 'removed' });
      i += 1;
    } else {
      parts.push({ text: b[j], kind: 'added' });
      j += 1;
    }
  }
  while (i < a.length) {
    parts.push({ text: a[i], kind: 'removed' });
    i += 1;
  }
  while (j < b.length) {
    parts.push({ text: b[j], kind: 'added' });
    j += 1;
  }

  return merge(parts);
}
