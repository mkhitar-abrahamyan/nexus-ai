import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { workflow, WorkflowStepTimeoutError, type WorkflowContext } from '../src/graph/functional.js';
import { SqliteOperationStore } from '../src/sqlite/operations.js';
import type { GraphCheckpointer, GraphEvent } from '../src/types/graph.js';

async function checkpointers(): Promise<Array<[string, () => GraphCheckpointer]>> {
  const store = new SqliteOperationStore(new DatabaseSync(':memory:'));
  await store.migrate();
  const memory = new MemoryGraphCheckpointer();
  return [
    ['memory', () => memory],
    // Each call builds a new checkpointer over the same file, as a second worker would.
    ['sqlite', () => new OperationStoreCheckpointer(store as never)],
  ];
}

test('a workflow records each step once and returns its output', async () => {
  for (const [name, checkpointer] of await checkpointers()) {
    const runs: string[] = [];
    const flow = workflow(
      async (input: { orderId: string }, { step }: WorkflowContext) => {
        const order = await step('load', () => {
          runs.push('load');
          return { id: input.orderId, total: 40 };
        });
        const doubled = await step('double', () => {
          runs.push('double');
          return order.total * 2;
        });
        return { id: order.id, doubled };
      },
      { name: 'refunds', checkpointer: checkpointer() },
    );
    const result = await flow.invoke({ orderId: 'o-1' }, { threadId: 't-1' });
    assert.equal(result.status, 'completed', name);
    assert.deepEqual(result.output, { id: 'o-1', doubled: 80 }, name);
    assert.equal(result.steps, 2, name);
    assert.deepEqual(runs, ['load', 'double'], name);
    assert.equal((await flow.state('t-1'))?.status, 'completed', name);
    assert.equal((await flow.state('t-1'))?.metadata?.graph, 'refunds', name);
  }
});

test('a workflow that crashed between steps finishes on another worker without re-running the first', async () => {
  for (const [name, checkpointer] of await checkpointers()) {
    const runs: string[] = [];
    let crash = true;
    const build = () =>
      workflow(
        async (_: unknown, { step }: WorkflowContext) => {
          await step('charge', () => {
            runs.push('charge');
            return 'charged';
          });
          await step('ship', () => {
            runs.push('ship');
            if (crash) throw new Error('worker died');
            return 'shipped';
          });
          return 'done';
        },
        { checkpointer: checkpointer() },
      );

    await assert.rejects(build().invoke({}, { threadId: 'order-7' }), /worker died/, name);
    assert.equal((await build().state('order-7'))?.status, 'failed', name);

    crash = false;
    const second = build();
    let last: unknown;
    for await (const event of second.continue('order-7')) last = event;
    assert.equal((last as { type: string }).type, 'done', name);
    assert.deepEqual(runs, ['charge', 'ship', 'ship'], `${name}: the charge ran once`);
  }
});

test('an interrupt pauses the workflow, and a resume on another worker answers it', async () => {
  for (const [name, checkpointer] of await checkpointers()) {
    let loads = 0;
    const build = () =>
      workflow(
        async (input: { amount: number }, { step, interrupt }: WorkflowContext) => {
          const order = await step('load', () => {
            loads += 1;
            return { amount: input.amount };
          });
          const approved = interrupt<boolean>({ reason: `Refund ${order.amount}?`, payload: order });
          if (!approved) return 'declined';
          return step('refund', () => `refunded ${order.amount}`);
        },
        { checkpointer: checkpointer() },
      );

    const paused = await build().invoke({ amount: 25 }, { threadId: 'r-1' });
    assert.equal(paused.status, 'awaiting_input', name);
    assert.equal(paused.interrupt?.reason, 'Refund 25?', name);
    assert.deepEqual(paused.interrupt?.payload, { amount: 25 }, name);

    const finished = await build().resumeWith('r-1', true);
    assert.equal(finished.status, 'completed', name);
    assert.equal(finished.output, 'refunded 25', name);
    assert.equal(loads, 1, `${name}: the step before the interrupt did not run again`);
    await assert.rejects(async () => {
      for await (const _ of build().resume('r-1', true));
    }, /not awaiting input/i);
  }
});

test('parallel steps run together within the concurrency limit, and a sibling of a failure is kept', async () => {
  let active = 0;
  let peak = 0;
  const runs: string[] = [];
  let fail = true;
  const checkpointer = new MemoryGraphCheckpointer();
  const build = () =>
    workflow(
      async (_: unknown, { step }: WorkflowContext) =>
        Promise.all(
          ['a', 'b', 'c', 'd'].map((letter) =>
            step(`fetch-${letter}`, async () => {
              active += 1;
              peak = Math.max(peak, active);
              await new Promise((resolve) => setTimeout(resolve, 10));
              active -= 1;
              runs.push(letter);
              if (letter === 'c' && fail) throw new Error('c is down');
              return letter.toUpperCase();
            }),
          ),
        ),
      { checkpointer, maxConcurrency: 2 },
    );

  await assert.rejects(build().invoke({}, { threadId: 'p-1' }), /c is down/);
  assert.equal(peak, 2, 'never more than two at once');
  const failed = await checkpointer.get('p-1');
  assert.ok(failed);
  const recorded = (failed.state as unknown as { steps: Record<string, unknown> }).steps;
  assert.deepEqual(Object.keys(recorded).sort(), ['fetch-a', 'fetch-b', 'fetch-d'], 'finished siblings are kept');

  fail = false;
  let last: { output?: unknown } | undefined;
  for await (const event of build().continue('p-1')) last = event as never;
  assert.deepEqual(last?.output, ['A', 'B', 'C', 'D']);
  assert.equal(runs.filter((letter) => letter === 'c').length, 2);
  assert.equal(runs.filter((letter) => letter === 'a').length, 1, 'only the failed step ran again');
});

test('steps retry under a policy, time out, and repeated names are numbered in call order', async () => {
  let attempts = 0;
  const events: GraphEvent[] = [];
  const flow = workflow(async (_: unknown, { step }: WorkflowContext) => {
    const flaky = await step(
      'flaky',
      ({ attempt }) => {
        attempts = attempt;
        if (attempt < 3) throw new Error('try again');
        return 'ok';
      },
      { retry: { maxAttempts: 3, initialIntervalMs: 1, jitter: false } },
    );
    const first = await step('tick', () => 1);
    const second = await step('tick', () => 2);
    return { flaky, first, second };
  });
  const result = await flow.invoke({}, { threadId: 'x', onEvent: (event) => events.push(event) });
  assert.deepEqual(result.output, { flaky: 'ok', first: 1, second: 2 });
  assert.equal(attempts, 3);
  assert.deepEqual(Object.keys(result.state.steps).sort(), ['flaky', 'tick', 'tick#2']);
  assert.equal(events.filter((event) => event.type === 'task_retry').length, 2);
  assert.ok(events.some((event) => event.type === 'checkpoint' && event.status === 'completed'));

  const slow = workflow(async (_: unknown, { step }: WorkflowContext) =>
    step('slow', ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', resolve)), {
      timeoutMs: 10,
    }),
  );
  await assert.rejects(slow.invoke({}), WorkflowStepTimeoutError);
});

test('a cancelled workflow stops as interrupted and continues later; undefined results replay as undefined', async () => {
  const controller = new AbortController();
  let calls = 0;
  const checkpointer = new MemoryGraphCheckpointer();
  const flow = workflow(
    async (_: unknown, { step }: WorkflowContext) => {
      const nothing = await step('side-effect', () => {
        calls += 1;
        return undefined;
      });
      await step('wait', ({ signal }) =>
        controller.signal.aborted
          ? 'late'
          : new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve('aborted'));
              controller.abort();
            }),
      );
      return nothing === undefined ? 'undefined kept' : 'changed';
    },
    { checkpointer },
  );
  const stopped = await flow.invoke({}, { threadId: 'c-1', signal: controller.signal });
  assert.equal(stopped.status, 'interrupted');
  let last: { output?: unknown } | undefined;
  for await (const event of flow.continue('c-1')) last = event as never;
  assert.equal(last?.output, 'undefined kept');
  assert.equal(calls, 1);
  assert.equal(flow.describe().nodes[0]?.id, 'workflow');
});
