import assert from 'node:assert/strict';
import test from 'node:test';
import { appendList, counter, lastValue, mergeObject, appendSet, reducerChannel } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import {
  GraphNodeError,
  GraphNotInterruptedError,
  GraphStepLimitError,
  GraphThreadNotFoundError,
  GraphValidationError,
} from '../src/graph/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { END } from '../src/types/graph.js';
import { MemoryOperationStore } from '../src/operations/store.js';

function basicChannels() {
  return { log: appendList<string>(), count: counter(), done: lastValue(false) };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

// ── Channels ───────────────────────────────────────────────────────

test('lastValue overwrites, appendList concatenates', () => {
  const last = lastValue<string>('a');
  assert.equal(last.initial?.(), 'a');
  assert.equal(last.reduce('a', 'b'), 'b');

  const list = appendList<number>();
  assert.deepEqual(list.initial?.(), []);
  assert.deepEqual(list.reduce([1], [2, 3]), [1, 2, 3]);
});

test('counter sums and mergeObject merges keys', () => {
  assert.equal(counter().reduce(2, 3), 5);
  assert.equal(counter(10).initial?.(), 10);
  assert.deepEqual(mergeObject().reduce({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test('appendSet keeps distinct values in first-seen order', () => {
  const set = appendSet<string>();
  assert.deepEqual(set.reduce(['a', 'b'], ['b', 'c', 'a']), ['a', 'b', 'c']);
});

test('reducerChannel builds a custom rule', () => {
  const max = reducerChannel<number>(
    (current, update) => Math.max(current ?? 0, update),
    () => 0,
  );
  assert.equal(max.reduce(5, 3), 5);
  assert.equal(max.reduce(1, 9), 9);
});

// ── Building and validation ────────────────────────────────────────

test('a graph needs channels and an entry point', () => {
  assert.throws(() => createGraph({ channels: {} }), GraphValidationError);
  assert.throws(
    () =>
      createGraph({ channels: basicChannels() })
        .addNode('a', () => undefined)
        .compile(),
    /needs an entry point/,
  );
});

test('reserved names, duplicates, and non-functions are refused', () => {
  const graph = createGraph({ channels: basicChannels() });
  assert.throws(() => graph.addNode('__end__', () => undefined), /reserved/);
  assert.throws(() => graph.addNode('  ', () => undefined), /must not be empty/);
  graph.addNode('a', () => undefined);
  assert.throws(() => graph.addNode('a', () => undefined), /already defined/);
  assert.throws(() => graph.addNode('b', undefined as never), /must be a function/);
});

test('an edge to an unknown node is caught at compile time', () => {
  assert.throws(
    () =>
      createGraph({ channels: basicChannels() })
        .addNode('a', () => undefined)
        .setEntry('a')
        .addEdge('a', 'ghost')
        .compile(),
    /unknown node "ghost"/,
  );
});

test('a node nothing routes to is caught at compile time', () => {
  // Nearly always a typo in an edge, and it would otherwise fail silently by never running.
  assert.throws(
    () =>
      createGraph({ channels: basicChannels() })
        .addNode('a', () => undefined)
        .addNode('orphan', () => undefined)
        .setEntry('a')
        .addEdge('a', END)
        .compile(),
    /No edge reaches "orphan"/,
  );
});

// ── Running ────────────────────────────────────────────────────────

test('a linear graph runs its nodes in order and reduces state', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('first', () => ({ log: ['first'], count: 1 }))
    .addNode('second', () => ({ log: ['second'], count: 1 }))
    .setEntry('first')
    .addEdge('first', 'second')
    .addEdge('second', END)
    .compile();

  const result = await graph.invoke();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.state.log, ['first', 'second']);
  assert.equal(result.state.count, 2);
  assert.equal(result.steps, 2);
});

test('input seeds the state through the channel reducers', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('only', (ctx) => ({ log: [`saw ${ctx.state.log.length}`] }))
    .setEntry('only')
    .addEdge('only', END)
    .compile();

  const result = await graph.invoke({ log: ['seeded'], count: 5 });
  assert.deepEqual(result.state.log, ['seeded', 'saw 1']);
  assert.equal(result.state.count, 5);
});

test('a node sees frozen state and writes only by returning', async () => {
  let threw = false;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('only', (ctx) => {
      try {
        (ctx.state as { count: number }).count = 99;
      } catch {
        threw = true;
      }
      return { count: 1 };
    })
    .setEntry('only')
    .addEdge('only', END)
    .compile();

  const result = await graph.invoke();
  assert.equal(result.state.count, 1);
  assert.equal(threw, true, 'mutating state should not silently succeed');
});

test('writing an undeclared channel is reported, not dropped', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('only', () => ({ nope: 1 }) as never)
    .setEntry('only')
    .addEdge('only', END)
    .compile();

  await assert.rejects(() => graph.invoke(), /not a declared channel/);
});

// ── Conditional edges, cycles, fan-out ─────────────────────────────

test('a conditional edge routes on state', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('start', () => ({ count: 1 }))
    .addNode('big', () => ({ log: ['big'] }))
    .addNode('small', () => ({ log: ['small'] }))
    .setEntry('start')
    .addConditionalEdges('start', (state) => (state.count > 5 ? 'big' : 'small'))
    .addEdge('big', END)
    .addEdge('small', END)
    .compile();

  assert.deepEqual((await graph.invoke()).state.log, ['small']);
  assert.deepEqual((await graph.invoke({ count: 10 })).state.log, ['big']);
});

test('a router mapping lets the router return a domain word', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('check', () => ({ count: 1 }))
    .addNode('approve', () => ({ log: ['approved'] }))
    .setEntry('check')
    .addConditionalEdges('check', () => 'ok', { ok: 'approve' })
    .addEdge('approve', END)
    .compile();

  assert.deepEqual((await graph.invoke()).state.log, ['approved']);
});

test('a cycle runs until the router routes to END', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', (ctx) => ({ count: 1, log: [`tick ${ctx.state.count}`] }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 3 ? END : 'tick'))
    .compile();

  const result = await graph.invoke();
  assert.equal(result.state.count, 3);
  assert.deepEqual(result.state.log, ['tick 0', 'tick 1', 'tick 2']);
  assert.equal(result.status, 'completed');
});

test('a runaway cycle hits the step limit with an actionable message', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('forever', () => ({ count: 1 }))
    .setEntry('forever')
    .addConditionalEdges('forever', () => 'forever')
    .compile({ maxSteps: 5 });

  await assert.rejects(
    () => graph.invoke(),
    (error: unknown) =>
      error instanceof GraphStepLimitError && error.maxSteps === 5 && /routes to END/.test(error.message),
  );
});

test('a router returning an array fans out and both writes are reduced', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('left', () => ({ log: ['left'], count: 1 }))
    .addNode('right', () => ({ log: ['right'], count: 1 }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['left', 'right'])
    .addEdge('left', END)
    .addEdge('right', END)
    .compile();

  const result = await graph.invoke();
  assert.equal(result.state.count, 2, 'both branches wrote and the counter summed them');
  assert.deepEqual(result.state.log, ['split', 'left', 'right']);
  assert.equal(result.steps, 2, 'fan-out runs in one superstep');
});

test('a router returning an unknown target is reported', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => undefined)
    .setEntry('a')
    .addConditionalEdges('a', () => 'ghost')
    .compile();

  await assert.rejects(() => graph.invoke(), /unknown target "ghost"/);
});

test('a failing node reports which node and step failed', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('boom', () => {
      throw new Error('node exploded');
    })
    .setEntry('boom')
    .addEdge('boom', END)
    .compile();

  await assert.rejects(
    () => graph.invoke(),
    (error: unknown) =>
      error instanceof GraphNodeError &&
      error.node === 'boom' &&
      error.step === 1 &&
      /node exploded/.test(error.message),
  );
});

// ── Streaming ──────────────────────────────────────────────────────

test('stream yields one event per superstep and ends with done', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ log: ['a'] }))
    .addNode('b', () => ({ log: ['b'] }))
    .setEntry('a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile();

  const events = await collect(graph.stream());
  assert.deepEqual(
    events.map((event) => event.nodes),
    [['a'], ['b']],
  );
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(events.at(-1)?.status, 'completed');
});

test('an aborted signal stops the run and records it', async () => {
  const controller = new AbortController();
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', () => ({ count: 1 }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 10 ? END : 'tick'))
    .compile({ checkpointer });

  const events: string[] = [];
  for await (const event of graph.stream({}, { threadId: 't-abort', signal: controller.signal })) {
    events.push(event.status);
    if (event.step === 2) controller.abort();
  }

  assert.equal(events.at(-1), 'interrupted');
  assert.equal((await graph.state('t-abort'))?.status, 'interrupted');
});

// ── Checkpointing and resume ───────────────────────────────────────

test('every superstep is checkpointed and readable as history', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ log: ['a'] }))
    .addNode('b', () => ({ log: ['b'] }))
    .setEntry('a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 't1' });
  const history = await graph.history('t1');

  assert.equal(history.length, 3, 'seed plus two supersteps');
  assert.equal(history[0]?.step, 2, 'newest first');
  assert.equal(history[0]?.status, 'completed');
  assert.deepEqual(history[0]?.state.log, ['a', 'b']);
});

test('time travel rewinds to an earlier checkpoint and runs forward', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', () => ({ count: 1, log: ['tick'] }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 3 ? END : 'tick'))
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 't2' });
  assert.equal((await graph.state('t2'))?.state.count, 3);

  // Rewind to after the first tick and run forward again.
  const rerun = await collect(graph.resumeFrom('t2', 1));
  assert.equal(rerun.at(-1)?.state.count, 3);
  assert.equal(rerun.at(-1)?.status, 'completed');
});

test('resuming an unknown thread is reported clearly', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => undefined)
    .setEntry('a')
    .addEdge('a', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });

  await assert.rejects(() => collect(graph.continue('missing')), GraphThreadNotFoundError);
});

test('with checkpointing turned off there is no history to read', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => undefined)
    .setEntry('a')
    .addEdge('a', END)
    .compile({ checkpointer: false });

  await graph.invoke({}, { threadId: 't3' });
  assert.deepEqual(await graph.history('t3'), []);
  assert.equal(await graph.state('t3'), undefined);
});

test('compile() checkpoints in memory by default, so interrupts and history work without setup', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('approve', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }) }))
    .setEntry('approve')
    .addEdge('approve', END)
    .compile();

  // No threadId: the generated one must come back on the result, or the run could never be resumed.
  const paused = await graph.invoke();
  assert.equal(paused.status, 'awaiting_input');
  assert.match(paused.threadId, /^thread-[0-9a-f]{12}$/);
  assert.equal((await graph.state(paused.threadId))?.status, 'awaiting_input');

  const resumed = await graph.resumeWith(paused.threadId, true);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.threadId, paused.threadId);
  assert.equal(resumed.state.done, true);
  assert.ok((await graph.history(paused.threadId)).length >= 2);
});

test('a named thread id is reported back trimmed, exactly as it was stored', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ count: 1 }))
    .setEntry('a')
    .addEdge('a', END)
    .compile();

  const result = await graph.invoke({}, { threadId: '  order-42 ' });
  assert.equal(result.threadId, 'order-42');
  assert.equal((await graph.state('order-42'))?.status, 'completed');
});

test('the in-memory checkpointer drops the least recently written thread past maxThreads', () => {
  const checkpointer = new MemoryGraphCheckpointer({ maxThreads: 2 });
  const checkpoint = (threadId: string, step: number) => ({
    threadId,
    step,
    state: {},
    next: [],
    status: 'completed' as const,
    createdAt: new Date(0).toISOString(),
  });

  checkpointer.put(checkpoint('a', 0));
  checkpointer.put(checkpoint('b', 0));
  checkpointer.put(checkpoint('a', 1)); // touching "a" makes "b" the oldest
  checkpointer.put(checkpoint('c', 0));

  assert.deepEqual(checkpointer.threadIds().sort(), ['a', 'c']);
  assert.equal(checkpointer.get('b'), undefined);
  assert.equal(checkpointer.get('a')?.step, 1);
  assert.throws(() => new MemoryGraphCheckpointer({ maxThreads: 0 }), RangeError);
});

// ── Human in the loop ──────────────────────────────────────────────

test('interrupt suspends the run and surfaces the question', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('draft', () => ({ log: ['drafted'] }))
    .addNode('approve', (ctx) => {
      const approved = ctx.interrupt<boolean>({ reason: 'Approve the draft?', payload: { chars: 120 } });
      return { log: [approved ? 'approved' : 'rejected'], done: true };
    })
    .setEntry('draft')
    .addEdge('draft', 'approve')
    .addEdge('approve', END)
    .compile({ checkpointer });

  const result = await graph.invoke({}, { threadId: 'hitl' });

  assert.equal(result.status, 'awaiting_input');
  assert.equal(result.interrupt?.reason, 'Approve the draft?');
  assert.equal(result.interrupt?.node, 'approve');
  assert.deepEqual(result.interrupt?.payload, { chars: 120 });
  assert.deepEqual(result.state.log, ['drafted'], 'the interrupted node wrote nothing');
});

test('resume supplies the value and the node continues', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('approve', (ctx) => {
      const approved = ctx.interrupt<boolean>({ reason: 'Approve?' });
      return { log: [approved ? 'approved' : 'rejected'], done: true };
    })
    .setEntry('approve')
    .addEdge('approve', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'hitl2' });
  const resumed = await graph.resumeWith('hitl2', true);

  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.state.log, ['approved']);
  assert.equal(resumed.state.done, true);
});

test('a rejected answer takes the other branch', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('approve', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }) }))
    .addNode('publish', () => ({ log: ['published'] }))
    .addNode('discard', () => ({ log: ['discarded'] }))
    .setEntry('approve')
    .addConditionalEdges('approve', (state) => (state.done ? 'publish' : 'discard'))
    .addEdge('publish', END)
    .addEdge('discard', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'hitl3' });
  const resumed = await graph.resumeWith('hitl3', false);
  assert.deepEqual(resumed.state.log, ['discarded']);
});

test('a node may ask more than one question across resumes', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('ask', (ctx) => {
      const first = ctx.interrupt<string>({ reason: 'First?' });
      const second = ctx.interrupt<string>({ reason: 'Second?' });
      return { log: [first, second] };
    })
    .setEntry('ask')
    .addEdge('ask', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'two' });
  const afterFirst = await graph.resumeWith('two', 'alpha');
  assert.equal(afterFirst.status, 'awaiting_input');
  assert.equal(afterFirst.interrupt?.reason, 'Second?');

  const afterSecond = await graph.resumeWith('two', 'beta');
  assert.deepEqual(afterSecond.state.log, ['alpha', 'beta']);
});

test('resuming a thread that is not waiting is refused', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ log: ['a'] }))
    .setEntry('a')
    .addEdge('a', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'done' });
  await assert.rejects(() => graph.resumeWith('done', true), GraphNotInterruptedError);
});

test('interrupt with checkpointing turned off fails loudly rather than hanging', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('ask', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }) }))
    .setEntry('ask')
    .addEdge('ask', END)
    .compile({ checkpointer: false });

  await assert.rejects(() => graph.invoke(), /without a checkpointer/);
});

test('work done by other branches before an interrupt is not repeated', async () => {
  const checkpointer = new MemoryGraphCheckpointer();
  let sideEffects = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('work', () => {
      sideEffects += 1;
      return { log: ['worked'], count: 1 };
    })
    .addNode('ask', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }) }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['work', 'ask'])
    .addEdge('work', END)
    .addEdge('ask', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'fanout-hitl' });
  await graph.resumeWith('fanout-hitl', true);

  assert.equal(sideEffects, 1, 'the completed branch ran once, not once per resume');
});

// ── Subgraphs ──────────────────────────────────────────────────────

test('a compiled graph can be a node in another graph', async () => {
  const child = createGraph({ channels: { log: appendList<string>() } })
    .addNode('inner', () => ({ log: ['inner'] }))
    .setEntry('inner')
    .addEdge('inner', END)
    .compile();

  const parent = createGraph({ channels: basicChannels() })
    .addNode('before', () => ({ log: ['before'] }))
    .addNode('child', child.asNode())
    .addNode('after', () => ({ log: ['after'] }))
    .setEntry('before')
    .addEdge('before', 'child')
    .addEdge('child', 'after')
    .addEdge('after', END)
    .compile();

  const result = await parent.invoke();
  assert.deepEqual(result.state.log, ['before', 'before', 'inner', 'after']);
});

test('a subgraph keeps channels the parent does not declare private', async () => {
  const child = createGraph({ channels: { log: appendList<string>(), secret: lastValue('hidden') } })
    .addNode('inner', () => ({ log: ['inner'], secret: 'changed' }))
    .setEntry('inner')
    .addEdge('inner', END)
    .compile();

  const parent = createGraph({ channels: { log: appendList<string>() } })
    .addNode('child', child.asNode())
    .setEntry('child')
    .addEdge('child', END)
    .compile();

  const result = await parent.invoke();
  assert.deepEqual(result.state.log, ['inner']);
  assert.equal('secret' in result.state, false, 'a private channel does not leak into the parent');
});

// ── Durable checkpointer over the operation store ──────────────────

test('the operation-store checkpointer persists, reads back, and keeps history', async () => {
  const store = new MemoryOperationStore<never>();
  const checkpointer = new OperationStoreCheckpointer(store as never);
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', () => ({ count: 1, log: ['tick'] }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 3 ? END : 'tick'))
    .compile({ checkpointer });

  const result = await graph.invoke({}, { threadId: 'durable' });
  assert.equal(result.state.count, 3);

  const latest = await graph.state('durable');
  assert.equal(latest?.status, 'completed');
  assert.equal(latest?.state.count, 3);

  const history = await graph.history('durable');
  assert.equal(history.length, 4, 'seed plus three supersteps');
  assert.deepEqual(
    history.map((item) => item.step),
    [3, 2, 1, 0],
  );
});

test('a second graph instance resumes a thread the first suspended', async () => {
  // The point of a durable checkpointer: a different process finishes what another started.
  const store = new MemoryOperationStore<never>();
  const build = () =>
    createGraph({ channels: basicChannels() })
      .addNode('ask', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }), log: ['answered'] }))
      .setEntry('ask')
      .addEdge('ask', END)
      .compile({ checkpointer: new OperationStoreCheckpointer(store as never) });

  const first = build();
  const suspended = await first.invoke({}, { threadId: 'cross-process' });
  assert.equal(suspended.status, 'awaiting_input');

  const second = build();
  const finished = await second.resumeWith('cross-process', true);
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.state.log, ['answered']);
});

test('the store checkpointer can drop a finished thread', async () => {
  const store = new MemoryOperationStore<never>();
  const checkpointer = new OperationStoreCheckpointer(store as never);
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ log: ['a'] }))
    .setEntry('a')
    .addEdge('a', END)
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'disposable' });
  await checkpointer.delete('disposable');
  assert.equal(await graph.state('disposable'), undefined);
});

test('the memory checkpointer bounds retained history', async () => {
  const checkpointer = new MemoryGraphCheckpointer({ maxPerThread: 3 });
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', () => ({ count: 1 }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 6 ? END : 'tick'))
    .compile({ checkpointer });

  await graph.invoke({}, { threadId: 'bounded' });
  assert.equal((await graph.history('bounded')).length, 3);
});
