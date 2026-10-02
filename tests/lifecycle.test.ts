import assert from 'node:assert/strict';
import test from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { BatchManager } from '../src/batch/manager.js';
import { MockBatchProvider } from '../src/batch/mock.js';
import { BudgetExceededError, OperationDeniedError } from '../src/core/lifecycle.js';
import { NexusAI } from '../src/core/nexus.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import { lastValue } from '../src/graph/channels.js';
import { workflow } from '../src/graph/functional.js';
import { createGraph } from '../src/graph/graph.js';
import { MockImageProvider } from '../src/images/mock.js';
import { JobQueue } from '../src/jobs/queue.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { BaseProvider } from '../src/providers/base.js';
import { MockRealtimeTransport } from '../src/realtime/mock.transport.js';
import { createRealtimeSession } from '../src/realtime/session.js';
import type { AuditLogEvent, NexusAIConfig } from '../src/types/config.js';
import type { OperationDescriptor, OperationOutcome, ProviderCallContext } from '../src/types/lifecycle.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../src/types/response.js';
import type { TelephonyProvider } from '../src/types/telephony.js';
import type { SpeechResponse, TranscriptionResponse, VoiceProvider } from '../src/types/voice.js';

/**
 * A chat provider that records the context of every call and echoes a dated model name back, as
 * OpenAI does. The registry files the model undated, so a response priced on the echo costs nothing.
 */
class RecordingProvider extends BaseProvider {
  readonly info = { name: 'openai', isLocal: false };
  readonly contexts: ProviderCallContext[] = [];
  calls = 0;
  failNext = false;
  hold?: Promise<void>;

  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    this.calls += 1;
    if (context) this.contexts.push(context);
    await this.hold;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    return {
      content: `answer to ${String(request.messages.at(-1)?.content)}`,
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: 'provider-local-id',
        providerUsed: 'openai',
        modelUsed: `${request.model}-2024-08-06`,
        latencyMs: 1,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensSaved: 0,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        cost: { amount: 0, currency: 'USD', basis: 'estimated' },
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
    this.calls += 1;
    if (context) this.contexts.push(context);
    return this.createStream(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', content: 'part one ' };
      yield { type: 'text', content: 'part two' };
      yield {
        type: 'done',
        meta: {
          providerUsed: 'openai',
          modelUsed: request.model,
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        },
      };
    }, request.signal);
  }
}

const voice = (calls: ProviderCallContext[]): VoiceProvider => ({
  info: { name: 'mock-voice', supports: { transcription: true, speech: true } },
  async transcribe(_request, context): Promise<TranscriptionResponse> {
    if (context) calls.push(context);
    return { text: 'hello', providerUsed: 'mock-voice', modelUsed: 'mock-stt' };
  },
  async speak(_request, context): Promise<SpeechResponse> {
    if (context) calls.push(context);
    return {
      audio: { data: new Uint8Array([1]), format: 'mp3' },
      providerUsed: 'mock-voice',
      modelUsed: 'mock-tts',
      format: 'mp3',
    };
  },
});

const telephony = (calls: ProviderCallContext[]): TelephonyProvider => ({
  info: { name: 'mock-tel', supports: { outbound: true, callControl: true } },
  async createCall(_request, context) {
    if (context) calls.push(context);
    return {
      callId: 'CA1',
      providerUsed: 'mock-tel',
      status: 'queued' as const,
      direction: 'outbound' as const,
      to: '+15550001111',
      from: '+15550002222',
    };
  },
});

const question = (content: string, extra: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content }],
  ...extra,
});

interface Harness {
  ai: NexusAI;
  text: RecordingProvider;
  calls: ProviderCallContext[];
  admitted: OperationDescriptor[];
  finished: Array<{ operation: OperationDescriptor; outcome: OperationOutcome }>;
  audit: AuditLogEvent[];
}

function harness(
  config: Partial<NexusAIConfig> = {},
  authorize?: (operation: OperationDescriptor) => boolean,
): Harness {
  const text = new RecordingProvider();
  const calls: ProviderCallContext[] = [];
  const admitted: OperationDescriptor[] = [];
  const finished: Harness['finished'] = [];
  const audit: AuditLogEvent[] = [];
  const ai = new NexusAI({
    providers: {},
    metrics: { enabled: true },
    auditLog: { enabled: true, sink: (event) => void audit.push(event) },
    images: { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    embeddings: { providers: { mock: new MockEmbeddingProvider() }, defaultProvider: 'mock' },
    voice: { providers: { mock: voice(calls) }, defaultTranscriptionProvider: 'mock', defaultSpeechProvider: 'mock' },
    telephony: { providers: { mock: telephony(calls) }, defaultProvider: 'mock' },
    ...config,
    lifecycle: {
      ...config.lifecycle,
      authorize: (operation) => {
        admitted.push({ ...operation });
        return authorize ? authorize(operation) : true;
      },
      hooks: { onFinish: (operation, outcome) => void finished.push({ operation: { ...operation }, outcome }) },
    },
  });
  ai.registerProvider('openai', text);
  return { ai, text, calls, admitted, finished, audit };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Reading is all that is needed.
  }
}

async function settled(queue: JobQueue<string, string>, id: string): Promise<void> {
  while (!['completed', 'failed'].includes(queue.get(id)?.status ?? '')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ── One lifecycle, every family ────────────────────────────────────

test('one authorize callback, one audit log, and one set of hooks see every family', async () => {
  const { ai, admitted, finished, audit } = harness();

  await ai.complete(question('hi'));
  await drain(ai.stream(question('stream it')));
  await ai.embed({ input: 'hello' });
  await ai.transcribe({ audio: { buffer: new Uint8Array([1]), filename: 'a.mp3' } });
  await ai.speak({ text: 'hello' });
  await ai.createCall({ to: '+15550001111', from: '+15550002222' });
  await ai.images.generate({ prompt: 'a blue square' });
  await ai.agent({ goal: 'say hi', model: 'gpt-4o' });

  const graph = createGraph({ channels: { answer: lastValue<string>('') } })
    .addNode('ask', async () => ({ answer: (await ai.complete(question('inside a graph'))).content }))
    .addEdge('__start__', 'ask')
    .addEdge('ask', '__end__')
    .compile({ lifecycle: ai.lifecycle, name: 'ask-once' });
  await graph.invoke({});

  const agent = createAgent({ client: ai, model: 'gpt-4o', lifecycle: ai.lifecycle, name: 'helper' });
  await agent.invoke(agentInput('help me'));

  await workflow(async (input: string, context) => context.step('echo', () => input), {
    name: 'echo',
    lifecycle: ai.lifecycle,
  }).invoke('ping');

  const queue = new JobQueue<string, string>(async (payload) => payload, { lifecycle: ai.lifecycle });
  await settled(queue, queue.enqueue('work').id);

  const batch = new BatchManager(
    { providers: { mock: new MockBatchProvider() }, defaultProvider: 'mock', pollIntervalMs: 1 },
    { lifecycle: ai.lifecycle },
  );
  await (await batch.submit({ items: [{ customId: 'a', request: question('batched') }] })).result();

  const session = createRealtimeSession({
    model: 'gpt-realtime',
    transport: new MockRealtimeTransport(),
    lifecycle: ai.lifecycle,
  });
  await session.connect();
  await session.disconnect();

  const families = [...new Set(admitted.map((operation) => operation.family))].sort();
  assert.deepEqual(families, [
    'agent',
    'batch',
    'completion',
    'embedding',
    'graph',
    'image',
    'job',
    'realtime',
    'telephony',
    'voice',
  ]);
  assert.equal(finished.length, admitted.length, 'every admitted operation finished exactly once');
  assert.ok(finished.every(({ outcome }) => outcome.status === 'succeeded'));

  for (const family of families) {
    const types = audit.filter((event) => event.family === family).map((event) => event.type);
    assert.ok(types.includes('request') && types.includes('response'), `${family} writes a request and a response`);
  }
  const counters = Object.keys((ai.getMetricsSnapshot() as { counters: Record<string, number> }).counters);
  for (const family of families) {
    assert.ok(
      counters.some((key) => key.includes(`family=${family}`)),
      `${family} is counted`,
    );
  }
});

test('a refused operation never reaches its provider, in any family', async () => {
  const { ai, text, calls, audit, finished } = harness({}, () => false);
  const images = new MockImageProvider();
  ai.registerImageProvider('mock', images);

  await assert.rejects(() => ai.complete(question('hi')), OperationDeniedError);
  await assert.rejects(() => drain(ai.stream(question('hi'))), OperationDeniedError);
  await assert.rejects(() => ai.embed({ input: 'hello' }), OperationDeniedError);
  await assert.rejects(
    () => ai.transcribe({ audio: { buffer: new Uint8Array([1]), filename: 'a.mp3' } }),
    OperationDeniedError,
  );
  await assert.rejects(() => ai.createCall({ to: '+15550001111', from: '+15550002222' }), OperationDeniedError);
  await assert.rejects(() => ai.images.generate({ prompt: 'x' }), OperationDeniedError);

  assert.equal(text.calls, 0);
  assert.equal(calls.length, 0);
  assert.ok(
    audit.every((event) => event.type === 'blocked'),
    'only refusals are audited',
  );
  assert.ok(finished.every(({ outcome }) => outcome.status === 'denied'));
});

test('a throwing authorize callback refuses with its reason', async () => {
  const { ai } = harness({}, (operation) => {
    if (operation.userId === 'mallory') throw new Error('suspended account');
    return true;
  });
  await assert.rejects(
    () => ai.complete(question('hi', { userId: 'mallory' })),
    (error: unknown) => error instanceof OperationDeniedError && /suspended account/.test(error.message),
  );
  await ai.complete(question('hi', { userId: 'alice' }));
});

// ── Budgets ────────────────────────────────────────────────────────

test('a shared budget holds concurrent calls to one limit and is charged what each call cost', async () => {
  const ledger = budgetLedger({ limit: 1.5 });
  const { ai, text } = harness({ lifecycle: { budget: ledger } });
  // Each request is estimated at about one dollar of output; together they would pass the limit.
  const expensive = (content: string) => question(content, { estimatedOutputTokens: 100_000 });

  let release: () => void = () => {};
  text.hold = new Promise((resolve) => {
    release = resolve;
  });
  // Both are in flight together: the first holds its estimate while the second asks for one.
  const both = Promise.allSettled([ai.complete(expensive('one')), ai.complete(expensive('two'))]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const outcomes = await both;
  text.hold = undefined;

  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] && (rejected[0] as PromiseRejectedResult).reason instanceof BudgetExceededError);

  const response = (fulfilled[0] as PromiseFulfilledResult<NexusResponse>).value;
  const cost = response.meta.cost?.amount ?? 0;
  assert.ok(cost > 0, 'the response is priced on the routed model, not the dated name it echoed');
  assert.ok(Math.abs((await ledger.spent('default')) - cost) < 1e-9, 'the hold was replaced by the actual cost');

  text.failNext = true;
  await assert.rejects(() => ai.complete(question('fails')), /provider down/);
  assert.ok(Math.abs((await ledger.spent('default')) - cost) < 1e-9, 'a failed call gives its hold back');
});

test('budgets are kept per tenant', async () => {
  const ledger = budgetLedger({ limit: (key) => (key === 'small' ? 0.000001 : 10) });
  const { ai } = harness({ lifecycle: { budget: ledger } });
  await ai.complete(question('fine', { tenantId: 'large' }));
  await assert.rejects(() => ai.complete(question('too much', { tenantId: 'small' })), BudgetExceededError);
  assert.ok((await ledger.spent('large')) > 0);
  assert.equal(await ledger.spent('small'), 0);
});

// ── Finalization ───────────────────────────────────────────────────

test('hooks see a cache hit, a failure, and a stream stopped early', async () => {
  const { ai, text, finished, audit } = harness({ cache: { enabled: true } });

  await ai.complete(question('cached'));
  const hit = await ai.complete(question('cached'));
  assert.equal(hit.meta.cacheHit, true);
  assert.equal(text.calls, 1, 'the second answer came from the cache');
  const cached = finished.at(-1)?.outcome;
  assert.equal(cached?.status, 'succeeded');
  assert.equal(cached?.cacheHit, true);
  assert.equal(cached?.cost, 0);
  assert.equal(audit.filter((event) => event.type === 'response').at(-1)?.metadata?.cacheHit, true);
  const counters = Object.keys((ai.getMetricsSnapshot() as { counters: Record<string, number> }).counters);
  assert.ok(counters.some((key) => key.includes('cache_hits')));

  text.failNext = true;
  await assert.rejects(() => ai.complete(question('fails')), /provider down/);
  assert.equal(finished.at(-1)?.outcome.status, 'failed');
  assert.equal(audit.at(-1)?.type, 'error');

  for await (const _chunk of ai.stream(question('long answer'))) break;
  assert.equal(finished.at(-1)?.operation.operation, 'stream');
  assert.equal(finished.at(-1)?.outcome.status, 'cancelled');
});

test('a stream is audited, priced, and finished like a completion', async () => {
  const { ai, finished, audit } = harness();
  const chunks: StreamChunk[] = [];
  for await (const chunk of ai.stream(question('stream it'))) chunks.push(chunk);
  const done = chunks.at(-1);
  assert.equal(done?.type, 'done');
  assert.ok((done?.meta?.cost?.amount ?? 0) > 0);
  const last = finished.at(-1);
  assert.equal(last?.operation.operation, 'stream');
  assert.equal(last?.outcome.cost, done?.meta?.cost?.amount);
  assert.equal(done?.meta?.requestId, last?.operation.requestId);
  assert.deepEqual(
    audit.filter((event) => event.operation === 'stream').map((event) => event.type),
    ['request', 'response'],
  );
});

// ── The provider call context ──────────────────────────────────────

test('every provider call receives the operation id, its signal, its deadline, and its idempotency key', async () => {
  const { ai, text, calls, finished } = harness();

  const response = await ai.complete(question('hi', { requestId: 'req-42', idempotencyKey: 'once-42' }));
  const context = text.contexts.at(-1);
  assert.equal(context?.requestId, 'req-42');
  assert.equal(response.meta.requestId, 'req-42', 'one id from the audit log to the response');
  assert.equal(context?.idempotencyKey, 'once-42');
  assert.ok(context?.signal instanceof AbortSignal);
  assert.ok((context?.deadline ?? 0) > Date.now(), 'the client timeout becomes a deadline');

  await ai.transcribe({ audio: { buffer: new Uint8Array([1]), filename: 'a.mp3' } });
  await ai.createCall({ to: '+15550001111', from: '+15550002222' });
  assert.equal(calls.length, 2);
  const ids = finished.slice(-2).map(({ operation }) => operation.requestId);
  assert.deepEqual(
    calls.map((call) => call.requestId),
    ids,
  );
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});
