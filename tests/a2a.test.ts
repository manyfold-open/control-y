import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2AError, consumeA2AStream, foldA2AResults, safeErrorText, validateA2AUrl } from '../src/worker/a2a';

describe('foldA2AResults (stream accumulator)', () => {
  it('accumulates artifact appends and reaches a terminal state', () => {
    const snapshot = foldA2AResults([
      { kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'working' } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'Hello' }] } },
      { kind: 'artifact-update', append: true, artifact: { artifactId: 'a', parts: [{ kind: 'text', text: ', world' }] } },
      { kind: 'status-update', status: { state: 'completed' }, final: true },
    ]);
    expect(snapshot.text).toBe('Hello, world');
    expect(snapshot.taskId).toBe('t1');
    expect(snapshot.contextId).toBe('c1');
    expect(snapshot.state).toBe('completed');
    expect(snapshot.terminal).toBe(true);
  });

  it('replaces an artifact when append is not set', () => {
    const snapshot = foldA2AResults([
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'draft' }] } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'final' }] } },
    ]);
    expect(snapshot.text).toBe('final');
  });

  it('joins multiple artifacts in insertion order', () => {
    const snapshot = foldA2AResults([
      { kind: 'artifact-update', artifact: { artifactId: 'one', parts: [{ kind: 'text', text: 'first' }] } },
      { kind: 'artifact-update', artifact: { artifactId: 'two', parts: [{ kind: 'text', text: 'second' }] } },
    ]);
    expect(snapshot.text).toBe('first\n\nsecond');
  });

  it('falls back to direct message text, then status text', () => {
    const direct = foldA2AResults([
      { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'direct reply' }] },
    ]);
    expect(direct.text).toBe('direct reply');

    const status = foldA2AResults([
      { kind: 'status-update', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'thinking…' }] } } },
    ]);
    expect(status.text).toBe('thinking…');
    // When status text is the only text, it must not double as progress.
    expect(status.progressText).toBe('');
  });

  it('keeps progress narration separate from artifact text', () => {
    const snapshot = foldA2AResults([
      { kind: 'status-update', status: { state: 'working', message: { parts: [{ kind: 'text', text: 'working on it' }] } } },
      { kind: 'artifact-update', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'the answer' }] } },
    ]);
    expect(snapshot.text).toBe('the answer');
    expect(snapshot.progressText).toBe('working on it');
  });

  it('normalizes underscore and TASK_STATE_ prefixed states', () => {
    expect(foldA2AResults([{ status: { state: 'INPUT_REQUIRED' } }]).state).toBe('input-required');
    expect(foldA2AResults([{ status: { state: 'task_state_completed' } }]).terminal).toBe(true);
  });

  it('reads inline artifacts from a full task object', () => {
    const snapshot = foldA2AResults([
      {
        kind: 'task',
        id: 't9',
        status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'task result' }] }],
      },
    ]);
    expect(snapshot.text).toBe('task result');
    expect(snapshot.taskId).toBe('t9');
  });
});

describe('validateA2AUrl', () => {
  const label = 'the rpcUrl';

  it('accepts a public https URL and strips fragments', () => {
    expect(validateA2AUrl('https://api.manyfold.ai/api/a2a/agents/x/rpc#frag', true, label)).toBe(
      'https://api.manyfold.ai/api/a2a/agents/x/rpc',
    );
  });

  it.each([
    'http://api.manyfold.ai/rpc',
    'https://user:pass@api.manyfold.ai/rpc',
    'https://localhost/rpc',
    'https://127.0.0.1/rpc',
    'https://10.0.0.8/rpc',
    'https://192.168.1.5/rpc',
    'https://172.16.0.1/rpc',
    'https://169.254.169.254/latest/meta-data',
    'https://agent.local/rpc',
    'https://[::1]/rpc',
    'https://[fd00::1]/rpc',
    'not a url',
  ])('rejects %s in production', (url) => {
    expect(() => validateA2AUrl(url, true, label)).toThrow(A2AError);
  });

  it('allows http and private hosts in development', () => {
    expect(validateA2AUrl('http://localhost:8787/rpc', false, label)).toBe('http://localhost:8787/rpc');
  });
});

describe('safeErrorText', () => {
  it('redacts bearer tokens and JWTs', () => {
    const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
    const input = `HTTP 401 Bearer nca_secret_token for ${jwt} via ?token=abc123&x=1`;
    const output = safeErrorText(input);
    expect(output).not.toContain('nca_secret_token');
    expect(output).not.toContain(jwt);
    expect(output).not.toContain('abc123');
    expect(output).toContain('Bearer [redacted]');
  });

  it('collapses whitespace and truncates', () => {
    expect(safeErrorText('a\n\n  b')).toBe('a b');
    expect(safeErrorText('x'.repeat(2000)).length).toBeLessThanOrEqual(600);
  });
});

/* ───────── recovering a turn whose stream died ───────── */

const cred = { rpcUrl: 'https://agent.example/rpc', token: 'tok', label: 'ctrl-y-02' };

const frame = (result: unknown): string =>
  `data: ${JSON.stringify({ jsonrpc: '2.0', id: '1', result })}\n\n`;

/**
 * An SSE response that hands over `frames` and then either closes or has its
 * connection cut. The frames go out through `pull` rather than up front because
 * `controller.error()` discards anything still queued, and the point of the test
 * is a stream that dies *after* saying who it is.
 */
function sseResponse(frames: string[], cut: boolean): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (next < frames.length) {
        controller.enqueue(encoder.encode(frames[next++]));
        return;
      }
      if (cut) controller.error(new Error('Network connection lost.'));
      else controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

const WORKING = frame({ kind: 'status-update', taskId: 't1', contextId: 'c1', status: { state: 'working' } });

const FINISHED_TASK = {
  jsonrpc: '2.0',
  id: '2',
  result: {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: '{"findings":[]}' }] }],
  },
};

/** Records every call so a test can assert which A2A method was used. */
function stubFetch(responses: Response[]): { methods: string[] } {
  const methods: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    methods.push(JSON.parse(String(init.body)).method);
    const response = responses.shift();
    if (!response) throw new Error('unexpected extra request');
    return response;
  });
  return { methods };
}

describe('consumeA2AStream, when the stream dies mid-turn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (remaining: number | null) =>
    consumeA2AStream({
      cred,
      params: { message: { kind: 'message', role: 'user', parts: [] } },
      signal: new AbortController().signal,
      resume: remaining === null ? undefined : { remaining },
    });

  it('collects the answer with tasks/get instead of resending the turn', async () => {
    const { methods } = stubFetch([sseResponse([WORKING], true), jsonResponse(FINISHED_TASK)]);

    const snapshot = await run(4);

    expect(snapshot.text).toBe('{"findings":[]}');
    expect(snapshot.terminal).toBe(true);
    // Never a second message/send: that would bill the turn twice.
    expect(methods).toEqual(['message/stream', 'tasks/get']);
  });

  it('follows a stream that ends early without a verdict', async () => {
    const { methods } = stubFetch([sseResponse([WORKING], false), jsonResponse(FINISHED_TASK)]);
    const snapshot = await run(4);
    expect(snapshot.text).toBe('{"findings":[]}');
    expect(methods).toEqual(['message/stream', 'tasks/get']);
  });

  it('keeps the transport failure when the agent cannot answer for the task', async () => {
    stubFetch([
      sseResponse([WORKING], true),
      jsonResponse({ jsonrpc: '2.0', id: '2', error: { code: -32001, message: 'no such task' } }),
    ]);
    await expect(run(4)).rejects.toThrow('Network connection lost.');
  });

  it('fails fast without resume, and asks nothing further', async () => {
    const { methods } = stubFetch([sseResponse([WORKING], true)]);
    await expect(run(null)).rejects.toThrow('Network connection lost.');
    expect(methods).toEqual(['message/stream']);
  });

  it('cannot follow a stream that died before naming its task', async () => {
    const { methods } = stubFetch([sseResponse([], true)]);
    await expect(run(4)).rejects.toThrow(A2AError);
    expect(methods).toEqual(['message/stream']);
  });

  it('spends no more than the budget allows, and hands back what is left', async () => {
    vi.useFakeTimers();
    try {
      const working = { jsonrpc: '2.0', id: '2', result: { kind: 'task', id: 't1', status: { state: 'working' } } };
      // Far more answers than the budget can pay for: a task that never settles is
      // exactly the shape that spent a whole invocation's subrequests in production.
      const { methods } = stubFetch([
        sseResponse([WORKING], true),
        ...Array.from({ length: 20 }, () => jsonResponse(working)),
      ]);
      const budget = { remaining: 3 };
      const turn = consumeA2AStream({
        cred,
        params: { message: { kind: 'message', role: 'user', parts: [] } },
        signal: new AbortController().signal,
        resume: budget,
      });
      const settled = expect(turn).rejects.toThrow('Network connection lost.');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await settled;

      expect(methods.filter((method) => method === 'tasks/get')).toHaveLength(3);
      expect(budget.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one budget across every turn that draws on it', async () => {
    vi.useFakeTimers();
    try {
      const budget = { remaining: 2 };
      const turn = (responses: Response[]) => {
        stubFetch(responses);
        return consumeA2AStream({
          cred,
          params: { message: { kind: 'message', role: 'user', parts: [] } },
          signal: new AbortController().signal,
          resume: budget,
        });
      };

      const first = turn([sseResponse([WORKING], true), jsonResponse(FINISHED_TASK)]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await first).text).toBe('{"findings":[]}');
      expect(budget.remaining).toBe(1);

      // The second reviewer inherits what the first left, not a fresh allowance.
      const second = turn([sseResponse([WORKING], true), jsonResponse(FINISHED_TASK)]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await second).text).toBe('{"findings":[]}');
      expect(budget.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
