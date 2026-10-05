/**
 * Functional workflow steps have what graph nodes have — idle timeouts, onError after retries, a
 * drain between steps, and a tenant — and a function assistant can hand its run off on a drain as a
 * graph does.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { GraphDrainedError, GraphThreadNotFoundError } from '../src/graph/errors.js';
import { WorkflowStepTimeoutError, workflow } from '../src/graph/functional.js';
import { RunControl } from '../src/graph/run-control.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { functionAssistant, graphAssistant } from '../src/server/assistant.js';
import { RunHandOffError } from '../src/server/errors.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import { MemoryStore } from '../src/store/memory.js';
import { tenantStore } from '../src/store/tenant.js';
import type { GraphEvent } from '../src/types/graph.js';
import type { RunRecord } from '../src/types/server.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settledRuns(state: MemoryServerStore, count: number): Promise<RunRecord[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const runs = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 1_000 });
    if (runs.length >= count && runs.every((run) => ['succeeded', 'failed', 'cancelled'].includes(run.status))) {
      return runs;
    }
    await pause(10);
  }
  throw new Error('runs did not settle');
}

test('an idle timeout tells a hung step from a slow one that heartbeats', async () => {
  const flow = workflow(async (_input: unknown, { step }) => {
    const slow = await step(
      'slow',
      async ({ heartbeat }) => {
        for (let tick = 0; tick < 6; tick += 1) {
          await pause(20);
          heartbeat();
        }
        return 'worked';
      },
      { timeout: { idleMs: 60 } },
    );
    return slow;
  });
  assert.equal((await flow.invoke({})).output, 'worked', 'heartbeats kept a 120 ms step under a 60 ms idle limit');

  const hung = workflow(async (_input: unknown, { step }) =>
    step('hung', () => pause(200).then(() => 'late'), { timeout: { idleMs: 40 } }),
  );
  await assert.rejects(
    hung.invoke({}),
    (error: unknown) =>
      error instanceof WorkflowStepTimeoutError && error.kind === 'idle' && /no progress for 40 ms/.test(error.message),
  );

  const capped = workflow(async (_input: unknown, { step }) =>
    step(
      'capped',
      async ({ heartbeat }) => {
        for (let tick = 0; tick < 10; tick += 1) {
          await pause(15);
          heartbeat();
        }
        return 'never';
      },
      { timeout: { runMs: 50, idleMs: 1_000 } },
    ),
  );
  await assert.rejects(
    capped.invoke({}),
    (error: unknown) => error instanceof WorkflowStepTimeoutError && error.kind === 'run',
  );

  const defaults = workflow(async (_input: unknown, { step }) => step('hung', () => pause(200).then(() => 'late')), {
    stepDefaults: { timeout: { idleMs: 30 } },
  });
  await assert.rejects(
    defaults.invoke({}),
    (error: unknown) => error instanceof WorkflowStepTimeoutError && error.kind === 'idle',
  );
});

test('onError decides once retries run out, and its result is recorded so a resume does not repeat the step', async () => {
  let charges = 0;
  let refunds = 0;
  const events: GraphEvent[] = [];
  const checkpointer = new MemoryGraphCheckpointer();
  const flow = workflow(
    async (input: { order: string }, { step, interrupt }) => {
      const charge = await step(
        'charge',
        () => {
          charges += 1;
          throw new Error('card declined');
        },
        {
          retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false },
          onError: async ({ attempts, error }) => {
            refunds += 1;
            return { refunded: true, attempts, reason: (error as Error).message };
          },
        },
      );
      const approved = interrupt<boolean>({ reason: `Tell the customer about ${input.order}?` });
      return { charge, approved };
    },
    { checkpointer },
  );
  const paused = await flow.invoke({ order: 'o-1' }, { threadId: 't-charge', onEvent: (event) => events.push(event) });
  assert.equal(paused.status, 'awaiting_input');
  assert.deepEqual(paused.state.steps.charge?.value, { refunded: true, attempts: 2, reason: 'card declined' });
  assert.deepEqual(paused.state.steps.charge?.recovered, {
    error: { name: 'Error', message: 'card declined' },
    attempts: 2,
  });
  assert.ok(events.some((event) => event.type === 'task_failed' && event.recovered === true));

  const done = await flow.resumeWith('t-charge', true);
  assert.equal(done.status, 'completed');
  assert.equal(charges, 2, 'the failing step did not run again on resume');
  assert.equal(refunds, 1, 'nor did its recovery');

  const strict = workflow(async (_input: unknown, { step }) =>
    step('charge', () => Promise.reject(new Error('declined')), {
      onError: () => {
        throw new Error('escalated to a person');
      },
    }),
  );
  await assert.rejects(strict.invoke({}), /escalated to a person/);
});

test('a drain stops a workflow between steps, and continue() runs only what was left', async () => {
  const ran: string[] = [];
  const checkpointer = new MemoryGraphCheckpointer();
  const flow = workflow(
    async (_input: unknown, { step }) => {
      for (const name of ['s0', 's1', 's2', 's3', 's4']) {
        await step(name, async () => {
          ran.push(name);
          await pause(20);
          return name;
        });
      }
      return 'done';
    },
    { checkpointer },
  );
  const control = new RunControl();
  const running = flow.invoke({}, { threadId: 't-drain', control });
  while (ran.length < 2) await pause(2);
  control.drain('scale down');
  await assert.rejects(running, (error: unknown) => error instanceof GraphDrainedError);
  const parked = await checkpointer.get('t-drain');
  assert.equal(parked?.status, 'interrupted');
  assert.equal((parked as { drained?: { reason?: string } } | undefined)?.drained?.reason, 'scale down');

  let result: unknown;
  for await (const event of flow.continue('t-drain')) if (event.type === 'done') result = event.output;
  assert.equal(result, 'done');
  assert.deepEqual(ran, ['s0', 's1', 's2', 's3', 's4'], 'every step ran exactly once');
});

test('a workflow run for a tenant keeps its thread and store to that tenant', async () => {
  const store = new MemoryStore();
  const flow = workflow(
    async (_input: unknown, { step, interrupt, store: scoped, tenantId }) => {
      await step('note', async () => {
        await scoped?.put(['notes'], 'last', { by: tenantId });
        return true;
      });
      return interrupt<string>({ reason: 'approve?' });
    },
    { store },
  );
  await flow.invoke({}, { threadId: 't-tenant', tenantId: 'acme' });
  assert.equal((await flow.state('t-tenant'))?.metadata?.tenantId, 'acme');
  assert.deepEqual((await tenantStore(store, 'acme').get(['notes'], 'last'))?.value, { by: 'acme' });
  assert.equal(await tenantStore(store, 'globex').get(['notes'], 'last'), undefined);
  await assert.rejects(flow.resumeWith('t-tenant', 'yes', { tenantId: 'globex' }), GraphThreadNotFoundError);
  await assert.rejects(flow.invoke({}, { threadId: 't-tenant', tenantId: 'globex' }), /cannot be used by this tenant/);
  assert.equal((await flow.resumeWith('t-tenant', 'yes')).output, 'yes', 'the owner resumes without naming the tenant');
});

test('a workflow served by the agent server is handed off on a drain and finishes on the next worker', async () => {
  const shared = {
    state: new MemoryServerStore(),
    events: new MemoryRunEventLog(),
    store: new MemoryOperationStore<unknown>(),
    checkpoints: new MemoryGraphCheckpointer(),
  };
  const ran: string[] = [];
  const steps = ['a', 'b', 'c', 'd', 'e'];
  const flow = workflow(
    async (_input: unknown, { step }) => {
      for (const name of steps) {
        await step(name, async () => {
          ran.push(name);
          await pause(30);
          return name;
        });
      }
      return 'finished';
    },
    { checkpointer: shared.checkpoints },
  );
  const replica = () =>
    createAgentServer({
      assistants: { pipeline: graphAssistant(flow as never) },
      state: shared.state,
      events: shared.events,
      operations: { store: shared.store, leaseMs: 5_000 },
      queue: { concurrency: 1, pollMs: 10 },
    });
  const first = replica();
  await first.start();
  const thread = await first.runs.createThread({ assistant: 'pipeline' });
  const accepted = await first.runs.start({ assistant: 'pipeline', threadId: thread.id, input: {} });
  while (ran.length < 2) await pause(5);
  const started = Date.now();
  const result = await first.drain({ timeoutMs: 5_000 });
  assert.ok(Date.now() - started < 1_000, 'the drain did not wait for its timeout');
  assert.deepEqual(result.released, [accepted.id]);

  const second = replica();
  await second.start();
  try {
    const [run] = await settledRuns(shared.state, 1);
    assert.equal(run?.status, 'succeeded');
    assert.equal(run?.attempt, 2);
    assert.deepEqual(ran, steps, 'every step ran exactly once across the two workers');
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('a function assistant hands its run off on a drain, and the next worker continues from its progress', async () => {
  const shared = {
    state: new MemoryServerStore(),
    events: new MemoryRunEventLog(),
    store: new MemoryOperationStore<unknown>(),
  };
  const processed: number[] = [];
  const assistant = functionAssistant(async (_input, context) => {
    let next = typeof context.progress === 'number' ? context.progress : 0;
    while (next < 8) {
      if (context.control?.draining) throw new RunHandOffError();
      processed.push(next);
      await pause(25);
      next += 1;
      await context.saveProgress?.(next);
    }
    return { processed: next };
  });
  const replica = () =>
    createAgentServer({
      assistants: { batch: assistant },
      state: shared.state,
      events: shared.events,
      operations: { store: shared.store, leaseMs: 5_000 },
      queue: { concurrency: 1, pollMs: 10 },
    });
  const first = replica();
  await first.start();
  const accepted = await first.runs.start({ assistant: 'batch', input: {} });
  while (processed.length < 3) await pause(5);
  const started = Date.now();
  const result = await first.drain({ timeoutMs: 5_000 });
  assert.ok(Date.now() - started < 1_000, 'the drain did not wait for its timeout');
  assert.deepEqual(result.released, [accepted.id]);

  const second = replica();
  await second.start();
  try {
    const [run] = await settledRuns(shared.state, 1);
    assert.equal(run?.status, 'succeeded');
    assert.equal(run?.attempt, 2);
    assert.deepEqual(processed, [0, 1, 2, 3, 4, 5, 6, 7], 'each item was processed once across the two workers');
  } finally {
    await first.stop();
    await second.stop();
  }

  // Thrown when the replica is not draining, it is an ordinary failure.
  const lone = createAgentServer({
    assistants: { bad: functionAssistant(() => Promise.reject(new RunHandOffError())) },
  });
  const failed = await lone.runs.start({ assistant: 'bad', input: {} });
  const deadline = Date.now() + 2_000;
  let status = '';
  while (Date.now() < deadline && !['failed', 'succeeded'].includes(status)) {
    status = (await lone.runs.run(failed.id)).status;
    await pause(5);
  }
  assert.equal(status, 'failed');
});
