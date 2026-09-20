import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentAsTool, agentInput, createAgent } from '../src/agent/create-agent.js';
import { limitToolCalls, redactMessages, summarizeHistory } from '../src/agent/middleware.js';
import { tool } from '../src/agent/tool.js';
import { appendList, counter } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { AlertEvaluator, createWebhookNotifier, measure } from '../src/tracing/alerts.js';
import { compareTraces, formatTree } from '../src/tracing/compare.js';
import { traceGraph, traceModelClient } from '../src/tracing/instrument.js';
import { JsonlTraceStore, MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import { END } from '../src/types/graph.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import type { Run } from '../src/types/tracing.js';

function tracerWith(options: Partial<ConstructorParameters<typeof Tracer>[0]> = {}) {
  const store = new MemoryTraceStore();
  return { store, tracer: new Tracer({ store, ...options }) };
}

const response = (overrides: Partial<NexusResponse> = {}): NexusResponse =>
  ({
    content: 'answer',
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'r1',
      providerUsed: 'openai',
      modelUsed: 'gpt-test',
      latencyMs: 12,
      tokensInput: 10,
      tokensOutput: 5,
      tokensSaved: 0,
      estimatedCost: '$0.01',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      cost: { amount: 0.01, currency: 'USD', basis: 'estimated' },
    },
    ...overrides,
  }) as NexusResponse;

// ── Runs and trees ─────────────────────────────────────────────────

test('a traced call records a run tree with timing, inputs, and outputs', async () => {
  const { store, tracer } = tracerWith({ tags: ['test'] });

  const answer = await tracer.trace({ name: 'answer-question', kind: 'chain', inputs: { q: 'why?' } }, async () => {
    await tracer.trace({ name: 'retrieve', kind: 'retriever' }, async () => ['doc-1']);
    return 'because';
  });

  assert.equal(answer, 'because');
  const runs = store.query();
  assert.equal(runs.length, 2);
  const tree = store.tree(runs[0]?.traceId as string);
  assert.equal(tree?.name, 'answer-question');
  assert.equal(tree?.status, 'ok');
  assert.deepEqual(tree?.inputs, { q: 'why?' });
  assert.equal(tree?.outputs, 'because');
  assert.ok((tree?.latencyMs ?? -1) >= 0);
  assert.deepEqual(tree?.tags, ['test']);
  assert.equal(tree?.children.length, 1);
  assert.equal(tree?.children[0]?.name, 'retrieve');
  assert.equal(tree?.children[0]?.parentId, tree?.id);
  assert.match(formatTree(tree as never), /chain:answer-question/);
});

test('a failing run is recorded as an error, and the error still reaches the caller', async () => {
  const { store, tracer } = tracerWith();
  await assert.rejects(
    () =>
      tracer.trace({ name: 'explode' }, async () => {
        throw new Error('boom');
      }),
    /boom/,
  );

  const [run] = store.query();
  assert.equal(run?.status, 'error');
  assert.deepEqual(run?.error, { name: 'Error', message: 'boom' });
});

test('traceable wraps an ordinary function, and feedback attaches to its run', async () => {
  const { store, tracer } = tracerWith();
  const classify = tracer.traceable({ name: 'classify', kind: 'model' }, async (text: string) => text.length);

  assert.equal(await classify('hello'), 5);
  const [run] = store.query();
  assert.deepEqual(run?.inputs, ['hello']);
  assert.equal(run?.outputs, 5);

  await tracer.recordFeedback(run?.id as string, { key: 'correct', score: 1, source: 'human' });
  assert.equal(store.get(run?.id as string)?.feedback?.[0]?.key, 'correct');
});

// ── Privacy and sampling ───────────────────────────────────────────

test('redaction keeps prompts out of a trace', async () => {
  const { store, tracer } = tracerWith({
    redaction: {
      hideFields: ['apiKey', 'user.email'],
      redact: (run) => ({ ...run, tags: [...(run.tags ?? []), 'clean'] }),
    },
  });

  await tracer.trace(
    { name: 'call', inputs: { apiKey: 'secret', user: { email: 'a@b.test', id: 7 }, keep: 'yes' } },
    () => 'ok',
  );

  const [run] = store.query();
  const inputs = run?.inputs as { apiKey?: string; user: { email?: string; id: number }; keep: string };
  assert.equal(inputs.apiKey, undefined);
  assert.equal(inputs.user.email, undefined);
  assert.equal(inputs.user.id, 7);
  assert.equal(inputs.keep, 'yes');
  assert.ok(run?.tags?.includes('clean'));

  const hidden = tracerWith({ redaction: { hideInputs: true, hideOutputs: true } });
  await hidden.tracer.trace({ name: 'call', inputs: { prompt: 'secret' } }, () => 'also secret');
  assert.equal(hidden.store.query()[0]?.inputs, undefined);
  assert.equal(hidden.store.query()[0]?.outputs, undefined);
});

test('tail sampling keeps failures and slow runs even at a low rate', async () => {
  const kept = tracerWith({ sampling: { rate: 0, keepErrors: true, keepSlowerThanMs: 0 } });
  await assert.rejects(
    () =>
      kept.tracer.trace({ name: 'fails' }, () => {
        throw new Error('nope');
      }),
    /nope/,
  );
  assert.equal(kept.store.query().length, 1, 'an error is kept whatever the rate says');

  const dropped = tracerWith({ sampling: { rate: 0 } });
  await dropped.tracer.trace({ name: 'quiet' }, () => 'fine');
  assert.equal(dropped.store.query().length, 0);

  const everything = tracerWith({ sampling: { rate: 1 } });
  await everything.tracer.trace({ name: 'kept' }, () => 'fine');
  assert.equal(everything.store.query().length, 1);
});

// ── Query and storage ──────────────────────────────────────────────

test('runs can be queried by kind, status, tags, cost, latency, and feedback', async () => {
  const store = new MemoryTraceStore();
  const base: Run = {
    id: 'r1',
    traceId: 't1',
    name: 'model-call',
    kind: 'model',
    status: 'ok',
    startedAt: '2026-09-20T10:00:00.000Z',
    latencyMs: 100,
    cost: 0.01,
    model: 'gpt-test',
    tags: ['prod'],
    metadata: { tenant: 'acme' },
  };
  store.save(base);
  store.save({
    ...base,
    id: 'r2',
    traceId: 't2',
    status: 'error',
    latencyMs: 4_000,
    cost: 0.5,
    tags: ['prod', 'beta'],
  });
  store.save({ ...base, id: 'r3', traceId: 't3', kind: 'tool', name: 'search', startedAt: '2026-09-19T10:00:00.000Z' });

  assert.deepEqual(
    store
      .query({ kind: 'model' })
      .map((run) => run.id)
      .sort(),
    ['r1', 'r2'],
  );
  assert.deepEqual(
    store.query({ status: 'error' }).map((run) => run.id),
    ['r2'],
  );
  assert.deepEqual(
    store.query({ tags: ['beta'] }).map((run) => run.id),
    ['r2'],
  );
  assert.deepEqual(
    store.query({ minLatencyMs: 1_000 }).map((run) => run.id),
    ['r2'],
  );
  assert.deepEqual(
    store.query({ minCost: 0.1 }).map((run) => run.id),
    ['r2'],
  );
  assert.deepEqual(store.query({ metadata: { tenant: 'acme' } }).length, 3);
  assert.deepEqual(
    store
      .query({ since: '2026-09-20T00:00:00.000Z' })
      .map((run) => run.id)
      .sort(),
    ['r1', 'r2'],
  );
  assert.deepEqual(
    store.query({ name: 'search' }).map((run) => run.id),
    ['r3'],
  );
  // Newest first, and pageable.
  assert.deepEqual(store.query({ limit: 1 }).length, 1);

  store.addFeedback('r1', { key: 'thumbs', score: 1, createdAt: '2026-09-20T11:00:00.000Z' });
  assert.deepEqual(
    store.query({ feedbackKey: 'thumbs' }).map((run) => run.id),
    ['r1'],
  );
  assert.equal(store.prune('2026-09-20T00:00:00.000Z'), 1);
  assert.equal(store.size(), 2);
});

test('the JSONL store survives a restart and a later line wins', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-traces-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'traces.jsonl');

  const store = new JsonlTraceStore({ file });
  const { tracer } = { tracer: new Tracer({ store }) };
  await tracer.trace({ name: 'root', kind: 'agent' }, async () => {
    await tracer.trace({ name: 'child', kind: 'tool' }, () => 'done');
    return 'finished';
  });

  // A second store, as a restarted process would see it.
  const reopened = new JsonlTraceStore({ file });
  const runs = await reopened.query();
  assert.equal(runs.length, 2);
  const tree = await reopened.tree(runs[0]?.traceId as string);
  assert.equal(tree?.children.length, 1);

  const rootRun = runs.find((run) => run.name === 'root') as Run;
  await reopened.addFeedback(rootRun.id, { key: 'useful', score: 1, createdAt: new Date().toISOString() });
  assert.equal((await reopened.get(rootRun.id))?.feedback?.length, 1);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3, 'feedback is appended, not rewritten');

  assert.equal(await reopened.prune(new Date(Date.now() + 60_000).toISOString()), 2);
  assert.deepEqual(await reopened.query(), []);
});

// ── Graph and agent instrumentation ────────────────────────────────

test('a graph run becomes a trace tree, one run per task', async () => {
  const { store, tracer } = tracerWith();
  const graph = createGraph({ channels: { log: appendList<string>(), count: counter() } })
    .addNode('plan', () => ({ log: ['planned'] }))
    .addNode('work', (context) => {
      context.emit({ progress: 'halfway' });
      return { log: ['worked'], count: 1 };
    })
    .setEntry('plan')
    .addEdge('plan', 'work')
    .addEdge('work', END)
    .compile();

  const tracing = traceGraph(tracer, { name: 'pipeline', inputs: { job: 1 } });
  const result = await graph.invoke({}, { threadId: 'traced', ...tracing.runOptions });
  await tracing.finish(result as never);

  const tree = store.tree(tracing.root.traceId);
  assert.equal(tree?.name, 'pipeline');
  assert.deepEqual(
    tree?.children.map((child) => child.name),
    ['plan', 'work'],
  );
  assert.equal(tree?.children[0]?.kind, 'node');
  assert.deepEqual(tree?.children[1]?.metadata?.emitted, [{ progress: 'halfway' }]);
  const workOutputs = tree?.children[1]?.outputs as { log: string[] } | undefined;
  assert.deepEqual(workOutputs?.log, ['worked']);
});

test('an agent trace nests model calls inside the node that made them', async () => {
  const { store, tracer } = tracerWith();
  let call = 0;
  const client = {
    complete: async (_request: CompletionRequest) => {
      call += 1;
      return call === 1
        ? response({
            content: '',
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }],
          })
        : response({ content: 'all done' });
    },
  };

  const tracing = traceGraph(tracer, { name: 'support-agent', kind: 'agent' });
  const agent = createAgent({
    client: traceModelClient(client, tracer, { parent: () => tracing.runFor('model') }),
    tools: [
      tool({ name: 'lookup', description: 'looks up', parameters: { type: 'object' }, execute: async () => 'found' }),
    ],
  });

  const result = await agent.invoke(agentInput('help'), { threadId: 'agent-trace', ...tracing.runOptions });
  await tracing.finish(result as never);

  const tree = store.tree(tracing.root.traceId);
  assert.equal(tree?.kind, 'agent');
  const modelNodes = tree?.children.filter((child) => child.name === 'model') ?? [];
  assert.equal(modelNodes.length, 2);
  const modelCall = modelNodes[0]?.children[0];
  assert.equal(modelCall?.kind, 'model');
  assert.equal(modelCall?.model, 'auto');
  assert.deepEqual(modelCall?.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(modelCall?.cost, 0.01);
  assert.equal(modelCall?.metadata?.provider, 'openai');
  assert.ok(
    tree?.children.some((child) => child.name === 'tools'),
    'the tool task is its own run',
  );
});

test('comparing two traces of the same shape reports what changed', async () => {
  const { store, tracer } = tracerWith();
  const run = async (answer: string) =>
    tracer.trace({ name: 'pipeline', inputs: { q: 'why' } }, async () => {
      await tracer.trace({ name: 'model', kind: 'model' }, () => answer);
      return answer;
    });

  await run('first');
  await run('second');
  const traces = [...new Set(store.query().map((item) => item.traceId))];
  const left = store.tree(traces[1] as string);
  const right = store.tree(traces[0] as string);

  const comparison = compareTraces(left as never, right as never);
  assert.equal(comparison.matched.length, 2);
  const modelDiff = comparison.matched.find((item) => item.path.includes('model'));
  assert.deepEqual(
    modelDiff?.differences.map((difference) => difference.path),
    ['outputs'],
  );
  assert.deepEqual(comparison.onlyLeft, []);
  assert.deepEqual(comparison.onlyRight, []);
});

// ── Alerts ─────────────────────────────────────────────────────────

test('alert rules fire on error rate, latency, and cost, and carry the runs that caused them', async () => {
  const store = new MemoryTraceStore();
  const now = new Date('2026-09-20T12:00:00.000Z');
  const base: Run = {
    id: 'a',
    traceId: 'ta',
    name: 'model-call',
    kind: 'model',
    status: 'ok',
    startedAt: new Date(now.getTime() - 60_000).toISOString(),
    latencyMs: 100,
    cost: 0.1,
  };
  store.save(base);
  store.save({ ...base, id: 'b', traceId: 'tb', status: 'error', latencyMs: 9_000, cost: 1 });
  store.save({ ...base, id: 'c', traceId: 'tc', status: 'error' });

  const notified: string[] = [];
  const evaluator = new AlertEvaluator(
    store,
    [
      { name: 'too many errors', metric: 'errorRate', threshold: 0.5 },
      { name: 'slow', metric: 'latencyP95', threshold: 5_000 },
      { name: 'expensive', metric: 'cost', threshold: 0.5 },
      { name: 'quiet rule', metric: 'count', threshold: 100 },
      { name: 'ignored, too few runs', metric: 'errorRate', threshold: 0, minRuns: 10 },
    ],
    { now: () => now, notifier: { notify: (event) => void notified.push(event.rule) } },
  );

  const fired = await evaluator.evaluate();
  assert.deepEqual(
    fired.map((event) => event.rule),
    ['too many errors', 'slow', 'expensive'],
  );
  assert.deepEqual(notified, ['too many errors', 'slow', 'expensive']);
  assert.deepEqual(
    fired[0]?.samples.map((sample) => sample.id).sort(),
    ['b', 'c'],
    'an error alert points at the failing runs',
  );
  assert.equal(measure('errorRate', store.query()), 2 / 3);
  assert.equal(measure('count', store.query()), 3);
});

test('the webhook notifier posts a readable payload', async () => {
  let posted: { url: string; body: unknown } | undefined;
  const notifier = createWebhookNotifier({
    url: 'https://hooks.example.test/alerts',
    fetch: async (url, init) => {
      posted = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response('', { status: 200 });
    },
  });

  await notifier.notify({
    rule: 'too many errors',
    metric: 'errorRate',
    value: 0.667,
    threshold: 0.5,
    runs: 3,
    windowStart: '2026-09-20T11:45:00.000Z',
    windowEnd: '2026-09-20T12:00:00.000Z',
    samples: [],
  });

  assert.equal(posted?.url, 'https://hooks.example.test/alerts');
  const payload = posted?.body as { text?: string } | undefined;
  assert.match(String(payload?.text), /too many errors: errorRate is 0\.667/);
});

// ── Agent middleware and delegation ────────────────────────────────

test('bundled middleware summarizes history, redacts secrets, and caps tool calls', async () => {
  const requests: CompletionRequest[] = [];
  const client = {
    complete: async (request: CompletionRequest) => {
      requests.push(request);
      return requests.length < 3
        ? response({
            content: '',
            toolCalls: [{ id: `c${requests.length}`, type: 'function', function: { name: 'peek', arguments: '{}' } }],
          })
        : response({ content: 'done sk-secret123' });
    },
  };

  let peeks = 0;
  const agent = createAgent({
    client,
    maxIterations: 5,
    tools: [
      tool({
        name: 'peek',
        description: 'peeks',
        parameters: { type: 'object' },
        execute: async () => {
          peeks += 1;
          return 'peeked';
        },
      }),
    ],
    middleware: [
      redactMessages({ patterns: [/sk-[a-z0-9]+/gi], redactOutput: true }),
      limitToolCalls({ peek: 1 }),
      summarizeHistory({
        triggerAfter: 2,
        keepLast: 1,
        summarize: async (messages) => `summary of ${messages.length}`,
      }),
    ],
  });

  const result = await agent.invoke(agentInput('my key is sk-secret123, use peek twice'));

  assert.match(String(requests[0]?.messages.at(-1)?.content), /\[redacted\]/);
  assert.doesNotMatch(String(requests[0]?.messages.at(-1)?.content), /sk-secret123/);
  assert.equal(peeks, 1, 'the second call was refused by the limit');
  assert.match(
    String(result.state.messages.filter((message) => message.role === 'tool').at(-1)?.content),
    /already run/,
  );
  assert.ok(
    requests.at(-1)?.messages.some((message) => String(message.content).startsWith('Summary of the conversation')),
  );
  assert.match(result.state.answer, /\[redacted\]/);
});

test('an agent can be given to another agent as a tool', async () => {
  const specialist = createAgent({
    client: { complete: async () => response({ content: 'the answer is 42' }) },
  });
  const supervisorClient = {
    complete: async (request: CompletionRequest) =>
      request.messages.some((message) => message.role === 'tool')
        ? response({ content: 'Relaying: the answer is 42' })
        : response({
            content: '',
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'researcher', arguments: '{"goal":"find it"}' } },
            ],
          }),
  };

  const supervisor = createAgent({
    client: supervisorClient,
    tools: [agentAsTool({ agent: specialist, name: 'researcher', description: 'Researches things' })],
  });

  const result = await supervisor.invoke(agentInput('delegate this'));
  assert.equal(result.state.answer, 'Relaying: the answer is 42');
  assert.match(String(result.state.messages.find((message) => message.role === 'tool')?.content), /the answer is 42/);
});
