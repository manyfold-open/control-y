import { describe, expect, it } from 'vitest';
import { evidenceText, readEvidence } from '../src/shared/evidence';

/* ── readEvidence ────────────────────────────────────────────────────────────
   Two shapes arrive here. What a model returns now, and what is already in D1
   from before evidence was structured. There is no migration step in this app,
   so the old shape has to keep rendering for as long as those rows exist. */

describe('readEvidence', () => {
  it('reads the structured shape a model returns', () => {
    const evidence = readEvidence({
      label: 'staging.xlsx · row 47',
      quote: null,
      rows: [
        { field: 'amount', value: 'EUR 632,911.04', note: null },
        { field: 'counterparty', value: '(blank)', note: 'no match on the counterparty master' },
      ],
    });

    expect(evidence).toEqual({
      label: 'staging.xlsx · row 47',
      quote: null,
      rows: [
        { field: 'amount', value: 'EUR 632,911.04', note: null },
        { field: 'counterparty', value: '(blank)', note: 'no match on the counterparty master' },
      ],
    });
  });

  it('recovers columns from a row stored in the old lines format', () => {
    const evidence = readEvidence({
      label: 'staging.xlsx · row 47',
      lines: [
        'date          2026-03-27',
        'counterparty  (blank)         -> no match on counterparty master',
      ],
    });

    expect(evidence?.rows).toEqual([
      { field: 'date', value: '2026-03-27', note: null },
      { field: 'counterparty', value: '(blank)', note: 'no match on counterparty master' },
    ]);
  });

  it('keeps a prose line whole when there is no column to recover', () => {
    const evidence = readEvidence({
      label: 'recon.xlsx',
      lines: ['Note: "charge posted after cut-off"', '', '   a late charge would be negative'],
    });

    // The blank line carried nothing and is dropped; the indented line lost its
    // indentation to trimming long before it was stored, so it stands alone.
    expect(evidence?.rows).toEqual([
      { field: '', value: 'Note: "charge posted after cut-off"', note: null },
      { field: '', value: 'a late charge would be negative', note: null },
    ]);
  });

  it('reads a quotation, and defaults a missing label', () => {
    const evidence = readEvidence({ quote: 'the Management Fee shall not exceed 1.25%' });
    expect(evidence).toEqual({
      label: 'Evidence',
      quote: 'the Management Fee shall not exceed 1.25%',
      rows: [],
    });
  });

  it('returns null when there is nothing to show under the label', () => {
    expect(readEvidence(null)).toBeNull();
    expect(readEvidence('staging.xlsx')).toBeNull();
    expect(readEvidence({ label: 'staging.xlsx · row 47' })).toBeNull();
    expect(readEvidence({ label: 'x', rows: [{ field: '', value: '', note: '' }] })).toBeNull();
  });

  it('drops what it cannot read rather than the whole excerpt', () => {
    const evidence = readEvidence({
      label: 'x',
      quote: 42,
      rows: ['nonsense', null, { field: 'amount', value: 'EUR 1.00' }],
    });
    expect(evidence).toEqual({
      label: 'x',
      quote: null,
      rows: [{ field: 'amount', value: 'EUR 1.00', note: null }],
    });
  });

  it('caps a runaway record', () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ field: `f${index}`, value: 'v' }));
    expect(readEvidence({ label: 'x', rows })?.rows).toHaveLength(40);
  });
});

describe('evidenceText', () => {
  it('flattens quote and rows for the clipboard and the prompt', () => {
    const evidence = readEvidence({
      label: 'Fenwick side letter',
      quote: 'the Management Fee shall not exceed 1.25%',
      rows: [{ field: 'Q1 2026 accrual', value: '1.50% per annum', note: '25 bps above the cap' }],
    })!;

    expect(evidenceText(evidence)).toBe(
      'the Management Fee shall not exceed 1.25%\nQ1 2026 accrual  1.50% per annum  — 25 bps above the cap',
    );
  });
});
