/**
 * The tenant-isolation suite: every storage adapter, seen through one tenant's view, must refuse any
 * cross-tenant get, list, search, delete, fork, resume, trace query, vector search, or cache hit.
 * Tenant A writes through its view; tenant B, through its own over the same store, must find nothing
 * and change nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { MemoryCacheAdapter, RedisCacheAdapter, SQLiteCacheAdapter } from '../src/cache/adapters.js';
import { NexusAI } from '../src/core/nexus.js';
import {
  FileDatasetStore,
  FileExperimentStore,
  MemoryDatasetStore,
  MemoryExperimentStore,
} from '../src/evaluate/datasets.js';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { appendList } from '../src/graph/channels.js';
import { GraphThreadNotFoundError, GraphValidationError } from '../src/graph/errors.js';
import { createGraph } from '../src/graph/graph.js';
import { createHashEmbeddings, MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { FilesystemAssetStore } from '../src/images/asset-stores.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import {
  PostgresDatasetStore,
  PostgresExperimentStore,
  type PostgresLikeClient,
  PostgresOperationStore,
  PostgresPromptStore,
  PostgresRollupStore,
  PostgresStore,
  PostgresTraceStore,
  PostgresVectorStore,
} from '../src/postgres/index.js';
import { FilePromptStore } from '../src/prompts/file.js';
import { MemoryPromptStore } from '../src/prompts/memory.js';
import { RedisPromptStore } from '../src/prompts/redis.js';
import { BaseProvider } from '../src/providers/base.js';
import { SqliteOperationStore, SqliteStore, SqliteVectorStore } from '../src/sqlite/index.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import {
  assertTenantId,
  tenantAssetStore,
  tenantCache,
  tenantDatasetStore,
  tenantExperimentStore,
  tenantOperationStore,
  tenantPromptStore,
  tenantRollupStore,
  tenantScope,
  tenantStore,
  tenantTraceStore,
  tenantVectorStore,
} from '../src/tenancy/index.js';
import { MemoryRollupStore } from '../src/tracing/rollups.js';
import { JsonlTraceStore, MemoryTraceStore } from '../src/tracing/stores.js';
import type { CacheAdapter } from '../src/cache/adapters.js';
import type { VectorStore } from '../src/hallucination/retrieval.js';
import type { AssetStore } from '../src/images/asset-support.js';
import type { RollupStore } from '../src/tracing/rollups.js';
import type { DatasetStore, Experiment, ExperimentStore } from '../src/types/evaluate.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { OperationRecord, OperationStore } from '../src/types/operations.js';
import type { PromptStore } from '../src/types/prompts.js';
import type { NexusResponse } from '../src/types/response.js';
import type { Store } from '../src/types/store.js';
import type { Run, TraceStore } from '../src/types/tracing.js';
import { END } from '../src/types/graph.js';
import { FakeRedis } from './redis-fake.js';

const A = 'acme';
const B = 'globex';
const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-tenants-'));
let pg: PGlite;
let client: PostgresLikeClient;
let redis: FakeRedis;
let tables = 0;
const table = (base: string) => `${base}_${++tables}`;

before(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
  client = pg as unknown as PostgresLikeClient;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function migrated<T extends { migrate(): Promise<unknown> }>(store: T): Promise<T> {
  await store.migrate();
  return store;
}

test('a tenant id cannot hold a separator, so no prefix is the start of another', () => {
  assert.equal(assertTenantId('acme-01_eu'), 'acme-01_eu');
  for (const bad of ['', 'acme/x', 'acme.x', 'a b', 'x'.repeat(129)]) {
    assert.throws(() => assertTenantId(bad), /not a valid tenant id/);
  }
  assert.throws(() => tenantStore(new MemoryStore(), 'acme/x'), /not a valid tenant id/);
});

test('long-term memory: no cross-tenant get, search, listing, or delete', async () => {
  const stores: Array<[string, Store]> = [
    ['memory', new MemoryStore()],
    ['redis', new RedisStore(redis as never, { prefix: `iso-store-${++tables}` })],
    ['postgres', await migrated(new PostgresStore(client, { table: table('iso_store') }))],
    ['sqlite', await migrated(new SqliteStore(new DatabaseSync(':memory:')))],
  ];
  for (const [name, store] of stores) {
    const a = tenantStore(store, A);
    const b = tenantStore(store, B);
    await a.put(['users', 'alice'], 'prefs', { theme: 'dark', note: 'acme secret' });
    assert.equal((await a.get(['users', 'alice'], 'prefs'))?.namespace.join('/'), 'users/alice', name);
    assert.equal(await b.get(['users', 'alice'], 'prefs'), undefined, `${name}: get`);
    assert.deepEqual(await b.search(['users']), [], `${name}: search`);
    assert.deepEqual(await b.search([], { query: 'acme secret' }), [], `${name}: text search`);
    assert.deepEqual(await b.listNamespaces(), [], `${name}: namespaces`);
    await b.delete(['users', 'alice'], 'prefs');
    assert.ok(await a.get(['users', 'alice'], 'prefs'), `${name}: delete reached only the caller's own`);
    assert.deepEqual(await a.listNamespaces(), [['users', 'alice']], `${name}: own namespaces`);
  }
});

test('traces: no cross-tenant get, query, tree, or feedback', async () => {
  const stores: Array<[string, TraceStore]> = [
    ['memory', new MemoryTraceStore()],
    ['jsonl', new JsonlTraceStore({ file: path.join(scratch, 'runs.jsonl') })],
    ['postgres', await migrated(new PostgresTraceStore(client, { table: table('iso_runs') }))],
  ];
  for (const [name, store] of stores) {
    const a = tenantTraceStore(store, A);
    const b = tenantTraceStore(store, B);
    const root = {
      id: `${name}-root`,
      traceId: `${name}-trace`,
      name: 'support',
      kind: 'chain',
      status: 'ok',
      startedAt: '2026-10-04T10:00:00.000Z',
    } as Run;
    await a.save(root);
    await a.save({ ...root, id: `${name}-child`, parentId: root.id, kind: 'model', name: 'model' } as Run);
    assert.equal((await a.get(root.id))?.metadata?.tenantId, A, `${name}: stamped`);
    assert.equal(await b.get(root.id), undefined, `${name}: get`);
    assert.deepEqual(await b.query({}), [], `${name}: query`);
    assert.deepEqual(await b.query({ traceId: root.traceId }), [], `${name}: query by trace`);
    assert.equal(await b.tree(root.traceId), undefined, `${name}: tree`);
    assert.equal((await a.tree(root.traceId))?.children.length, 1, name);
    await b.addFeedback?.(root.id, { key: 'score', score: 0, at: '2026-10-04T10:01:00.000Z' } as never);
    assert.equal((await a.get(root.id))?.feedback?.length ?? 0, 0, `${name}: feedback`);
    assert.equal((await a.query({})).length, 2, name);
  }
});

test('operations: no cross-tenant read, update, delete, idempotency replay, claim, or count', async () => {
  const stores: Array<[string, OperationStore<string>]> = [
    ['memory', new MemoryOperationStore<string>()],
    ['redis', new RedisOperationStore<string>(redis, { prefix: `iso-ops-${++tables}:` })],
    ['redis indexed', new RedisOperationStore<string>(redis, { prefix: `iso-ops-${++tables}:`, index: true })],
    ['postgres', await migrated(new PostgresOperationStore<string>(client, { table: table('iso_ops') }))],
    ['sqlite', await migrated(new SqliteOperationStore<string>(new DatabaseSync(':memory:')))],
  ];
  const record = (id: string, overrides: Partial<OperationRecord<string>> = {}): OperationRecord<string> => ({
    id,
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    sequence: 0,
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    kind: 'job',
    ...overrides,
  });
  for (const [name, store] of stores) {
    const a = tenantOperationStore(store, A);
    const b = tenantOperationStore(store, B);
    await a.create(record('op-a', { idempotencyKey: 'order-1' }));
    await b.create(record('op-b', { idempotencyKey: 'order-1', createdAt: '2026-10-04T10:00:01.000Z' }));
    assert.equal((await a.findByIdempotencyKey?.('order-1'))?.id, 'op-a', `${name}: keys do not collide`);
    assert.equal((await b.findByIdempotencyKey?.('order-1'))?.id, 'op-b', name);
    assert.equal((await a.read('op-a'))?.idempotencyKey, 'order-1', `${name}: the key reads back as given`);
    assert.equal(await b.read('op-a'), undefined, `${name}: read`);
    assert.equal(await b.update(record('op-a', { sequence: 1, status: 'running' }), 0), false, `${name}: update`);
    assert.equal(await b.delete?.('op-a'), false, `${name}: delete`);
    assert.deepEqual(
      (await b.listQueued?.(10))?.map((item) => item.id),
      ['op-b'],
      `${name}: claim`,
    );
    assert.deepEqual(
      (await b.list?.())?.map((item) => item.id),
      ['op-b'],
      `${name}: list`,
    );
    assert.deepEqual((await b.stats?.('2026-10-04T11:00:00.000Z'))?.byStatus, { queued: 1 }, `${name}: stats`);
    assert.equal((await a.read('op-a'))?.status, 'queued', `${name}: untouched`);
  }
});

test('prompts and context bundles: no cross-tenant version, label, history, or name', async () => {
  const postgres = await migrated(new PostgresPromptStore(client, { table: table('iso_prompt') }));
  const stores: Array<[string, PromptStore]> = [
    ['memory', new MemoryPromptStore()],
    ['file', new FilePromptStore(path.join(scratch, 'prompts'))],
    ['redis', new RedisPromptStore(redis as never, { prefix: `iso-prompts-${++tables}:` })],
    ['postgres', postgres],
  ];
  for (const [name, store] of stores) {
    const a = tenantPromptStore(store, A);
    const b = tenantPromptStore(store, B);
    const version = {
      name: 'support',
      version: 'v1',
      variables: [],
      createdAt: '2026-10-04T10:00:00Z',
      messages: [{ role: 'user', content: 'acme only' }],
    };
    await a.saveVersion(version as never);
    await a.setLabel({ name: 'support', label: 'production', version: 'v1', updatedAt: '2026-10-04T10:00:00Z' });
    await a.appendHistory({ name: 'support', action: 'commit', version: 'v1', at: '2026-10-04T10:00:00Z' });
    assert.equal((await a.getVersion('support', 'v1'))?.name, 'support', name);
    assert.equal(await b.getVersion('support', 'v1'), undefined, `${name}: version`);
    assert.deepEqual(await b.listVersions('support'), [], `${name}: versions`);
    assert.equal(await b.getLabel('support', 'production'), undefined, `${name}: label`);
    assert.deepEqual(await b.listHistory('support'), [], `${name}: history`);
    assert.deepEqual(await b.listNames(), [], `${name}: names`);
    assert.equal(await b.deleteLabel('support', 'production'), false, `${name}: delete`);
    assert.deepEqual(await a.listNames(), ['support'], name);
  }
});

test('datasets and experiments: no cross-tenant get or list', async () => {
  const pairs: Array<[string, DatasetStore, ExperimentStore]> = [
    ['memory', new MemoryDatasetStore(), new MemoryExperimentStore()],
    [
      'file',
      new FileDatasetStore(path.join(scratch, 'datasets')),
      new FileExperimentStore(path.join(scratch, 'experiments')),
    ],
  ];
  const evaluation = { datasetsTable: table('iso_datasets'), experimentsTable: table('iso_experiments') };
  pairs.push([
    'postgres',
    await migrated(new PostgresDatasetStore(client, evaluation)),
    new PostgresExperimentStore(client, evaluation),
  ]);
  for (const [name, datasets, experiments] of pairs) {
    const a = tenantDatasetStore(datasets, A);
    const b = tenantDatasetStore(datasets, B);
    await a.save({ name: 'tickets', version: 'v1', examples: [], createdAt: '2026-10-04T10:00:00Z' });
    assert.equal((await a.get('tickets'))?.name, 'tickets', name);
    assert.equal(await b.get('tickets'), undefined, `${name}: dataset`);
    assert.deepEqual(await b.list(), [], `${name}: datasets`);

    const ea = tenantExperimentStore(experiments, A);
    const eb = tenantExperimentStore(experiments, B);
    const experiment = {
      id: 'exp-1',
      name: 'baseline',
      dataset: { name: 'tickets', version: 'v1' },
      startedAt: '2026-10-04T10:00:00Z',
      finishedAt: '2026-10-04T10:01:00Z',
      errors: 0,
      results: [],
      metrics: [],
      summary: [],
    } as unknown as Experiment;
    await ea.save(experiment);
    assert.equal((await ea.get('exp-1'))?.dataset.name, 'tickets', name);
    assert.equal(await eb.get('exp-1'), undefined, `${name}: experiment`);
    assert.deepEqual(await eb.list(), [], `${name}: experiments`);
    assert.deepEqual(await eb.list({ dataset: 'tickets' }), [], `${name}: by dataset`);
    assert.equal((await ea.list({ dataset: 'tickets' })).length, 1, name);
  }
});

test("vector search: another tenant's chunks are never ranked, and delete reaches only the caller's", async () => {
  const embed = (texts: string[]) => createHashEmbeddings(texts, 8);
  const stores: Array<[string, VectorStore]> = [
    ['memory', new MemoryVectorStore(embed)],
    [
      'postgres',
      await migrated(
        new PostgresVectorStore(client, { dimensions: 8, embed, table: table('iso_vectors'), index: 'none' }),
      ),
    ],
    ['sqlite', await migrated(new SqliteVectorStore(new DatabaseSync(':memory:'), { dimensions: 8, embed }))],
  ];
  for (const [name, store] of stores) {
    const a = tenantVectorStore(store, A);
    const b = tenantVectorStore(store, B);
    await a.add([{ id: 'refund-policy', content: 'acme refunds within thirty days', metadata: { lang: 'en' } }]);
    await b.add([{ id: 'other', content: 'globex shipping times' }]);
    const own = await a.search('refunds within thirty days', { topK: 5 });
    assert.deepEqual(
      own.map((result) => result.id),
      ['refund-policy'],
      `${name}: ids read back as given`,
    );
    assert.deepEqual(own[0]?.metadata, { lang: 'en' }, `${name}: metadata reads back as given`);
    assert.deepEqual(
      (await b.search('refunds within thirty days', { topK: 5 })).map((result) => result.id),
      ['other'],
      `${name}: search`,
    );
    await b.delete(['refund-policy']);
    assert.equal((await a.search('refunds', { topK: 5 })).length, 1, `${name}: delete`);
  }
});

test("caches: no cross-tenant hit, and a client never answers one tenant from another's entry", async () => {
  const caches: Array<[string, CacheAdapter<string>]> = [
    ['memory', new MemoryCacheAdapter<string>()],
    ['redis', new RedisCacheAdapter<string>(redis as never, `iso-cache-${++tables}:`)],
    ['sqlite', new SQLiteCacheAdapter<string>(new DatabaseSync(':memory:') as never)],
  ];
  for (const [name, cache] of caches) {
    const a = tenantCache(cache, A);
    const b = tenantCache(cache, B);
    await a.set('answer', 'acme answer', 60);
    assert.equal(await a.get('answer'), 'acme answer', name);
    assert.equal(await b.get('answer'), undefined, `${name}: hit`);
    await b.delete?.('answer');
    assert.equal(await a.get('answer'), 'acme answer', `${name}: delete`);
  }

  for (const strategy of ['exact', 'semantic', 'hybrid'] as const) {
    let calls = 0;
    const ai = new NexusAI({ providers: {}, security: 'off', cache: { enabled: true, strategy } });
    ai.registerProvider('openai', new Echo(() => (calls += 1)));
    const ask = (tenantId: string): CompletionRequest => ({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is our refund policy?' }],
      tenantId,
    });
    const first = await ai.complete(ask(A));
    assert.equal(first.meta.cache?.outcome, 'miss', `${strategy}: the first ask is a miss`);
    assert.equal((await ai.complete(ask(A))).meta.cache?.outcome, 'hit', `${strategy}: the same tenant hits`);
    const other = await ai.complete(ask(B));
    assert.equal(other.meta.cacheHit, false, `${strategy}: another tenant is not answered from the cache`);
    assert.equal(calls, 2, strategy);
  }
});

test("assets and rollups: no cross-tenant read, and a tenant's rollups count only its runs", async () => {
  const stores: Array<[string, AssetStore]> = [
    ['memory', new MemoryAssetStore()],
    ['filesystem', new FilesystemAssetStore({ directory: path.join(scratch, 'assets') })],
  ];
  for (const [name, store] of stores) {
    const a = tenantAssetStore(store, A);
    const b = tenantAssetStore(store, B);
    const stat = await a.put(
      { location: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) }, mimeType: 'image/png' } as never,
      { provenance: { provider: 'mock', operation: 'generate', requestId: 'r' } } as never,
    );
    assert.ok(await a.get(stat.assetId), name);
    assert.equal(await b.get(stat.assetId), undefined, `${name}: get`);
    assert.equal(await b.stat(stat.assetId), undefined, `${name}: stat`);
    assert.equal(await b.delete(stat.assetId), undefined, `${name}: delete`);
    assert.ok(await a.stat(stat.assetId), name);
  }

  const rollupStores: Array<[string, RollupStore]> = [
    ['memory', new MemoryRollupStore()],
    ['postgres', await migrated(new PostgresRollupStore(client, { table: table('iso_rollups') }))],
  ];
  for (const [name, store] of rollupStores) {
    const key = {
      hour: '2026-10-04T10:00:00.000Z',
      kind: 'model' as const,
      name: '',
      model: 'm',
      provider: 'p',
      tenant: '',
    };
    const totals = { runs: 1, errors: 0, cost: 1, inputTokens: 0, outputTokens: 0, latency: [] };
    await tenantRollupStore(store, A).add(key, totals);
    await tenantRollupStore(store, B).add({ ...key, tenant: A }, totals);
    assert.equal((await tenantRollupStore(store, A).query()).length, 1, `${name}: a tenant cannot write as another`);
    assert.equal(
      (await tenantRollupStore(store, B).query({ tenant: A })).every((row) => row.tenant === B),
      true,
      name,
    );
  }
});

test('graphs: no cross-tenant resume, continue, fork, state, history, edit, or store read', async () => {
  const checkpointers = [
    ['memory', new MemoryGraphCheckpointer()],
    [
      'postgres',
      new OperationStoreCheckpointer(
        (await migrated(new PostgresOperationStore(client, { table: table('iso_threads') }))) as never,
      ),
    ],
  ] as const;
  for (const [name, checkpointer] of checkpointers) {
    const store = new MemoryStore();
    const graph = createGraph({ channels: { log: appendList<string>() } })
      .addNode('remember', async (context) => {
        await context.store?.put(['notes'], 'last', { by: context.tenantId });
        const answer = context.interrupt<string>({ reason: 'approve?' });
        return { log: [`${context.tenantId}:${answer}`] };
      })
      .addEdge('remember', END)
      .setEntry('remember')
      .compile({ checkpointer, store });

    const paused = await graph.invoke({}, { threadId: `${name}-t1`, tenantId: A });
    assert.equal(paused.status, 'awaiting_input', name);
    assert.equal((await graph.state(`${name}-t1`))?.metadata?.tenantId, A, `${name}: checkpoints carry the tenant`);
    assert.equal((await tenantStore(store, A).get(['notes'], 'last'))?.value instanceof Object, true, name);
    assert.equal(await tenantStore(store, B).get(['notes'], 'last'), undefined, `${name}: the store is the tenant's`);

    await assert.rejects(
      graph.resumeWith(`${name}-t1`, 'yes', { tenantId: B }),
      GraphThreadNotFoundError,
      `${name}: resume`,
    );
    await assert.rejects(
      (async () => {
        for await (const _event of graph.continue(`${name}-t1`, { tenantId: B })) {
          // nothing should run
        }
      })(),
      GraphThreadNotFoundError,
      `${name}: continue`,
    );
    await assert.rejects(graph.fork(`${name}-t1`, { tenantId: B }), GraphThreadNotFoundError, `${name}: fork`);
    await assert.rejects(
      graph.updateState(`${name}-t1`, { log: ['x'] }, { tenantId: B }),
      GraphThreadNotFoundError,
      `${name}: edit`,
    );
    assert.equal(await graph.state(`${name}-t1`, undefined, { tenantId: B }), undefined, `${name}: state`);
    assert.deepEqual(await graph.history(`${name}-t1`, 10, { tenantId: B }), [], `${name}: history`);
    await assert.rejects(
      graph.invoke({}, { threadId: `${name}-t1`, tenantId: B }),
      GraphValidationError,
      `${name}: reuse`,
    );

    // The owner resumes without naming the tenant again, and the run keeps it.
    const done = await graph.resumeWith(`${name}-t1`, 'yes');
    assert.deepEqual(done.state.log, [`${A}:yes`], name);
    const forked = await graph.fork(`${name}-t1`, { tenantId: A });
    assert.equal((await graph.state(forked))?.metadata?.tenantId, A, `${name}: a fork keeps the tenant`);
  }
});

test('tenantScope builds every view at once and keeps the stores it was not asked to scope', async () => {
  const shared = { store: new MemoryStore(), traces: new MemoryTraceStore(), extra: 'kept' };
  const a = tenantScope(A, shared);
  const b = tenantScope(B, shared);
  await a.store.put(['x'], 'k', 1);
  assert.equal(await b.store.get(['x'], 'k'), undefined);
  assert.equal(a.extra, 'kept');
  assert.equal(a.tenantId, A);
});

/** A provider that answers every request with the same text, counting calls. */
class Echo extends BaseProvider {
  readonly info = { name: 'openai', isLocal: false };

  constructor(private readonly onCall: () => void) {
    super();
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    this.onCall();
    return {
      content: `answer for ${request.tenantId ?? 'nobody'}`,
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: 'local',
        providerUsed: 'openai',
        modelUsed: request.model,
        latencyMs: 1,
        tokensInput: 1,
        tokensOutput: 1,
        tokensSaved: 0,
        cacheHit: false,
        guardrailsApplied: [],
      },
    } as NexusResponse;
  }

  stream(): never {
    throw new Error('not streamed');
  }
}
