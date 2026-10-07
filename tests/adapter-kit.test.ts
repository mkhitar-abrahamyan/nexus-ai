/**
 * The adapter kit: every kind of adapter verified against its contract, failures normalized into one
 * vocabulary, every call reported for telemetry, and versions checked against declared ranges.
 *
 * Each contract runs against this package's own reference implementations, which must pass, and
 * against a deliberately broken one, which must fail exactly the checks it breaks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdapterError,
  type AdapterCallEvent,
  classifyAdapterError,
  defineEmbeddingsAdapter,
  defineProviderAdapter,
  defineRetrieverAdapter,
  defineStoreAdapter,
  defineVectorStoreAdapter,
  parseVersion,
  runVectorStoreContract,
  satisfiesRange,
} from '../src/adapter-kit/index.js';
import { createHashEmbeddings, MemoryVectorStore, type VectorStore } from '../src/hallucination/retrieval.js';
import { BaseProvider } from '../src/providers/base.js';
import { KeywordIndex, vectorRetriever } from '../src/rag/retrievers.js';
import { MemoryStore } from '../src/store/memory.js';
import type { EmbeddingsProvider } from '../src/types/embeddings.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../src/types/response.js';
import { NEXUS_VERSION } from '../src/version.js';

const embed = (texts: string[]) => createHashEmbeddings(texts, 256);

test('version ranges read as npm reads them', () => {
  const cases: Array<[string, string, boolean]> = [
    ['2.4.0', '>=2.4.0 <3', true],
    ['3.0.0', '>=2.4.0 <3', false],
    ['2.3.9', '>=2.4', false],
    ['2.9.1', '^2.4.0', true],
    ['3.0.0', '^2.4.0', false],
    ['0.3.5', '^0.3.1', true],
    ['0.4.0', '^0.3.1', false],
    ['0.0.4', '^0.0.3', false],
    ['2.4.9', '~2.4.1', true],
    ['2.5.0', '~2.4.1', false],
    ['2.7.0', '2.x', true],
    ['3.0.0', '2.x', false],
    ['2.4.3', '2.4.x', true],
    ['5.1.0', '*', true],
    ['2.4.0', '2.4.0', true],
    ['2.4.1', '=2.4.0', false],
    ['3.1.0', '^2.4.0 || ^3.0.0', true],
    ['2.5.0', '>2.4', true],
    ['2.4.9', '>2.4', false],
    ['2.4.9', '<=2.4', true],
    ['2.5.0', '<=2.4', false],
    ['2.4.0-beta.1', '>=2.4.0', true],
    ['not a version', '*', false],
  ];
  for (const [version, range, expected] of cases)
    assert.equal(satisfiesRange(version, range), expected, `${version} ${range}`);
  assert.deepEqual(parseVersion('v2.4.1'), [2, 4, 1]);
  assert.equal(parseVersion('2.4'), undefined);
  assert.throws(() => satisfiesRange('2.4.0', 'about two'), /not a version range/);
});

test('failures are classified by status, network code, and name, into one vocabulary', () => {
  const cases: Array<[unknown, string, boolean]> = [
    [{ status: 401 }, 'AUTH', false],
    [{ statusCode: 403 }, 'AUTH', false],
    [{ response: { status: 404 } }, 'NOT_FOUND', false],
    [{ status: 400 }, 'INVALID', false],
    [{ status: 409 }, 'CONFLICT', false],
    [{ status: 408 }, 'TIMEOUT', true],
    [{ status: 429 }, 'RATE_LIMIT', true],
    [{ status: 503 }, 'UNAVAILABLE', true],
    [{ code: 'ECONNREFUSED' }, 'UNAVAILABLE', true],
    [{ code: 'ETIMEDOUT' }, 'TIMEOUT', true],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'CANCELLED', false],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'TIMEOUT', true],
    [new Error('who knows'), 'UNKNOWN', false],
    [null, 'UNKNOWN', false],
  ];
  for (const [error, code, retryable] of cases) {
    const classified = classifyAdapterError(error);
    assert.equal(classified.code, code, JSON.stringify(error));
    assert.equal(classified.retryable, retryable, code);
  }
  assert.equal(classifyAdapterError({ status: 429 }).status, 429);
});

test('a vector-store adapter passes its contract, reports its calls, and is held to its budgets', async () => {
  const memory = defineVectorStoreAdapter({
    name: 'memory-vectors',
    version: '1.0.0',
    nexus: `>=${NEXUS_VERSION}`,
    capabilities: { filters: 'typed' },
    create: () => new MemoryVectorStore(embed),
    budgets: { search: 1_000 },
  });
  assert.equal(memory.kind, 'vector-store');
  assert.equal(memory.compatible(), true);
  assert.equal(memory.compatible('1.0.0'), false);
  const report = await memory.verify(undefined, { embed });
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((check) => !check.ok)));
  assert.equal(report.compatible, true);
  assert.ok(
    report.checks.some(
      (check) => check.name === 'tells a number from the same digits as text in a filter' && !check.skipped,
    ),
  );
  assert.ok((report.benchmark.search?.calls ?? 0) > 3);
  assert.ok(report.checks.some((check) => check.name === 'search stays within 1000 ms at p95' && check.ok));

  // An impossible budget fails, and an operation the contract never calls is skipped.
  const strict = defineVectorStoreAdapter({
    name: 'strict',
    version: '1.0.0',
    nexus: '*',
    capabilities: {},
    create: () => new MemoryVectorStore(embed),
    budgets: { search: -1, rebuild: 5 },
  });
  const strictReport = await strict.verify(undefined, { embed });
  assert.equal(strictReport.passed, false);
  assert.match(strictReport.checks.find((check) => check.name.startsWith('search stays'))?.detail ?? '', /measured/);
  assert.equal(strictReport.checks.find((check) => check.name.startsWith('rebuild'))?.skipped, true);

  // A store outside its declared range is reported incompatible, whatever its contract says.
  const old = defineVectorStoreAdapter({
    name: 'old',
    version: '0.1.0',
    nexus: '^1.0.0',
    capabilities: {},
    create: () => new MemoryVectorStore(embed),
  });
  const oldReport = await old.verify(undefined, { embed });
  assert.equal(oldReport.compatible, false);
  assert.equal(oldReport.passed, false);
  assert.match(oldReport.checks[0]?.detail ?? '', /\^1\.0\.0/);
});

test('a broken store fails exactly the checks it breaks, and a missing capability is skipped', async () => {
  /** Ignores filters, keeps duplicates on re-add, and never deletes. */
  class Careless implements VectorStore {
    private readonly inner = new MemoryVectorStore(embed);
    private readonly rows: Parameters<VectorStore['add']>[0] = [];
    async add(documents: Parameters<VectorStore['add']>[0]) {
      this.rows.push(...documents);
      await this.inner.add(documents.map((doc, index) => ({ ...doc, id: `${doc.id}~${this.rows.length + index}` })));
    }
    async search(query: string, options: Parameters<VectorStore['search']>[1] = {}) {
      const results = await this.inner.search(query, { ...options, filter: undefined });
      return results.map((result) => ({ ...result, id: result.id.split('~')[0] as string }));
    }
    async searchVector(vector: number[], options: Parameters<VectorStore['searchVector']>[1] = {}) {
      const results = await this.inner.searchVector(vector, options);
      return results.map((result) => ({ ...result, id: result.id.split('~')[0] as string }));
    }
    async delete() {}
  }
  const checks = await runVectorStoreContract(new Careless(), { embed, capabilities: { searchVector: false } });
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  assert.deepEqual(failed, [
    'narrows a search by metadata',
    'replaces a passage added again under its id',
    'deletes by id, ignoring ids it does not hold',
  ]);
  assert.equal(checks.find((check) => check.name === 'searches by a precomputed vector')?.skipped, true);
  const throwing = await runVectorStoreContract(
    {
      add: async () => Promise.reject(new Error('disk full')),
      search: async () => [],
      searchVector: async () => [],
      delete: async () => {},
    },
    { embed },
  );
  assert.equal(throwing[0]?.ok, false);
  assert.equal(throwing[0]?.detail, 'disk full', 'a thrown error fails its check and the suite carries on');
});

test('instances normalize every failure and report every call, with private fields intact', async () => {
  class Remote {
    #calls = 0;
    async search() {
      this.#calls += 1;
      throw Object.assign(new Error('slow down'), { status: 429 });
    }
    async add() {
      this.#calls += 1;
      throw Object.assign(new Error('teapot'), { status: 418, vendorCode: 'QUOTA' });
    }
    async searchVector() {
      return [];
    }
    async delete() {}
    calls() {
      return this.#calls;
    }
  }
  const events: AdapterCallEvent[] = [];
  const adapter = defineVectorStoreAdapter({
    name: 'remote',
    version: '1.0.0',
    nexus: '*',
    capabilities: {},
    create: () => new Remote() as unknown as VectorStore & Remote,
    normalizeError: (error) =>
      (error as { vendorCode?: string }).vendorCode === 'QUOTA' ? { code: 'RATE_LIMIT', retryable: true } : undefined,
  });
  const store = await adapter.create(undefined, { onCall: (event) => events.push(event) });
  await assert.rejects(store.search('x'), (error: unknown) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'RATE_LIMIT');
    assert.equal(error.retryable, true);
    assert.equal(error.status, 429);
    assert.equal(error.operation, 'search');
    assert.match(error.message, /remote search failed \(RATE_LIMIT\): slow down/);
    return true;
  });
  await assert.rejects(
    store.add([]),
    (error: unknown) => (error as AdapterError).code === 'RATE_LIMIT',
    'the adapter’s own reading wins',
  );
  assert.deepEqual(await store.searchVector([1]), []);
  assert.equal(store.calls(), 2, 'a method the kit does not wrap still sees the instance’s private fields');
  assert.deepEqual(
    events.map((event) => [event.operation, event.ok, event.error?.code]),
    [
      ['search', false, 'RATE_LIMIT'],
      ['add', false, 'RATE_LIMIT'],
      ['searchVector', true, undefined],
    ],
  );
  assert.ok(
    events.every((event) => event.adapter === 'remote' && event.kind === 'vector-store' && event.durationMs >= 0),
  );

  assert.throws(
    () => defineStoreAdapter({ name: '', version: '1', nexus: '*', capabilities: {}, create: () => new MemoryStore() }),
    /needs a name/,
  );
  assert.throws(
    () =>
      defineStoreAdapter({
        name: 'x',
        version: '1',
        nexus: 'whenever',
        capabilities: {},
        create: () => new MemoryStore(),
      }),
    /not a version range/,
  );
});

test('retriever and store adapters pass their contracts, with or without writes', async () => {
  const keywords = defineRetrieverAdapter({
    name: 'bm25',
    version: '1.0.0',
    nexus: '*',
    capabilities: {},
    create: () => new KeywordIndex(),
  });
  const sparse = await keywords.verify(undefined, {});
  assert.equal(sparse.passed, true, JSON.stringify(sparse.checks.filter((check) => !check.ok)));
  assert.ok(
    sparse.checks.some((check) => check.name === 'deletes by id, ignoring ids it does not hold' && !check.skipped),
  );

  const backing = new MemoryVectorStore(embed);
  const dense = defineRetrieverAdapter({
    name: 'dense',
    version: '1.0.0',
    nexus: '*',
    capabilities: {},
    create: () => vectorRetriever(backing),
  });
  const denseReport = await dense.verify(undefined, { load: (passages) => backing.add(passages) });
  assert.equal(denseReport.passed, true, JSON.stringify(denseReport.checks.filter((check) => !check.ok)));
  assert.equal(denseReport.checks.find((check) => check.name.startsWith('replaces'))?.skipped, true);
  const unloaded = await dense.verify(undefined, {});
  assert.match(unloaded.checks.find((check) => !check.ok)?.detail ?? '', /needs a load/);

  const store = defineStoreAdapter({
    name: 'memory-store',
    version: '1.0.0',
    nexus: '*',
    capabilities: {},
    create: () => new MemoryStore(),
  });
  const storeReport = await store.verify(undefined, {});
  assert.equal(storeReport.passed, true, JSON.stringify(storeReport.checks.filter((check) => !check.ok)));
  const minimal = defineStoreAdapter({
    name: 'minimal',
    version: '1.0.0',
    nexus: '*',
    capabilities: { search: false, namespaces: false },
    create: () => new MemoryStore(),
  });
  assert.equal((await minimal.verify(undefined, {})).checks.filter((check) => check.skipped).length, 3);
});

test('provider and embeddings adapters run the conformance suites for what they declare', async () => {
  class Echo extends BaseProvider {
    readonly info = { name: 'echo', isLocal: true };
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      const base = this.createBaseResponse('echo', request.model);
      const json = request.responseFormat?.type === 'json' || request.responseFormat?.type === 'json_schema';
      return { ...base, content: json ? '{"ok":true}' : 'ok' };
    }
    stream(): NexusStream {
      return this.createStream(async function* () {
        yield { type: 'text', content: 'ok' } satisfies StreamChunk;
        yield { type: 'done' } satisfies StreamChunk;
      });
    }
  }
  const provider = defineProviderAdapter({
    name: 'echo',
    version: '1.0.0',
    nexus: '*',
    capabilities: { streaming: true, json: true, tools: false, health: true },
    create: () => new Echo(),
  });
  const providerReport = await provider.verify(undefined, { model: 'echo-1' });
  assert.equal(providerReport.passed, true, JSON.stringify(providerReport.checks.filter((check) => !check.ok)));
  assert.ok(providerReport.checks.some((check) => check.name.startsWith('streams')));
  assert.ok(providerReport.checks.some((check) => check.name === 'answers its health check'));
  assert.ok((providerReport.benchmark.complete?.calls ?? 0) >= 1);

  const vectors: EmbeddingsProvider = {
    info: { name: 'hash', defaultModel: 'hash-256', capabilities: {} },
    embed: async (request, context) => {
      context.signal?.throwIfAborted();
      return { vectors: embed(request.input) };
    },
  };
  const embeddings = defineEmbeddingsAdapter({
    name: 'hash',
    version: '1.0.0',
    nexus: '*',
    capabilities: { abort: true, deterministic: true },
    create: () => vectors,
  });
  const embeddingsReport = await embeddings.verify(undefined, {});
  assert.equal(embeddingsReport.passed, true, JSON.stringify(embeddingsReport.checks.filter((check) => !check.ok)));
  assert.ok(embeddingsReport.checks.some((check) => check.name.includes('aborted')));

  const careless = defineEmbeddingsAdapter({
    name: 'careless',
    version: '1.0.0',
    nexus: '*',
    capabilities: { abort: true, deterministic: false },
    create: (): EmbeddingsProvider => ({ ...vectors, embed: async (request) => ({ vectors: embed(request.input) }) }),
  });
  const carelessReport = await careless.verify(undefined, {});
  assert.equal(carelessReport.passed, false, 'an adapter that claims abort support and ignores the signal fails');
});
