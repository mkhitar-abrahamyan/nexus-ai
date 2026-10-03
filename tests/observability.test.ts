import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { LLMJudge } from '../src/evals/judge.js';
import { createDataset } from '../src/evaluate/datasets.js';
import { withProvenance } from '../src/evaluate/provenance.js';
import { evaluate } from '../src/evaluate/run.js';
import { appendList, counter, lastValue } from '../src/graph/channels.js';
import { GraphStreamOverflowError } from '../src/graph/event-stream.js';
import { createGraph } from '../src/graph/graph.js';
import { OperationRunner } from '../src/operations/runner.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { recordingFetch, replayFetch } from '../src/testing/record.js';
import { OtlpTraceExporter, type OtlpSpan, runToOtlpSpan } from '../src/tracing/otlp.js';
import { MemoryRollupStore, rollupPercentile, rollupTraceStore, sumRollups } from '../src/tracing/rollups.js';
import { closeAbandonedRuns, JsonlTraceStore, MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import { END, type GraphStreamEvent } from '../src/types/graph.js';
import type { NexusResponse, StreamChunk } from '../src/types/response.js';
import type { Run, TraceStore } from '../src/types/tracing.js';
import { NEXUS_VERSION } from '../src/version.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-observe-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ── Crash-safe traces ──────────────────────────────────────────────

test('an incremental trace survives the process that wrote it, with every run that finished', async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'runs.jsonl');
    // The first process runs a long agent and dies near the end: its root never finishes.
    const tracer = new Tracer({ store: new JsonlTraceStore({ file }), incremental: true });
    const root = tracer.startRun({ name: 'nightly-report', kind: 'agent' });
    for (let step = 0; step < 14; step += 1) {
      const node = root.child({ name: `step-${step}`, kind: 'node' });
      const model = node.child({ name: 'model', kind: 'model', model: 'claude-sonnet-5-5' });
      await model.finish({ outputs: `minute ${step}`, usage: { inputTokens: 100, outputTokens: 20 }, cost: 0.01 });
      await node.finish({ outputs: step });
    }
    // Step 14 is in flight when the process dies.
    root.child({ name: 'step-14', kind: 'node' });
    await tracer.flush();

    // A second process reads the same file.
    const store = new JsonlTraceStore({ file });
    const tree = await store.tree(root.traceId);
    assert.ok(tree, 'the trace is there');
    assert.equal(tree.status, 'running', 'its root never finished');
    assert.equal(tree.children.filter((child) => child.status === 'ok').length, 14, 'every finished step is kept');
    assert.equal(tree.children[0]?.children[0]?.cost, 0.01);

    const closed = await closeAbandonedRuns(store, {
      olderThanMs: 60_000,
      now: () => new Date(Date.now() + 3_600_000),
    });
    assert.equal(closed, 2, 'the root and the step in flight');
    const after = await store.tree(root.traceId);
    assert.equal(after?.status, 'error');
    assert.equal(after?.error?.name, 'RunAbandoned');
    assert.equal(after?.metadata?.abandoned, true);
  });
});

test('an incremental tracer writes a run before its end, in order, and still tail-samples errors', async () => {
  const saves: string[] = [];
  const memory = new MemoryTraceStore();
  const slow: TraceStore = {
    async save(run) {
      await sleep(run.status === 'running' ? 10 : 0);
      saves.push(`${run.name}:${run.status}`);
      memory.save(run);
    },
    get: (id) => memory.get(id),
    query: (query) => memory.query(query),
    tree: (id) => memory.tree(id),
  };
  const tracer = new Tracer({ store: slow, incremental: true });
  const run = tracer.startRun({ name: 'quick' });
  await run.finish();
  assert.deepEqual(saves, ['quick:running', 'quick:ok'], 'a slow start write still lands before the end');

  const sampled = new MemoryTraceStore();
  const sampler = new Tracer({ store: sampled, incremental: true, sampling: { rate: 0, keepErrors: true } });
  await sampler.startRun({ name: 'fine' }).finish();
  const failing = sampler.startRun({ name: 'broken' });
  await failing.child({ name: 'tool', kind: 'tool' }).finish({ error: new Error('timeout') });
  assert.equal(sampled.size(), 0, 'an unsampled trace waits for its root');
  await failing.finish();
  assert.deepEqual(
    sampled
      .query()
      .map((item) => item.name)
      .sort(),
    ['broken', 'tool'],
    'the failing trace is kept whole, the fine one is not',
  );
});

// ── OpenTelemetry ──────────────────────────────────────────────────

test('runs reach an OTLP collector as GenAI spans, with one trace across a server and a worker', async () => {
  const received: OtlpSpan[] = [];
  const resources: unknown[] = [];
  const collector = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      assert.equal(request.url, '/v1/traces');
      const payload = JSON.parse(body) as {
        resourceSpans: Array<{ resource: unknown; scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
      };
      for (const resource of payload.resourceSpans) {
        resources.push(resource.resource);
        for (const scope of resource.scopeSpans) received.push(...scope.spans);
      }
      response.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
  try {
    const exporter = (service: string) => new OtlpTraceExporter({ endpoint, serviceName: service, maxBatch: 10 });
    const serverExporter = exporter('agent-server');
    const workerExporter = exporter('worker');
    const server = new Tracer({ store: new MemoryTraceStore(), exporters: [serverExporter] });
    const worker = new Tracer({ store: new MemoryTraceStore(), exporters: [workerExporter] });
    const runner = new OperationRunner<string>({ store: new MemoryOperationStore() });

    // The server accepts a request and queues the work, handing the trace along in traceContext.
    const request = server.startRun({ name: 'POST /runs', kind: 'chain' });
    const handle = await runner.submit(
      async (context) => {
        const job = worker.startRun({
          name: 'summarize',
          kind: 'agent',
          traceparent: context.traceContext?.traceparent,
        });
        const call = job.child({
          name: 'model',
          kind: 'model',
          model: 'gpt-6-luna',
          provider: 'openai',
          metadata: { requestedModel: 'openai/fast' },
        });
        await call.finish({ usage: { inputTokens: 1200, outputTokens: 80 }, cost: 0.0002 });
        await job.finish({ outputs: 'done' });
        return 'done';
      },
      { traceContext: { traceparent: request.traceparent() } },
    );
    await handle.result();
    await request.finish();
    await server.flush();
    await worker.flush();

    assert.equal(received.length, 3);
    assert.equal(new Set(received.map((span) => span.traceId)).size, 1, 'one trace across both processes');
    const root = received.find((span) => span.name === 'POST /runs') as OtlpSpan;
    const agent = received.find((span) => span.name === 'invoke_agent summarize') as OtlpSpan;
    const model = received.find((span) => span.name === 'chat gpt-6-luna') as OtlpSpan;
    assert.equal(agent.parentSpanId, root.spanId, "the worker's run hangs from the server's");
    assert.equal(model.parentSpanId, agent.spanId);
    assert.equal(model.kind, 3, 'a model call is a client span');
    const attributes = Object.fromEntries(model.attributes.map((item) => [item.key, Object.values(item.value)[0]]));
    assert.equal(attributes['gen_ai.operation.name'], 'chat');
    assert.equal(attributes['gen_ai.provider.name'], 'openai');
    assert.equal(attributes['gen_ai.request.model'], 'openai/fast');
    assert.equal(attributes['gen_ai.response.model'], 'gpt-6-luna');
    assert.equal(attributes['gen_ai.usage.input_tokens'], '1200');
    assert.equal(attributes['gen_ai.usage.output_tokens'], '80');
    assert.equal(attributes['nexus.cost.usd'], 0.0002);
    assert.match(root.traceId, /^[0-9a-f]{32}$/);
    assert.ok(resources.length >= 2, 'each process names its own service');
  } finally {
    collector.close();
  }
});

test('a failed run is an error span, and a graph node keeps its step', () => {
  const span = runToOtlpSpan({
    id: 'run-00000000000000aa',
    traceId: 'trace-00000000000000bb',
    name: 'charge',
    kind: 'node',
    status: 'error',
    startedAt: '2026-10-04T10:00:00.000Z',
    endedAt: '2026-10-04T10:00:01.500Z',
    error: { name: 'TimeoutError', message: 'card network timed out' },
    metadata: { step: 3 },
  });
  assert.deepEqual(span.status, { code: 2, message: 'card network timed out' });
  assert.equal(span.endTimeUnixNano, '1791108001500000000');
  const attributes = Object.fromEntries(span.attributes.map((item) => [item.key, Object.values(item.value)[0]]));
  assert.equal(attributes['error.type'], 'TimeoutError');
  assert.equal(attributes['nexus.graph.node'], 'charge');
  assert.equal(attributes['nexus.graph.step'], '3');
});

// ── The event stream ───────────────────────────────────────────────

/** A model that streams its answer, or asks for a tool on its first turn. */
function streamingClient() {
  let turns = 0;
  const response = (content: string, toolCalls?: NexusResponse['toolCalls']): NexusResponse => ({
    content,
    role: 'assistant',
    ...(toolCalls ? { toolCalls } : {}),
    finishReason: toolCalls ? 'tool_calls' : 'stop',
    meta: {
      requestId: 'r',
      providerUsed: 'mock',
      modelUsed: 'mock',
      latencyMs: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensSaved: 0,
      cacheHit: false,
      guardrailsApplied: [],
    },
  });
  return {
    complete: async () => response('unused'),
    async *stream(): AsyncIterable<StreamChunk> {
      turns += 1;
      if (turns === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Yerevan"}' } },
        };
        yield { type: 'done', meta: response('').meta };
        return;
      }
      for (const word of ['It ', 'is ', 'sunny.']) yield { type: 'text', content: word };
      yield { type: 'done', meta: response('').meta };
    },
  };
}

test('an agent streams its tokens and tool calls onto the event stream, with no wiring in its nodes', async () => {
  const agent = createAgent({
    client: streamingClient(),
    streamTokens: true,
    tools: [
      {
        name: 'weather',
        description: 'Weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        execute: async (args: Record<string, unknown>) => ({ city: args.city, sky: 'clear' }),
      },
    ],
  });

  const stream = agent.events(agentInput('Weather in Yerevan?'), { include: ['messages', 'tools', 'values'] });
  const tokens = stream.messages();
  const tools = stream.tools();
  const everything: Array<GraphStreamEvent['type']> = [];
  const read = async () => {
    for await (const event of stream) everything.push(event.type);
  };
  const collectTokens = async () => {
    const text: string[] = [];
    for await (const event of tokens) text.push(event.chunk.content);
    return text;
  };
  const collectTools = async () => {
    const phases: string[] = [];
    for await (const event of tools) phases.push(`${event.tool.name}:${event.tool.phase}`);
    return phases;
  };
  const [, text, phases] = await Promise.all([read(), collectTokens(), collectTools()]);

  assert.deepEqual(text, ['It ', 'is ', 'sunny.']);
  assert.deepEqual(phases, ['weather:start', 'weather:result']);
  assert.ok(everything.includes('values'));
  const result = await stream.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.state.answer, 'It is sunny.');
});

test('a subgraph streams through its parent under a namespace, only when asked', async () => {
  const child = createGraph({ channels: { notes: appendList<string>() } })
    .addNode('draft', ({ message }) => {
      message({ content: 'drafting' });
      return { notes: ['drafted'] };
    })
    .setEntry('draft')
    .addEdge('draft', END)
    .compile({ checkpointer: false });
  const parent = createGraph({ channels: { notes: appendList<string>() } })
    .addNode('review', child.asNode())
    .setEntry('review')
    .addEdge('review', END)
    .compile({ checkpointer: false });

  const quiet: GraphStreamEvent[] = [];
  for await (const event of parent.events({}, { include: ['messages'] })) quiet.push(event);
  assert.deepEqual(quiet, [], "a subgraph's events stay inside it by default");

  const nested: GraphStreamEvent[] = [];
  for await (const event of parent.events({}, { include: ['messages'], subgraphs: true })) nested.push(event);
  assert.equal(nested.length, 1);
  assert.deepEqual(nested[0]?.namespace, ['review']);
});

// ── Backpressure ───────────────────────────────────────────────────

/** A node that streams `count` chunks as fast as it can, in one superstep. */
function chatty(count: number) {
  return createGraph({ channels: { done: lastValue(false) } })
    .addNode('talk', ({ message }) => {
      for (let index = 0; index < count; index += 1) message({ content: 'x' });
      return { done: true };
    })
    .setEntry('talk')
    .addEdge('talk', END)
    .compile({ checkpointer: false });
}

/** Reads a stream a hundred times slower than it is written, by yielding to the event loop per event. */
async function slowly(stream: AsyncIterable<GraphStreamEvent>): Promise<GraphStreamEvent[]> {
  const read: GraphStreamEvent[] = [];
  for await (const event of stream) {
    read.push(event);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return read;
}

test('a slow reader holds a bounded buffer under every overflow policy', async () => {
  const chunks = 100_000;

  const coalesced = chatty(chunks).events({}, { include: ['messages'], maxBuffered: 100 });
  const read = await slowly(coalesced);
  const stats = coalesced.streamStats();
  assert.ok(stats.peak <= 100, `peak ${stats.peak}`);
  assert.ok(stats.coalesced > 0);
  const text = read.map((event) => (event.type === 'messages' ? event.chunk.content : '')).join('');
  assert.equal(text.length, chunks, 'coalescing merges chunks without losing any text');

  const dropping = chatty(chunks).events({}, { include: ['messages'], maxBuffered: 100, overflow: 'drop-oldest' });
  await slowly(dropping);
  assert.ok(dropping.streamStats().peak <= 100);
  assert.ok(dropping.streamStats().dropped > 0, 'and drop-oldest counts what it lost');

  const strict = chatty(chunks).events({}, { include: ['messages'], maxBuffered: 100, overflow: 'error' });
  await assert.rejects(() => slowly(strict), GraphStreamOverflowError);
  await assert.rejects(() => strict.result, GraphStreamOverflowError);
});

test('between supersteps the run waits for its slowest reader', async () => {
  let started = 0;
  const graph = createGraph({ channels: { n: counter() } });
  for (let index = 0; index < 20; index += 1) {
    graph.addNode(`s${index}`, ({ message }) => {
      started = index;
      for (let chunk = 0; chunk < 50; chunk += 1) message({ content: `${index}`, messageId: String(chunk) });
      return { n: 1 };
    });
  }
  graph.setEntry('s0');
  for (let index = 0; index < 19; index += 1) graph.addEdge(`s${index}`, `s${index + 1}`);
  graph.addEdge('s19', END);
  const stream = graph.compile({ checkpointer: false }).events({}, { include: ['values'], maxBuffered: 4 });

  let lead = 0;
  for await (const event of stream) {
    if (event.type !== 'values') continue;
    lead = Math.max(lead, started - event.step);
    await sleep(2);
  }
  assert.ok(lead <= 3, `the graph ran at most a few steps ahead of its reader, not ${lead}`);
  assert.equal((await stream.result).state.n, 20);
});

// ── Rollups ────────────────────────────────────────────────────────

test('rollups count each finished run once, by hour, with percentiles', async () => {
  const rollups = new MemoryRollupStore();
  const store = rollupTraceStore(new MemoryTraceStore(), rollups);
  const tracer = new Tracer({ store, incremental: true });
  for (let index = 0; index < 50; index += 1) {
    const run = tracer.startRun({ name: 'answer', kind: 'model', model: 'gpt-6-luna', provider: 'openai' });
    await run.finish({
      cost: 0.01,
      usage: { inputTokens: 10, outputTokens: 5 },
      ...(index % 10 === 0 ? { error: new Error('x') } : {}),
    });
  }
  await tracer.recordFeedback((await store.query({ limit: 1 }))[0]?.id as string, { key: 'helpful', score: 1 });

  const total = sumRollups(await rollups.query());
  assert.equal(total.runs, 50, 'a run started, finished, and given feedback is one run');
  assert.equal(total.errors, 5);
  assert.ok(Math.abs(total.cost - 0.5) < 1e-9);
  assert.equal(total.inputTokens, 500);
  assert.equal(rollupPercentile(total.latency, 0.95), 10, 'every run took under 10 ms');
});

test('a million runs roll up into a few hundred rows', async () => {
  const rollups = new MemoryRollupStore();
  const discard: TraceStore = { save() {}, get: () => undefined, query: () => [], tree: () => undefined };
  const store = rollupTraceStore(discard, rollups);
  const start = Date.parse('2026-09-04T00:00:00.000Z');
  const models = ['gpt-6-luna', 'claude-sonnet-5-5', 'gemini-3.8-flash'];
  for (let index = 0; index < 1_000_000; index += 1) {
    const at = new Date(start + (index % 720) * 3_600_000 + (index % 1000)).toISOString();
    const run: Run = {
      id: `run-${index}`,
      traceId: `trace-${index}`,
      name: 'answer',
      kind: 'model',
      status: 'ok',
      startedAt: at,
      latencyMs: 400,
      cost: 0.001,
      model: models[index % 3],
    };
    await store.save(run);
  }
  assert.ok(rollups.size() <= 720 * 3, `${rollups.size()} rows`);
  const started = performance.now();
  const rows = await rollups.query({ since: '2026-09-28T00:00:00.000Z' });
  const total = sumRollups(rows);
  assert.ok(performance.now() - started < 100, 'a week of a million-run month reads in well under 100 ms');
  assert.ok(total.runs >= 199_000 && total.runs <= 201_000, `${total.runs} runs in the last six days`);
});

// ── Timed replay ───────────────────────────────────────────────────

test('a stream recorded with timing replays at its pace, scaled, stepped, or at once', async () => {
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const word of ['one', 'two', 'three']) {
      response.write(`data: ${word}\n\n`);
      await sleep(60);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;
  await withDirectory(async (directory) => {
    try {
      const record = recordingFetch({ directory, timing: true });
      await (await record(url)).text();
      await record.flush();
    } finally {
      server.close();
    }

    const read = async (pace: Parameters<typeof replayFetch>[0]['pace']) => {
      const started = performance.now();
      const body = (await replayFetch({ directory, pace })(url)).body as ReadableStream<Uint8Array>;
      const parts: string[] = [];
      for await (const part of body) parts.push(new TextDecoder().decode(part));
      return { parts, ms: performance.now() - started };
    };

    const instant = await read('instant');
    assert.equal(instant.parts.join(''), 'data: one\n\ndata: two\n\ndata: three\n\n');
    const original = await read('original');
    assert.equal(original.parts.join(''), instant.parts.join(''));
    assert.ok(original.ms >= 90, `the original gaps are kept: ${Math.round(original.ms)} ms`);
    const fast = await read(0.1);
    assert.ok(fast.ms < original.ms, 'a scale of 0.1 is faster');

    const released: number[] = [];
    const stepped = await read(async ({ index, count }) => {
      released.push(index);
      assert.ok(count >= 3);
    });
    assert.deepEqual(released, [...released.keys()], 'a pacing function releases each chunk in order');
    assert.equal(stepped.parts.join(''), instant.parts.join(''));
  });
});

// ── Evaluator provenance ───────────────────────────────────────────

test('an experiment records which evaluator, judge, and framework produced each score', async () => {
  const dataset = createDataset({
    name: 'answers',
    examples: [
      { id: 'a', inputs: 'capital of Armenia?', expected: 'Yerevan' },
      { id: 'b', inputs: 'capital of France?', expected: 'Paris' },
    ],
  });
  const judge = new LLMJudge({
    model: 'claude-sonnet-5-5',
    rubric: 'Names the right city.',
    client: {
      complete: async () =>
        ({ content: '{"score":1,"passed":true,"rationale":"correct"}' }) as unknown as NexusResponse,
    },
  });
  const exact = withProvenance(
    ({ output, example }) => ({ key: 'exact', score: output === example.expected ? 1 : 0 }),
    { name: 'exact-city', version: '2' },
  );
  const experiment = await evaluate(
    async (question) => (String(question).includes('Armenia') ? 'Yerevan' : 'Paris'),
    dataset,
    [
      exact,
      judge.asEvaluator({ key: 'correct' }),
      function lengthCheck() {
        return { key: 'short', score: 1 };
      },
    ],
  );

  assert.deepEqual(experiment.framework, { name: 'nexus-ai-pro', version: NEXUS_VERSION });
  const [first, second, third] = experiment.evaluators ?? [];
  assert.deepEqual(first, { name: 'exact-city', version: '2', position: 0, keys: ['exact'] });
  assert.equal(second?.name, 'correct');
  assert.equal(second?.judge?.model, 'claude-sonnet-5-5');
  assert.equal(second?.judge?.temperature, 0);
  assert.match(second?.judge?.promptVersion ?? '', /^[0-9a-f]{12}$/);
  assert.equal(second?.rubric, 'Names the right city.');
  assert.deepEqual(second?.keys, ['correct']);
  assert.deepEqual(third, { position: 2, name: 'lengthCheck', keys: ['short'] });
  assert.ok(experiment.metrics.some((metric) => metric.key === 'correct'));
});
