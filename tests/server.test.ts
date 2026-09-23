import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { appendList, lastValue } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { END } from '../src/types/graph.js';
import type { CronRecord, Principal, RunEvent, RunRecord, ServerAssistant, ThreadRecord } from '../src/types/server.js';
import { functionAssistant, graphAssistant } from '../src/server/assistant.js';
import { CronScheduler, parseCron } from '../src/server/cron.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { toNodeListener } from '../src/server/node.js';
import { createRemoteGraph } from '../src/server/remote.js';
import { type AgentServer, type AgentServerOptions, createAgentServer } from '../src/server/server.js';
import { fromStore, MemoryServerStore } from '../src/server/state.js';

const BASE = 'http://server.test';

function call(server: AgentServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return server.handle(
    new Request(`${BASE}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
      ...(body === undefined ? { headers } : {}),
    }),
  );
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Waits for a run to reach a finished state, so a test never depends on timing. */
async function settled(server: AgentServer, runId: string, timeoutMs = 2_000): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await jsonOf<RunRecord>(await call(server, 'GET', `/runs/${runId}`));
    if (['succeeded', 'failed', 'cancelled', 'expired', 'awaiting_input'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not settle`);
}

/** An assistant that yields a given number of steps, pausing between them. */
function counter(steps: number, delayMs = 0): ServerAssistant {
  return {
    description: 'counts',
    async *stream(input: unknown) {
      for (let step = 1; step <= steps; step += 1) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: 'step', step, status: step === steps ? 'completed' : 'running', state: { step, input } };
      }
    },
  };
}

function server(options: Partial<AgentServerOptions> = {}): AgentServer {
  return createAgentServer({ assistants: { counter: counter(3) }, ...options } as AgentServerOptions);
}

// ── Routes ─────────────────────────────────────────────────────────

test('the server reports its health and the assistants it serves', async () => {
  const app = server({ assistants: { counter: counter(1), graph: graphAssistant(buildGraph()) } });
  const health = await jsonOf<{ status: string; worker: string }>(await call(app, 'GET', '/health'));
  assert.equal(health.status, 'ok');
  assert.ok(health.worker);

  const listed = await jsonOf<{ assistants: Array<{ id: string; supports: Record<string, boolean> }> }>(
    await call(app, 'GET', '/assistants'),
  );
  assert.deepEqual(
    listed.assistants.map((item) => item.id),
    ['counter', 'graph'],
  );
  assert.deepEqual(listed.assistants[1]?.supports, { resume: true, state: true, rollback: true });
  assert.equal((await call(app, 'GET', '/assistants/missing')).status, 400);
  assert.equal((await call(app, 'GET', '/nope')).status, 404);
  assert.equal((await call(app, 'DELETE', '/health')).status, 405);
});

test('a run on a thread reports its status, output, and events', async () => {
  const app = server();
  const thread = await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'counter' }));
  assert.match(thread.id, /^thread-/);

  const accepted = await call(app, 'POST', `/threads/${thread.id}/runs`, { input: { hello: 'world' } });
  assert.equal(accepted.status, 202);
  const run = await jsonOf<RunRecord>(accepted);
  const finished = await settled(app, run.id);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.output, { step: 3, input: { hello: 'world' } });

  const runs = await jsonOf<{ runs: RunRecord[] }>(await call(app, 'GET', `/threads/${thread.id}/runs`));
  assert.deepEqual(
    runs.runs.map((item) => item.id),
    [run.id],
  );
  assert.equal((await call(app, 'GET', '/runs/nope')).status, 404);
});

test('a stateless run needs no thread, and an unknown assistant is refused', async () => {
  const app = server();
  const run = await jsonOf<RunRecord>(await call(app, 'POST', '/runs', { assistant: 'counter', input: 1 }));
  assert.equal((await settled(app, run.id)).status, 'succeeded');
  const bad = await call(app, 'POST', '/runs', { assistant: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await jsonOf<{ error: { code: string } }>(bad)).error.code, 'UNKNOWN_ASSISTANT');
});

test('the same idempotency key replays one run instead of starting a second', async () => {
  const app = server();
  const first = await jsonOf<RunRecord>(
    await call(app, 'POST', '/runs', { assistant: 'counter', idempotencyKey: 'k-1' }),
  );
  const second = await jsonOf<RunRecord>(
    await call(app, 'POST', '/runs', { assistant: 'counter', idempotencyKey: 'k-1' }),
  );
  assert.equal(second.id, first.id);
  assert.equal((await jsonOf<{ runs: RunRecord[] }>(await call(app, 'GET', '/runs'))).runs.length, 1);
});

test('a run can be cancelled', async () => {
  const app = server({ assistants: { counter: counter(50, 20) } });
  const run = await jsonOf<RunRecord>(await call(app, 'POST', '/runs', { assistant: 'counter' }));
  const cancelled = await jsonOf<RunRecord>(
    await call(app, 'POST', `/runs/${run.id}/cancel`, { reason: 'changed my mind' }),
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error?.message, 'changed my mind');
});

// ── Streaming ──────────────────────────────────────────────────────

/** Reads an event stream, stopping after `take` events or when it ends. */
async function readStream(response: Response, take = Number.POSITIVE_INFINITY): Promise<RunEvent[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];
  let buffer = '';
  try {
    while (events.length < take) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim();
        if (data) events.push(JSON.parse(data) as RunEvent);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

test('an event stream resumes from Last-Event-ID without gaps or repeats', async () => {
  const app = server({ assistants: { counter: counter(6, 15) } });
  const run = await jsonOf<RunRecord>(await call(app, 'POST', '/runs', { assistant: 'counter' }));

  const first = await readStream(await call(app, 'GET', `/runs/${run.id}/events`), 3);
  assert.equal(first.length, 3);
  assert.deepEqual(
    first.map((event) => event.id),
    [1, 2, 3],
  );

  const resumed = await readStream(
    await app.handle(
      new Request(`${BASE}/runs/${run.id}/events`, { headers: { 'last-event-id': String(first[2]?.id) } }),
    ),
  );
  assert.deepEqual(
    resumed.map((event) => event.id),
    Array.from({ length: resumed.length }, (_, index) => index + 4),
    'the stream carries on from the id the client reported',
  );
  const last = resumed[resumed.length - 1] as RunEvent;
  assert.equal(last.type, 'status');
  assert.equal((last.data as { status: string }).status, 'succeeded');

  const everything = [...first, ...resumed].map((event) => event.id);
  assert.deepEqual(everything, [...new Set(everything)], 'no event was delivered twice');
});

test('streaming a run that already finished still ends with its status', async () => {
  const app = server();
  const run = await jsonOf<RunRecord>(await call(app, 'POST', '/runs', { assistant: 'counter' }));
  await settled(app, run.id);
  const events = await readStream(await call(app, 'GET', `/runs/${run.id}/events`));
  const last = events[events.length - 1] as RunEvent;
  assert.equal((last.data as { status: string }).status, 'succeeded');
});

test('a run can be started and streamed in one request', async () => {
  const app = server();
  const response = await call(app, 'POST', '/runs', { assistant: 'counter', stream: true });
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = await readStream(response);
  assert.equal((events.at(-1)?.data as { status?: string } | undefined)?.status, 'succeeded');
});

// ── Busy policies ──────────────────────────────────────────────────

function buildGraph() {
  return createGraph({ channels: { messages: appendList<string>(), turns: lastValue<number>() } })
    .addNode('ask', async (context) => {
      const answer = await context.interrupt({ reason: 'confirm', payload: context.state.messages });
      return { messages: [`answered:${String(answer)}`], turns: (context.state.turns ?? 0) + 1 };
    })
    .setEntry('ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });
}

test('a busy thread is refused, queued, interrupted, or rolled back', async () => {
  for (const policy of ['reject', 'enqueue', 'interrupt'] as const) {
    const app = server({ assistants: { counter: counter(4, 15) }, onBusy: policy });
    const thread = await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'counter' }));
    const first = await jsonOf<RunRecord>(await call(app, 'POST', `/threads/${thread.id}/runs`, { input: 'a' }));

    if (policy === 'reject') {
      const refused = await call(app, 'POST', `/threads/${thread.id}/runs`, { input: 'b' });
      assert.equal(refused.status, 409, policy);
      assert.equal((await jsonOf<{ error: { code: string } }>(refused)).error.code, 'THREAD_BUSY');
      continue;
    }

    const second = await jsonOf<RunRecord>(await call(app, 'POST', `/threads/${thread.id}/runs`, { input: 'b' }));
    assert.notEqual(second.id, first.id, policy);
    assert.equal((await settled(app, second.id, 4_000)).status, 'succeeded', policy);
    const firstRun = await jsonOf<RunRecord>(await call(app, 'GET', `/runs/${first.id}`));
    if (policy === 'interrupt') assert.equal(firstRun.status, 'cancelled', policy);
    else assert.equal(firstRun.status, 'succeeded', 'enqueue lets the first run finish');
  }
});

test('the rollback policy puts the thread back to where the cancelled run started', async () => {
  const restored: Array<{ threadId: string; step: number }> = [];
  const assistant: ServerAssistant = {
    ...counter(20, 20),
    step: () => 7,
    restore: (threadId, step) => {
      restored.push({ threadId, step });
    },
  };
  const app = server({ assistants: { counter: assistant }, onBusy: 'rollback' });
  const thread = await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'counter' }));
  const first = await jsonOf<RunRecord>(await call(app, 'POST', `/threads/${thread.id}/runs`, { input: 'a' }));
  await call(app, 'POST', `/threads/${thread.id}/runs`, { input: 'b' });
  assert.deepEqual(restored, [{ threadId: thread.id, step: 7 }]);
  assert.equal((await jsonOf<RunRecord>(await call(app, 'GET', `/runs/${first.id}`))).status, 'cancelled');

  const without = server({ assistants: { counter: counter(20, 20) }, onBusy: 'rollback' });
  const plain = await jsonOf<ThreadRecord>(await call(without, 'POST', '/threads', { assistant: 'counter' }));
  await call(without, 'POST', `/threads/${plain.id}/runs`, { input: 'a' });
  const refused = await call(without, 'POST', `/threads/${plain.id}/runs`, { input: 'b' });
  assert.equal(refused.status, 409, 'an assistant that cannot roll back says so');
});

// ── Threads on a graph ─────────────────────────────────────────────

test('a graph assistant reports state, pauses for input, and resumes', async () => {
  const app = server({ assistants: { graph: graphAssistant(buildGraph(), { description: 'asks first' }) } });
  const thread = await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'graph' }));
  const run = await jsonOf<RunRecord>(
    await call(app, 'POST', `/threads/${thread.id}/runs`, { input: { messages: ['hi'] } }),
  );
  const paused = await settled(app, run.id);
  assert.equal(paused.status, 'awaiting_input');
  assert.ok(paused.interrupt, 'the run reports what it is waiting for');

  const resumed = await jsonOf<RunRecord>(await call(app, 'POST', `/threads/${thread.id}/runs`, { resume: 'yes' }));
  assert.equal((await settled(app, resumed.id)).status, 'succeeded');
  const state = await jsonOf<{ state: { messages: string[] } }>(await call(app, 'GET', `/threads/${thread.id}/state`));
  assert.deepEqual(state.state.messages, ['hi', 'answered:yes']);

  const stateless = server();
  const bad = await call(stateless, 'POST', '/runs', { assistant: 'counter', resume: 'x' });
  assert.equal(bad.status, 400, 'a resume needs a thread');
});

// ── Authentication and tenancy ─────────────────────────────────────

test('requests are authenticated, scoped, and isolated by tenant', async () => {
  const principals: Record<string, Principal> = {
    'token-a': { tenantId: 'tenant-a', userId: 'ada', scopes: ['runs:read', 'runs:write'] },
    'token-b': { tenantId: 'tenant-b', userId: 'bob', scopes: ['runs:read', 'runs:write'] },
    'token-r': { tenantId: 'tenant-a', userId: 'rae', scopes: ['runs:read'] },
  };
  const app = server({
    authenticate: (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''],
    scopes: { read: 'runs:read', write: 'runs:write' },
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  assert.equal((await call(app, 'GET', '/threads')).status, 401);
  const thread = await jsonOf<ThreadRecord>(
    await call(app, 'POST', '/threads', { assistant: 'counter' }, auth('token-a')),
  );
  assert.equal(thread.tenantId, 'tenant-a');
  assert.equal(thread.createdBy, 'ada');

  assert.equal((await call(app, 'GET', `/threads/${thread.id}`, undefined, auth('token-b'))).status, 404);
  assert.equal((await call(app, 'GET', `/threads/${thread.id}`, undefined, auth('token-a'))).status, 200);
  assert.equal(
    (await jsonOf<{ threads: ThreadRecord[] }>(await call(app, 'GET', '/threads', undefined, auth('token-b')))).threads
      .length,
    0,
  );
  assert.equal((await call(app, 'POST', '/threads', { assistant: 'counter' }, auth('token-r'))).status, 403);

  const anonymous = server({ allowAnonymous: false });
  assert.equal((await call(anonymous, 'GET', '/health')).status, 401);
});

test('an authenticate hook can answer the request itself', async () => {
  const app = server({ authenticate: () => new Response('go away', { status: 418 }) });
  assert.equal((await call(app, 'GET', '/health')).status, 418);
});

// ── Cron ───────────────────────────────────────────────────────────

test('cron expressions are parsed, and invalid ones are refused', () => {
  assert.deepEqual(parseCron('*/15 * * * *').minute, [0, 15, 30, 45]);
  assert.deepEqual(parseCron('0 9-11 * * 1-5').hour, [9, 10, 11]);
  assert.deepEqual(parseCron('0 0 1 1 0').weekday, [0]);
  assert.throws(() => parseCron('* * * *'), /5-field/);
  assert.throws(() => parseCron('61 * * * *'), /outside 0-59/);
  assert.throws(() => parseCron('*/0 * * * *'), /invalid step/);
});

test('a cron job fires once across replicas, however many are ticking', async () => {
  const state = new MemoryServerStore();
  const operations = new MemoryOperationStore();
  const started: string[] = [];
  const replica = () =>
    server({
      assistants: { counter: counter(1) },
      state,
      operations: { store: operations },
      cron: { state, tickMs: 60_000 },
      onError: () => undefined,
      // Each replica records what it actually started, so a double firing would show up here.
      now: () => new Date(Date.parse('2026-09-23T10:00:00Z')),
    }) as AgentServer & { id?: string };

  const a = replica();
  const b = replica();
  const job = await jsonOf<CronRecord>(
    await call(a, 'POST', '/crons', { assistant: 'counter', schedule: { everyMs: 60_000 }, input: { tick: true } }),
  );
  assert.match(job.id, /^cron-/);

  const firedA = await a.cron?.tick(new Date(Date.parse('2026-09-23T10:01:00Z')));
  const firedB = await b.cron?.tick(new Date(Date.parse('2026-09-23T10:01:00Z')));
  assert.equal(firedA?.length, 1, 'the first replica fires the slot');
  assert.equal(firedB?.length, 0, 'the second sees the firing the first recorded');

  const runs = await jsonOf<{ runs: RunRecord[] }>(await call(a, 'GET', '/runs'));
  assert.equal(runs.runs.length, 1, 'the slot produced one run');
  started.push(...runs.runs.map((run) => run.id));

  // And when both replicas do believe a slot is due, the idempotency key still leaves one run.
  const slot = { assistant: 'counter', idempotencyKey: 'cron-x:1', input: { tick: true } };
  const viaA = await a.runs.start(slot);
  const viaB = await b.runs.start(slot);
  assert.equal(viaB.id, viaA.id, 'two replicas firing the same slot submit one run');

  const listed = await jsonOf<{ crons: CronRecord[] }>(await call(a, 'GET', '/crons'));
  assert.equal(listed.crons.length, 1);
  assert.equal((await call(a, 'DELETE', `/crons/${job.id}`)).status, 204);
  assert.equal((await jsonOf<{ crons: CronRecord[] }>(await call(a, 'GET', '/crons'))).crons.length, 0);
  assert.equal(started.length, 1);
});

test('a cron schedule fires on the minute it names', async () => {
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    start: async (job) => {
      fired.push(`${job.id}@${new Date(job.slot).toISOString()}`);
      return { id: 'run-1' } as RunRecord;
    },
    tickMs: 60_000,
  });
  await scheduler.add({ id: 'nightly', assistant: 'counter', schedule: { cron: '30 2 * * *' } });
  await scheduler.tick(new Date(Date.parse('2026-09-23T01:30:00Z')));
  assert.deepEqual(fired, [], 'not due at the wrong hour');
  await scheduler.tick(new Date(Date.parse('2026-09-23T02:30:20Z')));
  assert.deepEqual(fired, ['nightly@2026-09-23T02:30:00.000Z']);
  await scheduler.tick(new Date(Date.parse('2026-09-23T02:30:50Z')));
  assert.equal(fired.length, 1, 'a slot fires once');
});

// ── Durability ─────────────────────────────────────────────────────

test('another replica finishes a run whose worker stopped', async () => {
  const state = fromStore(new MemoryStore());
  const operations = new MemoryOperationStore();
  const events = new MemoryRunEventLog();
  let released: (() => void) | undefined;

  const stuck: ServerAssistant = {
    async *stream() {
      yield { type: 'step', step: 1, status: 'running', state: { step: 1 } };
      await new Promise<void>((resolve) => {
        released = resolve;
      });
      yield { type: 'done', status: 'completed', state: { step: 2 } };
    },
  };
  const first = createAgentServer({
    assistants: { worker: stuck },
    state,
    events,
    // Recovery re-runs an attempt, so the run has to be allowed more than one.
    operations: { store: operations, leaseMs: 40, heartbeatMs: 20, retry: { maxAttempts: 2 } },
  });
  const run = await jsonOf<RunRecord>(await call(first, 'POST', '/runs', { assistant: 'worker', input: { n: 1 } }));

  // A crash leaves a record whose lease lapses and is never renewed. Writing a lapsed lease is that
  // state exactly, without waiting for a heartbeat that this process would keep sending.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const abandoned = await operations.read(run.id);
  assert.ok(abandoned, 'the run was persisted');
  await operations.update(
    {
      ...abandoned,
      sequence: abandoned.sequence + 1,
      lease: { owner: 'dead-worker', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    },
    abandoned.sequence,
  );

  const second = createAgentServer({
    assistants: { worker: functionAssistant(() => ({ finishedBy: 'replica-2' })) },
    state,
    events,
    operations: { store: operations, leaseMs: 1_000, retry: { maxAttempts: 2 } },
  });
  const recovered = await second.runs.recover();
  assert.deepEqual(recovered, [run.id], 'the second replica claimed the abandoned run');

  const finished = await settled(second, run.id, 3_000);
  assert.equal(finished.status, 'succeeded');
  assert.deepEqual(finished.output, { finishedBy: 'replica-2' });
  released?.();
});

test('two replicas sharing a store serve the same threads and runs', async () => {
  const state = fromStore(new MemoryStore());
  const operations = new MemoryOperationStore();
  const events = new MemoryRunEventLog();
  const options = { assistants: { counter: counter(2) }, state, events, operations: { store: operations } };
  const a = createAgentServer(options);
  const b = createAgentServer(options);

  const thread = await jsonOf<ThreadRecord>(await call(a, 'POST', '/threads', { assistant: 'counter' }));
  const run = await jsonOf<RunRecord>(await call(a, 'POST', `/threads/${thread.id}/runs`, { input: 'x' }));
  await settled(a, run.id);

  assert.equal((await jsonOf<ThreadRecord>(await call(b, 'GET', `/threads/${thread.id}`))).id, thread.id);
  const seen = await jsonOf<RunRecord>(await call(b, 'GET', `/runs/${run.id}`));
  assert.equal(seen.status, 'succeeded');
  const events2 = await readStream(await call(b, 'GET', `/runs/${run.id}/events`));
  assert.ok(events2.length > 0, 'the second replica streams the first replica events');
});

// ── Node adapter and the remote client ─────────────────────────────

test('the server runs on node:http, and a remote graph drives it', async () => {
  const app = server({ assistants: { counter: counter(2), graph: graphAssistant(buildGraph()) } });
  const http = createServer(toNodeListener(app) as never);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  try {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal((health as { status: string }).status, 'ok');

    const remote = createRemoteGraph({ url, assistant: 'counter' });
    const result = await remote.invoke({ hello: 'remote' });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.output, { step: 2, input: { hello: 'remote' } });

    const streamed: RunEvent[] = [];
    for await (const event of remote.stream({ hello: 'stream' })) streamed.push(event);
    assert.ok(streamed.length >= 3, 'the stream carries the run events');
    assert.equal((streamed.at(-1)?.data as { status?: string } | undefined)?.status, 'succeeded');

    const graphClient = createRemoteGraph({ url, assistant: 'graph' });
    const thread = await graphClient.createThread();
    const paused = await graphClient.invoke({ messages: ['remote'] }, { threadId: thread.id });
    assert.equal(paused.status, 'awaiting_input');
    const answered = await graphClient.resume(thread.id, 'sure');
    assert.equal(answered.status, 'succeeded');
    assert.deepEqual(((await graphClient.state(thread.id)) as { messages: string[] }).messages, [
      'remote',
      'answered:sure',
    ]);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('a remote graph is a node in a local graph', async () => {
  const app = server({ assistants: { counter: counter(1) } });
  const http = createServer(toNodeListener(app) as never);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;

  try {
    const remote = createRemoteGraph({ url: `http://127.0.0.1:${port}`, assistant: 'counter' });
    const node = remote.asNode();
    const graph = createGraph({ channels: { step: lastValue<number>(), input: lastValue<string>() } })
      .addNode('remote', async (context) => {
        const output = (await node({ state: context.state as Record<string, unknown>, signal: context.signal })) as {
          step: number;
        };
        return { step: output.step };
      })
      .setEntry('remote')
      .addEdge('remote', END)
      .compile();

    const result = await graph.invoke({ input: 'from the parent' });
    assert.equal(result.state.step, 1, 'the subgraph ran on the server');
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
