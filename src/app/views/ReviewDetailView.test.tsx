/**
 * The live view of a running pass: how the streamed events fold into what the
 * header shows while the panel works.
 *
 * Worth testing away from the browser because the ordering is the whole point —
 * an agent is queued until it is asked, reading until it lands, and the
 * consolidator is not on the roster the pass started with at all.
 */

import { describe, expect, it } from 'vitest';
import { applyPassEvent, liveStatus } from './ReviewDetailView';
import type { Pass, PassEvent } from '../../shared/types';

const pass: Pass = {
  id: 'pass-1',
  number: 3,
  status: 'running',
  openCount: null,
  error: null,
  agents: [
    { key: 'a-tie', name: 'Tie-out', findings: null, error: null },
    { key: 'a-doc', name: 'Documents', findings: null, error: null },
  ],
  memoryEffects: 0,
  startedAt: '2026-09-06T00:00:00.000Z',
  finishedAt: null,
};

const start: PassEvent = { type: 'start', pass };

/** Folds a run of events from nothing, the way the stream handler does. */
const fold = (events: PassEvent[], atMs = 1000) =>
  events.reduce<ReturnType<typeof applyPassEvent>>(
    (live, event) => applyPassEvent(live, event, atMs),
    null,
  );

describe('applyPassEvent', () => {
  it('seeds every enabled agent as queued, in the order the pass listed them', () => {
    const live = fold([start])!;
    expect(live.order).toEqual(['a-tie', 'a-doc']);
    expect(live.total).toBe(2);
    expect(live.agents['a-tie']).toMatchObject({ name: 'Tie-out', state: '', startedAt: null });
  });

  it('ignores anything that arrives before the pass exists', () => {
    const stage: PassEvent = { type: 'stage', stage: 'reviewers', done: 1, total: 2 };
    expect(applyPassEvent(null, stage, 1000)).toBeNull();
  });

  it('records the stage and its counters', () => {
    const live = fold([start, { type: 'stage', stage: 'consolidator', done: 0, total: 1 }])!;
    expect(live.stage).toBe('consolidator');
  });

  it('stamps the start time on the first progress and keeps it on the next', () => {
    const first = applyPassEvent(fold([start]), progress('a-tie', 'submitted'), 5_000)!;
    expect(first.agents['a-tie']).toMatchObject({ state: 'submitted', startedAt: 5_000 });

    const second = applyPassEvent(first, progress('a-tie', 'working', 'Reading staging.xlsx'), 9_000)!;
    expect(second.agents['a-tie']).toMatchObject({
      state: 'working',
      note: 'Reading staging.xlsx',
      startedAt: 5_000,
    });
  });

  it('records what an agent came back with, and when', () => {
    const live = applyPassEvent(
      fold([start, progress('a-tie', 'working')]),
      { type: 'agent', key: 'a-tie', name: 'Tie-out', findings: 4, error: null },
      12_000,
    )!;
    expect(live.agents['a-tie']).toMatchObject({ findings: 4, error: null, finishedAt: 12_000 });
  });

  it('adds the consolidator to the order when it first reports — it is not on the roster', () => {
    const live = fold([start, progress('consolidator', 'submitted')])!;
    expect(live.order).toEqual(['a-tie', 'a-doc', 'consolidator']);
    expect(live.agents.consolidator.name).toBe('Consolidator');
  });

  it('leaves the other agents alone when one reports', () => {
    const live = fold([start, progress('a-tie', 'working')])!;
    expect(live.agents['a-doc']).toMatchObject({ state: '', startedAt: null });
  });
});

describe('liveStatus', () => {
  const agent = (over: Partial<Parameters<typeof liveStatus>[0]> = {}) =>
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
    expect(agent().label).toBe('queued');
  });

  it('separates sent from reading', () => {
    expect(agent({ state: 'submitted' }).label).toBe('sent');
    expect(agent({ state: 'working' }).label).toBe('reading');
  });

  it('shows a state it does not recognise as the agent said it', () => {
    expect(agent({ state: 'auth-required' }).label).toBe('auth-required');
  });

  it('states nothing found as a result, not as an absence', () => {
    expect(agent({ findings: 0 }).label).toBe('nothing found');
  });

  it('shows the count once an agent lands, over whatever state it left behind', () => {
    expect(agent({ state: 'working', findings: 7 }).label).toBe('7');
  });

  it('reports an agent that could not be reached', () => {
    expect(agent({ state: 'working', error: 'timed out' }).label).toBe('did not answer');
  });
});

function progress(key: string, state: string, note = ''): PassEvent {
  const names: Record<string, string> = {
    'a-tie': 'Tie-out',
    'a-doc': 'Documents',
    consolidator: 'Consolidator',
  };
  return { type: 'progress', key, name: names[key] ?? key, state, note };
}
