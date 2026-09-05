/**
 * Client side of the chat stream. EventSource cannot POST or set headers, so this
 * is a plain fetch whose response body is read as SSE: frames separated by a blank
 * line, JSON payload on `data:` lines. Each parsed ChatEvent is handed to the
 * caller in order; the promise resolves when the stream closes.
 */

import type { ChatEvent } from '../shared/types';
import { ApiError, authHeaders } from './api';
import type { ApiErrorBody } from '../shared/types';

export async function streamChat(
  agentId: string,
  message: string,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Chat failed with HTTP ${response.status}.`,
    );
  }
  if (!response.body) throw new ApiError(502, 'no_stream', 'The chat response had no body.');

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
            onEvent(JSON.parse(data) as ChatEvent);
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
