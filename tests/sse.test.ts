import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventStream } from '../src/worker/sse';

const decoder = new TextDecoder();

/** Drains the stream in the background, the way a browser would. */
function collect(readable: ReadableStream): { frames: string[]; done: Promise<void> } {
  const frames: string[] = [];
  const reader = readable.getReader();
  const done = (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      frames.push(decoder.decode(chunk.value));
    }
  })();
  return { frames, done };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('eventStream', () => {
  // The collector is attached first on purpose: a TransformStream applies
  // backpressure from its very first write, so an emit before anything reads the
  // readable side does not settle. In the route that reader is workerd, pumping
  // the Response body this readable became.
  it('writes one SSE data frame per event', async () => {
    const stream = eventStream<{ n: number }>();
    const { frames, done } = collect(stream.readable);
    await stream.emit({ n: 1 });
    await stream.emit({ n: 2 });
    await stream.close();
    await done;
    expect(frames).toEqual(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']);
  });

  it('keeps the connection warm through a silence, and stops when it closes', async () => {
    vi.useFakeTimers();
    const stream = eventStream<{ n: number }>();
    const { frames, done } = collect(stream.readable);

    // A pass spends minutes here: five reviewers reading, nothing to report yet.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(frames).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);

    await stream.close();
    await done;

    // The interval must not outlive the response it was keeping open.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames).toHaveLength(2);
  });

  it('writes a keep-alive that carries no data line, so no parser sees an event', async () => {
    vi.useFakeTimers();
    const stream = eventStream<{ n: number }>();
    const { frames, done } = collect(stream.readable);
    await vi.advanceTimersByTimeAsync(10_000);
    await stream.close();
    await done;

    const dataLines = frames[0].split('\n').filter((line) => line.startsWith('data:'));
    expect(dataLines).toEqual([]);
  });

  it('gives up on a reader that has gone rather than blocking the run', async () => {
    vi.useFakeTimers();
    const stream = eventStream<{ n: number }>();
    // Nothing ever reads `stream.readable`: the tab is closed. Every write has to
    // settle anyway, or the run behind it stops on its first event.
    const writes = Promise.all([1, 2, 3].map((n) => stream.emit({ n })));
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(writes).resolves.toHaveLength(3);
  });
});
