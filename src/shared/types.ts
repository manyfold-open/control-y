/**
 * Types shared between the Worker (src/worker) and the browser app (src/app).
 * Everything here is part of the JSON API surface, so keep it serializable
 * and free of runtime imports from either side.
 */

/** A Manyfold agent the user authorized, as exposed to the browser (never the token). */
export interface ConnectedAgent {
  agentId: string;
  name: string;
  description: string;
  rpcUrl: string;
  expiresAt: string | null;
  /** Did the non-billing auth probe succeed at connect / last verify time? */
  verified: boolean;
  warning: string | null;
  connectedAt: string;
}

/** An in-flight Manyfold authorization handshake, as exposed to the browser. */
export interface ConnectSession {
  connectId: string;
  /** Shown to the user to compare against Manyfold's consent page (anti-phishing). */
  userCode: string;
  authUrl: string;
  expiresAt: string;
}

export type PollStatus = 'pending' | 'denied' | 'expired' | 'approved';

export interface PollOutcome {
  status: PollStatus;
  userEmail?: string | null;
  agents?: ConnectedAgent[];
  failed?: { name: string; error: string }[];
}

/** Bootstrap payload: everything the SPA needs to render its first frame. */
export interface AppState {
  service: string;
  /** Is ADMIN_PASSWORD set on the deployment? */
  adminRequired: boolean;
  /** Did this request carry a valid x-admin-password header (or none is needed)? */
  adminOk: boolean;
  connect: { session: ConnectSession | null };
  agents: ConnectedAgent[];
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  content: string;
  status: 'complete' | 'error' | 'input-required';
  error: string | null;
  createdAt: string;
}

export interface ConversationInfo {
  contextId: string | null;
  activeTaskId: string | null;
}

/**
 * Events the Worker streams to the browser during a chat turn (SSE `data:` payloads).
 * `text` always carries the FULL accumulated reply — the client replaces, never appends,
 * so A2A artifact append/lastChunk semantics stay entirely server-side.
 */
export type ChatEvent =
  | { type: 'status'; state: string; taskId: string | null; contextId: string | null }
  | { type: 'text'; text: string }
  | { type: 'done'; state: string; text: string }
  | { type: 'error'; message: string };

export interface ApiErrorBody {
  error: { code: string; message: string };
}
