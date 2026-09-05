/**
 * Manyfold connect: the user authorizes on Manyfold's own page and picks which agents
 * to share. No account token needed here, and no pre-arranged A2A peer relationship.
 *
 * The handshake, three steps:
 *   POST {base}/api/connect/a2a/start  {clientName, clientUrl?}
 *        → { requestId, userCode, authUrl, deviceCode, expiresAt }
 *   user opens authUrl, checks that userCode matches, ticks the agents to share
 *   POST {base}/api/connect/a2a/poll   {deviceCode}
 *        → pending | denied | expired
 *        | approved { userEmail, agents[{ agentId, name, rpcUrl, cardUrl, token, expiresAt }] }
 *
 * Security invariants, each for a reason:
 *  - deviceCode is the *only* thing that can redeem agent tokens, so it stays on the
 *    server, encrypted; the browser only gets an opaque connectId. Otherwise anyone who
 *    saw the response could redeem the user's credentials.
 *  - tokens are delivered once, so the approved branch flips the session to 'exchanged'
 *    before consuming them and wipes the used deviceCode; of two concurrent polls only
 *    one gets through.
 *  - the browser must display userCode for the user to check against the authorization
 *    page — that is the only anti-phishing check in this flow.
 *  - connectivity is verified with a tasks/get probe, never message/send: connecting
 *    N agents must not bill N turns.
 *  - a failed probe warns but does not roll back: the token has already been issued,
 *    and dropping it would leave a live credential nobody can revoke.
 */

import type { ConnectedAgent, ConnectSession, PollOutcome } from '../shared/types';
import type { AgentCredential, Env } from './types';
import {
  A2AError,
  describeFromCard,
  fetchTimeout,
  probeAgentAuth,
  safeErrorText,
  validateA2AUrl,
} from './a2a';
import { seal, unseal } from './crypto';
import { now } from './db';

const DEFAULT_API_BASE = 'https://api.manyfold.ai';
const CLIENT_NAME = 'Cloudflare Worker Starter';
const START_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 15 * 60_000;

const apiBase = (env: Env) => (env.MANYFOLD_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/+$/, '');

/** Thrown by connectFetch on a poll 404 that means "device code gone", not "wrong URL". */
class DeviceCodeGone extends Error {}

async function connectFetch<T>(
  env: Env,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const response = await fetchTimeout(
    `${apiBase(env)}${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    },
    timeoutMs,
  );

  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }

  if (!response.ok) {
    const message = String(parsed?.error?.message ?? `Manyfold returned ${response.status}.`);
    if (response.status === 404) {
      // A 404 means two different things and only the message tells them apart:
      // a dead device code answers "deviceCode not found", a mistyped base URL
      // answers with the router's "Cannot POST /…". Start never carries a device
      // code, so any 404 there is a config problem.
      const wrongPath = path.endsWith('/start') || /cannot\s+(post|get)/i.test(message);
      if (!wrongPath) throw new DeviceCodeGone(message);
      throw new A2AError(
        `${apiBase(env)}${path} does not exist (404). Check MANYFOLD_API_BASE_URL in wrangler.jsonc.`,
        false,
      );
    }
    throw new A2AError(`Manyfold rejected the request: ${safeErrorText(message)}`, response.status >= 500);
  }
  return parsed as T;
}

/* ───────── start ───────── */

interface StartResponse {
  requestId: string;
  userCode: string;
  authUrl: string;
  deviceCode: string;
  expiresAt: string;
}

export async function startConnect(env: Env, requestUrl: string): Promise<ConnectSession> {
  // Keep at most one handshake: the browser tracks one, and stale rows are just
  // device codes nobody can use.
  await env.DB.prepare('DELETE FROM connect_sessions').run();

  // clientUrl is optional and Manyfold requires https, so a local http origin is omitted.
  const origin = new URL(requestUrl).origin;
  const clientUrl = origin.startsWith('https://') ? origin : undefined;

  const started = await connectFetch<StartResponse>(
    env,
    '/api/connect/a2a/start',
    { clientName: CLIENT_NAME, ...(clientUrl ? { clientUrl } : {}) },
    START_TIMEOUT_MS,
  );
  if (!started?.deviceCode || !started.authUrl || !started.userCode) {
    throw new A2AError('Manyfold returned an incomplete handshake.', true);
  }

  // Fall back to our own TTL if the expiry does not parse, or the row never expires locally.
  const remote = Date.parse(started.expiresAt ?? '');
  const expiresAt = Number.isFinite(remote)
    ? new Date(remote).toISOString()
    : new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const sealed = await seal(env, started.deviceCode);
  const connectId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO connect_sessions
     (id, request_id, user_code, auth_url, device_code_ct, device_code_iv, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      connectId,
      started.requestId,
      started.userCode,
      started.authUrl,
      sealed.ciphertext,
      sealed.iv,
      now(),
      expiresAt,
    )
    .run();

  // deviceCode is deliberately not returned.
  return { connectId, userCode: started.userCode, authUrl: started.authUrl, expiresAt };
}

/** The in-flight handshake, if any — lets a reloaded page resume where it was. */
export async function getConnectSession(env: Env): Promise<ConnectSession | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_code, auth_url, expires_at FROM connect_sessions
     WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`,
  ).first<{ id: string; user_code: string; auth_url: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return {
    connectId: row.id,
    userCode: row.user_code,
    authUrl: row.auth_url,
    expiresAt: row.expires_at,
  };
}

/* ───────── poll ───────── */

interface PollAgent {
  agentId: string;
  name: string;
  rpcUrl: string;
  cardUrl: string;
  token: string;
  expiresAt: string | null;
}

type PollResponse =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; userEmail: string | null; agents: PollAgent[] };

export async function pollConnect(env: Env, connectId: string): Promise<PollOutcome> {
  const row = await env.DB.prepare(
    'SELECT id, device_code_ct, device_code_iv, expires_at, status FROM connect_sessions WHERE id = ?',
  )
    .bind(connectId)
    .first<{
      id: string;
      device_code_ct: string;
      device_code_iv: string;
      expires_at: string;
      status: string;
    }>();
  if (!row) throw new A2AError('That authorization session no longer exists.', false);
  if (row.status !== 'pending') return { status: 'expired' };
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE connect_sessions SET status='expired' WHERE id = ?")
      .bind(connectId)
      .run();
    return { status: 'expired' };
  }

  const deviceCode = await unseal(env, row.device_code_ct, row.device_code_iv);
  let result: PollResponse;
  try {
    result = await connectFetch<PollResponse>(
      env,
      '/api/connect/a2a/poll',
      { deviceCode },
      POLL_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof DeviceCodeGone) {
      // Expired, already redeemed elsewhere, or revoked — either way this session is over.
      await env.DB.prepare("UPDATE connect_sessions SET status='expired' WHERE id = ?")
        .bind(connectId)
        .run();
      return { status: 'expired' };
    }
    throw error;
  }

  if (result.status !== 'approved') {
    if (result.status !== 'pending') {
      await env.DB.prepare('UPDATE connect_sessions SET status = ? WHERE id = ?')
        .bind(result.status, connectId)
        .run();
    }
    return { status: result.status };
  }

  // Tokens are delivered once. Burn the session before consuming them and wipe the used
  // deviceCode; the status condition lets exactly one of two concurrent polls through,
  // and the loser reads 'expired' next time.
  const burned = await env.DB.prepare(
    `UPDATE connect_sessions SET status='exchanged', device_code_ct='', device_code_iv=''
     WHERE id = ? AND status='pending'`,
  )
    .bind(connectId)
    .run();
  if (!burned.meta.changes) return { status: 'expired' };

  const saved: ConnectedAgent[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const entry of result.agents ?? []) {
    try {
      saved.push(await saveConnectedAgent(env, entry));
    } catch (error) {
      failed.push({
        name: entry?.name ?? 'unknown agent',
        error: error instanceof Error ? safeErrorText(error.message) : safeErrorText(error),
      });
    }
  }

  return { status: 'approved', userEmail: result.userEmail ?? null, agents: saved, failed };
}

async function saveConnectedAgent(env: Env, entry: PollAgent): Promise<ConnectedAgent> {
  const rpcUrl = validateA2AUrl(entry.rpcUrl, env.ENVIRONMENT === 'production', "the agent's rpcUrl");
  const name = (entry.name || 'Manyfold agent').slice(0, 80);
  const description = entry.cardUrl ? await describeFromCard(entry.cardUrl) : '';
  const sealed = await seal(env, entry.token);
  const t = now();

  // The probe checks auth only; it does not run a turn. A failure is recorded as a
  // warning because the token is already issued — dropping it would leave a live
  // credential nobody can revoke.
  let verified = 1;
  let warning: string | null = null;
  try {
    await probeAgentAuth({ rpcUrl, token: entry.token, label: name });
  } catch (error) {
    verified = 0;
    warning = error instanceof Error ? safeErrorText(error.message) : safeErrorText(error);
  }

  await env.DB.prepare(
    `INSERT INTO agents
     (agent_id, name, description, rpc_url, card_url, token_ct, token_iv, expires_at, verified, warning, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET
       name = excluded.name, description = excluded.description, rpc_url = excluded.rpc_url,
       card_url = excluded.card_url, token_ct = excluded.token_ct, token_iv = excluded.token_iv,
       expires_at = excluded.expires_at, verified = excluded.verified,
       warning = excluded.warning, connected_at = excluded.connected_at`,
  )
    .bind(
      entry.agentId,
      name,
      description,
      rpcUrl,
      entry.cardUrl ?? null,
      sealed.ciphertext,
      sealed.iv,
      entry.expiresAt ?? null,
      verified,
      warning,
      t,
    )
    .run();

  // A rotated token starts a fresh session on the agent's side; the old conversation
  // ids belong to the old credential and would only confuse the next turn.
  await env.DB.prepare(
    'UPDATE conversations SET context_id = NULL, active_task_id = NULL, updated_at = ? WHERE agent_id = ?',
  )
    .bind(t, entry.agentId)
    .run();

  return {
    agentId: entry.agentId,
    name,
    description,
    rpcUrl,
    expiresAt: entry.expiresAt ?? null,
    verified: verified === 1,
    warning,
    connectedAt: t,
  };
}

export async function cancelConnect(env: Env, connectId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM connect_sessions WHERE id = ?').bind(connectId).run();
}

/* ───────── connected agents ───────── */

export async function listConnectedAgents(env: Env): Promise<ConnectedAgent[]> {
  // verified is 0/1 in D1; convert on the way out.
  const { results } = await env.DB.prepare(
    `SELECT agent_id AS agentId, name, description, rpc_url AS rpcUrl, expires_at AS expiresAt,
            verified, warning, connected_at AS connectedAt
     FROM agents ORDER BY connected_at DESC, name`,
  ).all<Omit<ConnectedAgent, 'verified'> & { verified: number }>();
  return (results ?? []).map((row) => ({ ...row, verified: row.verified === 1 }));
}

/** Decrypts one agent's credential for an actual A2A call. */
export async function credentialFor(env: Env, agentId: string): Promise<AgentCredential> {
  const row = await env.DB.prepare(
    'SELECT name, rpc_url, token_ct, token_iv, expires_at FROM agents WHERE agent_id = ?',
  )
    .bind(agentId)
    .first<{
      name: string;
      rpc_url: string;
      token_ct: string;
      token_iv: string;
      expires_at: string | null;
    }>();
  if (!row) throw new A2AError('That agent is not connected.', false);
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    throw new A2AError(
      `The authorization for "${row.name}" expired on ${row.expires_at}. Connect it again.`,
      false,
    );
  }
  return {
    rpcUrl: row.rpc_url,
    token: await unseal(env, row.token_ct, row.token_iv),
    label: row.name,
  };
}

/** Re-runs the non-billing auth probe and records the outcome. */
export async function verifyAgent(env: Env, agentId: string): Promise<ConnectedAgent> {
  const cred = await credentialFor(env, agentId);
  let verified = 1;
  let warning: string | null = null;
  try {
    await probeAgentAuth(cred);
  } catch (error) {
    verified = 0;
    warning = error instanceof Error ? safeErrorText(error.message) : safeErrorText(error);
  }
  await env.DB.prepare('UPDATE agents SET verified = ?, warning = ? WHERE agent_id = ?')
    .bind(verified, warning, agentId)
    .run();
  const agents = await listConnectedAgents(env);
  const agent = agents.find((entry) => entry.agentId === agentId);
  if (!agent) throw new A2AError('That agent is not connected.', false);
  return agent;
}

/** Removes the agent and everything that hangs off it. */
export async function disconnectAgent(env: Env, agentId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE agent_id = ?)`,
    ).bind(agentId),
    env.DB.prepare('DELETE FROM conversations WHERE agent_id = ?').bind(agentId),
    env.DB.prepare('DELETE FROM agents WHERE agent_id = ?').bind(agentId),
  ]);
}
