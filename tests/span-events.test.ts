/**
 * Span events and links: what happens inside a run, at its times, and the runs it came from.
 *
 * A graph fans out over three branches and joins them: the join's run links to each branch, and a
 * branch that failed once has its retry as an event. A model call's run has the attempts that failed
 * before its answer, as `retry` and `failover` at the times they failed, and the guardrails and cache
 * it went through. Events and links reach OTLP's spans, and a run started from another process's
 * `traceparent` links back to it. The tracer keeps at most `maxEventsPerRun` and counts the rest.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { appendList, counter, lastValue } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { BaseProvider } from '../src/providers/base.js';
import { NexusProviderError } from '../src/providers/errors.js';
import { FailoverExecutor } from '../src/router/failover.js';
import { traceGraph, traceModelClient } from '../src/tracing/instrument.js';
import { runToOtlpSpan } from '../src/tracing/otlp.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer, w3cSpanId, w3cTraceId } from '../src/tracing/tracer.js';
import { END, Send } from '../src/types/graph.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';
import type { Run } from '../src/types/tracing.js';

const tracerWith = (options: Partial<ConstructorParameters<typeof Tracer>[0]> = {}) => {
  const store = new MemoryTraceStore();
  return { store, tracer: new Tracer({ store, ...options }) };
};

const answer = (meta: Partial<NexusResponse['meta']> = {}): NexusResponse =>
  ({
    content: 'answer',
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'r',
      providerUsed: 'openai',
      modelUsed: 'gpt-test',
      latencyMs: 1,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      cacheHit: false,
      guardrailsApplied: [],
      ...meta,
    },
  }) as NexusResponse;

test('proof: a join links to each branch it gathers, and a retry is an event of its branch', async () => {
  const { store, tracer } = tracerWith({ incremental: true });
  const failedOnce = new Set<string>();
  const graph = createGraph({
    channels: { log: appendList<string>(), count: counter(), urls: lastValue<string[]>([]) },
  })
    .addNode('plan', () => ({ urls: ['a.test', 'b.test', 'c.test'] }))
    .addNode(
      'research',
      (context) => {
        const url = String(context.input);
        if (url === 'b.test' && !failedOnce.has(url)) {
          failedOnce.add(url);
          throw new Error('b.test timed out');
        }
        return { log: [`fetched ${url}`], count: 1 };
      },
      { ends: [END], retry: { maxAttempts: 2, initialIntervalMs: 0, jitter: false } },
    )
    .addNode('report', (context) => ({ log: [`report:${context.state.count}`] }))
    .setEntry('plan')
    .addConditionalEdges('plan', (state) => state.urls.map((url) => new Send('research', url)))
    .addConditionalEdges('research', () => 'report')
    .addEdge('report', END)
    .compile();

  const tracing = traceGraph(tracer, { name: 'crawl' });
  const result = await graph.invoke({}, { threadId: 'crawl', ...tracing.runOptions });
  await tracing.finish(result as never);
  await tracer.flush();
  assert.equal(result.status, 'completed');

  const runs = store.query({ traceId: tracing.root.traceId, limit: 50 });
  const byName = (name: string) => runs.filter((run) => run.name === name);
  const branches = byName('research');
  const [report] = byName('report');
  assert.equal(branches.length, 3, 'three branches');
  assert.deepEqual(
    (report?.links ?? []).map((link) => link.runId).sort(),
    branches.map((run) => run.id).sort(),
    'the join links to every branch it gathered',
  );
  assert.ok(
    report?.links?.every(
      (link) => link.traceId === tracing.root.traceId && link.attributes?.['nexus.link'] === 'previous_step',
    ),
  );
  assert.equal(byName('plan')[0]?.links, undefined, 'a step after one task links to nothing');
  assert.ok(
    branches.every((run) => run.links === undefined),
    'nor does the fan-out after it',
  );

  const retried = branches.filter((run) => run.events?.some((event) => event.name === 'retry'));
  assert.equal(retried.length, 1, 'one branch retried');
  assert.deepEqual(retried[0]?.events?.[0]?.attributes, { 'nexus.attempt': 1, 'error.message': 'b.test timed out' });
  assert.ok(!Number.isNaN(Date.parse(retried[0]?.events?.[0]?.time ?? '')));

  // As spans: the join's links name the branches' spans, and the retry is a span event.
  const joined = runToOtlpSpan(report as Run);
  assert.deepEqual(joined.links?.map((link) => link.spanId).sort(), branches.map((run) => w3cSpanId(run.id)).sort());
  assert.ok(joined.links?.every((link) => link.traceId === w3cTraceId(tracing.root.traceId)));
  const branchSpan = runToOtlpSpan(retried[0] as Run);
  assert.equal(branchSpan.events?.[0]?.name, 'retry');
  assert.equal(
    branchSpan.events?.[0]?.timeUnixNano,
    `${BigInt(Date.parse(retried[0]?.events?.[0]?.time as string)) * 1_000_000n}`,
  );
});

/** A provider that fails as told, then answers. */
class Flaky extends BaseProvider {
  readonly info: { name: string; isLocal: boolean };
  calls = 0;
  constructor(
    name: string,
    private readonly failures: number,
  ) {
    super();
    this.info = { name, isLocal: true };
  }
  async complete(): Promise<NexusResponse> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      throw new NexusProviderError({
        message: `${this.info.name} is overloaded`,
        category: 'rate-limit',
        provider: this.info.name,
        model: `${this.info.name}/model`,
      });
    }
    return answer({ providerUsed: this.info.name, modelUsed: `${this.info.name}/model` });
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} } as unknown as NexusStream;
  }
}

test('a model run has the attempts that failed before its answer, at their times, and what its answer went through', async () => {
  // Failover records what failed: the first provider twice, then the second answers.
  const executor = new FailoverExecutor();
  const primary = new Flaky('primary', 5);
  const backup = new Flaky('backup', 0);
  const response = await executor.complete(
    { model: 'primary/model', messages: [{ role: 'user', content: 'hi' }] },
    {
      providerName: 'primary',
      model: 'primary/model',
      reason: 'test',
      fallbacks: [{ providerName: 'backup', model: 'backup/model' }],
    },
    new Map<string, BaseProvider>([
      ['primary', primary],
      ['backup', backup],
    ]),
    {
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, backoff: 'fixed', retryOn: ['rate-limit'] },
    },
  );
  assert.deepEqual(
    response.meta.failedAttempts?.map(({ provider, model, error, category }) => ({ provider, model, error, category })),
    [
      { provider: 'primary', model: 'primary/model', error: 'primary is overloaded', category: 'rate-limit' },
      { provider: 'primary', model: 'primary/model', error: 'primary is overloaded', category: 'rate-limit' },
    ],
  );
  assert.ok(response.meta.failedAttempts?.every((attempt) => !Number.isNaN(Date.parse(attempt.at))));

  // Traced, the response's report becomes the run's events, in time order.
  const { store, tracer } = tracerWith();
  const failedAt = ['2026-10-21T09:00:00.100Z', '2026-10-21T09:00:00.200Z', '2026-10-21T09:00:00.300Z'];
  const client = traceModelClient(
    {
      complete: async (_request: CompletionRequest) =>
        answer({
          providerUsed: 'anthropic',
          failedAttempts: [
            {
              provider: 'openai',
              model: 'gpt-test',
              error: 'overloaded',
              category: 'rate_limit',
              at: failedAt[1] as string,
            },
            {
              provider: 'anthropic',
              model: 'claude',
              error: 'timed out',
              category: 'timeout',
              at: failedAt[2] as string,
            },
            { provider: 'openai', model: 'gpt-test', error: 'overloaded', at: failedAt[0] as string },
          ],
          guardrailsApplied: ['pii-redaction'],
          cache: { outcome: 'miss', layer: 'exact', reason: 'no entry' },
          capabilityWarnings: [{ feature: 'temperature', model: 'claude', action: 'dropped', reason: 'not taken' }],
        }),
    },
    tracer,
  );
  await client.complete({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  await tracer.flush();
  const [run] = store.query({ kind: 'model', limit: 1 });
  const events = run?.events ?? [];
  assert.deepEqual(
    events.slice(0, 3).map((event) => [event.name, event.time, event.attributes?.['gen_ai.provider.name']]),
    [
      ['failover', failedAt[0], 'openai'],
      ['failover', failedAt[1], 'openai'],
      ['retry', failedAt[2], 'anthropic'],
    ],
    'retried on the provider that answered, failed over from the others, in the order they failed',
  );
  assert.equal(events[1]?.attributes?.['error.type'], 'rate_limit');
  assert.deepEqual(
    events.slice(3).map((event) => [event.name, Object.values(event.attributes ?? {}).join(' ')]),
    [
      ['guardrail', 'pii-redaction'],
      ['cache', 'miss exact no entry'],
      ['capability_warning', 'temperature dropped'],
    ],
  );
});

test('events and links through the tracer: in scope, by handle, from a traceparent, capped, and closed at the end', async () => {
  const { store, tracer } = tracerWith({ maxEventsPerRun: 3 });
  assert.equal(tracer.event('nowhere'), false, 'no run in scope');
  const upstream = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  let handle: ReturnType<Tracer['startRun']> | undefined;
  await tracer.trace(
    {
      name: 'job',
      links: [{ traceparent: upstream, attributes: { 'nexus.link': 'queued_by' } }, { traceparent: 'nonsense' }],
    },
    (run) => {
      handle = run;
      assert.equal(tracer.event('started', { step: 1 }), true, 'the run in scope');
      run.event('checkpoint', { ok: true }, '2026-10-21T08:00:00.000Z');
      run.event('third');
      run.event('fourth');
      run.event('fifth');
    },
  );
  handle?.event('after the end');
  await tracer.flush();
  const [job] = store.query({ name: 'job', limit: 1 });
  assert.deepEqual(job?.links, [
    {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      runId: 'run-00f067aa0ba902b7',
      attributes: { 'nexus.link': 'queued_by' },
    },
  ]);
  assert.deepEqual(
    job?.events?.map((event) => event.name),
    ['started', 'checkpoint', 'third'],
  );
  assert.equal(job?.events?.[1]?.time, '2026-10-21T08:00:00.000Z');
  assert.equal(job?.droppedEvents, 2, 'two past the cap, and none after the end');
  const span = runToOtlpSpan(job as Run);
  assert.equal(span.droppedEventsCount, 2);
  assert.deepEqual(span.links?.[0], {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    attributes: [{ key: 'nexus.link', value: { stringValue: 'queued_by' } }],
  });

  // A handle links to its run; links and events can also arrive with the end.
  const parent = tracer.startRun({ name: 'parent' });
  const later = tracer.startRun({ name: 'later' });
  await later.finish({
    links: [parent.link({ why: 'continues' })],
    events: [{ name: 'reported', time: new Date('2026-10-21T07:00:00.000Z') }],
  });
  await parent.finish();
  const [laterRun] = store.query({ name: 'later', limit: 1 });
  assert.deepEqual(laterRun?.links, [{ traceId: parent.traceId, runId: parent.id, attributes: { why: 'continues' } }]);
  assert.equal(laterRun?.events?.[0]?.name, 'reported');
  // A finished run in scope takes no more events.
  assert.equal(
    tracer.within(later, () => tracer.event('late')),
    false,
    'a run that finished records nothing',
  );
  assert.deepEqual(
    laterRun?.events?.map((event) => event.name),
    ['reported'],
  );

  // Nor through its handle: an exporter that batches holds the finished run, and sees what it ended with.
  const held: Run[] = [];
  const batching = new Tracer({ store: new MemoryTraceStore(), exporters: [{ export: (run) => void held.push(run) }] });
  const exported = batching.startRun({ name: 'exported' });
  exported.event('during');
  await exported.finish();
  exported.event('after');
  await batching.flush();
  assert.deepEqual(
    held[0]?.events?.map((event) => event.name),
    ['during'],
    'an event after the end reaches no exporter',
  );
});

test('a tool’s progress is an event of its run, as it reports it', async () => {
  const { store, tracer } = tracerWith();
  let call = 0;
  const agent = createAgent({
    client: {
      complete: async () => {
        call += 1;
        return call === 1
          ? ({
              ...answer(),
              content: '',
              toolCalls: [{ id: 'c1', type: 'function', function: { name: 'import', arguments: '{}' } }],
            } as NexusResponse)
          : answer();
      },
    },
    tools: [
      tool({
        name: 'import',
        description: 'Imports rows',
        parameters: { type: 'object', properties: {} },
        async *stream() {
          yield { progress: 1, total: 2, message: 'half' };
          yield 'almost';
          return 'done';
        },
      }),
    ],
  });
  const tracing = traceGraph(tracer, { name: 'importer', kind: 'agent' });
  const result = await agent.invoke(
    { messages: [{ role: 'user', content: 'import' }] },
    { threadId: 'import', ...tracing.runOptions },
  );
  await tracing.finish(result as never);
  await tracer.flush();
  const [run] = store.query({ kind: 'tool', limit: 1 });
  assert.deepEqual(
    run?.events?.map((event) => [event.name, event.attributes]),
    [
      ['progress', { 'nexus.progress': 1, 'nexus.progress.total': 2, 'nexus.progress.message': 'half' }],
      ['progress', { 'nexus.progress.message': 'almost' }],
    ],
  );
  assert.ok(Array.isArray(run?.metadata?.progress), 'and still kept as metadata, as before');
});
