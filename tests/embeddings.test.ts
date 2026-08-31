import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  MistralEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from '../src/embeddings/adapters.js';
import {
  EmbeddingCapabilityError,
  EmbeddingProviderError,
  EmbeddingProviderNotFoundError,
  EmbeddingProviderResponseError,
  EmbeddingValidationError,
} from '../src/embeddings/errors.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import {
  KNOWN_EMBEDDING_MODELS,
  estimateEmbeddingCost,
  listEmbeddingModels,
  listEmbeddingModelsForProvider,
  priceEmbeddingUsage,
  resolveEmbeddingModel,
} from '../src/embeddings/models.js';
import {
  createCohereEmbeddingProvider,
  createGeminiEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  toEmbeddingFunction,
} from '../src/embeddings/providers.js';
import { createConfiguredEmbeddingProviders } from '../src/embeddings/register.js';
import { NexusAI } from '../src/core/nexus.js';
import { MemoryCacheAdapter } from '../src/cache/adapters.js';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { AuditLogger } from '../src/ops/audit-logger.js';
import { InMemoryMetrics, MetricsCollector } from '../src/ops/metrics.js';
import { NexusRateLimitError } from '../src/ops/rate-limiter.js';
import { NexusProviderError } from '../src/providers/errors.js';
import { CostBudgetError } from '../src/optimizer/cost.js';
import { runEmbeddingProviderConformance } from '../src/testing/embedding-provider-conformance.js';
import type { AuditLogEvent } from '../src/types/config.js';
import type {
  EmbeddingProviderCallContext,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingsProvider,
} from '../src/types/embeddings.js';

function mockManager(provider = new MockEmbeddingProvider()): {
  manager: EmbeddingManager;
  mock: MockEmbeddingProvider;
} {
  const manager = new EmbeddingManager({ providers: { mock: provider }, defaultProvider: 'mock' });
  return { manager, mock: provider };
}

function callContext(overrides: Partial<EmbeddingProviderCallContext> = {}): EmbeddingProviderCallContext {
  return { requestId: 'test', signal: new AbortController().signal, attempt: 1, batchIndex: 0, ...overrides };
}

function jsonFetch(body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

// ── The smallest call ──────────────────────────────────────────────

test('embeds a single string and reports one vector', async () => {
  const { manager, mock } = mockManager();
  const response = await manager.embed({ input: 'hello world' });

  assert.equal(response.embeddings.length, 1);
  assert.equal(response.vectors.length, 1);
  assert.equal(response.vectors[0]?.length, 16);
  assert.equal(response.meta.count, 1);
  assert.equal(response.meta.batches, 1);
  assert.equal(response.meta.dimensions, 16);
  assert.equal(response.meta.providerUsed, 'mock');
  assert.equal(mock.callCount, 1);
});

test('embedOne returns the vector alone', async () => {
  const { manager } = mockManager();
  const vector = await manager.embedOne('hello');
  assert.equal(Array.isArray(vector), true);
  assert.equal(vector.length, 16);
});

test('rejects empty input rather than calling a provider', async () => {
  const { manager, mock } = mockManager();
  await assert.rejects(() => manager.embed({ input: '' }), EmbeddingValidationError);
  await assert.rejects(() => manager.embed({ input: [] }), EmbeddingValidationError);
  await assert.rejects(() => manager.embed({ input: ['ok', ''] }), EmbeddingValidationError);
  assert.equal(mock.callCount, 0);
});

// ── The large call ─────────────────────────────────────────────────

test('splits a batch larger than the provider limit and keeps input order', async () => {
  const { manager, mock } = mockManager(new MockEmbeddingProvider({ capabilities: { maxBatchSize: 3 } }));
  const inputs = Array.from({ length: 10 }, (_, index) => `document number ${index}`);
  const response = await manager.embed({ input: inputs });

  assert.equal(response.vectors.length, 10);
  assert.equal(response.meta.batches, 4);
  assert.equal(mock.callCount, 4);

  // Each vector must still match the one produced for that text on its own.
  const single = await manager.embed({ input: inputs[7] as string });
  assert.deepEqual(response.vectors[7], single.vectors[0]);
});

test('honors a per-request concurrency limit while splitting', async () => {
  const provider = new MockEmbeddingProvider({ capabilities: { maxBatchSize: 1 }, latencyMs: 5 });
  const { manager } = mockManager(provider);
  const response = await manager.embed({ input: ['a', 'b', 'c', 'd'], concurrency: 2 });

  assert.equal(response.meta.batches, 4);
  assert.equal(response.vectors.length, 4);
});

test('answers duplicate inputs from a single provider call', async () => {
  const { manager, mock } = mockManager();
  const response = await manager.embed({ input: ['same', 'other', 'same', 'same'] });

  assert.equal(response.vectors.length, 4);
  assert.deepEqual(response.vectors[0], response.vectors[2]);
  assert.deepEqual(response.vectors[0], response.vectors[3]);
  assert.equal(response.meta.deduplicatedInputs, 2);
  assert.equal(mock.calls[0]?.input.length, 2);
});

test('deduplication can be turned off', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({ providers: { mock: provider }, deduplicate: false });
  const response = await manager.embed({ input: ['same', 'same'] });

  assert.equal(response.meta.deduplicatedInputs, undefined);
  assert.equal(provider.calls[0]?.input.length, 2);
});

// ── Caching ────────────────────────────────────────────────────────

test('serves repeated inputs from cache and reports a full hit', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({ providers: { mock: provider }, cache: { enabled: true } });

  const first = await manager.embed({ input: ['alpha', 'beta'] });
  assert.equal(first.meta.cacheHit, false);
  assert.equal(provider.callCount, 1);

  const second = await manager.embed({ input: ['alpha', 'beta'] });
  assert.equal(second.meta.cacheHit, true);
  assert.equal(second.meta.cachedInputs, 2);
  assert.equal(second.meta.batches, 0);
  assert.equal(provider.callCount, 1);
  assert.deepEqual(second.vectors, first.vectors);
});

test('sends only the uncached share of a partially cached batch', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({ providers: { mock: provider }, cache: { enabled: true } });

  await manager.embed({ input: ['alpha'] });
  const second = await manager.embed({ input: ['alpha', 'gamma'] });

  assert.equal(second.meta.cacheHit, false);
  assert.equal(second.meta.cachedInputs, 1);
  assert.equal(provider.callCount, 2);
  assert.deepEqual(provider.calls[1]?.input, ['gamma']);
  assert.equal(second.vectors.length, 2);
});

test('uses a supplied cache adapter', async () => {
  const adapter = new MemoryCacheAdapter<number[]>();
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    cache: { enabled: true, adapter },
  });

  await manager.embed({ input: 'stored' });
  const second = await manager.embed({ input: 'stored' });

  assert.equal(second.meta.cacheHit, true);
  assert.equal(provider.callCount, 1);
});

test('a different model does not read another model cache entry', async () => {
  const provider = new MockEmbeddingProvider({ capabilities: { models: ['mock-embedding', 'mock-other'] } });
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    models: {
      registry: { 'mock-other': { provider: 'mock', dimensions: 16, maxInputTokens: 100, costPer1kInput: 0 } },
    },
    cache: { enabled: true },
  });

  await manager.embed({ input: 'shared text' });
  const second = await manager.embed({ input: 'shared text', model: 'mock-other' });

  assert.equal(second.meta.cacheHit, false);
  assert.equal(provider.callCount, 2);
});

// ── Capability refusal ─────────────────────────────────────────────

test('refuses dimensions a fixed-size model cannot produce', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    models: {
      registry: { 'mock-embedding': { provider: 'mock', dimensions: 16, maxInputTokens: 100, costPer1kInput: 0 } },
    },
  });

  await assert.rejects(() => manager.embed({ input: 'x', dimensions: 8 }), EmbeddingCapabilityError);
  assert.equal(provider.callCount, 0);
});

test('refuses a dimension value outside a declared list', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    models: {
      registry: {
        'mock-embedding': {
          provider: 'mock',
          dimensions: 16,
          supportedDimensions: [4, 8, 16],
          maxInputTokens: 100,
          costPer1kInput: 0,
        },
      },
    },
  });

  await assert.rejects(() => manager.embed({ input: 'x', dimensions: 12 }), EmbeddingCapabilityError);
  const ok = await manager.embed({ input: 'x', dimensions: 8 });
  assert.equal(ok.meta.dimensions, 8);
});

test('refuses an input type the adapter does not declare', async () => {
  const { manager } = mockManager(new MockEmbeddingProvider({ capabilities: { inputTypes: ['document'] } }));
  await assert.rejects(() => manager.embed({ input: 'x', inputType: 'query' }), EmbeddingCapabilityError);
});

test('passes an option through when the registry describes nothing', async () => {
  // An unknown model means unknown, not unsupported, so the request is not blocked.
  const { manager, mock } = mockManager();
  const response = await manager.embed({ input: 'x', model: 'unlisted-model', dimensions: 4 });

  assert.equal(response.meta.dimensions, 4);
  assert.equal(mock.calls[0]?.dimensions, 4);
});

test('rejects a non-integer dimension count', async () => {
  const { manager } = mockManager();
  await assert.rejects(() => manager.embed({ input: 'x', dimensions: 0 }), EmbeddingValidationError);
  await assert.rejects(() => manager.embed({ input: 'x', dimensions: 1.5 }), EmbeddingValidationError);
});

// ── Post-processing ────────────────────────────────────────────────

test('normalizes vectors to unit length on request', async () => {
  const { manager } = mockManager();
  const response = await manager.embed({ input: 'a normalized sentence', normalize: true });
  const magnitude = Math.sqrt((response.vectors[0] as number[]).reduce((sum, value) => sum + value * value, 0));

  assert.ok(Math.abs(magnitude - 1) < 1e-9, `expected a unit vector, got magnitude ${magnitude}`);
});

test('truncates locally when the provider returns more dimensions than asked for', async () => {
  const wide: EmbeddingsProvider = {
    info: { name: 'wide', defaultModel: 'wide-model', capabilities: { dimensions: true } },
    async embed(): Promise<EmbeddingProviderResult> {
      return { vectors: [[3, 4, 5, 6]] };
    },
  };
  const manager = new EmbeddingManager({ providers: { wide } });
  const response = await manager.embed({ input: 'x', dimensions: 2 });

  assert.deepEqual(response.vectors[0], [3, 4]);
  assert.equal(response.meta.dimensions, 2);
});

test('rescales a truncated vector from a provider that returns unit vectors', async () => {
  const unit: EmbeddingsProvider = {
    info: { name: 'unit', defaultModel: 'unit-model', capabilities: { dimensions: true, normalized: true } },
    async embed(): Promise<EmbeddingProviderResult> {
      return { vectors: [[0.6, 0.8, 0, 0]] };
    },
  };
  const manager = new EmbeddingManager({ providers: { unit } });
  const response = await manager.embed({ input: 'x', dimensions: 2, normalize: true });
  const magnitude = Math.sqrt((response.vectors[0] as number[]).reduce((sum, value) => sum + value * value, 0));

  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

// ── Usage and cost ─────────────────────────────────────────────────

test('prices reported usage through the embedding registry', async () => {
  const provider = new MockEmbeddingProvider({ usage: () => ({ inputTokens: 1000, totalTokens: 1000 }) });
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    models: {
      registry: { 'mock-embedding': { provider: 'mock', dimensions: 16, maxInputTokens: 100, costPer1kInput: 0.5 } },
    },
  });

  const response = await manager.embed({ input: 'x' });
  assert.equal(response.meta.usage.inputTokens, 1000);
  assert.equal(response.meta.usage.outputTokens, 0);
  assert.equal(response.meta.cost.amount, 0.5);
  assert.equal(response.meta.cost.basis, 'estimated');
  assert.equal(response.meta.cost.currency, 'USD');
});

test('estimates tokens locally when the provider reports none', async () => {
  const silent: EmbeddingsProvider = {
    info: { name: 'silent', defaultModel: 'silent-model', capabilities: {} },
    async embed(request: EmbeddingProviderRequest): Promise<EmbeddingProviderResult> {
      return { vectors: request.input.map(() => [1, 0]) };
    },
  };
  const manager = new EmbeddingManager({ providers: { silent } });
  const response = await manager.embed({ input: 'several words go in here' });

  assert.ok(response.meta.usage.inputTokens > 0, 'usage should be estimated rather than reported as zero');
});

test('sums usage across split batches', async () => {
  const provider = new MockEmbeddingProvider({
    capabilities: { maxBatchSize: 1 },
    usage: () => ({ inputTokens: 10, totalTokens: 10 }),
  });
  const { manager } = mockManager(provider);
  const response = await manager.embed({ input: ['a', 'b', 'c'] });

  assert.equal(response.meta.usage.inputTokens, 30);
  assert.equal(response.meta.usage.totalTokens, 30);
});

test('estimateEmbeddingCost prices input only', () => {
  const estimate = estimateEmbeddingCost({ model: 'text-embedding-3-small', inputTokens: 1_000_000 });
  assert.equal(estimate.outputTokens, 0);
  assert.equal(estimate.outputCost, 0);
  assert.ok(estimate.totalCost > 0);
  assert.equal(estimate.totalCost, estimate.inputCost);
});

test('priceEmbeddingUsage returns an estimated ResponseCost', () => {
  const cost = priceEmbeddingUsage('text-embedding-3-large', { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 });
  assert.equal(cost.basis, 'estimated');
  assert.equal(cost.output, 0);
  assert.ok((cost.amount ?? 0) > 0);
});

// ── Budget, rate limit, metrics, audit ─────────────────────────────

test('refuses a batch that exceeds the cost budget', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    models: {
      registry: { 'mock-embedding': { provider: 'mock', dimensions: 16, maxInputTokens: 100, costPer1kInput: 10 } },
    },
    costBudget: { enabled: true, maxEstimatedCost: 0.0001 },
  });

  await assert.rejects(() => manager.embed({ input: 'a reasonably long sentence to price' }), CostBudgetError);
  assert.equal(provider.callCount, 0);
});

test('applies the rate limit to embeddings', async () => {
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    rateLimit: { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global' },
  });

  await manager.embed({ input: 'first' });
  await assert.rejects(() => manager.embed({ input: 'second' }), NexusRateLimitError);
});

test('records embedding requests, responses, and errors as metrics', async () => {
  const sink = new InMemoryMetrics();
  const metrics = new MetricsCollector({ enabled: true, sink });
  const manager = new EmbeddingManager({ providers: { mock: new MockEmbeddingProvider() } }, { metrics });
  await manager.embed({ input: 'measured' });

  const failing = new EmbeddingManager(
    { providers: { mock: new MockEmbeddingProvider({ failOn: { attempt: 1, error: new Error('boom') } }) } },
    { metrics },
  );
  await assert.rejects(() => failing.embed({ input: 'broken' }));

  const counters = (sink.snapshot() as { counters: Record<string, number> }).counters;
  const keys = Object.keys(counters);
  assert.ok(
    keys.some((key) => key.includes('requests') && key.includes('operation=embed')),
    `expected an embed request counter, got ${keys.join(', ')}`,
  );
  assert.ok(keys.some((key) => key.includes('responses') && key.includes('operation=embed')));
  assert.ok(keys.some((key) => key.includes('errors') && key.includes('operation=embed')));
});

test('writes audit events for an embedding call', async () => {
  const events: AuditLogEvent[] = [];
  const manager = new EmbeddingManager(
    { providers: { mock: new MockEmbeddingProvider() } },
    { auditLogger: new AuditLogger({ enabled: true, sink: (event) => void events.push(event) }) },
  );

  await manager.embed({ input: 'audited', userId: 'user-1' });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'request');
  assert.equal(events[1]?.type, 'response');
  assert.equal(events[0]?.userId, 'user-1');
});

// ── Retry, failover, cancellation ──────────────────────────────────

test('retries a retryable provider error and reports the retry', async () => {
  const provider = new MockEmbeddingProvider({
    failOn: {
      attempt: 1,
      error: new NexusProviderError({
        provider: 'mock',
        model: 'mock-embedding',
        message: 'rate limited',
        status: 429,
      }),
    },
  });
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  });

  const response = await manager.embed({ input: 'retried' });
  assert.equal(response.vectors.length, 1);
  assert.equal(provider.callCount, 2);
  assert.equal(response.meta.retries, 1);
});

test('does not retry a validation error', async () => {
  const provider = new MockEmbeddingProvider({
    failOn: { attempt: 1, error: new EmbeddingValidationError('bad request') },
  });
  const manager = new EmbeddingManager({
    providers: { mock: provider },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
  });

  await assert.rejects(() => manager.embed({ input: 'x' }), EmbeddingProviderError);
  assert.equal(provider.callCount, 1);
});

test('falls over to a configured second provider', async () => {
  const primary = new MockEmbeddingProvider({
    name: 'primary',
    failOn: {
      attempt: 1,
      error: new NexusProviderError({ provider: 'primary', model: 'mock-embedding', message: 'down', status: 503 }),
    },
  });
  const secondary = new MockEmbeddingProvider({ name: 'secondary' });
  const manager = new EmbeddingManager({
    providers: { primary, secondary },
    defaultProvider: 'primary',
    fallback: [{ provider: 'secondary' }],
  });

  const response = await manager.embed({ input: 'failed over' });
  assert.equal(response.vectors.length, 1);
  assert.equal(secondary.callCount, 1);
});

test('reports every failed attempt when nothing succeeds', async () => {
  const provider = new MockEmbeddingProvider({ failOn: { attempt: 1, error: new Error('unavailable') } });
  const manager = new EmbeddingManager({ providers: { mock: provider } });

  await assert.rejects(
    () => manager.embed({ input: 'x' }),
    (error: unknown) => error instanceof EmbeddingProviderError && /unavailable/.test(error.message),
  );
});

test('an aborted signal stops the call', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new MockEmbeddingProvider();
  const manager = new EmbeddingManager({ providers: { mock: provider } });

  await assert.rejects(() => manager.embed({ input: 'x', signal: controller.signal }));
});

test('a timeout aborts a slow provider call', async () => {
  const provider = new MockEmbeddingProvider({ latencyMs: 200 });
  const manager = new EmbeddingManager({ providers: { mock: provider }, timeoutMs: 10 });

  await assert.rejects(() => manager.embed({ input: 'x' }));
});

// ── Routing ────────────────────────────────────────────────────────

test('routes by the model registry when no provider is named', async () => {
  const openai = new MockEmbeddingProvider({ name: 'openai' });
  const cohere = new MockEmbeddingProvider({ name: 'cohere' });
  const manager = new EmbeddingManager({ providers: { openai, cohere } });

  const response = await manager.embed({ input: 'x', model: 'embed-v4.0' });
  assert.equal(response.meta.providerUsed, 'cohere');
  assert.equal(cohere.callCount, 1);
  assert.equal(openai.callCount, 0);
});

test('an explicit model never silently runs on another provider', async () => {
  const cohere = new MockEmbeddingProvider({ name: 'cohere' });
  const manager = new EmbeddingManager({ providers: { cohere } });

  await assert.rejects(
    () => manager.embed({ input: 'x', model: 'text-embedding-3-small' }),
    EmbeddingProviderNotFoundError,
  );
});

test('falls back to the adapter default model when the request names none', async () => {
  const provider = new MockEmbeddingProvider({ name: 'local', defaultModel: 'local-model' });
  const manager = new EmbeddingManager({ providers: { local: provider } });

  const response = await manager.embed({ input: 'x' });
  assert.equal(response.meta.modelUsed, 'local-model');
  assert.equal(provider.calls[0]?.model, 'local-model');
});

test('reports a clear error when nothing is registered', async () => {
  const manager = new EmbeddingManager();
  await assert.rejects(() => manager.embed({ input: 'x' }), EmbeddingProviderNotFoundError);
});

test('rejects an unregistered provider name', async () => {
  const { manager } = mockManager();
  await assert.rejects(() => manager.embed({ input: 'x', provider: 'nope' }), EmbeddingProviderNotFoundError);
});

// ── Registry ───────────────────────────────────────────────────────

test('resolves aliases to concrete models', () => {
  assert.equal(resolveEmbeddingModel('auto').model, 'text-embedding-3-small');
  assert.equal(resolveEmbeddingModel('embed-quality').model, 'text-embedding-3-large');
  assert.equal(resolveEmbeddingModel('embed-quality').providerName, 'openai');
});

test('an application alias overrides a bundled one', () => {
  const resolved = resolveEmbeddingModel('auto', { aliases: { auto: 'embed-v4.0' } });
  assert.equal(resolved.model, 'embed-v4.0');
  assert.equal(resolved.providerName, 'cohere');
});

test('every bundled embedding entry declares usable metadata', () => {
  for (const [name, capabilities] of Object.entries(KNOWN_EMBEDDING_MODELS)) {
    assert.ok(capabilities.provider, `${name} should name a provider`);
    assert.ok(capabilities.dimensions > 0, `${name} should declare a positive vector size`);
    assert.ok(capabilities.maxInputTokens > 0, `${name} should declare an input limit`);
    assert.ok(capabilities.costPer1kInput >= 0, `${name} should declare a price`);
  }
});

test('lists models overall and per provider', () => {
  const all = listEmbeddingModels();
  assert.ok(all.includes('text-embedding-3-small'));
  assert.deepEqual(listEmbeddingModelsForProvider('cohere'), [
    'embed-english-v3.0',
    'embed-multilingual-v3.0',
    'embed-v4.0',
  ]);
});

test('bundled defaults can be replaced entirely', () => {
  const registry = { only: { provider: 'x', dimensions: 2, maxInputTokens: 10, costPer1kInput: 0 } };
  const resolved = resolveEmbeddingModel('text-embedding-3-small', { includeDefaults: false, registry });
  assert.equal(resolved.capabilities, undefined);
});

// ── Adapters ───────────────────────────────────────────────────────

test('the OpenAI adapter maps the request and restores index order', async () => {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const provider = new OpenAIEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch(
      {
        model: 'text-embedding-3-small',
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      },
      (url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
      },
    ),
  });

  const result = await provider.embed(
    { input: ['a', 'b'], model: 'text-embedding-3-small', dimensions: 2, user: 'u1' },
    callContext(),
  );

  assert.equal(captured?.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(captured?.body.dimensions, 2);
  assert.equal(captured?.body.user, 'u1');
  assert.deepEqual(result.vectors, [
    [1, 2],
    [3, 4],
  ]);
  assert.equal(result.usage?.inputTokens, 7);
});

test('the OpenAI adapter decodes base64 vectors', async () => {
  const floats = new Float32Array([0.5, -0.25]);
  const encoded = Buffer.from(floats.buffer).toString('base64');
  const provider = new OpenAIEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch({ data: [{ index: 0, embedding: encoded }] }),
  });

  const result = await provider.embed(
    { input: ['a'], model: 'text-embedding-3-small', encodingFormat: 'base64' },
    callContext(),
  );
  assert.deepEqual(result.vectors, [[0.5, -0.25]]);
});

test('providerOptions reach the OpenAI request body untouched', async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAIEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch({ data: [{ index: 0, embedding: [1] }] }, (_url, init) => {
      body = JSON.parse(String(init.body));
    }),
  });

  await provider.embed(
    { input: ['a'], model: 'text-embedding-3-small', providerOptions: { future_flag: true } },
    callContext(),
  );
  assert.equal(body?.future_flag, true);
});

test('the Google adapter maps input types to task types', async () => {
  let body: { requests: Array<Record<string, unknown>> } | undefined;
  const provider = new GoogleEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch({ embeddings: [{ values: [1, 2] }] }, (_url, init) => {
      body = JSON.parse(String(init.body));
    }),
  });

  const result = await provider.embed(
    { input: ['a'], model: 'gemini-embedding-001', inputType: 'query', dimensions: 2 },
    callContext(),
  );

  assert.equal(body?.requests[0]?.taskType, 'RETRIEVAL_QUERY');
  assert.equal(body?.requests[0]?.outputDimensionality, 2);
  assert.deepEqual(result.vectors, [[1, 2]]);
  assert.equal(result.usage, undefined);
});

test('the Cohere adapter reads the float embedding list', async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new CohereEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch({ embeddings: { float: [[1, 2]] }, meta: { billed_units: { input_tokens: 4 } } }, (_url, init) => {
      body = JSON.parse(String(init.body));
    }),
  });

  const result = await provider.embed(
    { input: ['a'], model: 'embed-v4.0', inputType: 'query', truncate: 'end' },
    callContext(),
  );

  assert.equal(body?.input_type, 'search_query');
  assert.equal(body?.truncate, 'END');
  assert.deepEqual(result.vectors, [[1, 2]]);
  assert.equal(result.usage?.inputTokens, 4);
});

test('the Mistral adapter targets its own base URL', async () => {
  let url: string | undefined;
  const provider = new MistralEmbeddingProvider({
    apiKey: 'key',
    fetch: jsonFetch({ data: [{ index: 0, embedding: [1] }] }, (requestUrl) => {
      url = requestUrl;
    }),
  });

  await provider.embed({ input: ['a'], model: 'mistral-embed' }, callContext());
  assert.equal(url, 'https://api.mistral.ai/v1/embeddings');
  assert.equal(provider.info.name, 'mistral');
  assert.equal(provider.info.capabilities.dimensions, false);
});

test('the Ollama adapter reads its embeddings array', async () => {
  const provider = new OllamaEmbeddingProvider({
    fetch: jsonFetch({ embeddings: [[1, 2, 3]], prompt_eval_count: 9 }),
  });

  const result = await provider.embed({ input: ['a'], model: 'nomic-embed-text' }, callContext());
  assert.deepEqual(result.vectors, [[1, 2, 3]]);
  assert.equal(result.usage?.inputTokens, 9);
  assert.equal(provider.info.isLocal, true);
});

test('an adapter surfaces an HTTP failure as a retryable provider error', async () => {
  const provider = new OpenAIEmbeddingProvider({
    apiKey: 'key',
    fetch: (async () => new Response('server exploded', { status: 503 })) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => provider.embed({ input: ['a'], model: 'text-embedding-3-small' }, callContext()),
    (error: unknown) => error instanceof NexusProviderError && error.retryable,
  );
});

test('an adapter rejects a response with no vectors', async () => {
  const provider = new OpenAIEmbeddingProvider({ apiKey: 'key', fetch: jsonFetch({}) });
  await assert.rejects(
    () => provider.embed({ input: ['a'], model: 'text-embedding-3-small' }, callContext()),
    EmbeddingProviderResponseError,
  );
});

// ── Conformance harness ────────────────────────────────────────────

test('the mock adapter passes the embedding conformance harness', async () => {
  const results = await runEmbeddingProviderConformance('mock', new MockEmbeddingProvider(), {
    testDeterminism: true,
  });

  for (const result of results) {
    assert.equal(result.ok, true, `${result.caseName} failed: ${result.error}`);
  }
});

test('the harness catches an adapter that returns the wrong number of vectors', async () => {
  const broken: EmbeddingsProvider = {
    info: { name: 'broken', defaultModel: 'broken-model', capabilities: {} },
    async embed(): Promise<EmbeddingProviderResult> {
      return { vectors: [[1, 2]] };
    },
  };

  const results = await runEmbeddingProviderConformance('broken', broken);
  const batch = results.find((result) => result.caseName === 'batch-input');
  assert.equal(batch?.ok, false);
  assert.match(String(batch?.error), /expected 3 vectors/);
});

// ── Integration ────────────────────────────────────────────────────

test('NexusAI exposes embed(), embedOne(), and provider registration', async () => {
  const ai = new NexusAI({ providers: {} });
  ai.registerEmbeddingProvider('mock', new MockEmbeddingProvider());

  assert.equal(ai.hasEmbeddingProvider('mock'), true);
  assert.deepEqual(ai.listEmbeddingProviders(), ['mock']);

  const response = await ai.embed({ input: ['a', 'b'] });
  assert.equal(response.vectors.length, 2);

  const single = await ai.embedOne('a');
  assert.deepEqual(single, response.vectors[0]);
});

test('the embeddings manager is built once and only on first use', () => {
  const ai = new NexusAI({ providers: {} });
  assert.equal(ai.embeddings, ai.embeddings);
});

test('configured chat credentials register embedding adapters automatically', () => {
  const created = createConfiguredEmbeddingProviders({
    openai: { apiKey: 'a' },
    cohere: { apiKey: 'b' },
    ollama: {},
  });

  assert.deepEqual(
    created.map(([name]) => name),
    ['openai', 'cohere', 'ollama'],
  );
});

test('auto-registration can be turned off', () => {
  const ai = new NexusAI({ providers: { openai: { apiKey: 'a' } }, embeddings: { autoRegisterProviders: false } });
  assert.deepEqual(ai.listEmbeddingProviders(), []);
});

test('an explicitly registered provider wins over an auto-registered one', () => {
  const ai = new NexusAI({ providers: { openai: { apiKey: 'a' } } });
  const mock = new MockEmbeddingProvider({ name: 'replacement' });
  ai.registerEmbeddingProvider('openai', mock);

  assert.equal(ai.embeddings.listEmbeddingProviders().includes('openai'), true);
});

test('toEmbeddingFunction drives a vector store through the family', async () => {
  const manager = new EmbeddingManager({ providers: { mock: new MockEmbeddingProvider({ dimensions: 64 }) } });
  const store = new MemoryVectorStore(toEmbeddingFunction(manager, { inputType: 'document' }));

  await store.add([
    { id: '1', content: 'cats purr and sleep in the sun' },
    { id: '2', content: 'distributed systems fail in partial ways' },
  ]);
  const results = await store.search('cats sleep', { topK: 1 });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, '1');
});

// ── Legacy factory functions ───────────────────────────────────────

async function withStubbedFetch<T>(
  body: unknown,
  run: (seen: { url?: string; body?: unknown }) => Promise<T>,
): Promise<T> {
  const seen: { url?: string; body?: unknown } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

test('createOpenAIEmbeddingProvider returns the embedding list', async () => {
  await withStubbedFetch({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }, async (seen) => {
    const embed = createOpenAIEmbeddingProvider({ apiKey: 'key' });
    const vectors = await embed(['a', 'b']);

    assert.equal(seen.url, 'https://api.openai.com/v1/embeddings');
    assert.deepEqual(vectors, [
      [1, 2],
      [3, 4],
    ]);
  });
});

test('createGeminiEmbeddingProvider maps to batchEmbedContents', async () => {
  await withStubbedFetch({ embeddings: [{ values: [1] }] }, async (seen) => {
    const embed = createGeminiEmbeddingProvider({ apiKey: 'key', model: 'text-embedding-004' });
    const vectors = await embed(['a']);

    assert.match(String(seen.url), /batchEmbedContents/);
    assert.deepEqual(vectors, [[1]]);
  });
});

test('createCohereEmbeddingProvider reads either embedding shape', async () => {
  await withStubbedFetch({ embeddings: { float: [[1, 2]] } }, async () => {
    const embed = createCohereEmbeddingProvider({ apiKey: 'key' });
    assert.deepEqual(await embed(['a']), [[1, 2]]);
  });
  await withStubbedFetch({ embeddings: [[3, 4]] }, async () => {
    const embed = createCohereEmbeddingProvider({ apiKey: 'key' });
    assert.deepEqual(await embed(['a']), [[3, 4]]);
  });
});

test('a legacy factory surfaces an HTTP failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  try {
    const embed = createOpenAIEmbeddingProvider({ apiKey: 'key' });
    await assert.rejects(() => Promise.resolve(embed(['a'])), /OpenAI embeddings failed: 500/);
  } finally {
    globalThis.fetch = original;
  }
});
