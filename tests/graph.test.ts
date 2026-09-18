import assert from 'node:assert/strict';
import test from 'node:test';
import { appendList, counter, lastValue, mergeObject, appendSet, reducerChannel } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import {
  GraphNodeError,
  GraphNodeTimeoutError,
  GraphNotInterruptedError,
  GraphStepLimitError,
  GraphThreadNotFoundError,
  GraphValidationError,
} from '../src/graph/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { toGraphJSON, toMermaid } from '../src/graph/visualize.js';
import { Command, END, Send } from '../src/types/graph.js';
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

test('a finished sibling still routes onward after the step resumes from an interrupt', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('work', () => ({ log: ['worked'] }))
    .addNode('after-work', () => ({ log: ['after-work'] }))
    .addNode('ask', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Approve?' }) }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['work', 'ask'])
    .addEdge('work', 'after-work')
    .addEdge('after-work', END)
    .addEdge('ask', END)
    .compile();

  await graph.invoke({}, { threadId: 'route-after-pause' });
  const resumed = await graph.resumeWith('route-after-pause', true);

  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.state.log, ['split', 'worked', 'after-work']);
});

test('a failed step keeps finished siblings, and continue() retries only the failure', async () => {
  let workRuns = 0;
  let flakyRuns = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('work', () => {
      workRuns += 1;
      return { log: ['worked'], count: 1 };
    })
    .addNode('flaky', () => {
      flakyRuns += 1;
      if (flakyRuns === 1) throw new Error('transient');
      return { log: ['flaky-ok'] };
    })
    .addNode('after-work', () => ({ log: ['after-work'] }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['work', 'flaky'])
    .addEdge('work', 'after-work')
    .addEdge('flaky', END)
    .addEdge('after-work', END)
    .compile();

  await assert.rejects(() => graph.invoke({}, { threadId: 'retry' }), GraphNodeError);
  const failed = await graph.state('retry');
  assert.equal(failed?.status, 'failed');
  assert.deepEqual(failed?.next, ['flaky']);
  assert.deepEqual(failed?.state.log, ['split', 'worked'], 'the sibling write survived the failure');

  const events = await collect(graph.continue('retry'));
  const final = events.at(-1);
  assert.equal(final?.status, 'completed');
  assert.equal(workRuns, 1, 'the sibling that finished was not run again');
  assert.equal(flakyRuns, 2);
  assert.equal(final?.state.count, 1);
  assert.deepEqual(final?.state.log, ['split', 'worked', 'flaky-ok', 'after-work']);
  assert.equal((await graph.state('retry'))?.error, undefined);
});

test('rewinding drops checkpoints from the abandoned timeline', async () => {
  for (const checkpointer of [
    new MemoryGraphCheckpointer(),
    new OperationStoreCheckpointer(new MemoryOperationStore() as never),
  ]) {
    const graph = createGraph({ channels: basicChannels() })
      .addNode('tick', () => ({ count: 1 }))
      .setEntry('tick')
      .addConditionalEdges('tick', (state) => (state.count >= 4 ? END : 'tick'))
      .compile({ checkpointer });

    await graph.invoke({}, { threadId: 'rewind' });
    assert.equal((await graph.state('rewind'))?.step, 4);

    // Rewind to step 1 but stop after one more step: the old steps 3 and 4 must not reappear.
    await collect(graph.resumeFrom('rewind', 1, { maxSteps: 2 })).catch(() => undefined);
    const latest = await graph.state('rewind');
    assert.equal(latest?.step, 2);
    assert.deepEqual(
      (await graph.history('rewind')).map((checkpoint) => checkpoint.step),
      [2, 1, 0],
    );
  }
});

test('context.report() reaches onProgress, and a throwing listener does not fail the node', async () => {
  const seen: string[] = [];
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', (ctx) => {
      ctx.report({ message: 'halfway' });
      return { count: 1 };
    })
    .setEntry('a')
    .addEdge('a', END)
    .compile({ name: 'reporter' });

  await graph.invoke({}, { threadId: 'progress', onProgress: (p) => seen.push(`${p.node}:${p.step}:${p.message}`) });
  assert.deepEqual(seen, ['a:1:halfway']);
  assert.equal((await graph.state('progress'))?.metadata?.graph, 'reporter');

  const result = await graph.invoke(
    {},
    {
      onProgress: () => {
        throw new Error('listener bug');
      },
    },
  );
  assert.equal(result.status, 'completed');
});

// ── Subgraphs ──────────────────────────────────────────────────────

test('a subgraph interrupt pauses the parent, and resuming answers the subgraph', async () => {
  let draftRuns = 0;
  const child = createGraph({ channels: basicChannels() })
    .addNode('draft', () => {
      draftRuns += 1;
      return { log: ['drafted'] };
    })
    .addNode('review', (ctx) => {
      const first = ctx.interrupt<string>({ reason: 'Title?' });
      const second = ctx.interrupt<string>({ reason: 'Tone?' });
      return { log: [`${first}/${second}`], done: true };
    })
    .setEntry('draft')
    .addEdge('draft', 'review')
    .addEdge('review', END)
    .compile();

  let publishRuns = 0;
  const parent = createGraph({ channels: basicChannels() })
    .addNode('write', child.asNode())
    .addNode('publish', () => {
      publishRuns += 1;
      return { log: ['published'] };
    })
    .setEntry('write')
    .addEdge('write', 'publish')
    .addEdge('publish', END)
    .compile();

  const paused = await parent.invoke({}, { threadId: 'nested' });
  assert.equal(paused.status, 'awaiting_input', 'the parent must not carry on past a waiting subgraph');
  assert.equal(paused.interrupt?.reason, 'Title?');
  assert.equal(publishRuns, 0);

  const second = await parent.resumeWith('nested', 'Launch');
  assert.equal(second.status, 'awaiting_input');
  assert.equal(second.interrupt?.reason, 'Tone?');

  const done = await parent.resumeWith('nested', 'warm');
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.state.log, ['drafted', 'Launch/warm', 'published']);
  assert.equal(draftRuns, 1, 'the subgraph continued where it stopped rather than starting over');
  assert.equal(publishRuns, 1);
});

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

// ── Parallel supersteps ────────────────────────────────────────────

function slowNode(ms: number, label: string, log: string[]) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(label);
    return { log: [label] };
  };
}

test('tasks in one superstep run at the same time', async () => {
  const order: string[] = [];
  const build = (maxConcurrency?: number) =>
    createGraph({ channels: basicChannels() })
      .addNode('split', () => ({ log: ['split'] }))
      .addNode('a', slowNode(60, 'a', order))
      .addNode('b', slowNode(60, 'b', order))
      .addNode('c', slowNode(60, 'c', order))
      .addNode('d', slowNode(60, 'd', order))
      .setEntry('split')
      .addConditionalEdges('split', () => ['a', 'b', 'c', 'd'])
      .addEdge('a', END)
      .addEdge('b', END)
      .addEdge('c', END)
      .addEdge('d', END)
      .compile(maxConcurrency === undefined ? {} : { maxConcurrency });

  const startedParallel = Date.now();
  const parallel = await build().invoke();
  const parallelMs = Date.now() - startedParallel;

  order.length = 0;
  const startedSerial = Date.now();
  const serial = await build(1).invoke();
  const serialMs = Date.now() - startedSerial;

  assert.equal(parallel.status, 'completed');
  // Four 60 ms branches together take about 60 ms, not 240 ms.
  assert.ok(parallelMs < 150, `expected the four branches to overlap, took ${parallelMs}ms`);
  assert.ok(serialMs >= 200, `maxConcurrency 1 should run them one at a time, took ${serialMs}ms`);

  // Whatever the timing, writes are reduced in task order, so both runs produce the same state.
  assert.deepEqual(parallel.state.log, ['split', 'a', 'b', 'c', 'd']);
  assert.deepEqual(serial.state.log, parallel.state.log);
});

test('maxConcurrency bounds how many tasks are in flight, and a run can override the compiled limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('fan', () => ({ log: ['fan'] }))
    .addNode('worker', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return { count: 1 };
    })
    .setEntry('fan')
    .addConditionalEdges('fan', () => Array.from({ length: 9 }, (_, index) => new Send('worker', index)))
    .addEdge('worker', END)
    .compile({ maxConcurrency: 3 });

  const bounded = await graph.invoke();
  assert.equal(bounded.state.count, 9);
  assert.equal(peak, 3);

  peak = 0;
  await graph.invoke({}, { maxConcurrency: 9 });
  assert.equal(peak, 9);
});

// ── Send ───────────────────────────────────────────────────────────

test('Send fans one node out over a list decided at run time', async () => {
  const seen: Array<{ input: unknown; taskId: string }> = [];
  const graph = createGraph({ channels: { ...basicChannels(), urls: lastValue<string[]>([]) } })
    .addNode('plan', () => ({ urls: ['a.test', 'b.test', 'c.test'] }))
    .addNode(
      'research',
      (ctx) => {
        seen.push({ input: ctx.input, taskId: ctx.taskId });
        return { log: [`fetched ${ctx.input}`], count: 1 };
      },
      { ends: [END] },
    )
    .addNode('report', (ctx) => ({ log: [`report:${ctx.state.count}`] }))
    .setEntry('plan')
    .addConditionalEdges('plan', (state) => state.urls.map((url) => new Send('research', url)))
    .addConditionalEdges('research', () => 'report')
    .addEdge('report', END)
    .compile();

  const result = await graph.invoke({}, { threadId: 'send' });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.count, 3);
  assert.deepEqual(
    seen.map((item) => item.input),
    ['a.test', 'b.test', 'c.test'],
  );
  // Each copy of the node is its own task, so an interrupt or a retry can tell them apart.
  assert.equal(new Set(seen.map((item) => item.taskId)).size, 3);
  assert.deepEqual(result.state.log, [
    'fetched a.test',
    'fetched b.test',
    'fetched c.test',
    // The aggregator runs once, after every branch of the fan-out finished.
    'report:3',
  ]);
});

test('a checkpointed Send survives a resume, and only the unfinished copies run again', async () => {
  let runs = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('plan', () => ({ log: ['planned'] }))
    .addNode(
      'each',
      (ctx) => {
        runs += 1;
        const approved = ctx.interrupt<boolean>({ reason: `Use ${ctx.input}?` });
        return { log: [`${ctx.input}:${approved}`] };
      },
      { ends: [END] },
    )
    .setEntry('plan')
    .addConditionalEdges('plan', () => [new Send('each', 'x'), new Send('each', 'y')])
    .compile();

  const paused = await graph.invoke({}, { threadId: 'send-hitl' });
  assert.equal(paused.status, 'awaiting_input');
  // Both copies asked, so both questions are pending at once.
  assert.equal(paused.interrupts?.length, 2);
  assert.deepEqual(
    paused.interrupts?.map((item) => item.reason),
    ['Use x?', 'Use y?'],
  );

  const stored = await graph.state('send-hitl');
  assert.deepEqual(
    stored?.tasks?.map((task) => task.input),
    ['x', 'y'],
  );

  const ids = paused.interrupts?.map((item) => item.id) ?? [];
  const done = await graph.resumeInterruptsWith('send-hitl', { [ids[0] as string]: true, [ids[1] as string]: false });

  assert.equal(done.status, 'completed');
  assert.deepEqual(done.state.log, ['planned', 'x:true', 'y:false']);
  assert.equal(runs, 4, 'each copy ran once to ask and once to use its answer');
});

test('answering one of several questions leaves the rest pending', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('ask-a', (ctx) => ({ log: [`a:${ctx.interrupt<string>({ reason: 'A?' })}`] }))
    .addNode('ask-b', (ctx) => ({ log: [`b:${ctx.interrupt<string>({ reason: 'B?' })}`] }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['ask-a', 'ask-b'])
    .addEdge('ask-a', END)
    .addEdge('ask-b', END)
    .compile();

  const paused = await graph.invoke({}, { threadId: 'two-asks' });
  assert.equal(paused.interrupts?.length, 2);

  const first = paused.interrupts?.[0]?.id as string;
  const partial = await graph.resumeInterruptsWith('two-asks', { [first]: 'yes' });
  assert.equal(partial.status, 'awaiting_input');
  assert.deepEqual(
    partial.interrupts?.map((item) => item.reason),
    ['B?'],
  );

  const second = partial.interrupts?.[0]?.id as string;
  const done = await graph.resumeInterruptsWith('two-asks', { [second]: 'no' });
  assert.deepEqual(done.state.log, ['split', 'a:yes', 'b:no']);

  await assert.rejects(
    () => graph.resumeInterruptsWith('two-asks', { nonsense: 1 }),
    GraphNotInterruptedError,
    'a finished thread has nothing to answer',
  );
});

// ── Retries and timeouts ───────────────────────────────────────────

test('a node retries under its policy and reports the attempts it needed', async () => {
  let attempts = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode(
      'flaky',
      (ctx) => {
        attempts += 1;
        if (attempts < 3) throw new Error('upstream hiccup');
        return { count: ctx.attempt };
      },
      { retry: { maxAttempts: 3, initialIntervalMs: 1, jitter: false } },
    )
    .setEntry('flaky')
    .addEdge('flaky', END)
    .compile();

  const events = await collect(graph.stream({}, { threadId: 'retry-policy' }));
  assert.equal(attempts, 3);
  assert.equal(events.at(-1)?.state.count, 3, 'context.attempt tells the node which try this is');
  assert.deepEqual(events.at(-1)?.attempts, { flaky: 3 });
});

test('retries stop at maxAttempts, and retryOn can refuse to retry at all', async () => {
  let runs = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode(
      'always-fails',
      () => {
        runs += 1;
        throw new Error('permanent');
      },
      { retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false } },
    )
    .setEntry('always-fails')
    .addEdge('always-fails', END)
    .compile();

  await assert.rejects(() => graph.invoke({}, { threadId: 'exhausted' }), GraphNodeError);
  assert.equal(runs, 2);

  let picky = 0;
  const selective = createGraph({ channels: basicChannels() })
    .addNode(
      'fails',
      () => {
        picky += 1;
        throw new Error('do not retry me');
      },
      { retry: { maxAttempts: 5, initialIntervalMs: 1, retryOn: (error) => !String(error).includes('do not retry') } },
    )
    .setEntry('fails')
    .addEdge('fails', END)
    .compile();

  await assert.rejects(() => selective.invoke(), GraphNodeError);
  assert.equal(picky, 1);
});

test('a graph-wide retry policy applies to nodes that declare none', async () => {
  let runs = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('flaky', () => {
      runs += 1;
      if (runs < 2) throw new Error('once');
      return { count: 1 };
    })
    .setEntry('flaky')
    .addEdge('flaky', END)
    .compile({ retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false } });

  const result = await graph.invoke();
  assert.equal(result.status, 'completed');
  assert.equal(runs, 2);
});

test('a node that outruns its timeout fails with its signal aborted', async () => {
  let aborted = false;
  const graph = createGraph({ channels: basicChannels() })
    .addNode(
      'slow',
      async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { count: 1 };
      },
      { timeoutMs: 20 },
    )
    .setEntry('slow')
    .addEdge('slow', END)
    .compile();

  await assert.rejects(
    () => graph.invoke({}, { threadId: 'timeout' }),
    (error: unknown) => {
      assert.ok(error instanceof GraphNodeError);
      assert.ok(error.cause instanceof GraphNodeTimeoutError);
      assert.match((error.cause as GraphNodeTimeoutError).message, /20ms timeout/);
      return true;
    },
  );
  assert.equal(aborted, true, 'the node is told to stop, not merely reported as late');
});

// ── Failure policy ─────────────────────────────────────────────────

test('a failing task aborts its siblings by default, and settle lets them finish', async () => {
  const build = (onNodeError?: 'fail-fast' | 'settle') => {
    const finished: string[] = [];
    const graph = createGraph({ channels: basicChannels() })
      .addNode('split', () => ({ log: ['split'] }))
      .addNode('boom', () => {
        throw new Error('boom');
      })
      .addNode('slow', async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (!ctx.signal.aborted) finished.push('slow');
        return { log: ['slow'] };
      })
      .setEntry('split')
      .addConditionalEdges('split', () => ['boom', 'slow'])
      .addEdge('boom', END)
      .addEdge('slow', END)
      .compile(onNodeError ? { onNodeError } : {});
    return { graph, finished };
  };

  const fast = build();
  await assert.rejects(() => fast.graph.invoke({}, { threadId: 'ff' }), GraphNodeError);
  assert.deepEqual(fast.finished, [], 'the sibling was told to stop as soon as the other task failed');

  const settled = build('settle');
  await assert.rejects(() => settled.graph.invoke({}, { threadId: 'settle' }), GraphNodeError);
  assert.deepEqual(settled.finished, ['slow'], 'settle lets expensive siblings finish before reporting');
  assert.deepEqual((await settled.graph.state('settle'))?.completed, ['slow']);
});

test('an unknown Send target is reported with the node that produced it', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('plan', () => ({ log: ['planned'] }))
    .addNode('real', () => undefined, { ends: [END] })
    .setEntry('plan')
    .addConditionalEdges('plan', () => [new Send('ghost', 1)])
    .compile();

  await assert.rejects(
    () => graph.invoke(),
    (error: unknown) => {
      assert.ok(error instanceof GraphValidationError);
      assert.match(error.message, /Send from "plan" targets unknown node "ghost"/);
      return true;
    },
  );
});

// ── Commands ───────────────────────────────────────────────────────

test('a Command updates state and routes in one return', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode(
      'triage',
      (ctx) => new Command({ update: { log: ['triaged'] }, goto: ctx.state.count > 0 ? 'urgent' : 'normal' }),
      {
        ends: ['urgent', 'normal'],
      },
    )
    .addNode('urgent', () => ({ log: ['urgent'] }))
    .addNode('normal', () => ({ log: ['normal'] }))
    .setEntry('triage')
    .addEdge('urgent', END)
    .addEdge('normal', END)
    .compile();

  assert.deepEqual((await graph.invoke()).state.log, ['triaged', 'normal']);
  assert.deepEqual((await graph.invoke({ count: 1 })).state.log, ['triaged', 'urgent']);
});

test('a Command can fan out with Send, and a node reached only by Command passes compile checks', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('plan', () => new Command({ goto: [new Send('work', 'a'), new Send('work', 'b')] }), { ends: ['work'] })
    .addNode('work', (ctx) => ({ log: [`did ${ctx.input}`] }), { ends: [END] })
    .setEntry('plan')
    .compile();

  assert.deepEqual((await graph.invoke()).state.log, ['did a', 'did b']);
});

test('a Command route survives a pause in the same step', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({ log: ['split'] }))
    .addNode('decide', () => new Command({ update: { log: ['decided'] }, goto: 'follow-up' }), { ends: ['follow-up'] })
    .addNode('ask', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'Proceed?' }) }))
    .addNode('follow-up', () => ({ log: ['followed up'] }))
    .setEntry('split')
    .addConditionalEdges('split', () => ['decide', 'ask'])
    .addEdge('ask', END)
    .addEdge('follow-up', END)
    .compile();

  await graph.invoke({}, { threadId: 'command-pause' });
  const done = await graph.resumeWith('command-pause', true);
  assert.equal(done.status, 'completed');
  // "decide" is not re-run on resume, so its route has to come from the checkpoint.
  assert.deepEqual(done.state.log, ['split', 'decided', 'followed up']);
});

test('Command.PARENT hands control from a subgraph back to its parent', async () => {
  const child = createGraph({ channels: basicChannels() })
    .addNode('try', () => ({ log: ['child tried'] }))
    .addNode('escalate', () => new Command({ graph: Command.PARENT, goto: 'human', update: { log: ['escalated'] } }))
    .addNode('unreachable-after-escalation', () => ({ log: ['should not run'] }))
    .setEntry('try')
    .addEdge('try', 'escalate')
    .addEdge('escalate', 'unreachable-after-escalation')
    .addEdge('unreachable-after-escalation', END)
    .compile();

  const parent = createGraph({ channels: basicChannels() })
    .addNode('agent', child.asNode(), { ends: ['human'] })
    .addNode('human', () => ({ log: ['human took over'] }))
    .setEntry('agent')
    .addEdge('human', END)
    .compile();

  const result = await parent.invoke();
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.state.log, ['child tried', 'escalated', 'human took over']);
});

test('parallel Send copies of a subgraph node run on separate subgraph threads', async () => {
  const child = createGraph({ channels: { ...basicChannels(), topic: lastValue<string>('') } })
    .addNode('ask', (ctx) => ({
      log: [`${ctx.state.topic}:${ctx.interrupt<string>({ reason: `About ${ctx.state.topic}?` })}`],
    }))
    .setEntry('ask')
    .addEdge('ask', END)
    .compile();

  const parent = createGraph({ channels: { ...basicChannels(), topic: lastValue<string>('') } })
    .addNode('fan', () => ({}))
    .addNode(
      'research',
      async (ctx) =>
        child.asNode<ReturnType<typeof basicChannels> & { topic: ReturnType<typeof lastValue<string>> }>()({
          ...ctx,
          state: { ...ctx.state, topic: String(ctx.input) },
        }),
      { ends: [END] },
    )
    .setEntry('fan')
    .addConditionalEdges('fan', () => [new Send('research', 'x'), new Send('research', 'y')])
    .compile();

  const paused = await parent.invoke({}, { threadId: 'per-task' });
  assert.equal(paused.interrupts?.length, 2);
  assert.deepEqual(
    paused.interrupts?.map((item) => item.reason).sort(),
    ['About x?', 'About y?'],
    'each copy kept its own subgraph thread, so each asked its own question',
  );
});

// ── Breakpoints ────────────────────────────────────────────────────

test('interruptBefore pauses in front of a node, and continue() runs it without pausing again', async () => {
  let risky = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('draft', () => ({ log: ['draft'] }))
    .addNode('publish', () => {
      risky += 1;
      return { log: ['published'] };
    })
    .setEntry('draft')
    .addEdge('draft', 'publish')
    .addEdge('publish', END)
    .compile({ interruptBefore: ['publish'] });

  const paused = await graph.invoke({}, { threadId: 'bp-before' });
  assert.equal(paused.status, 'interrupted');
  assert.deepEqual(paused.breakpoint, { when: 'before', nodes: ['publish'] });
  assert.equal(risky, 0);

  const events = await collect(graph.continue('bp-before'));
  assert.equal(events.at(-1)?.status, 'completed');
  assert.equal(risky, 1);
});

test('interruptAfter pauses once a node has written, and a run can override the compiled breakpoints', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('a', () => ({ log: ['a'] }))
    .addNode('b', () => ({ log: ['b'] }))
    .setEntry('a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile({ interruptAfter: ['a'] });

  const paused = await graph.invoke({}, { threadId: 'bp-after' });
  assert.equal(paused.status, 'interrupted');
  assert.deepEqual(paused.breakpoint, { when: 'after', nodes: ['a'] });
  assert.deepEqual(paused.state.log, ['a']);
  assert.equal((await collect(graph.continue('bp-after'))).at(-1)?.status, 'completed');

  const unpaused = await graph.invoke({}, { interruptAfter: [] });
  assert.equal(unpaused.status, 'completed');
});

// ── Deferred nodes ─────────────────────────────────────────────────

test('a deferred node waits for branches of different lengths and runs once', async () => {
  let aggregations = 0;
  const graph = createGraph({ channels: basicChannels() })
    .addNode('split', () => ({}))
    .addNode('short', () => ({ log: ['short'] }))
    .addNode('long-1', () => ({ log: ['long-1'] }))
    .addNode('long-2', () => ({ log: ['long-2'] }))
    .addNode(
      'aggregate',
      (ctx) => {
        aggregations += 1;
        return { log: [`aggregate saw ${ctx.state.log.length}`] };
      },
      { defer: true },
    )
    .setEntry('split')
    .addConditionalEdges('split', () => ['short', 'long-1'])
    .addEdge('short', 'aggregate')
    .addEdge('long-1', 'long-2')
    .addEdge('long-2', 'aggregate')
    .addEdge('aggregate', END)
    .compile();

  const result = await graph.invoke();
  assert.equal(aggregations, 1);
  assert.deepEqual(result.state.log, ['short', 'long-1', 'long-2', 'aggregate saw 3']);
});

// ── Events ─────────────────────────────────────────────────────────

test('onEvent reports tasks, retries, checkpoints, and custom events as they happen', async () => {
  let attempts = 0;
  const events: string[] = [];
  const graph = createGraph({ channels: basicChannels() })
    .addNode(
      'stream-tokens',
      (ctx) => {
        attempts += 1;
        if (attempts === 1) throw new Error('flaky');
        for (const token of ['Hel', 'lo']) ctx.emit({ token });
        return { log: ['Hello'] };
      },
      { retry: { maxAttempts: 2, initialIntervalMs: 1, jitter: false } },
    )
    .setEntry('stream-tokens')
    .addEdge('stream-tokens', END)
    .compile();

  await graph.invoke(
    {},
    {
      onEvent: (event) => {
        if (event.type === 'custom') events.push(`custom:${(event.data as { token: string }).token}`);
        else if (event.type === 'checkpoint') events.push(`checkpoint:${event.step}:${event.status}`);
        else events.push(`${event.type}:${event.node}`);
      },
    },
  );

  assert.deepEqual(events, [
    'checkpoint:0:running',
    'task_start:stream-tokens',
    'task_retry:stream-tokens',
    'task_start:stream-tokens',
    'custom:Hel',
    'custom:lo',
    'task_end:stream-tokens',
    'checkpoint:1:completed',
  ]);

  const quiet = await graph.invoke(
    {},
    {
      onEvent: () => {
        throw new Error('listener bug');
      },
    },
  );
  assert.equal(quiet.status, 'completed', 'a broken listener never fails the run');
});

// ── Editing state and forking ──────────────────────────────────────

test('updateState edits a paused thread in place, and asNode applies an update as that node', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('research', () => ({ log: ['wrong fact'] }))
    .addNode('review', (ctx) => ({ done: ctx.interrupt<boolean>({ reason: 'OK?' }) }))
    .addNode('write', (ctx) => ({ log: [`wrote from ${ctx.state.log.length} notes`] }))
    .setEntry('research')
    .addEdge('research', 'review')
    .addEdge('review', 'write')
    .addEdge('write', END)
    .compile();

  await graph.invoke({}, { threadId: 'edit' });
  const edited = await graph.updateState('edit', { log: ['correction'] });
  assert.equal(edited.status, 'awaiting_input', 'editing in place keeps the question pending');
  assert.equal(edited.metadata?.source, 'update');

  await assert.rejects(() => graph.updateState('edit', { count: 1 }, { asNode: 'research' }), /waiting for an answer/);

  const done = await graph.resumeWith('edit', true);
  assert.deepEqual(done.state.log, ['wrong fact', 'correction', 'wrote from 2 notes']);

  const skipped = await graph.updateState('edit', { log: ['manual'] }, { asNode: 'review' });
  assert.deepEqual(skipped.next, ['write'], 'the next step follows the edges of the node named');
  await assert.rejects(() => graph.updateState('edit', {}, { asNode: 'ghost' }), /not a node/);
});

test('fork copies a thread up to a step, and both timelines stay readable and runnable', async () => {
  const graph = createGraph({ channels: basicChannels() })
    .addNode('tick', () => ({ count: 1 }))
    .setEntry('tick')
    .addConditionalEdges('tick', (state) => (state.count >= 3 ? END : 'tick'))
    .compile();

  await graph.invoke({}, { threadId: 'original' });
  const forkId = await graph.fork('original', { step: 1, threadId: 'alternative' });
  assert.equal(forkId, 'alternative');

  const forked = await graph.state('alternative');
  assert.equal(forked?.step, 1);
  assert.deepEqual(forked?.metadata?.forkedFrom, { threadId: 'original', step: 1 });

  await graph.updateState('alternative', { count: 10 });
  const finished = await collect(graph.continue('alternative'));
  assert.equal(finished.at(-1)?.state.count, 12);
  assert.equal((await graph.state('original'))?.state.count, 3, 'the original timeline is untouched');

  await assert.rejects(() => graph.fork('original', { threadId: 'alternative' }), /already exists/);
  await assert.rejects(() => graph.fork('original', { step: 99 }), /no checkpoint at step 99/);
  await assert.rejects(() => graph.fork('nobody'), GraphThreadNotFoundError);
});

// ── Describe and visualize ─────────────────────────────────────────

test('describe() returns the shape, and toMermaid renders it with subgraphs and highlights', () => {
  const child = createGraph({ channels: basicChannels() })
    .addNode('inner', () => undefined)
    .setEntry('inner')
    .addEdge('inner', END)
    .compile({ name: 'child' });

  const graph = createGraph({ channels: basicChannels() })
    .addNode('plan', () => undefined)
    .addNode('act', () => undefined, { retry: { maxAttempts: 3 } })
    .addNode('nested', child.asNode())
    .addNode('free-router', () => undefined)
    .addNode('sum', () => undefined, { defer: true })
    .setEntry('plan')
    .addConditionalEdges('plan', () => 'go', { go: 'act', skip: 'sum' })
    .addEdge('act', 'nested')
    .addEdge('nested', 'free-router')
    .addConditionalEdges('free-router', () => 'sum')
    .addEdge('sum', END)
    .compile({ name: 'demo' });

  const description = graph.describe();
  assert.equal(description.name, 'demo');
  assert.deepEqual(description.dynamic, ['free-router']);
  assert.equal(description.nodes.find((node) => node.id === 'act')?.retry, true);
  assert.equal(description.nodes.find((node) => node.id === 'sum')?.defer, true);
  assert.equal(description.nodes.find((node) => node.id === 'nested')?.subgraph?.name, 'child');
  assert.ok(description.edges.some((edge) => edge.from === 'plan' && edge.to === 'act' && edge.label === 'go'));

  const mermaid = toMermaid(graph, { highlight: ['act'] });
  assert.match(mermaid, /^flowchart TD/);
  assert.match(mermaid, /__start__ --> n_plan/);
  assert.match(mermaid, /n_plan -\.->\|go\| n_act/);
  assert.match(mermaid, /subgraph n_nested\["nested"\]/);
  assert.match(mermaid, /n_nested_2f_inner/);
  assert.match(mermaid, /n_free_2d_router -\.-> /);
  assert.match(mermaid, /class n_act active/);

  const collapsed = toMermaid(graph, { subgraphs: 'collapse', direction: 'LR' });
  assert.match(collapsed, /^flowchart LR/);
  assert.doesNotMatch(collapsed, /subgraph/);

  assert.deepEqual(toGraphJSON(description), description);
});
