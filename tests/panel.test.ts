import { describe, expect, it } from 'vitest';
import {
  buildAgentPrompt,
  buildConsolidatorPrompt,
  buildRetrospectivePrompt,
  consolidateIssues,
  parseLessons,
  parsePayload,
  progressUpdate,
} from '../src/worker/panel';
import type { Issue } from '../src/shared/types';

const ctx = {
  header: 'THE REVIEW\nQ1 2026 journal batch',
  memory: 'WHAT THIS WORKSPACE ALREADY KNOWS\n- [m-bank] [Treatment] Bank charges carry no counterparty.',
  documents: '### staging.xlsx\nrow 47  SARDONYX CLOSING  632,911.04',
  carried: 'ISSUES CARRIED IN\n- TZ-047 · material · staging!row 47',
  replies: '',
};

describe('parsePayload', () => {
  it('reads a bare JSON object', () => {
    expect(parsePayload<{ findings: unknown[] }>('{"findings":[]}')).toEqual({ findings: [] });
  });

  it('reads a fenced object, with or without the json tag', () => {
    expect(parsePayload('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parsePayload('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('reads an object wrapped in prose', () => {
    const reply = 'Here is what I found.\n\n{"findings":[{"statement":"x"}]}\n\nLet me know.';
    expect(parsePayload<{ findings: { statement: string }[] }>(reply)?.findings[0].statement).toBe('x');
  });

  it('returns null rather than throwing on anything unparseable', () => {
    expect(parsePayload('I could not do that.')).toBeNull();
    expect(parsePayload('{ not json at all }')).toBeNull();
    expect(parsePayload('')).toBeNull();
  });

  it('rejects a bare array or scalar — callers expect an object', () => {
    expect(parsePayload('[1,2,3]')).toBeNull();
    expect(parsePayload('42')).toBeNull();
  });
});

describe('prompt building', () => {
  it('puts the agent prompt first, then the review, memory and documents', () => {
    const prompt = buildAgentPrompt('Check every total.', ctx);
    expect(prompt.indexOf('Check every total.')).toBe(0);
    expect(prompt).toContain('Q1 2026 journal batch');
    expect(prompt).toContain('Bank charges carry no counterparty.');
    expect(prompt).toContain('SARDONYX CLOSING');
    expect(prompt).toContain('"findings"');
    // The agents must never be handed the roster: assignment is the consolidator's job.
    expect(prompt).not.toContain('assigneeId');
  });

  it('omits sections that are empty rather than leaving an empty heading', () => {
    const prompt = buildAgentPrompt('Check.', { ...ctx, memory: '', carried: '', replies: '' });
    expect(prompt).not.toContain('WHAT THIS WORKSPACE ALREADY KNOWS');
    expect(prompt).not.toContain('\n\n\n');
  });

  it('gives the consolidator the roster and the panel findings', () => {
    const prompt = buildConsolidatorPrompt(
      'Merge the findings.',
      ctx,
      '- p-roos — Anneke Roos',
      '### Arithmetic and bridges\n1. [material] recon!DKK',
    );
    expect(prompt).toContain('p-roos — Anneke Roos');
    expect(prompt).toContain('Arithmetic and bridges');
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain('assigneeId');
  });
});

/* ── consolidateIssues ───────────────────────────────────────────────────────
   The consolidator's reply is untrusted model output. These are the guarantees
   the rest of the product relies on when it is wrong. */

const carried: Issue = {
  id: 'i1',
  ref: 'TZ-047',
  location: 'staging!row 47',
  severity: 'material',
  status: 'open',
  statement: 'SARDONYX CLOSING resolves to nothing.',
  whyItMatters: 'Largest unresolved row.',
  raisedBy: ['Unresolved reference data'],
  assigneeId: 'p-halvorsen',
  assigneeReason: 'They ran the closing.',
  flags: [],
  evidence: {
    label: 'staging.xlsx · row 47',
    quote: null,
    rows: [{ field: 'amount', value: 'EUR 632,911.04', note: null }],
  },
  memory: null,
  conflict: null,
  draft: 'Hello Sigrid,\n\nWhat is this?\n\nThank you.',
  resolution: null,
  sentAt: null,
  previous: null,
};

const context = {
  existing: [carried],
  personIds: ['p-self', 'p-roos', 'p-halvorsen'],
  memoryIds: ['m-bank'],
  agentNames: ['Unresolved reference data', 'Arithmetic and bridges'],
};

describe('consolidateIssues', () => {
  it('carries an issue forward under its own ref', () => {
    const [issue] = consolidateIssues(
      [{ ref: 'TZ-047', status: 'resolved', severity: 'material', statement: 'Settled.', resolution: 'Counsel classified it.' }],
      context,
    );
    expect(issue.ref).toBe('TZ-047');
    expect(issue.status).toBe('resolved');
    expect(issue.resolution).toBe('Counsel classified it.');
    // Not a new issue, so it is not flagged as one.
    expect(issue.flags).toEqual([]);
  });

  it('mints a ref for a new issue and flags it new', () => {
    const [issue] = consolidateIssues([{ ref: null, statement: 'Something else.' }], context);
    expect(issue.ref).toBe('TZ-048');
    expect(issue.flags).toEqual(['new']);
  });

  it('ignores a second issue claiming a ref already used in this reply', () => {
    const issues = consolidateIssues(
      [
        { ref: 'TZ-047', statement: 'First.' },
        { ref: 'TZ-047', statement: 'Duplicate, must be dropped.' },
      ],
      context,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].statement).toBe('First.');
  });

  it('drops entries with no statement, and non-objects', () => {
    expect(consolidateIssues([null, 42, {}, { statement: '   ' }, 'x'], context)).toEqual([]);
  });

  it('keeps the existing severity when the reply gives an unreadable one', () => {
    const [issue] = consolidateIssues([{ ref: 'TZ-047', severity: 'urgent', statement: 'Still open.' }], context);
    expect(issue.severity).toBe('material');
  });

  it('defaults a new issue with no readable severity to a question', () => {
    const [issue] = consolidateIssues([{ severity: 'urgent', statement: 'New one.' }], context);
    expect(issue.severity).toBe('question');
  });

  it('refuses an assignee who is not on the roster, keeping the previous one', () => {
    const [carriedOn] = consolidateIssues([{ ref: 'TZ-047', assigneeId: 'ghost', statement: 'x' }], context);
    expect(carriedOn.assigneeId).toBe('p-halvorsen');
    const [fresh] = consolidateIssues([{ assigneeId: 'ghost', statement: 'y' }], context);
    expect(fresh.assigneeId).toBeNull();
  });

  it('keeps only agents that actually ran, and falls back to what was there', () => {
    const [issue] = consolidateIssues(
      [{ ref: 'TZ-047', raisedBy: ['Arithmetic and bridges', 'A made-up agent', 'Arithmetic and bridges'], statement: 'x' }],
      context,
    );
    expect(issue.raisedBy).toEqual(['Arithmetic and bridges']);
    const [kept] = consolidateIssues([{ ref: 'TZ-047', raisedBy: ['nobody real'], statement: 'x' }], context);
    expect(kept.raisedBy).toEqual(['Unresolved reference data']);
  });

  it('accepts a memory reference only for an entry that exists', () => {
    const [good] = consolidateIssues(
      [{ ref: 'TZ-047', statement: 'x', memory: { entryId: 'm-bank', effect: 'Severity dropped.' } }],
      context,
    );
    expect(good.memory).toEqual({ entryId: 'm-bank', effect: 'Severity dropped.' });
    const [bad] = consolidateIssues(
      [{ ref: 'TZ-047', statement: 'x', memory: { entryId: 'm-invented', effect: 'nope' } }],
      context,
    );
    expect(bad.memory).toBeNull();
  });

  it('keeps unreadable flags and evidence out, falling back to what exists', () => {
    const [issue] = consolidateIssues(
      [{ ref: 'TZ-047', statement: 'x', flags: ['urgent', 'CONTRADICTS', 7], evidence: 'not an object' }],
      context,
    );
    expect(issue.flags).toEqual(['contradicts']);
    expect(issue.evidence).toEqual(carried.evidence);
  });

  it('only records a conflict when two positions and a ruling are present', () => {
    const [one] = consolidateIssues(
      [{ statement: 'x', conflict: { positions: [{ agent: 'a', verdict: 'v' }], ruling: 'r' } }],
      context,
    );
    expect(one.conflict).toBeNull();
    const [two] = consolidateIssues(
      [{ statement: 'x', conflict: { positions: [{ agent: 'a', verdict: 'v' }, { agent: 'b', verdict: 'w' }], ruling: 'r' } }],
      context,
    );
    expect(two.conflict?.ruling).toBe('r');
  });

  it('drops a resolution on an issue that is not resolved', () => {
    const [issue] = consolidateIssues([{ ref: 'TZ-047', status: 'open', statement: 'x', resolution: 'not yet' }], context);
    expect(issue.resolution).toBeNull();
  });

  it('sorts material first, then presentational, then questions', () => {
    const issues = consolidateIssues(
      [
        { statement: 'a question', severity: 'question' },
        { statement: 'a material one', severity: 'material' },
      ],
      context,
    );
    expect(issues[0].sortOrder).toBeGreaterThan(issues[1].sortOrder);
  });
});

describe('buildRetrospectivePrompt', () => {
  const retroCtx = {
    header: 'THE REVIEW, NOW CLOSED\nQ1 2026 journal batch',
    history: 'HOW IT CONVERGED\n- pass 1: 18 open',
    issues: 'EVERY ISSUE RAISED ON THIS REVIEW\n- TZ-001 · material · resolved · agreed with Meridian',
    known: 'WHAT THIS WORKSPACE ALREADY KNOWS\n- [Treatment] Bank charges carry no counterparty.',
    replies: '',
  };

  it('puts the agent prompt first, then the review and its issues', () => {
    const prompt = buildRetrospectivePrompt('You are the retrospective.', retroCtx);
    expect(prompt.indexOf('You are the retrospective.')).toBe(0);
    expect(prompt.indexOf(retroCtx.header)).toBeLessThan(prompt.indexOf(retroCtx.issues));
    expect(prompt).toContain('"lessons"');
  });

  it('omits sections that are empty rather than leaving an empty heading', () => {
    const prompt = buildRetrospectivePrompt('p', { ...retroCtx, history: '', known: '', replies: '' });
    expect(prompt).not.toContain('\n\n\n');
    expect(prompt).toContain(retroCtx.issues);
  });
});

describe('parseLessons', () => {
  const lessonCtx = { refs: ['TZ-001', 'TZ-002'] };

  it('keeps a lesson that cites a ref on this review', () => {
    const [lesson] = parseLessons(
      [{ kind: 'Pattern', text: 'Check note 21 first.', basis: ['TZ-001'] }],
      lessonCtx,
    );
    expect(lesson).toMatchObject({ kind: 'Pattern', text: 'Check note 21 first.', basis: ['TZ-001'] });
  });

  it('drops a lesson citing no issue — an untethered rule would apply to every future review', () => {
    expect(parseLessons([{ kind: 'Fact', text: 'Something vague.', basis: [] }], lessonCtx)).toEqual([]);
    expect(parseLessons([{ kind: 'Fact', text: 'Something vague.' }], lessonCtx)).toEqual([]);
  });

  it('drops refs that belong to another review, and the lesson with them', () => {
    expect(parseLessons([{ text: 'x', basis: ['TZ-999'] }], lessonCtx)).toEqual([]);
    const [lesson] = parseLessons([{ text: 'x', basis: ['TZ-999', 'TZ-002'] }], lessonCtx);
    expect(lesson.basis).toEqual(['TZ-002']);
  });

  it('falls back to Treatment for an unreadable kind', () => {
    const [lesson] = parseLessons([{ kind: 'Nonsense', text: 'x', basis: ['TZ-001'] }], lessonCtx);
    expect(lesson.kind).toBe('Treatment');
  });

  it('drops entries with no text, and non-objects', () => {
    expect(parseLessons([null, 'nope', 42, { basis: ['TZ-001'] }], lessonCtx)).toEqual([]);
  });

  it('de-duplicates lessons that say the same thing', () => {
    const lessons = parseLessons(
      [
        { text: 'Check note 21 first.', basis: ['TZ-001'] },
        { text: 'check note 21 FIRST.', basis: ['TZ-002'] },
      ],
      lessonCtx,
    );
    expect(lessons).toHaveLength(1);
  });

  it('caps how many rules one close-out can propose', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ text: `rule ${index}`, basis: ['TZ-001'] }));
    expect(parseLessons(many, lessonCtx).length).toBeLessThanOrEqual(12);
  });
});

describe('progressUpdate', () => {
  const nothingSaidYet = { state: '', note: '', at: 0 };
  const working = (progressText = '') => ({ state: 'working', progressText, terminal: false });

  it('reports the first state an agent gives', () => {
    expect(progressUpdate(nothingSaidYet, working('Reading staging.xlsx'), 1000)).toEqual({
      state: 'working',
      note: 'Reading staging.xlsx',
    });
  });

  it('says nothing about a terminal snapshot — the agent event reports that outcome', () => {
    const done = { state: 'completed', progressText: 'Finished', terminal: true };
    expect(progressUpdate(nothingSaidYet, done, 1000)).toBeNull();
  });

  it('says nothing when the turn has no state to report', () => {
    expect(progressUpdate(nothingSaidYet, { state: '', progressText: 'x', terminal: false }, 1000)).toBeNull();
  });

  it('says nothing when the state and the note both repeat', () => {
    const last = { state: 'working', note: 'Reading', at: 1000 };
    expect(progressUpdate(last, working('Reading'), 9000)).toBeNull();
  });

  it('lets a state change through however soon it arrives', () => {
    const last = { state: 'submitted', note: '', at: 1000 };
    expect(progressUpdate(last, working(), 1001)).toEqual({ state: 'working', note: '' });
  });

  it('rate limits note churn under an unchanged state', () => {
    const last = { state: 'working', note: 'Reading page 1', at: 1000 };
    expect(progressUpdate(last, working('Reading page 2'), 1050)).toBeNull();
    expect(progressUpdate(last, working('Reading page 2'), 1400)).toEqual({
      state: 'working',
      note: 'Reading page 2',
    });
  });

  it('redacts a token an agent puts in its own progress text', () => {
    const leaky = working('Fetching with Bearer sk-live-abcdef123456');
    expect(progressUpdate(nothingSaidYet, leaky, 1000)?.note).toBe('Fetching with Bearer [redacted]');
  });

  it('caps a note long enough to reflow the header', () => {
    const note = progressUpdate(nothingSaidYet, working('x'.repeat(5000)), 1000)?.note ?? '';
    expect(note.length).toBe(200);
  });
});
