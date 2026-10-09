import assert from 'node:assert/strict';
import test from 'node:test';
import { appendList, counter, lastValue } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { GraphDrainedError, GraphNodeError, GraphNodeTimeoutError } from '../src/graph/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { lintGraph } from '../src/graph/lint.js';
import { RunControl } from '../src/graph/run-control.js';
import { OperationRunner } from '../src/operations/runner.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import {
  Command,
  END,
  type GraphCheckpoint,
  type GraphCheckpointer,
  type GraphEvent,
  type NodeFailure,
  Send,
} from '../src/types/graph.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A checkpointer that takes `latencyMs` per write and records the steps it wrote, in order. */
class SlowCheckpointer implements GraphCheckpointer {
  readonly inner = new MemoryGraphCheckpointer();
  readonly written: number[] = [];
  inFlight = 0;
  peak = 0;
  constructor(
    private readonly latencyMs: number,
    private readonly failAt?: number,
  ) {}
  async put(checkpoint: GraphCheckpoint): Promise<void> {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await sleep(this.latencyMs);
    this.inFlight -= 1;
    if (this.failAt !== undefined && checkpoint.step === this.failAt) throw new Error('the store is down');
    this.written.push(checkpoint.step);
    this.inner.put(checkpoint);
  }
  get(threadId: string, step?: number) {
    return this.inner.get(threadId, step);
  }
  history(threadId: string, limit?: number) {
    return this.inner.history(threadId, limit);
  }
}

/** A chain of `steps` nodes, each appending its name after `workMs` of work. */
function chain(steps: number, compile: Parameters<ReturnType<typeof createGraph>['compile']>[0], workMs = 0) {
  const graph = createGraph({ channels: { log: appendList<string>() } });
  for (let index = 0; index < steps; index += 1) {
    graph.addNode(`n${index}`, async () => {
      if (workMs > 0) await sleep(workMs);
      return { log: [`n${index}`] };
    });
  }
  graph.setEntry('n0');
  for (let index = 0; index < steps - 1; index += 1) graph.addEdge(`n${index}`, `n${index + 1}`);
  graph.addEdge(`n${steps - 1}`, END);
  return graph.compile(compile);
}

// ── Durability ─────────────────────────────────────────────────────

test('async durability writes every checkpoint, in order, and the run waits for them before it returns', async () => {
  const store = new SlowCheckpointer(5);
  const result = await chain(6, { checkpointer: store, durability: 'async' }).invoke({}, { threadId: 't' });

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.state.log, ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
  assert.deepEqual(store.written, [0, 1, 2, 3, 4, 5, 6], 'every step, in order');
  assert.equal(store.inFlight, 0, 'nothing is still being written when invoke() returns');
  assert.equal((await store.get('t'))?.status, 'completed');
});

test('async durability overlaps writes with the work, and keeps them one at a time', async () => {
  // Whether a checkpoint write was still in flight as each node began its work: the overlap itself,
  // observed rather than timed, so a loaded machine cannot blur it. The graph benchmark times it.
  const run = async (durability: 'sync' | 'async') => {
    const store = new SlowCheckpointer(20);
    const overlapped: boolean[] = [];
    const graph = createGraph({ channels: { log: appendList<string>() } });
    for (let index = 0; index < 8; index += 1) {
      graph.addNode(`n${index}`, async () => {
        overlapped.push(store.inFlight > 0);
        await sleep(20);
        return { log: [`n${index}`] };
      });
    }
    graph.setEntry('n0');
    for (let index = 0; index < 7; index += 1) graph.addEdge(`n${index}`, `n${index + 1}`);
    graph.addEdge('n7', END);
    const result = await graph.compile({ checkpointer: store, durability, maxPendingWrites: 2 }).invoke();
    return { store, overlapped: overlapped.filter(Boolean).length, result };
  };
  const sync = await run('sync');
  const background = await run('async');

  assert.equal(background.result.state.log.length, 8);
  // Sync waits for each step's write before the next step works; async works while it writes.
  assert.equal(sync.overlapped, 0, 'sync never works while a write is in flight');
  assert.ok(background.overlapped >= 4, `async worked during a write on ${background.overlapped} of 8 steps`);
  assert.equal(background.store.peak, 1, 'writes land one at a time, in order');
  assert.deepEqual(background.store.written, sync.store.written);
});

test('a write that fails in the background fails the run', async () => {
  const store = new SlowCheckpointer(1, 2);
  await assert.rejects(() => chain(5, { checkpointer: store, durability: 'async' }).invoke(), /the store is down/);
});

test('exit durability writes only where the run stops', async () => {
  const store = new SlowCheckpointer(1);
  const result = await chain(5, { checkpointer: store, durability: 'exit' }).invoke({}, { threadId: 'quick' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(store.written, [5], 'one write, at completion');

  const paused = createGraph({ channels: { answer: lastValue('') } })
    .addNode('ask', ({ interrupt }) => ({ answer: interrupt<string>({ reason: 'name?' }) }))
    .setEntry('ask')
    .addEdge('ask', END)
    .compile({ checkpointer: store, durability: 'exit' });
  const waiting = await paused.invoke({}, { threadId: 'ask' });
  assert.equal(waiting.status, 'awaiting_input');
  assert.equal((await store.get('ask'))?.status, 'awaiting_input', 'a pause is written');
  assert.equal((await paused.resumeWith('ask', 'Ada')).state.answer, 'Ada');
});

test('describe() reports durability, the checkpointer, and the node options lint reads', () => {
  const described = createGraph({ channels: { n: counter() } })
    .addNode('a', () => ({ n: 1 }), {
      retry: { maxAttempts: 3 },
      timeout: { runMs: 1_000, idleMs: 100 },
      onError: () => undefined,
      idempotent: true,
    })
    .setEntry('a')
    .addEdge('a', END)
    .compile({ durability: 'async' })
    .describe();
  assert.equal(described.durability, 'async');
  assert.equal(described.checkpointer, 'memory');
  assert.deepEqual(described.nodes[0], {
    id: 'a',
    retry: true,
    maxAttempts: 3,
    timeout: { runMs: 1_000, idleMs: 100 },
    onError: true,
    idempotent: true,
  });
});

// ── Recovery after retries ─────────────────────────────────────────

/** A checkout that charges a card, and refunds when the charge cannot go through. */
function checkout(options: {
  checkpointer: GraphCheckpointer;
  charges: { count: number };
  refunds: { count: number };
}) {
  return createGraph({
    channels: { status: lastValue('new'), log: appendList<string>() },
  })
    .addNode(
      'charge',
      () => {
        options.charges.count += 1;
        throw new Error('card declined');
      },
      {
        retry: { maxAttempts: 3, initialIntervalMs: 1, jitter: false },
        ends: ['refund'],
        onError: (failure: NodeFailure) =>
          new Command({
            update: { status: 'payment_failed', log: [`charge failed after ${failure.attempts}`] },
            goto: 'refund',
          }),
      },
    )
    .addNode('refund', () => {
      options.refunds.count += 1;
      return { status: 'refunded', log: ['refunded'] };
    })
    .addNode('ship', () => ({ status: 'shipped' }))
    .setEntry('charge')
    .addEdge('charge', 'ship')
    .addEdge('refund', END)
    .addEdge('ship', END)
    .compile({ checkpointer: options.checkpointer });
}

test('onError routes a node whose retries ran out to compensation, and the checkpoint records why', async () => {
  const charges = { count: 0 };
  const refunds = { count: 0 };
  const checkpointer = new MemoryGraphCheckpointer();
  const events: GraphEvent[] = [];
  const result = await checkout({ checkpointer, charges, refunds }).invoke(
    {},
    { threadId: 'order-1', onEvent: (event) => events.push(event) },
  );

  assert.equal(result.status, 'completed');
  assert.equal(charges.count, 3);
  assert.equal(refunds.count, 1);
  assert.equal(result.state.status, 'refunded');
  assert.deepEqual(result.state.log, ['charge failed after 3', 'refunded']);

  const afterCharge = await checkpointer.get('order-1', 1);
  assert.equal(afterCharge?.version, 2);
  const recovered = (afterCharge as GraphCheckpoint).recovered?.[0];
  assert.equal(recovered?.node, 'charge');
  assert.equal(recovered?.attempts, 3);
  assert.equal(recovered?.retryExhausted, true);
  assert.deepEqual(recovered?.error, { name: 'Error', message: 'card declined' });
  assert.deepEqual(recovered?.goto, ['refund']);
  assert.deepEqual((afterCharge as GraphCheckpoint).next, ['ship', 'refund'], 'its own edges run too');
  assert.ok(events.some((event) => event.type === 'task_failed' && event.recovered && event.attempts === 3));
});

test('a crash after the recovery decision resumes into the same compensation, without charging again', async () => {
  const charges = { count: 0 };
  const refunds = { count: 0 };
  const store = new MemoryGraphCheckpointer();
  let crashed = false;
  // The process dies while the refund runs: nothing is written after that point.
  const dying: GraphCheckpointer = {
    put: (checkpoint) => {
      if (crashed) throw new Error('process died');
      store.put(checkpoint);
    },
    get: (threadId, step) => store.get(threadId, step),
    history: (threadId, limit) => store.history(threadId, limit),
  };
  const firstProcess = createGraph({ channels: { status: lastValue('new') } })
    .addNode(
      'charge',
      () => {
        charges.count += 1;
        throw new Error('card declined');
      },
      {
        retry: { maxAttempts: 2, initialIntervalMs: 1 },
        ends: ['refund'],
        onError: () => new Command({ goto: 'refund' }),
      },
    )
    .addNode('refund', () => {
      crashed = true;
      throw new Error('process died');
    })
    .setEntry('charge')
    .addEdge('refund', END)
    .compile({ checkpointer: dying });
  await assert.rejects(() => firstProcess.invoke({}, { threadId: 'order-2' }), /process died/);
  assert.equal(charges.count, 2);

  const secondProcess = checkout({ checkpointer: store, charges, refunds });
  for await (const _ of secondProcess.continue('order-2')) {
    // Runs the thread on from its last checkpoint.
  }
  const final = await secondProcess.state('order-2');
  assert.equal(final?.state.status, 'refunded', 'the resumed run refunds');
  assert.equal(charges.count, 2, 'and never charges again');
  assert.equal(refunds.count, 1);
});

test('without onError, or when onError throws, the node fails the graph as before', async () => {
  const failing = (onError?: () => never) =>
    createGraph({ channels: { n: counter() } })
      .addNode(
        'boom',
        () => {
          throw new Error('broken');
        },
        onError ? { onError } : {},
      )
      .setEntry('boom')
      .addEdge('boom', END)
      .compile();
  await assert.rejects(() => failing().invoke(), GraphNodeError);
  await assert.rejects(
    () =>
      failing(() => {
        throw new Error('cannot recover');
      }).invoke(),
    /cannot recover/,
  );
});

test('nodeDefaults set retries, timeouts, and onError once, and a node overrides them', async () => {
  const seen: string[] = [];
  const graph = createGraph({ channels: { log: appendList<string>() } })
    .addNode('a', () => {
      throw new Error('a failed');
    })
    .addNode(
      'b',
      () => {
        throw new Error('b failed');
      },
      { onError: () => ({ log: ['b handled itself'] }) },
    )
    .setEntry('a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile({
      nodeDefaults: {
        retry: { maxAttempts: 2, initialIntervalMs: 1 },
        onError: (failure) => {
          seen.push(`${failure.node}:${failure.attempts}`);
          return { log: [`${failure.node} recovered`] };
        },
      },
    });
  const result = await graph.invoke();
  assert.deepEqual(result.state.log, ['a recovered', 'b handled itself']);
  assert.deepEqual(seen, ['a:2']);
});

// ── Timeouts ───────────────────────────────────────────────────────

test('an idle timeout fails a node that stops showing progress, and a heartbeat keeps one alive', async () => {
  const silent = createGraph({ channels: { done: lastValue(false) } })
    .addNode(
      'work',
      async () => {
        await sleep(80);
        return { done: true };
      },
      {
        timeout: { idleMs: 25 },
        onError: (failure) => {
          assert.deepEqual(failure.timeout, { type: 'idle', limitMs: 25 });
          assert.ok(failure.error instanceof GraphNodeTimeoutError && failure.error.kind === 'idle');
          return { done: false };
        },
      },
    )
    .setEntry('work')
    .addEdge('work', END)
    .compile();
  assert.equal((await silent.invoke()).state.done, false);

  const beating = createGraph({ channels: { done: lastValue(false) } })
    .addNode(
      'work',
      async ({ heartbeat, emit }) => {
        for (let index = 0; index < 5; index += 1) {
          await sleep(15);
          if (index % 2 === 0) heartbeat();
          else emit({ progress: index });
        }
        return { done: true };
      },
      { timeout: { idleMs: 25 } },
    )
    .setEntry('work')
    .addEdge('work', END)
    .compile();
  assert.equal((await beating.invoke()).state.done, true, '75ms of work, never 25ms without progress');
});

test('a run timeout caps an attempt however much progress it shows', async () => {
  const graph = createGraph({ channels: { done: lastValue(false) } })
    .addNode(
      'work',
      async ({ heartbeat, signal }) => {
        while (!signal.aborted) {
          heartbeat();
          await sleep(5);
        }
        return { done: true };
      },
      { timeout: { runMs: 40, idleMs: 20 } },
    )
    .setEntry('work')
    .addEdge('work', END)
    .compile();
  await assert.rejects(
    () => graph.invoke(),
    (error: unknown) =>
      error instanceof GraphNodeError &&
      error.cause instanceof GraphNodeTimeoutError &&
      error.cause.kind === 'run' &&
      error.cause.timeoutMs === 40,
  );
});

test('a Send overrides the timeout of the task it creates, and the override survives a checkpoint', async () => {
  const graph = createGraph({ channels: { done: appendList<string>() } })
    .addNode('plan', () => ({}))
    .addNode(
      'fetch',
      async ({ input }) => {
        await sleep((input as { ms: number }).ms);
        return { done: [String((input as { ms: number }).ms)] };
      },
      { timeout: { runMs: 20 }, ends: [END] },
    )
    .setEntry('plan')
    .addConditionalEdges('plan', () => [
      new Send('fetch', { ms: 5 }),
      new Send('fetch', { ms: 45 }, { timeout: { runMs: 200 } }),
    ])
    .compile();
  const result = await graph.invoke({}, { threadId: 'fanout' });
  assert.deepEqual(result.state.done, ['5', '45']);
  const planned = await graph.state('fanout', 1);
  assert.deepEqual(planned?.tasks[1]?.timeout, { runMs: 200 });
});

// ── Drain ──────────────────────────────────────────────────────────

test('a drained run finishes its superstep, writes its checkpoint, and another worker continues it', async () => {
  const store = new MemoryGraphCheckpointer();
  const ran: string[] = [];
  const build = () => {
    const graph = createGraph({ channels: { log: appendList<string>() } });
    for (let index = 0; index < 5; index += 1) {
      graph.addNode(`s${index}`, async () => {
        ran.push(`s${index}`);
        await sleep(10);
        return { log: [`s${index}`] };
      });
    }
    graph.setEntry('s0');
    for (let index = 0; index < 4; index += 1) graph.addEdge(`s${index}`, `s${index + 1}`);
    graph.addEdge('s4', END);
    return graph.compile({ checkpointer: store });
  };

  const control = new RunControl();
  const reasons: Array<string | undefined> = [];
  control.onDrain((reason) => reasons.push(reason));
  const running = build().invoke({}, { threadId: 'job', control });
  await sleep(15);
  control.drain('sigterm');
  await assert.rejects(
    running,
    (error: unknown) => error instanceof GraphDrainedError && error.reason === 'sigterm' && error.step >= 1,
  );
  assert.deepEqual(reasons, ['sigterm']);
  const parked = await store.get('job');
  assert.equal(parked?.status, 'interrupted');
  assert.equal((parked as GraphCheckpoint).drained?.reason, 'sigterm');

  const finished = await build()
    .resumeWith('job', undefined)
    .catch(() => undefined);
  assert.equal(finished, undefined, 'a drained run is not waiting for input');
  let last: unknown;
  for await (const event of build().continue('job')) last = event;
  const final = await store.get('job');
  assert.equal(final?.status, 'completed');
  assert.deepEqual(final?.state.log, ['s0', 's1', 's2', 's3', 's4']);
  assert.deepEqual(ran, ['s0', 's1', 's2', 's3', 's4'], 'no step ran twice');
  assert.equal((final as GraphCheckpoint).drained, undefined);
  assert.ok(last);
});

// ── Operations ─────────────────────────────────────────────────────

test('an operation attempt resumes from the progress the last one reported', async () => {
  const runner = new OperationRunner<number>({
    store: new MemoryOperationStore(),
    retry: { maxAttempts: 2, baseDelayMs: 1 },
  });
  const starts: unknown[] = [];
  const handle = await runner.submit(async (context) => {
    starts.push(context.previousHeartbeat);
    const from = (context.previousHeartbeat as { row: number } | undefined)?.row ?? 0;
    for (let row = from; row < 10; row += 1) {
      if (row === 6 && context.attempt === 1) throw new Error('worker died at row 6');
      await context.heartbeat({ row: row + 1 });
    }
    return context.attempt;
  });
  assert.equal(await handle.result(), 2);
  assert.deepEqual(starts, [undefined, { row: 6 }]);
  assert.deepEqual((await runner.read(handle.id))?.heartbeatDetails, { row: 10 });
});

test('a heartbeat inside the executor no longer strands its result', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });
  const handle = await runner.submit(async (context) => {
    await context.heartbeat();
    await context.heartbeat({ phase: 'done' });
    return 'kept';
  });
  assert.equal(await handle.result(), 'kept');
  const record = await runner.read(handle.id);
  assert.equal(record?.status, 'succeeded', 'the final write lands after manual heartbeats');
  assert.equal(record?.result, 'kept');
});

// ── Lint ───────────────────────────────────────────────────────────

test('lint finds a static cycle, retries that are not safe, and an in-process checkpointer', () => {
  const graph = createGraph({ channels: { n: counter() } })
    .addNode('a', () => ({ n: 1 }), { retry: { maxAttempts: 3 } })
    .addNode('b', () => ({ n: 1 }))
    .addNode('safe', () => ({ n: 1 }), { retry: { maxAttempts: 3 }, idempotent: true, timeout: { runMs: 1_000 } })
    .setEntry('a')
    .addEdge('a', 'b')
    .addEdge('b', 'a')
    .addEdge('a', 'safe')
    .addEdge('safe', END)
    .compile({ durability: 'async' });

  const findings = lintGraph(graph, { deployed: true });
  const codes = findings.map((finding) => `${finding.code}${finding.node ? `@${finding.node}` : ''}`);
  assert.ok(codes.includes('UNBOUNDED_CYCLE@a') || codes.includes('UNBOUNDED_CYCLE@b'));
  assert.ok(codes.includes('RETRY_WITHOUT_IDEMPOTENCY@a'));
  assert.ok(codes.includes('RETRY_WITHOUT_TIMEOUT@a'));
  assert.ok(!codes.some((code) => code.endsWith('@safe')), 'an idempotent node with a timeout is fine');
  assert.ok(codes.includes('DEFERRED_DURABILITY_WITH_SIDE_EFFECTS'));
  assert.equal(findings.find((finding) => finding.code === 'MEMORY_CHECKPOINTER')?.severity, 'error');
  assert.equal(lintGraph(graph).find((finding) => finding.code === 'MEMORY_CHECKPOINTER')?.severity, 'warning');
  assert.ok(findings.every((finding) => finding.fix.length > 0));
});

test('lint passes a loop that a router ends, reads subgraphs, and takes a saved description', () => {
  const child = createGraph({ channels: { n: counter() } })
    .addNode('inner', () => ({ n: 1 }), { retry: { maxAttempts: 2 }, timeout: { runMs: 100 } })
    .setEntry('inner')
    .addEdge('inner', END)
    .compile({ checkpointer: false });
  const parent = createGraph({ channels: { n: counter() } })
    .addNode('loop', () => ({ n: 1 }))
    .addNode('nested', child.asNode())
    .setEntry('loop')
    .addConditionalEdges('loop', (state) => (state.n < 3 ? 'loop' : 'nested'), { loop: 'loop', nested: 'nested' })
    .addEdge('nested', END)
    .compile({ checkpointer: false });

  const findings = lintGraph(JSON.parse(JSON.stringify(parent.describe())), { ignore: ['NO_CHECKPOINTER'] });
  assert.deepEqual(
    findings.map((finding) => `${finding.code}@${finding.node}`),
    ['RETRY_WITHOUT_IDEMPOTENCY@nested/inner'],
  );
});
