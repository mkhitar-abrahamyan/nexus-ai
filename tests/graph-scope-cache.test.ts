import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCacheAdapter } from '../src/cache/adapters.js';
import { appendList, counter, lastValue } from '../src/graph/channels.js';
import { GraphValidationError } from '../src/graph/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { END, type GraphEvent, type NodeCacheEntry, type NodeOptions } from '../src/types/graph.js';

// ── Input and output channels ──────────────────────────────────────

function scopedGraph() {
  return createGraph({
    channels: { question: lastValue(''), scratch: appendList<string>(), answer: lastValue('') },
    input: ['question'],
    output: ['answer'],
  })
    .addNode('think', ({ state }) => ({ scratch: [`considering ${state.question}`] }))
    .addNode('answer', ({ state }) => ({ answer: `${state.question} -> ${state.scratch.length} notes` }))
    .addEdge('think', 'answer')
    .addEdge('answer', END)
    .setEntry('think')
    .compile();
}

test('a graph with declared channels accepts only its inputs and returns only its outputs', async () => {
  const graph = scopedGraph();
  const result = await graph.invoke({ question: 'why' });

  assert.deepEqual(result.state, { answer: 'why -> 1 notes' });
  // @ts-expect-error scratch is not an output channel, so it is not on the result type either.
  assert.equal(result.state.scratch, undefined);

  // @ts-expect-error scratch is not an input channel.
  await assert.rejects(graph.invoke({ question: 'x', scratch: ['forged'] }), /"scratch" is not an input/);

  // The thread still holds the whole state: checkpoints describe the run, not the answer.
  const checkpoint = await graph.state(result.threadId);
  assert.deepEqual(checkpoint?.state.scratch, ['considering why']);
});

test('createGraph rejects input or output names that are not channels', () => {
  assert.throws(
    () => createGraph({ channels: { a: lastValue(0) }, input: ['b' as 'a'] }),
    (error: unknown) => error instanceof GraphValidationError && /input channel "b"/.test(error.message),
  );
  assert.throws(() => createGraph({ channels: { a: lastValue(0) }, output: ['c' as 'a'] }), /output channel "c"/);
});

test('an empty input list means the graph takes no input at all', async () => {
  const graph = createGraph({ channels: { n: counter() }, input: [] })
    .addNode('tick', () => ({ n: 1 }))
    .setEntry('tick')
    .addEdge('tick', END)
    .compile();
  assert.equal((await graph.invoke()).state.n, 1);
  // @ts-expect-error n is not an input channel.
  await assert.rejects(graph.invoke({ n: 5 }), /accepts no input/);
});

test('as a subgraph, only declared inputs go in and only declared outputs come back', async () => {
  const inner = createGraph({
    channels: { topic: lastValue(''), scratch: appendList<string>(), summary: lastValue('') },
    input: ['topic'],
    output: ['summary'],
  })
    .addNode('draft', ({ state }) => ({ scratch: [`inner saw ${state.scratch.length} parent notes`] }))
    .addNode('finish', ({ state }) => ({ summary: `${state.topic}: ${state.scratch.join('; ')}` }))
    .addEdge('draft', 'finish')
    .addEdge('finish', END)
    .setEntry('draft')
    .compile();

  // The parent has a channel named `scratch` too. Without scoping it would be passed in and the
  // subgraph's working notes would be merged back into it.
  const outer = createGraph({
    channels: { topic: lastValue(''), scratch: appendList<string>(), summary: lastValue('') },
  })
    .addNode('prepare', () => ({ scratch: ['parent note'] }))
    .addNode('summarize', inner.asNode())
    .addEdge('prepare', 'summarize')
    .addEdge('summarize', END)
    .setEntry('prepare')
    .compile();

  const result = await outer.invoke({ topic: 'caching' });
  assert.equal(result.state.summary, 'caching: inner saw 0 parent notes');
  assert.deepEqual(result.state.scratch, ['parent note']);
});

test('describe() reports declared channels and cached nodes', () => {
  const described = createGraph({ channels: { a: lastValue(0), b: lastValue(0) }, input: ['a'], output: ['b'] })
    .addNode('copy', ({ state }) => ({ b: state.a }), { cache: {} })
    .setEntry('copy')
    .addEdge('copy', END)
    .compile()
    .describe();
  assert.deepEqual(described.input, ['a']);
  assert.deepEqual(described.output, ['b']);
  assert.equal(described.nodes[0]?.cache, true);
});

// ── Node caching ───────────────────────────────────────────────────

function cachedGraph(calls: { count: number }, options: NodeOptions = {}) {
  return createGraph({ channels: { query: lastValue(''), result: lastValue(''), hops: counter() } })
    .addNode(
      'lookup',
      ({ state }) => {
        calls.count += 1;
        return { result: `answer for ${state.query}` };
      },
      { cache: {}, ...options },
    )
    .setEntry('lookup')
    .addEdge('lookup', END);
}

test('a cached node runs once for the same state, across threads, and again for a different state', async () => {
  const calls = { count: 0 };
  const graph = cachedGraph(calls).compile();
  const events: GraphEvent[] = [];

  const first = await graph.invoke({ query: 'weather' });
  const second = await graph.invoke({ query: 'weather' }, { onEvent: (event) => events.push(event) });
  await graph.invoke({ query: 'traffic' });

  assert.equal(first.state.result, 'answer for weather');
  assert.equal(second.state.result, 'answer for weather');
  assert.notEqual(first.threadId, second.threadId);
  assert.equal(calls.count, 2);
  const ended = events.find((event) => event.type === 'task_end');
  assert.equal(ended?.type === 'task_end' && ended.cached, true);
  assert.equal(
    events.some((event) => event.type === 'task_start'),
    false,
    'a cache hit does not start the node',
  );
});

test('cached results expire, and a key function can ignore state the node does not read', async () => {
  let now = Date.parse('2026-09-21T00:00:00Z');
  const calls = { count: 0 };
  const graph = createGraph({ channels: { query: lastValue(''), noise: counter(), result: lastValue('') } })
    .addNode(
      'lookup',
      ({ state }) => {
        calls.count += 1;
        return { result: state.query.toUpperCase() };
      },
      { cache: { ttlMs: 1_000, key: ({ state }) => `lookup:${(state as { query: string }).query}` } },
    )
    .setEntry('lookup')
    .addEdge('lookup', END)
    .compile({ now: () => new Date(now) });

  await graph.invoke({ query: 'a', noise: 1 });
  await graph.invoke({ query: 'a', noise: 7 });
  assert.equal(calls.count, 1, 'the key ignores `noise`');

  now += 1_001;
  await graph.invoke({ query: 'a' });
  assert.equal(calls.count, 2, 'an expired entry runs the node again');
});

test('a shared cache adapter reuses results across compiled graphs', async () => {
  const shared = new MemoryCacheAdapter<NodeCacheEntry>();
  const calls = { count: 0 };
  const one = cachedGraph(calls).compile({ cache: shared, name: 'lookup-graph' });
  const two = cachedGraph(calls).compile({ cache: shared, name: 'lookup-graph' });

  await one.invoke({ query: 'q' });
  await two.invoke({ query: 'q' });
  assert.equal(calls.count, 1);

  // A different graph name is a different key space, so two graphs never collide by accident.
  await cachedGraph(calls).compile({ cache: shared, name: 'other' }).invoke({ query: 'q' });
  assert.equal(calls.count, 2);
});

test('failures, interrupt answers, and unkeyable state are never served from the cache', async () => {
  let failures = 0;
  const flaky = createGraph({ channels: { value: lastValue(0) } })
    .addNode(
      'flaky',
      () => {
        failures += 1;
        if (failures === 1) throw new Error('first attempt fails');
        return { value: failures };
      },
      { cache: {} },
    )
    .setEntry('flaky')
    .addEdge('flaky', END)
    .compile();
  await assert.rejects(flaky.invoke(), /first attempt fails/);
  assert.equal((await flaky.invoke()).state.value, 2, 'the failure was not cached');

  let asked = 0;
  const approval = createGraph({ channels: { approved: lastValue(false) } })
    .addNode(
      'ask',
      ({ interrupt }) => {
        asked += 1;
        return { approved: interrupt<boolean>({ reason: 'approve?' }) };
      },
      { cache: {} },
    )
    .setEntry('ask')
    .addEdge('ask', END)
    .compile();
  const paused = await approval.invoke();
  await approval.resumeWith(paused.threadId, true);
  const again = await approval.invoke();
  assert.equal(again.status, 'awaiting_input', 'a second thread is still asked, not answered from the cache');

  let mapped = 0;
  const unkeyable = createGraph({ channels: { index: lastValue(new Map<string, number>()) } })
    .addNode(
      'read',
      () => {
        mapped += 1;
        return {};
      },
      { cache: {} },
    )
    .setEntry('read')
    .addEdge('read', END)
    .compile();
  await unkeyable.invoke({ index: new Map([['a', 1]]) });
  await unkeyable.invoke({ index: new Map([['a', 2]]) });
  assert.equal(mapped, 2, 'a Map would hash like {} and share a key, so the default key refuses it');
  assert.ok(asked >= 3);
});

test('a cache that throws is treated as a miss, never as a failed node', async () => {
  const broken = {
    get() {
      throw new Error('cache down');
    },
    set() {
      throw new Error('cache down');
    },
  };
  const calls = { count: 0 };
  const graph = cachedGraph(calls, { cache: { store: broken } }).compile();
  assert.equal((await graph.invoke({ query: 'x' })).status, 'completed');
  assert.equal((await graph.invoke({ query: 'x' })).status, 'completed');
  assert.equal(calls.count, 2);
});
