import { describe, expect, it } from 'vitest';
import { composeLetter, letterBody } from '../src/shared/letter';
import type { Issue, RosterEntry } from '../src/shared/types';

const issue = (fields: Partial<Issue>): Issue => ({
  id: 'i1',
  ref: 'TZ-047',
  location: 'staging!row 47',
  severity: 'material',
  status: 'open',
  statement: 'A statement.',
  whyItMatters: 'Why it matters.',
  raisedBy: [],
  assigneeId: 'p-roos',
  assigneeReason: '',
  flags: [],
  evidence: null,
  memory: null,
  conflict: null,
  draft: null,
  resolution: null,
  sentAt: null,
  previous: null,
  ...fields,
});

const anneke: RosterEntry = {
  id: 'p-roos',
  name: 'Anneke Roos',
  org: 'Meridian Fund Services',
  role: 'Fund accountant',
  email: 'a.roos@meridianfs.com',
  isSelf: false,
  reviewTitle: 'Prepared the Q1 journal batch',
};

describe('letterBody', () => {
  it('strips a greeting and a sign-off so several drafts merge into one letter', () => {
    const draft = 'Hello Sigrid,\n\nThe 27 March payment is unclassified.\n\nCould you confirm?\n\nThank you.';
    expect(letterBody(draft)).toBe('The 27 March payment is unclassified.\n\nCould you confirm?');
  });

  it('leaves a draft that opens with substance untouched', () => {
    const draft = 'The DKK 134.51 break runs the wrong way.\n\nPlease re-check it.';
    expect(letterBody(draft)).toBe(draft);
  });

  it('never strips a draft down to nothing', () => {
    expect(letterBody('Hello Anneke,\n\nThank you.')).toBe('Hello Anneke,\n\nThank you.');
    expect(letterBody('Hi,')).toBe('Hi,');
    expect(letterBody('   ')).toBe('');
  });

  it('keeps a body paragraph that merely follows a greeting', () => {
    expect(letterBody('Hello Tomas,\n\nBest guesses are not enough here.\n\nRegards')).toBe(
      'Best guesses are not enough here.',
    );
  });
});

describe('composeLetter', () => {
  it('numbers each issue under one greeting and one sign-off', () => {
    const letter = composeLetter(anneke, 'Q1 2026 journal batch', [
      issue({ ref: 'TZ-012', draft: 'Hello Anneke,\n\nThirty rows have no project code.\n\nThank you.' }),
      issue({ ref: 'TZ-031', location: 'recon!DKK', statement: 'The break runs the wrong way.', whyItMatters: 'Direction is wrong.' }),
    ]);
    expect(letter).toContain('Hello Anneke,');
    expect(letter).toContain('are 2 points on the Q1 2026 journal batch');
    expect(letter).toContain('1. TZ-012');
    expect(letter).toContain('Thirty rows have no project code.');
    expect(letter).toContain('2. TZ-031 · recon!DKK');
    expect(letter).toContain('Direction is wrong.');
    // Only the outer greeting and sign-off survive.
    expect(letter.match(/Hello Anneke,/g)).toHaveLength(1);
    expect(letter.match(/Thank you\./g)).toHaveLength(1);
  });

  it('says "one point" rather than "1 points"', () => {
    const letter = composeLetter(anneke, 'Q1 2026 journal batch', [issue({})]);
    expect(letter).toContain('There is one point on the Q1 2026 journal batch that needs you.');
  });
});
