import { describe, expect, it } from 'vitest';
import { diffWords, type DiffPart } from '../src/shared/diff';

/* The two guarantees the callout leans on: the parts join back into exactly the
   two strings that went in, and a small edit produces a small diff. Everything
   else is presentation. */

const rebuild = (parts: DiffPart[], side: 'before' | 'after'): string =>
  parts
    .filter((part) => part.kind === 'same' || part.kind === (side === 'before' ? 'removed' : 'added'))
    .map((part) => part.text)
    .join('');

const changed = (parts: DiffPart[]): DiffPart[] => parts.filter((part) => part.kind !== 'same');

describe('diffWords', () => {
  it('reproduces both inputs exactly', () => {
    const before = '52 rows carry a counterparty string that resolves to no entity on the master list.';
    const after = '41 of 52 rows carry a counterparty string that resolves to no entity on the master list.';
    const parts = diffWords(before, after);
    expect(rebuild(parts, 'before')).toBe(before);
    expect(rebuild(parts, 'after')).toBe(after);
  });

  it('keeps an unchanged statement whole', () => {
    const parts = diffWords('The rule changed on 1 March 2026.', 'The rule changed on 1 March 2026.');
    expect(parts).toEqual([{ text: 'The rule changed on 1 March 2026.', kind: 'same' }]);
  });

  it('touches only the words that moved', () => {
    const parts = diffWords('The accrual is struck at 1.50%.', 'The accrual is struck at 1.25%.');
    expect(changed(parts)).toEqual([
      { text: '1.50%.', kind: 'removed' },
      { text: '1.25%.', kind: 'added' },
    ]);
  });

  it('runs a deleted phrase together rather than one <del> per word', () => {
    const parts = diffWords('a b c d e', 'a e');
    expect(changed(parts)).toEqual([{ text: 'b c d ', kind: 'removed' }]);
  });

  it('reads old before new on a replacement', () => {
    const kinds = changed(diffWords('the cat sat', 'the dog sat')).map((part) => part.kind);
    expect(kinds).toEqual(['removed', 'added']);
  });

  it('survives an empty side', () => {
    expect(diffWords('', 'Something new.')).toEqual([{ text: 'Something new.', kind: 'added' }]);
    expect(diffWords('Something old.', '')).toEqual([{ text: 'Something old.', kind: 'removed' }]);
    expect(diffWords('', '')).toEqual([]);
  });

  it('falls back to a whole-block replacement past the token cap', () => {
    const long = Array.from({ length: 500 }, (_, index) => `word${index}`).join(' ');
    const parts = diffWords(long, `${long} tail`);
    expect(parts.map((part) => part.kind)).toEqual(['removed', 'added']);
    expect(rebuild(parts, 'before')).toBe(long);
    expect(rebuild(parts, 'after')).toBe(`${long} tail`);
  });
});
