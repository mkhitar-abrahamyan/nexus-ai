import type { RunEvent, RunRecord } from '../types/server.js';

/** Options for `createRemoteGraph()`. */
export interface RemoteGraphOptions {
  /** Where the server is, such as `https://agents.internal/api`. */
  url: string;
  /** The assistant to run. */
  assistant: string;
  /** Headers added to every request, such as authorization. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
  /** How long to wait for a run to finish, in milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** How often to poll when the server's event stream is unavailable, in milliseconds. Defaults to 500. */
  pollIntervalMs?: number;
}

/** A run on a remote server, as the client reports it. */
export interface RemoteRunResult {
  /** The run's id, for cancelling or reconnecting to it. */
  runId: string;
  /** The thread it belonged to, when it had one. */
  threadId?: string;
  /** Where it ended. */
  status: RunRecord['status'];
  /** What it produced. */
  output?: unknown;
  /** What it is waiting for, when it stopped to ask. */
  interrupt?: unknown;
  /** Why it failed. */
  error?: RunRecord['error'];
}

/**
 * A graph running on another server, usable as a subgraph.
 *
 * `invoke()` and `stream()` mirror a compiled graph, so an orchestrating graph can call a deployed
 * one through `asNode()` without knowing it is remote. The stream reconnects from the last event it
 * saw, so a dropped connection costs a round trip rather than the run.
 */
export interface RemoteGraph {
  /** Runs an input to completion and returns the result. */
  invoke(
    input?: unknown,
    options?: { threadId?: string; signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<RemoteRunResult>;
  /** Runs an input, yielding each event the server records. */
  stream(
    input?: unknown,
    options?: { threadId?: string; signal?: AbortSignal; idempotencyKey?: string },
  ): AsyncIterable<RunEvent>;
  /** Answers an interrupt on a thread and runs on. */
  resume(threadId: string, value: unknown, options?: { signal?: AbortSignal }): Promise<RemoteRunResult>;
  /** Creates a thread on the server. */
  createThread(options?: { metadata?: Record<string, unknown> }): Promise<{ id: string }>;
  /** The assistant's state for a thread. */
  state(threadId: string): Promise<unknown>;
  /** Cancels a run. */
  cancel(runId: string, reason?: string): Promise<void>;
  /** The remote graph as a node, so a local graph can call it as a subgraph. */
  asNode(): (context: { state: Record<string, unknown>; signal?: AbortSignal }) => Promise<unknown>;
}

/** Creates a client for an assistant on a remote agent server. */
export function createRemoteGraph(options: RemoteGraphOptions): RemoteGraph {
  const base = options.url.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status}${body ? ` ${body}` : ''}`);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  async function startRun(body: Record<string, unknown>, threadId?: string): Promise<RunRecord> {
    return call<RunRecord>(threadId ? `/threads/${encodeURIComponent(threadId)}/runs` : '/runs', {
      method: 'POST',
      body: JSON.stringify({ assistant: options.assistant, ...body }),
    });
  }

  async function* streamEvents(runId: string, signal?: AbortSignal): AsyncIterable<RunEvent> {
    let lastId = 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && !signal?.aborted) {
      const response = await fetchImpl(`${base}/runs/${encodeURIComponent(runId)}/events`, {
        headers: {
          accept: 'text/event-stream',
          ...options.headers,
          ...(lastId ? { 'last-event-id': String(lastId) } : {}),
        },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`Streaming run ${runId} failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      try {
        while (!signal?.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const event = parseFrame(frame);
            if (!event) continue;
            if (event.id) lastId = event.id;
            yield event;
            if (isTerminal(event)) finished = true;
          }
          if (finished) return;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (finished || signal?.aborted) return;
      // The connection dropped before the run ended; reconnect from the last event seen.
      await delay(options.pollIntervalMs ?? 500, signal);
    }
  }

  async function settle(runId: string, signal?: AbortSignal): Promise<RemoteRunResult> {
    for await (const event of streamEvents(runId, signal)) {
      if (isTerminal(event)) break;
    }
    const run = await call<RunRecord>(`/runs/${encodeURIComponent(runId)}`);
    return {
      runId: run.id,
      threadId: run.threadId,
      status: run.status,
      output: run.output,
      interrupt: run.interrupt,
      error: run.error,
    };
  }

  return {
    async invoke(input, runOptions = {}) {
      const run = await startRun(
        { input, ...(runOptions.idempotencyKey ? { idempotencyKey: runOptions.idempotencyKey } : {}) },
        runOptions.threadId,
      );
      return settle(run.id, runOptions.signal);
    },
    async *stream(input, runOptions = {}) {
      const run = await startRun(
        { input, ...(runOptions.idempotencyKey ? { idempotencyKey: runOptions.idempotencyKey } : {}) },
        runOptions.threadId,
      );
      yield* streamEvents(run.id, runOptions.signal);
    },
    async resume(threadId, value, runOptions = {}) {
      const run = await startRun({ resume: value }, threadId);
      return settle(run.id, runOptions.signal);
    },
    async createThread(threadOptions = {}) {
      return call<{ id: string }>('/threads', {
        method: 'POST',
        body: JSON.stringify({ assistant: options.assistant, metadata: threadOptions.metadata }),
      });
    },
    async state(threadId) {
      return (await call<{ state: unknown }>(`/threads/${encodeURIComponent(threadId)}/state`)).state;
    },
    async cancel(runId, reason) {
      await call(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    },
    asNode() {
      return async (context) => {
        const result = await this.invoke(context.state, { signal: context.signal });
        if (result.status === 'failed') throw new Error(result.error?.message ?? `Remote run ${result.runId} failed`);
        return result.output;
      };
    },
  };
}

function parseFrame(frame: string): RunEvent | undefined {
  let id: number | undefined;
  let data: string | undefined;
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('data:')) data = `${data ?? ''}${line.slice(5).trim()}`;
  }
  if (data === undefined) return undefined;
  try {
    const parsed = JSON.parse(data) as RunEvent;
    return { ...parsed, ...(id === undefined ? {} : { id }) };
  } catch {
    return undefined;
  }
}

function isTerminal(event: RunEvent): boolean {
  if (event.type !== 'status') return false;
  const status = (event.data as { status?: string } | undefined)?.status;
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired' ||
    status === 'awaiting_input'
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object') timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
