/**
 * Client side of the two streamed operations: a chat turn, and a pass.
 *
 * EventSource cannot POST or set headers, so this is a plain fetch whose response
 * body is read as SSE: frames separated by a blank line, JSON payload on `data:`
 * lines. Each parsed event is handed to the caller in order; the promise resolves
 * when the stream closes.
 *
 * For a pass, holding this connection open is what keeps the Worker running it
 * alive — closing the tab part-way stops the run. See the route in
 * src/worker/routes.ts.
 */

import type { ChatEvent, PassEvent } from '../shared/types';
import { ApiError, authHeaders } from './api';
import type { ApiErrorBody } from '../shared/types';

export const streamChat = (
  agentId: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
): Promise<void> =>
  streamPost(`/api/agents/${encodeURIComponent(agentId)}/chat`, { message }, onEvent, 'Chat');

export const streamPass = (reviewId: string, onEvent: (event: PassEvent) => void): Promise<void> =>
  streamPost(`/api/reviews/${encodeURIComponent(reviewId)}/passes`, undefined, onEvent, 'The pass');

async function streamPost<Event>(
  path: string,
  body: unknown,
  onEvent: (event: Event) => void,
  label: string,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...authHeaders(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    let failure: ApiErrorBody | null = null;
    try {
      failure = (await response.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(
      response.status,
      failure?.error?.code ?? 'request_failed',
      failure?.error?.message ?? `${label} failed with HTTP ${response.status}.`,
    );
  }
  if (!response.body) throw new ApiError(502, 'no_stream', `${label} response had no body.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            onEvent(JSON.parse(data) as Event);
          } catch {
            /* skip malformed frame */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
