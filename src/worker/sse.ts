/**
 * The server side of an event stream that has to survive a long silence.
 *
 * A pass is minutes of agent turns, and the agents do not stream while they think
 * (see the note on TURN_IDLE_MS in panel.ts). So the interesting part of this
 * stream is the part where nothing happens — and a connection carrying nothing for
 * minutes is indistinguishable, to everything between here and the browser, from a
 * dead one.
 *
 * MEASURED on r-7b4d4c93, 6 Sept 2026: two passes in a row emitted their opening
 * burst of events, went quiet while five reviewers read a 656 KB spreadsheet, and
 * died at almost exactly 60s — heartbeats to 60s, then nothing, then the reaper
 * failing the row 60s after that (121s from start, twice, to a tenth of a second).
 * No agent had answered. The Worker running a pass lives only as long as this
 * response, so whatever dropped the idle connection killed the run with it.
 *
 * Hence the keep-alive: a comment frame every KEEPALIVE_MS. It carries nothing — an
 * SSE comment is a line starting with a colon, and every parser ignores it,
 * including ours in src/app/sse.ts — but it puts bytes on the wire, which is the
 * entire point.
 */

/**
 * Floor between frames. Comfortably under the 60s idle timeout that killed the two
 * passes above, and under the 30s that proxies more commonly use, so several beats
 * have to be lost in a row before a live connection looks idle to anyone.
 */
const KEEPALIVE_MS = 10_000;

/**
 * How long one write may stall before the run stops waiting for a reader.
 * Comfortably longer than any real flush, far shorter than a single agent turn, so
 * a live watcher is never dropped and a dead one never blocks the run.
 */
const STALL_MS = 5_000;

export interface EventStream<Event> {
  /** The body to return in the Response. */
  readable: ReadableStream;
  /** Writes one event. Never throws, and never blocks for longer than STALL_MS. */
  emit: (event: Event) => Promise<void>;
  /** Stops the keep-alive and closes the stream. Call it exactly once, in a finally. */
  close: () => Promise<void>;
}

export const eventStreamHeaders = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
} as const;

/**
 * An SSE stream that keeps itself warm.
 *
 * `signal` is the request's abort signal: a closed tab is the common case, and
 * workerd reports it there long before a write would notice.
 */
export function eventStream<Event>(signal?: AbortSignal | null): EventStream<Event> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;

  signal?.addEventListener('abort', () => {
    clientGone = true;
  });

  const write = async (frame: string): Promise<void> => {
    if (clientGone) return;
    // A TransformStream writer applies backpressure: once nothing is reading the
    // readable side, write() neither resolves nor rejects, it simply never
    // settles. Awaiting it bare wedged a pass on its first event, before a single
    // agent had been asked anything, while the heartbeat kept beating from the
    // same invocation waitUntil was holding open. reapStaleRuns reads beats, so it
    // saw a healthy run and left the row latched for good.
    //
    // Bounding the wait is what makes "keep running, nobody is watching" true
    // rather than aspirational.
    const written = writer.write(encoder.encode(frame));
    written.catch(() => undefined); // the race below owns the outcome
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        written,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('emit stalled')), STALL_MS);
        }),
      ]);
    } catch {
      // The browser went away. Whatever is producing these events keeps running:
      // its outcome belongs on its own row whether or not anyone is still
      // watching it arrive.
      clientGone = true;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const beat: ReturnType<typeof setInterval> = setInterval(() => {
    // Nothing left to keep warm, and an interval left running would outlive the
    // response it was written for.
    if (clientGone) {
      clearInterval(beat);
      return;
    }
    void write(': keep-alive\n\n');
  }, KEEPALIVE_MS);

  return {
    readable,
    emit: (event) => write(`data: ${JSON.stringify(event)}\n\n`),
    close: async () => {
      clearInterval(beat);
      try {
        await writer.close();
      } catch {
        /* already closed or client gone */
      }
    },
  };
}
