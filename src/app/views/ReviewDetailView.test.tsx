/**
 * The live view of a running pass: how the pass row the Worker keeps current folds
 * into what the header shows while the panel works.
 *
 * Worth testing away from the browser because the reading is the whole point — an
 * agent is queued until it is asked, reading until it lands, and the consolidator
 * is not on the roster the pass started with at all.
 */

import { describe, expect, it } from 'vitest';
import { liveFromPass, liveStatus } from './ReviewDetailView';
import type { Pass, PassAgentResult } from '../../shared/types';

const agent = (over: Partial<PassAgentResult> & Pick<PassAgentResult, 'key' | 'name'>): PassAgentResult => ({
  findings: null,
  error: null,
  ...over,
});

const running = (agents: PassAgentResult[]): Pass => ({
  id: 'pass-1',
  number: 3,
  status: 'running',
  openCount: null,
  error: null,
  agents,
  memoryEffects: 0,
  startedAt: '2026-09-06T00:00:00.000Z',
  finishedAt: null,
});

describe('liveFromPass', () => {
  it('lists every reviewer in the order the pass did, queued until asked', () => {
    const live = liveFromPass(
      running([agent({ key: 'a-tie', name: 'Tie-out' }), agent({ key: 'a-doc', name: 'Documents' })]),
    );
    expect(live.order).toEqual(['a-tie', 'a-doc']);
    expect(live.total).toBe(2);
    expect(live.stage).toBe('reviewers');
    expect(live.agents['a-tie']).toMatchObject({ name: 'Tie-out', state: '', note: '', startedAt: null });
  });

  it('reads the state, the note and the clock off the agent', () => {
    const live = liveFromPass(
      running([
        agent({
          key: 'a-tie',
          name: 'Tie-out',
          state: 'working',
          note: 'Reading staging.xlsx',
          startedAt: '2026-09-06T00:00:05.000Z',
        }),
      ]),
    );
    expect(live.agents['a-tie']).toMatchObject({
      state: 'working',
      note: 'Reading staging.xlsx',
      startedAt: Date.parse('2026-09-06T00:00:05.000Z'),
      finishedAt: null,
    });
  });

  it('counts a reviewer as answered once it has findings or an error, not before', () => {
    const live = liveFromPass(
      running([
        agent({ key: 'a-tie', name: 'Tie-out', findings: 4, finishedAt: '2026-09-06T00:00:12.000Z' }),
        agent({ key: 'a-doc', name: 'Documents', error: 'timed out', finishedAt: '2026-09-06T00:00:13.000Z' }),
        agent({ key: 'a-ref', name: 'Reference data', state: 'working' }),
      ]),
    );
    expect(live.done).toBe(2);
    expect(live.total).toBe(3);
    expect(live.agents['a-tie'].finishedAt).toBe(Date.parse('2026-09-06T00:00:12.000Z'));
  });

  it('moves to the consolidator stage when it joins, without counting it as a reviewer', () => {
    const live = liveFromPass(
      running([
        agent({ key: 'a-tie', name: 'Tie-out', findings: 4 }),
        agent({ key: 'consolidator', name: 'Consolidator', state: 'submitted' }),
      ]),
    );
    expect(live.stage).toBe('consolidator');
    expect(live.order).toEqual(['a-tie', 'consolidator']);
    expect(live.total).toBe(1);
    expect(live.done).toBe(1);
    expect(live.agents.consolidator.name).toBe('Consolidator');
  });
});

describe('liveStatus', () => {
  const status = (over: Partial<Parameters<typeof liveStatus>[0]> = {}) =>
    liveStatus({
      name: 'Tie-out',
      state: '',
      note: '',
      findings: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      ...over,
    });

  it('calls an agent that has not been asked yet queued, not slow', () => {
    expect(status().label).toBe('queued');
  });

  it('separates sent from reading', () => {
    expect(status({ state: 'submitted' }).label).toBe('sent');
    expect(status({ state: 'working' }).label).toBe('reading');
  });

  it('shows a state it does not recognise as the agent said it', () => {
    expect(status({ state: 'auth-required' }).label).toBe('auth-required');
  });

  it('states nothing found as a result, not as an absence', () => {
    expect(status({ findings: 0 }).label).toBe('nothing found');
  });

  it('shows the count once an agent lands, over whatever state it left behind', () => {
    expect(status({ state: 'working', findings: 7 }).label).toBe('7');
  });

  it('reports an agent that could not be reached', () => {
    expect(status({ state: 'working', error: 'timed out' }).label).toBe('did not answer');
  });
});
