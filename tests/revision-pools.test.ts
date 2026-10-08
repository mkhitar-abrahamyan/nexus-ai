/**
 * Revision worker pools: each worker image carries some revisions of an assistant, and claims only
 * the runs routed to them. A new revision ships in a new image beside the old one, instead of every
 * image carrying every revision, and the API replicas route to it as soon as a worker reports it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryOperationStore } from '../src/operations/store.js';
import { Deployments } from '../src/server/deployments.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { type AgentServer, createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import type { RunRecord, ScalingSnapshot, ServerAssistant } from '../src/types/server.js';

const BASE = 'http://nexus.test';

function call(server: AgentServer, method: string, path: string, body?: unknown) {
  return server.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function settled(state: MemoryServerStore, count: number, timeoutMs = 10_000): Promise<RunRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 100_000 });
    if (runs.length >= count && runs.every((run) => run.status === 'succeeded')) return runs;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runs did not settle');
}

/** A fleet sharing one state store, one event log, and one queue. */
function fleet() {
  const shared = {
    state: new MemoryServerStore(),
    events: new MemoryRunEventLog(),
    store: new MemoryOperationStore<unknown>({ maxRecords: 100_000 }),
  };
  const executed = new Map<string, { image: string; revision: string }>();
  const revision = (image: string, id: string): ServerAssistant =>
    ({
      async *stream(_input, context) {
        executed.set(context.runId, { image, revision: id });
        yield { type: 'done', state: { answer: `${image}:${id}` } };
      },
    }) as ServerAssistant;
  /** One image: the revisions its code carries, and whether it claims queued runs. */
  const image = (name: string, revisions: readonly string[], role: 'api' | 'worker') => {
    // A long replica lifetime, so a heartbeat late on a busy machine never makes a worker look gone.
    const deployments = new Deployments({ state: shared.state, cacheMs: 0, heartbeatMs: 20, replicaTtlMs: 60_000 });
    const server = createAgentServer({
      assistants: {
        support: deployments.assistant('support', Object.fromEntries(revisions.map((id) => [id, revision(name, id)])), {
          live: 'v1',
        }),
      },
      state: shared.state,
      events: shared.events,
      operations: { store: shared.store, leaseMs: 5_000 },
      queue: role === 'api' ? { claim: false } : { concurrency: 4, pollMs: 10 },
      deployments,
    });
    return { server, deployments };
  };
  return { shared, executed, image };
}

test('two worker images with different revisions drain one queue, and no run executes on an image without its revision', async () => {
  const { shared, executed, image } = fleet();
  const api = image('api', ['v1'], 'api');
  const old = image('old', ['v1'], 'worker');
  const next = image('new', ['v1', 'v2'], 'worker');
  for (const { server } of [api, old, next]) await server.start();
  try {
    // The API image does not carry v2; it routes there because a worker reports it.
    await api.deployments.canary('support', 'v2', 0.5, { by: 'ada' });
    for (let index = 0; index < 60; index += 1) {
      assert.equal((await call(api.server, 'POST', '/runs', { assistant: 'support', input: {} })).status, 202);
    }
    const runs = await settled(shared.state, 60);

    const onV2 = runs.filter((run) => run.revision?.id === 'v2');
    assert.ok(onV2.length > 10 && onV2.length < 50, `the canary took its share: ${onV2.length} of 60`);
    for (const run of runs) {
      const where = executed.get(run.id);
      assert.equal(where?.revision, run.revision?.id, `run ${run.id} ran the revision it was routed to`);
      if (run.revision?.id === 'v2') assert.equal(where?.image, 'new', 'only the image with v2 ran v2');
    }
    assert.ok(
      runs.some((run) => executed.get(run.id)?.image === 'old'),
      'the old image kept serving v1',
    );
  } finally {
    for (const { server } of [api, old, next]) await server.stop();
  }
});

test('a run waits for a worker that carries its revision, counted per revision on /scaling and /metrics', async () => {
  const { shared, executed, image } = fleet();
  const api = image('api', ['v1'], 'api');
  const old = image('old', ['v1'], 'worker');
  const next = image('new', ['v1', 'v2'], 'worker');
  for (const { server } of [api, old, next]) await server.start();
  try {
    // The new image reports v2 but stops claiming, as a pool scaled to zero does.
    next.server.runs.stopWorking();
    await api.deployments.change('support', { action: 'split', traffic: { v2: 1 } }, 'ada');
    for (let index = 0; index < 10; index += 1) {
      await call(api.server, 'POST', '/runs', { assistant: 'support', input: {} });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const waiting = shared.state.list<RunRecord>(RUNS_NAMESPACE, { limit: 100 });
    assert.equal(waiting.length, 10);
    assert.ok(
      waiting.every((run) => run.status === 'queued' && run.revision?.id === 'v2'),
      'the old image claims none of them',
    );
    const scaling = (await (await call(api.server, 'GET', '/scaling')).json()) as ScalingSnapshot;
    assert.equal(scaling.queued, 10);
    assert.deepEqual(scaling.queuedByRevision, { support: { v2: 10 } });
    const metrics = await (await call(api.server, 'GET', '/metrics')).text();
    assert.match(metrics, /nexus_server_runs_queued_by_revision\{assistant="support",revision="v2"\} 10/);

    // The pool scales up: its worker claims them, and they run there.
    next.server.runs.startWorking();
    const runs = await settled(shared.state, 10);
    assert.ok(runs.every((run) => executed.get(run.id)?.image === 'new' && executed.get(run.id)?.revision === 'v2'));
    assert.deepEqual(
      ((await (await call(api.server, 'GET', '/scaling')).json()) as ScalingSnapshot).queuedByRevision,
      {},
    );
  } finally {
    for (const { server } of [api, old, next]) await server.stop();
  }
});

test('a run names a revision only a worker carries, and one no worker carries is refused', async () => {
  const { shared, executed, image } = fleet();
  const api = image('api', ['v1'], 'api');
  const next = image('new', ['v1', 'v2'], 'worker');
  for (const { server } of [api, next]) await server.start();
  try {
    const named = await call(api.server, 'POST', '/runs', { assistant: 'support', input: {}, revision: 'v2' });
    assert.equal(named.status, 202);
    const [run] = await settled(shared.state, 1);
    assert.equal(executed.get(run?.id ?? '')?.revision, 'v2');
    const missing = await call(api.server, 'POST', '/runs', { assistant: 'support', input: {}, revision: 'v9' });
    assert.equal(missing.status, 400);
  } finally {
    for (const { server } of [api, next]) await server.stop();
  }
});
