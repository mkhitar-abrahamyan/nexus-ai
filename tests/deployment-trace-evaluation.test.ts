/**
 * A deployment's evaluation, read from the trace and run through the online-evaluation worker.
 *
 * The proof: a server that traces its runs, an assistant that retrieves, calls a tool and a model,
 * and is sent a photo; its evaluators see the run's input, the tool call, the documents retrieved,
 * the model call, and the photo, not just the answer. Two replicas evaluating at once over one
 * operation store score each run once. A worker scores runs as they finish; an assistant tracing
 * itself is found by its run id; and what a trace holds is read into evidence, each medium once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaParts, traceEvidence } from '../src/evaluate/trace.js';
import { AnnotationQueue } from '../src/evaluate/review.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { functionAssistant } from '../src/server/assistant.js';
import { Deployments } from '../src/server/deployments.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import { traceModelClient, traceRetriever } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { EvaluationContext } from '../src/types/evaluate.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import type { RunRecord, ServerAssistant } from '../src/types/server.js';
import type { RunTree } from '../src/types/tracing.js';

const photo = { type: 'image' as const, source: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mimeType: 'image/png' } };

/** A support assistant: retrieves the policy, looks the order up with a tool, and asks a model. */
function support(tracer: Tracer): ServerAssistant {
  const model = traceModelClient(
    {
      async complete(request: CompletionRequest): Promise<NexusResponse> {
        const asked = JSON.stringify(request.messages);
        const day = /ships (\w+)/.exec(asked)?.[1] ?? 'never';
        return { content: `Order ships ${day}.`, meta: { modelUsed: 'answer-model', providerUsed: 'mock' } } as never;
      },
    },
    tracer,
  );
  const policies = traceRetriever(
    {
      async retrieve(query: string, _options?: { topK?: number }) {
        return [{ id: 'policy-3', content: `Orders ship within two days (${query}).`, score: 0.92 }];
      },
      describe: () => 'policies',
    },
    tracer,
  );
  return functionAssistant(async (input) => {
    const { orderId, question } = input as { orderId: string; question: string; photo: unknown };
    const documents = await policies.retrieve(question, { topK: 1 });
    const order = await tracer.trace({ name: 'lookup_order', kind: 'tool', inputs: { orderId } }, async () => ({
      orderId,
      ships: orderId.endsWith('7') ? 'Tuesday' : 'Friday',
    }));
    const response = await model.complete({
      model: 'answer-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: question }, (input as { photo: never }).photo] },
        { role: 'user', content: `Order ${order.orderId} ships ${order.ships}. ${documents.length} policy found.` },
      ],
    });
    return { answer: response.content };
  });
}

async function finished(state: MemoryServerStore, count: number): Promise<RunRecord[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const runs = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 10_000 });
    if (runs.length >= count && runs.every((run) => run.status === 'succeeded' || run.status === 'failed')) {
      return runs;
    }
    if (Date.now() > deadline) throw new Error('the runs did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function serve(
  options: { traced?: boolean; assistant?: (tracer: Tracer) => ServerAssistant; store?: MemoryTraceStore } = {},
) {
  const state = new MemoryServerStore();
  const store = options.store ?? new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: { support: deployments.assistant('support', { v1: (options.assistant ?? support)(tracer) }) },
    state,
    ...(options.traced === false ? {} : { tracer }),
  });
  const start = async (from: number, count: number) => {
    for (let index = from; index < from + count; index += 1) {
      await app.runs.start({
        assistant: 'support',
        input: { orderId: `order-${index}`, question: `When does order-${index} ship?`, photo },
      });
    }
  };
  return { state, store, tracer, deployments, app, start };
}

test('proof: a deployment’s evaluators judge each run by its trace: input, tool call, documents, model call, and media', async () => {
  const { state, store, deployments, start } = await serve();
  await start(0, 10);
  const runs = await finished(state, 10);
  assert.ok(
    runs.every((run) => run.traceId),
    'every run records its trace',
  );

  const seen: EvaluationContext[] = [];
  // Grounded: the answer says the day the tool returned, for the order the run was asked about,
  // and rests on a retrieved policy.
  const grounded = (context: EvaluationContext) => {
    seen.push(context);
    const trace = context.trace;
    const asked = (context.example.inputs as { orderId?: string } | undefined)?.orderId;
    const tool = trace?.toolCalls.find((call) => call.name === 'lookup_order');
    const day = (tool?.outputs as { ships?: string } | undefined)?.ships;
    const ok =
      asked !== undefined &&
      (tool?.inputs as { orderId?: string } | undefined)?.orderId === asked &&
      (context.output as { answer: string }).answer === `Order ships ${day}.` &&
      (trace?.retrievals[0]?.documents.length ?? 0) > 0;
    return { key: 'grounded', score: ok ? 1 : 0 };
  };
  const report = await deployments.evaluate('support', { evaluators: [grounded], traces: store });
  assert.deepEqual([report.evaluated, report.skipped, report.failed], [10, 0, 0]);
  assert.ok(
    report.scores.every((score) => score.score === 1),
    'every answer is grounded in its tool call and its documents',
  );

  const context = seen.find((item) => (item.example.inputs as { orderId: string }).orderId === 'order-7');
  assert.ok(context?.trace, 'the evaluator was given the trace');
  const trace = context.trace;
  assert.deepEqual(context.example.inputs, {
    orderId: 'order-7',
    question: 'When does order-7 ship?',
    photo,
  });
  assert.deepEqual(
    trace.toolCalls.map((call) => [call.name, call.inputs, call.outputs]),
    [['lookup_order', { orderId: 'order-7' }, { orderId: 'order-7', ships: 'Tuesday' }]],
  );
  assert.deepEqual(trace.retrievals, [
    {
      runId: trace.retrievals[0]?.runId,
      query: 'When does order-7 ship?',
      documents: [{ id: 'policy-3', content: 'Orders ship within two days (When does order-7 ship?).', score: 0.92 }],
    },
  ]);
  assert.deepEqual(
    trace.modelCalls.map((call) => [call.model, call.provider]),
    [['answer-model', 'mock']],
  );
  assert.deepEqual(
    trace.media.map((item) => [item.part, item.direction, item.kind]),
    [[photo, 'input', 'agent']],
    'the photo once, though the model call carried it too',
  );
  assert.equal(trace.root.name, 'support');
  assert.deepEqual(trace.outputs, { answer: 'Order ships Tuesday.' });

  // Each score is the run's feedback, so a canary guard compares it between revisions.
  const record = state.get<RunRecord>(RUNS_NAMESPACE, (context.example as { id: string }).id);
  assert.deepEqual(
    record?.feedback?.map((item) => [item.key, item.score, item.source]),
    [['grounded', 1, 'online-evaluation']],
  );
  // Called again, nothing is scored twice.
  const again = await deployments.evaluate('support', { evaluators: [grounded], traces: store });
  assert.deepEqual([again.evaluated, again.skipped], [0, 10]);

  // The gap this closes: without the traces, an evaluator sees the output alone.
  const blind: EvaluationContext[] = [];
  await deployments.evaluate('support', {
    evaluators: [
      (item) => {
        blind.push(item);
        return 1;
      },
    ],
    source: 'blind',
  });
  assert.equal(blind.length, 10);
  assert.ok(
    blind.every((item) => item.trace === undefined && item.example.inputs === undefined),
    'no trace, no input',
  );
});

test('two replicas evaluating at once over one operation store score each run once', async () => {
  const { state, deployments, start } = await serve({ traced: false });
  await start(0, 40);
  await finished(state, 40);
  const other = new Deployments({ state });
  const scoring = async (operations: () => MemoryOperationStore | undefined, source: string) => {
    const calls = new Map<string, number>();
    const slow = async (context: EvaluationContext) => {
      calls.set(context.example.id, (calls.get(context.example.id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { key: 'quality', score: 1 };
    };
    const reports = await Promise.all(
      [deployments, other].map((replica) => {
        const store = operations();
        return replica.evaluate('support', {
          evaluators: [slow],
          source,
          ...(store ? { operations: store } : {}),
        });
      }),
    );
    const feedback = state
      .list<RunRecord>(RUNS_NAMESPACE, { limit: 100 })
      .map((run) => run.feedback?.filter((item) => item.source === source).length ?? 0);
    return { calls, reports, feedback };
  };

  const shared = new MemoryOperationStore();
  const once = await scoring(() => shared, 'shared');
  assert.equal(once.calls.size, 40);
  assert.ok(
    [...once.calls.values()].every((count) => count === 1),
    'each run judged once',
  );
  assert.ok(
    once.feedback.every((count) => count === 1),
    'and scored once',
  );
  assert.equal((once.reports[0]?.evaluated ?? 0) + (once.reports[1]?.evaluated ?? 0), 40);

  // The control: each replica on a queue of its own judges the same runs twice.
  const apart = await scoring(() => new MemoryOperationStore(), 'apart');
  assert.ok(
    [...apart.calls.values()].some((count) => count > 1),
    'without a shared queue, runs are judged twice',
  );
});

test('an evaluation worker scores a deployment’s runs as they finish, and hears each score once', async () => {
  const { state, store, deployments, start } = await serve();
  const heard: Array<[string, number]> = [];
  const review = new AnnotationQueue({ rubric: [{ key: 'helpful', prompt: 'Was it helpful?', type: 'score' }] });
  const worker = deployments.evaluationWorker('support', {
    evaluators: [(context) => ({ key: 'has-tool', score: context.trace?.toolCalls.length ?? 0 })],
    operations: new MemoryOperationStore(),
    traces: store,
    concurrency: 3,
    onScored: ({ run, scores }) => {
      heard.push([run.id, scores[0]?.score ?? -1]);
    },
    // Order 3's answer goes to people too, who see what it was asked.
    reviewQueue: review,
    reviewWhen: (_scores, run) => (run.inputs as { orderId?: string } | undefined)?.orderId === 'order-3',
  });
  await start(0, 5);
  await finished(state, 5);
  assert.equal((await worker.drain()).scored, 5);
  await start(5, 7);
  await finished(state, 12);
  // New runs reach a worker within the deployment's read cache, kept by the wall clock, which a timer
  // does not run on: a virtual machine's, stepped back as it syncs with its host, can fall behind it.
  const cachedUntil = Date.now() + 2_100;
  while (Date.now() <= cachedUntil) await new Promise((resolve) => setTimeout(resolve, 20));
  const report = await worker.drain();
  assert.deepEqual([report.scored, report.failed], [12, 0]);
  assert.equal(heard.length, 12);
  assert.equal(new Set(heard.map(([id]) => id)).size, 12, 'each run once');
  assert.ok(
    heard.every(([, score]) => score === 1),
    'each saw its tool call',
  );
  const [item] = review.list();
  assert.deepEqual(
    [review.list().length, (item?.subject.inputs as { orderId?: string } | undefined)?.orderId, item?.subject.output],
    [1, 'order-3', { answer: 'Order ships Friday.' }],
    'a reviewer sees the input beside the answer',
  );
});

test('an assistant that traces itself is found by its run id', async () => {
  const { state, store, deployments, start } = await serve({
    traced: false,
    assistant: (tracer) =>
      functionAssistant((input, context) =>
        tracer.trace(
          { name: 'self-traced', kind: 'agent', inputs: input, metadata: { nexus: { run: context.runId } } },
          () => tracer.trace({ name: 'search', kind: 'tool', inputs: { q: 'x' } }, () => ['hit']),
        ),
      ),
  });
  await start(0, 3);
  const runs = await finished(state, 3);
  assert.ok(
    runs.every((run) => run.traceId === undefined),
    'the server traced nothing',
  );
  const seen: EvaluationContext[] = [];
  const record = (context: EvaluationContext) => {
    seen.push(context);
    return 1;
  };
  await deployments.evaluate('support', { evaluators: [record], traces: store });
  assert.equal(seen.length, 3);
  assert.ok(
    seen.every(
      (context) =>
        context.trace?.root.name === 'self-traced' &&
        context.trace.toolCalls[0]?.name === 'search' &&
        (context.example.inputs as { orderId?: string }).orderId?.startsWith('order-'),
    ),
    'each run found by its id, with its trace and its input',
  );
});

test('a server with a tracer makes each run the root of its trace, failures and all', async () => {
  // A slow store: a run that reads as finished still has its whole trace written.
  const slow = new MemoryTraceStore();
  const save = slow.save.bind(slow);
  (slow as { save: unknown }).save = async (run: Parameters<typeof save>[0]) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    save(run);
  };
  const { state, store, start } = await serve({
    store: slow,
    assistant: (tracer) =>
      functionAssistant(async (input) => {
        const { orderId } = input as { orderId: string };
        await tracer.trace({ name: 'step', kind: 'tool', inputs: { orderId } }, () => 'done');
        if (orderId === 'order-1') throw new Error('the order is locked');
        return { ok: orderId };
      }),
  });
  // One run alone first, so nothing else it waits for gives its trace time to land.
  await start(0, 1);
  const [first] = await finished(state, 1);
  assert.ok(store.tree(first?.traceId as string), 'its trace is written by the time it reads as finished');
  await start(1, 1);
  const runs = await finished(state, 2);
  for (const run of runs) {
    const tree = store.tree(run.traceId as string) as RunTree;
    assert.ok(tree, `${run.status}: its trace is written by the time it reads as finished`);
    assert.equal(tree.name, 'support');
    assert.equal(tree.kind, 'agent');
    assert.equal((tree.inputs as { orderId: string }).orderId, (run.output as { ok?: string })?.ok ?? 'order-1');
    assert.deepEqual(tree.metadata?.nexus, { run: run.id, assistant: 'support', attempt: 1, revision: 'v1' });
    assert.equal(tree.children[0]?.name, 'step', 'what the assistant traced hangs beneath the run');
    if (run.status === 'failed') {
      assert.equal(tree.status, 'error');
      assert.equal(tree.error?.message, 'the order is locked');
    } else {
      assert.deepEqual(tree.outputs, { ok: 'order-0' });
    }
  }
});

test('Tracer.within() puts a run in scope without finishing it', async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const root = tracer.startRun({ name: 'root' });
  await tracer.within(root, () => tracer.trace({ name: 'inside' }, () => 1));
  await tracer.trace({ name: 'outside' }, () => 2);
  await root.finish();
  const tree = store.tree(root.traceId);
  assert.deepEqual(
    tree?.children.map((child) => child.name),
    ['inside'],
  );
  assert.equal(store.query({ name: 'outside' })[0]?.traceId === root.traceId, false);
});

test('a trace is read into evidence: each medium once, assets from operations, documents in any shape', () => {
  const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const generated = {
    location: { kind: 'stored', uri: 'memory://a1', assetId: 'a1' },
    mimeType: 'image/png',
    provenance: { provider: 'mock', operation: 'generate', requestId: 'r1' },
  };
  const at = '2026-10-18T12:00:00.000Z';
  const node = (fields: Partial<RunTree> & Pick<RunTree, 'id' | 'name' | 'kind'>): RunTree => ({
    traceId: 't',
    status: 'ok',
    startedAt: at,
    children: [],
    ...fields,
  });
  const tree = node({
    id: 'root',
    name: 'designer',
    kind: 'agent',
    inputs: { brief: 'a poster', reference: { type: 'image', source: { buffer: pixels, mimeType: 'image/png' } } },
    outputs: { images: [generated] },
    children: [
      node({
        id: 'r',
        name: 'retrieve',
        kind: 'retriever',
        inputs: 'poster styles',
        outputs: ['Bauhaus', { text: 'Swiss' }],
      }),
      node({
        id: 'm',
        name: 'model',
        kind: 'model',
        model: 'vision',
        inputs: {
          messages: [{ role: 'user', content: [{ type: 'image', source: { buffer: pixels, mimeType: 'image/png' } }] }],
        },
        outputs: { content: 'ok' },
      }),
      node({
        id: 'g',
        name: 'generate_image',
        kind: 'tool',
        status: 'error',
        error: { name: 'Error', message: 'quota' },
        outputs: { type: 'tool_output', content: [{ type: 'audio', source: { transcript: 'a jingle' } }] },
      }),
      node({
        id: 'v',
        name: 'render',
        kind: 'tool',
        outputs: { clip: { type: 'video', source: { path: '/out/clip.mp4' } } },
      }),
    ],
  });
  const evidence = traceEvidence(tree);
  assert.deepEqual(
    evidence.media.map((item) => [item.part.type, item.direction, item.runId]),
    [
      ['image', 'input', 'root'],
      ['asset', 'output', 'root'],
      ['audio', 'output', 'g'],
      ['video', 'output', 'v'],
    ],
    'the reference image once, though the model call carried it too',
  );
  assert.deepEqual(evidence.media[1]?.part, { type: 'asset', asset: generated });
  assert.deepEqual(evidence.retrievals, [
    { runId: 'r', query: 'poster styles', documents: [{ content: 'Bauhaus' }, { content: 'Swiss' }] },
  ]);
  assert.deepEqual(
    evidence.toolCalls.map((call) => [call.name, call.error?.message]),
    [
      ['generate_image', 'quota'],
      ['render', undefined],
    ],
  );
  assert.equal(evidence.modelCalls[0]?.model, 'vision');
  assert.deepEqual(evidence.inputs, tree.inputs);
  // Bytes are content, never searched for media; a cycle ends the search.
  const cyclic: Record<string, unknown> = { pixels };
  cyclic.self = cyclic;
  assert.deepEqual(mediaParts(cyclic), []);
});
