/**
 * The embedding batch tier: the manager, its adapters' wire shapes, and ingestion through it, which
 * survives a crash between submitting a batch and writing it without submitting the batch twice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchCapabilityError, BatchValidationError } from '../src/batch/errors.js';
import { batchEmbedder, EmbeddingBatchManager, type BatchEmbedder } from '../src/embeddings/batch.js';
import { GoogleEmbeddingBatchProvider } from '../src/embeddings/batch-google.js';
import { MockEmbeddingBatchProvider } from '../src/embeddings/batch-mock.js';
import { OpenAIEmbeddingBatchProvider } from '../src/embeddings/batch-openai.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { OperationRunner } from '../src/operations/runner.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { createIngestionPipeline, type IngestionReport, ingestionExecutor } from '../src/rag/pipeline.js';
import { MemoryStore } from '../src/store/memory.js';
import type { BatchProviderCallContext } from '../src/types/batch.js';

const context = (): BatchProviderCallContext => ({
  requestId: 'test',
  signal: new AbortController().signal,
  attempt: 1,
});

test('a batch embeds what the direct call does, at the batch price', async () => {
  const texts = ['refunds take fourteen days', 'orders ship in two days', 'we are hiring'];
  const mock = new MockEmbeddingBatchProvider({ dimensions: 32, statuses: ['in_progress', 'completed'] });
  const manager = new EmbeddingBatchManager({ providers: { mock }, pollIntervalMs: 1 });
  const handle = await manager.submit({
    model: 'text-embedding-3-small',
    items: texts.map((input, index) => ({ customId: `t${index}`, input })),
  });
  const result = await handle.result();
  const direct = await new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 32 }) },
    defaultProvider: 'mock',
  }).embed({ input: texts, model: 'text-embedding-3-small' });

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    result.items.map((item) => item.vector),
    direct.vectors,
  );
  assert.deepEqual(result.counts, { total: 3, completed: 3, failed: 0 });
  assert.ok(Math.abs(result.cost.amount - direct.meta.cost.amount * 0.5) < 1e-12, 'half the direct price');
});

test('an embedding batch is checked before it is sent', async () => {
  const mock = new MockEmbeddingBatchProvider({ capabilities: { maxItems: 2 } });
  const manager = new EmbeddingBatchManager({ providers: { mock }, pollIntervalMs: 1 });
  const model = 'text-embedding-3-small';
  await assert.rejects(manager.submit({ model, items: [] }), BatchValidationError);
  await assert.rejects(
    manager.submit({
      model,
      items: [
        { customId: 'a', input: 'x' },
        { customId: 'a', input: 'y' },
      ],
    }),
    /Duplicate/,
  );
  await assert.rejects(manager.submit({ model: '', items: [{ customId: 'a', input: 'x' }] }), /concrete model/);
  await assert.rejects(
    manager.submit({ model, items: ['a', 'b', 'c'].map((customId) => ({ customId, input: customId })) }),
    BatchCapabilityError,
  );
  const image = { parts: [{ type: 'image' as const, source: { base64: 'AA==', mimeType: 'image/png' } }] };
  await assert.rejects(
    manager.submit({ model, items: [{ customId: 'a', input: image }] }),
    /takes text input, not image/,
    'text-embedding-3-small takes text, whatever the batch tier can carry',
  );
  assert.equal(mock.submitted.length, 0);
});

test('a worker that dies while it waits collects the same embedding batch, never a second', async () => {
  const mock = new MockEmbeddingBatchProvider({ statuses: ['in_progress', 'completed'] });
  let polls = 0;
  const provider = {
    info: mock.info,
    submit: mock.submit.bind(mock),
    results: mock.results.bind(mock),
    poll: async (...args: Parameters<MockEmbeddingBatchProvider['poll']>) => {
      polls += 1;
      if (polls === 1) throw new Error('the worker died while waiting');
      return mock.poll(...args);
    },
  };
  const manager = new EmbeddingBatchManager(
    { providers: { mock: provider }, pollIntervalMs: 1 },
    { operations: { store: new MemoryOperationStore(), retry: { maxAttempts: 2, baseDelayMs: 1 } } },
  );
  const handle = await manager.submit({ model: 'text-embedding-3-small', items: [{ customId: 'a', input: 'x' }] });
  assert.equal((await handle.result()).status, 'completed');
  assert.equal(mock.submitted.length, 1);
});

test('OpenAI: one /v1/embeddings line per input, and failed lines read from the error file', async () => {
  const uploads: string[] = [];
  const created: unknown[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/files') && init.method === 'POST') {
      uploads.push(await ((init.body as FormData).get('file') as Blob).text());
      return Response.json({ id: 'file-1' });
    }
    if (path.endsWith('/batches') && init.method === 'POST') {
      created.push(JSON.parse(String(init.body)));
      return Response.json({ id: 'batch-1', status: 'validating' });
    }
    if (path.endsWith('/batches/batch-1')) {
      return Response.json({ id: 'batch-1', status: 'completed', output_file_id: 'out', error_file_id: 'err' });
    }
    if (path.endsWith('/files/out/content')) {
      return new Response(
        JSON.stringify({
          custom_id: 'a',
          response: { status_code: 200, body: { data: [{ embedding: [0.6, 0.8] }], usage: { prompt_tokens: 3 } } },
        }),
      );
    }
    if (path.endsWith('/files/err/content')) {
      return new Response(
        JSON.stringify({ custom_id: 'b', response: { status_code: 400, body: { error: { message: 'too long' } } } }),
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const openai = new OpenAIEmbeddingBatchProvider({ apiKey: 'k', fetch });
  const ref = await openai.submit(
    {
      model: 'text-embedding-3-small',
      dimensions: 512,
      items: [
        { customId: 'a', input: 'alpha' },
        { customId: 'b', input: 'beta' },
      ],
    },
    context(),
  );
  assert.deepEqual(
    uploads[0]?.split('\n').map((line) => JSON.parse(line)),
    ['a', 'b'].map((customId, index) => ({
      custom_id: customId,
      method: 'POST',
      url: '/v1/embeddings',
      body: {
        model: 'text-embedding-3-small',
        input: ['alpha', 'beta'][index],
        encoding_format: 'float',
        dimensions: 512,
      },
    })),
  );
  assert.equal((created[0] as { endpoint: string }).endpoint, '/v1/embeddings');
  assert.deepEqual(await openai.results(ref, context()), [
    { customId: 'a', vector: [0.6, 0.8], inputTokens: 3 },
    { customId: 'b', error: { message: 'too long', status: 400 } },
  ]);
});

test('Google: asyncBatchEmbedContent inline, its states read, and results matched by position', async () => {
  const bodies: Array<{ path: string; body?: unknown }> = [];
  let state = 'BATCH_STATE_RUNNING';
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    bodies.push({ path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith(':asyncBatchEmbedContent')) return Response.json({ name: 'batches/abc', metadata: { state } });
    if (path.endsWith('/batches/abc')) {
      return Response.json({
        name: 'batches/abc',
        metadata: {
          state,
          batchStats: { requestCount: '2', successfulRequestCount: '1', failedRequestCount: '1' },
          output: {
            inlinedEmbedContentResponses: {
              inlinedResponses: [
                { response: { embedding: { values: [1, 0] } } },
                { error: { message: 'unsupported image', code: 3 } },
              ],
            },
          },
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const google = new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch });
  const ref = await google.submit(
    {
      model: 'gemini-embedding-2',
      inputType: 'query',
      items: [
        { customId: 'q1', input: 'red bicycle' },
        { customId: 'q2', input: '', contents: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
      ],
      metadata: { key: 'window-1' },
    },
    context(),
  );
  assert.equal(bodies[0]?.path, '/v1beta/models/gemini-embedding-2:asyncBatchEmbedContent');
  assert.deepEqual(bodies[0]?.body, {
    batch: {
      displayName: 'window-1',
      inputConfig: {
        requests: {
          requests: [
            {
              request: {
                model: 'models/gemini-embedding-2',
                content: { parts: [{ text: 'task: search result | query: red bicycle' }] },
              },
            },
            {
              request: {
                model: 'models/gemini-embedding-2',
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
              },
            },
          ],
        },
      },
    },
  });
  assert.equal((await google.poll(ref, context())).status, 'in_progress');
  state = 'BATCH_STATE_SUCCEEDED';
  const polled = await google.poll(ref, context());
  assert.equal(polled.status, 'completed');
  assert.deepEqual(polled.counts, { total: 2, completed: 1, failed: 1 });
  assert.deepEqual(await google.results(ref, context()), [
    { customId: 'q1', vector: [1, 0] },
    { customId: 'q2', error: { message: 'unsupported image', code: '3' } },
  ]);

  const huge = 'x'.repeat(11 * 1024 * 1024);
  await assert.rejects(
    google.submit(
      {
        model: 'gemini-embedding-001',
        items: [
          { customId: 'a', input: huge },
          { customId: 'b', input: huge },
        ],
      },
      context(),
    ),
    /at most 20 MB/,
  );
});

test('proof: a 100,000-chunk ingestion through a batch tier, crashed between submit and collect, never submits a window twice', async () => {
  const total = 100_000;
  const corpus = () =>
    (function* () {
      for (let index = 0; index < total; index += 1) {
        yield { id: `doc-${index}`, text: `Article ${index}: how to configure feature ${index % 97}.` };
      }
    })();
  const mock = new MockEmbeddingBatchProvider({ dimensions: 8 });
  const manager = new EmbeddingBatchManager({ providers: { mock }, pollIntervalMs: 1 });
  const tier = batchEmbedder(manager, { model: 'text-embedding-3-small', size: 10_000 });
  // The first attempt dies while it collects the third window: two are written, two more submitted.
  let collects = 0;
  const flaky: BatchEmbedder = {
    size: tier.size,
    submit: tier.submit,
    collect: async (ref, signal) => {
      collects += 1;
      if (collects === 3) throw new Error('the worker died while collecting a batch');
      return tier.collect(ref, signal);
    },
  };
  const vectors = new MemoryVectorStore();
  const pipeline = createIngestionPipeline({
    name: 'corpus',
    manifest: new MemoryStore({ maxItems: 200_000 }),
    vectors,
    batchEmbed: flaky,
    batchesInFlight: 2,
    embeddingModel: 'text-embedding-3-small',
    batchSize: 1_000,
  });
  const runner = new OperationRunner<IngestionReport>({
    store: new MemoryOperationStore(),
    retry: { maxAttempts: 2, baseDelayMs: 1 },
  });
  const handle = await runner.submit(
    ingestionExecutor(pipeline, () => corpus()),
    { idempotencyKey: 'corpus' },
  );
  const report = await handle.result();

  assert.equal(mock.submitted.length, 10, 'ten windows of 10,000 chunks, each submitted once across both attempts');
  assert.equal(report.batchesRecovered, 2, 'the retry collected the two batches the first attempt had submitted');
  assert.equal(report.batches, 6, 'and submitted only the six it had not');
  assert.equal(report.resumed, 20_000, 'it skipped the two windows already written');
  const embedded = mock.submitted.flatMap((batch) => batch.items.map((item) => item.input));
  assert.equal(new Set(embedded).size, total, 'every chunk embedded exactly once');
  assert.equal(embedded.length, total);
  assert.equal(vectors.size(), total);
  const found = await vectors.search('how to configure feature 42', { topK: 1 });
  assert.equal(found.length, 1);
});

test('ingestion through a batch tier writes nothing of a window whose batch failed an input', async () => {
  const mock = new MockEmbeddingBatchProvider({ failItems: ['1'] });
  const manager = new EmbeddingBatchManager({ providers: { mock }, pollIntervalMs: 1 });
  const vectors = new MemoryVectorStore();
  const pipeline = createIngestionPipeline({
    name: 'failing',
    manifest: new MemoryStore(),
    vectors,
    batchEmbed: batchEmbedder(manager, { model: 'text-embedding-3-small', size: 100 }),
    embeddingModel: 'text-embedding-3-small',
  });
  await assert.rejects(
    pipeline.run([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]),
    /failed input 1/,
  );
  assert.equal(vectors.size(), 0);
  assert.equal(await pipeline.document('a'), undefined, 'and records none of it');
  assert.throws(
    () => createIngestionPipeline({ name: 'x', manifest: new MemoryStore(), vectors, embeddingModel: 'm' }),
    /embed or batchEmbed/,
  );
});
