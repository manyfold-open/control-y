/**
 * The turns of a pass, one row each.
 *
 * A pass used to be one Worker invocation that held every agent's SSE stream open
 * for as long as the agents thought — minutes — and lived only as long as the
 * browser's own connection to it. It was killed by idle timeouts, by its
 * subrequest allowance, and by the user closing the tab; and every time, the agents
 * finished anyway (`tasks/list` showed the artifacts) with nobody left to collect.
 *
 * Now a turn is sent with `message/send { blocking: false }` and followed with
 * `tasks/get` from whatever short invocation comes next: the review page's poll, or
 * the minute cron. This module is the rows that make that possible; panel.ts decides
 * what happens to them.
 *
 * `message_id` is derived from the pass and the key, never random: A2A treats it as
 * an idempotency key, so a send retried after a refused first attempt returns the
 * original task instead of billing a second turn. `prompt` is kept for the same
 * reason — a retry has to send exactly what was meant.
 */

import type { Env } from './types';
import { now } from './db';
import { TERMINAL_STATES } from './a2a';

export type TurnRole = 'reviewer' | 'consolidator';

/**
 * `waiting` is the consolidator before the reviewers are in; `queued` is a turn
 * with a prompt and no task yet; everything after that is the A2A task state as the
 * agent last reported it.
 */
export type TurnState = 'waiting' | 'queued' | string;

export interface TurnRow {
  id: string;
  pass_id: string;
  review_id: string;
  key: string;
  name: string;
  role: TurnRole;
  agent_id: string | null;
  message_id: string;
  prompt: string;
  attachments: string;
  task_id: string | null;
  state: TurnState;
  note: string;
  reply: string | null;
  findings: number | null;
  error: string | null;
  sent_at: string | null;
  polled_at: string | null;
  finished_at: string | null;
}

export const turnId = (passId: string, key: string): string => `${passId}:${key}`;
export const turnMessageId = (passId: string, key: string): string => `turnzero-${passId}-${key}`;

/** A turn that has landed, one way or the other. */
export const settled = (turn: Pick<TurnRow, 'finished_at'>): boolean => turn.finished_at !== null;

/** A turn the agent has accepted and not yet finished. */
export const inFlight = (turn: Pick<TurnRow, 'task_id' | 'finished_at'>): boolean =>
  turn.task_id !== null && turn.finished_at === null;

export const isTerminalState = (state: string): boolean => TERMINAL_STATES.has(state);

export async function insertTurns(
  env: Env,
  turns: Array<
    Pick<TurnRow, 'pass_id' | 'review_id' | 'key' | 'name' | 'role' | 'agent_id' | 'prompt' | 'state'> & {
      attachments: unknown[];
    }
  >,
): Promise<void> {
  if (turns.length === 0) return;
  await env.DB.batch(
    turns.map((turn) =>
      env.DB.prepare(
        `INSERT INTO pass_turns (id, pass_id, review_id, key, name, role, agent_id, message_id, prompt, attachments, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        turnId(turn.pass_id, turn.key),
        turn.pass_id,
        turn.review_id,
        turn.key,
        turn.name,
        turn.role,
        turn.agent_id,
        turnMessageId(turn.pass_id, turn.key),
        turn.prompt,
        JSON.stringify(turn.attachments),
        turn.state,
      ),
    ),
  );
}

export async function listTurns(env: Env, passId: string): Promise<TurnRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM pass_turns WHERE pass_id = ? ORDER BY rowid')
    .bind(passId)
    .all<TurnRow>();
  return results ?? [];
}

/** Every turn of every pass on a review, for the pass list to fold in. */
export async function listReviewTurns(env: Env, reviewId: string): Promise<TurnRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM pass_turns WHERE review_id = ? ORDER BY rowid')
    .bind(reviewId)
    .all<TurnRow>();
  return results ?? [];
}

/** The agent accepted the turn: remember the task so the next invocation can follow it. */
export async function markSent(
  env: Env,
  id: string,
  fields: { taskId: string | null; state: string; agentId: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE pass_turns SET task_id = ?, state = ?, agent_id = ?, error = NULL, sent_at = ?, polled_at = ?
     WHERE id = ? AND finished_at IS NULL`,
  )
    .bind(fields.taskId, fields.state, fields.agentId, now(), now(), id)
    .run();
}

/** Nothing conclusive yet. Records what the agent said, and that it was asked. */
export async function markPolled(
  env: Env,
  id: string,
  fields: { state?: string; note?: string; error?: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE pass_turns SET
       state = COALESCE(?, state),
       note = COALESCE(?, note),
       error = ?,
       polled_at = ?
     WHERE id = ? AND finished_at IS NULL`,
  )
    .bind(fields.state ?? null, fields.note ?? null, fields.error ?? null, now(), id)
    .run();
}

/**
 * Ends a turn. Conditional on it not having ended already, and reports whether this
 * call was the one that ended it — so two invocations reading the same finished
 * task cannot both act on it. Whoever settles the consolidator consolidates.
 */
export async function settleTurn(
  env: Env,
  id: string,
  fields: { state: string; reply: string | null; findings: number | null; error: string | null },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE pass_turns SET state = ?, reply = ?, findings = ?, error = ?, polled_at = ?, finished_at = ?
     WHERE id = ? AND finished_at IS NULL`,
  )
    .bind(fields.state, fields.reply, fields.findings, fields.error, now(), now(), id)
    .run();
  return Boolean(result.meta.changes);
}

/** Moves a turn from one pre-flight state to another, exactly once. */
export async function claimTurn(env: Env, id: string, from: TurnState, to: TurnState): Promise<boolean> {
  const result = await env.DB.prepare('UPDATE pass_turns SET state = ? WHERE id = ? AND state = ?')
    .bind(to, id, from)
    .run();
  return Boolean(result.meta.changes);
}

/** Gives a claimed turn its prompt, when that could only be written later. */
export async function setTurnPrompt(env: Env, id: string, prompt: string): Promise<void> {
  await env.DB.prepare('UPDATE pass_turns SET prompt = ? WHERE id = ?').bind(prompt, id).run();
}

/* ───────── the pass's context ───────── */

export async function savePassContext(env: Env, passId: string, context: unknown): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO pass_contexts (pass_id, context) VALUES (?, ?)')
    .bind(passId, JSON.stringify(context))
    .run();
}

export async function loadPassContext<T>(env: Env, passId: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT context FROM pass_contexts WHERE pass_id = ?')
    .bind(passId)
    .first<{ context: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.context) as T;
  } catch {
    return null;
  }
}

export interface RunningPass {
  id: string;
  review_id: string;
  started_at: string;
}

export async function listRunningPasses(env: Env): Promise<RunningPass[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, review_id, started_at FROM passes WHERE status = 'running' ORDER BY started_at",
  ).all<RunningPass>();
  return results ?? [];
}
