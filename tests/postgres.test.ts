import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createDataset, MemoryDatasetStore, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { evaluate } from '../src/evaluate/run.js';
import { OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { lastValue, appendList } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { CircuitBreaker } from '../src/ops/circuit-breaker.js';
import { MemoryCircuitStateStore } from '../src/ops/circuit-store.js';
import { OperationDuplicateError, OperationSerializationError } from '../src/operations/errors.js';
import { OperationRunner } from '../src/operations/runner.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import {
  fromPostgresJs,
  PostgresCircuitStateStore,
  PostgresDatasetStore,
  PostgresExperimentStore,
  type PostgresLikeClient,
  PostgresOperationStore,
  PostgresStore,
  PostgresTraceStore,
  postgresMigration,
} from '../src/postgres/index.js';
import { quoteTable } from '../src/postgres/client.js';
import { MemoryStore } from '../src/store/memory.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { END } from '../src/types/graph.js';
import type { OperationRecord, OperationStore } from '../src/types/operations.js';
import type { Store } from '../src/types/store.js';
import type { Run, TraceStore } from '../src/types/tracing.js';

// PGlite is PostgreSQL compiled to WebAssembly: real SQL semantics, jsonb, and pgvector, in process,
// with no server — so these tests run in every CI job rather than only where a database exists.
let db: PGlite;
let client: PostgresLikeClient;
let tables = 0;
const table = (base: string) => `${base}_${++tables}`;

before(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  client = db as unknown as PostgresLikeClient;
});
after(async () => {
  await db.close();
});

// ── Operation store ────────────────────────────────────────────────

function record(overrides: Partial<OperationRecord<string>> = {}): OperationRecord<string> {
  return {
    id: 'op-1',
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    sequence: 0,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

async function operationStores(): Promise<Array<[string, OperationStore<string>]>> {
  const postgres = new PostgresOperationStore<string>(client, { table: table('ops') });
  await postgres.migrate();
  await postgres.migrate(); // idempotent
  return [
    ['memory', new MemoryOperationStore<string>()],
    ['postgres', postgres],
  ];
}

test('the Postgres operation store keeps the operation store contract', async () => {
  for (const [name, store] of await operationStores()) {
    await store.create(record({ idempotencyKey: 'charge-42', metadata: { note: "it's quoted" } }));
    assert.equal((await store.read('op-1'))?.metadata?.note, "it's quoted", name);
    assert.equal(await store.update(record({ sequence: 1, status: 'running' }), 0), true, name);
    assert.equal(await store.update(record({ sequence: 2, status: 'running' }), 0), false, `${name}: stale write`);
    assert.equal((await store.read('op-1'))?.sequence, 1, name);
    assert.equal((await store.findByIdempotencyKey?.('charge-42'))?.id, 'op-1', name);

    const now = '2026-09-21T01:00:00.000Z';
    await store.create(
      record({
        id: 'lapsed',
        status: 'running',
        lease: { owner: 'w', expiresAt: '2026-09-21T00:30:00.000Z' },
      } as never),
    );
    await store.create(
      record({ id: 'held', status: 'running', lease: { owner: 'w', expiresAt: '2026-09-21T02:00:00.000Z' } } as never),
    );
    await store.create(record({ id: 'orphan', status: 'running' }));
    await store.create(
      record({
        id: 'done',
        status: 'succeeded',
        lease: { owner: 'w', expiresAt: '2026-09-21T00:00:00.000Z' },
      } as never),
    );
    const expired = ((await store.claimExpired?.(now, 10)) ?? []).map((item) => item.id).sort();
    assert.deepEqual(expired, ['lapsed', 'op-1', 'orphan'], name);

    assert.equal(await store.delete?.('orphan'), true, name);
    assert.equal(await store.delete?.('orphan'), false, name);
    assert.equal(((await store.list?.()) ?? []).length, 4, name);
    await assert.rejects(
      async () => store.create(record({ id: 'bytes', result: new Uint8Array([1]) as never })),
      OperationSerializationError,
      name,
    );
  }
});

test('Postgres enforces unique idempotency keys, which closes the race between two workers', async () => {
  const store = new PostgresOperationStore<string>(client, { table: table('ops') });
  await store.migrate();
  await store.create(record({ id: 'first', idempotencyKey: 'k' }));
  await assert.rejects(store.create(record({ id: 'second', idempotencyKey: 'k' })), OperationDuplicateError);

  // Two runners look up the key at the same moment, both find nothing, and both try to create.
  const raced = new PostgresOperationStore<string>(client, { table: table('ops') });
  await raced.migrate();
  let arrived = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racing: OperationStore<string> = Object.assign(Object.create(raced), {
    findByIdempotencyKey: async (key: string) => {
      const found = await raced.findByIdempotencyKey(key);
      arrived += 1;
      if (arrived === 2) release();
      if (arrived <= 2) await barrier;
      return found;
    },
  });

  let executions = 0;
  const executor = async () => {
    executions += 1;
    return 'charged once';
  };
  const [one, two] = await Promise.all([
    new OperationRunner<string>({ store: racing }).submit(executor, { idempotencyKey: 'pay-7' }),
    new OperationRunner<string>({ store: racing }).submit(executor, { idempotencyKey: 'pay-7' }),
  ]);
  assert.equal(one.id, two.id, 'the loser attached to the winner');
  assert.equal(await one.result(), 'charged once');
  assert.equal(await two.result(), 'charged once');
  assert.equal(executions, 1);
});

test('a graph thread started on one worker is finished by another through Postgres', async () => {
  const shared = { table: table('graph_ops') };
  await new PostgresOperationStore(client, shared).migrate();

  const build = () =>
    createGraph({ channels: { log: appendList<string>(), approved: lastValue(false) } })
      .addNode('draft', () => ({ log: ['drafted'] }))
      .addNode('approve', ({ interrupt }) => ({
        approved: interrupt<boolean>({ reason: 'ship it?' }),
        log: ['reviewed'],
      }))
      .addEdge('draft', 'approve')
      .addEdge('approve', END)
      .setEntry('draft')
      // Each worker has its own client objects; only the database is shared.
      .compile({ checkpointer: new OperationStoreCheckpointer(new PostgresOperationStore(client, shared) as never) });

  const workerA = build();
  const paused = await workerA.invoke({}, { threadId: 'order-991' });
  assert.equal(paused.status, 'awaiting_input');

  const workerB = build();
  const finished = await workerB.resumeWith('order-991', true);
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.state.log, ['drafted', 'reviewed']);
  assert.equal(finished.state.approved, true);
  assert.equal((await workerB.history('order-991')).length >= 2, true);
});

// ── Long-term store ────────────────────────────────────────────────

/** Deterministic embeddings: a vector of letter counts, so similar words are close. */
async function embed(texts: string[]): Promise<number[][]> {
  return texts.map((text) => {
    const counts = [0, 0, 0, 0];
    for (const character of text.toLowerCase()) {
      if ('aeiou'.includes(character)) counts[0] += 1;
      else if (character === ' ') counts[1] += 1;
      else if ('tea'.includes(character)) counts[2] += 1;
      else counts[3] += 1;
    }
    return counts;
  });
}

async function memoryStores(clock: { now: () => Date }): Promise<Array<[string, Store]>> {
  const json = new PostgresStore(client, { table: table('store'), index: { embed }, now: clock.now });
  const pgvector = new PostgresStore(client, {
    table: table('store'),
    index: { embed },
    vectorDimensions: 4,
    now: clock.now,
  });
  await json.migrate();
  await pgvector.migrate();
  return [
    ['memory', new MemoryStore({ index: { embed }, now: clock.now })],
    ['postgres', json],
    ['postgres+pgvector', pgvector],
  ];
}

test('the Postgres store keeps the long-term memory contract, with and without pgvector', async () => {
  let now = Date.parse('2026-09-21T00:00:00Z');
  const clock = { now: () => new Date(now) };
  for (const [name, store] of await memoryStores(clock)) {
    now = Date.parse('2026-09-21T00:00:00Z');
    await store.put(['tenant-7', 'users', 'alice'], 'prefs', { theme: 'dark', drink: 'green tea', level: 3 });
    now += 1;
    await store.put(['tenant-7', 'users', 'bob'], 'prefs', { theme: 'light', drink: 'black coffee', level: 1 });
    now += 1;
    await store.put(['tenant-70', 'users', 'eve'], 'prefs', { theme: 'dark', drink: 'water', level: 2 });
    now += 1;
    await store.put(['odd%name', 'x_y'], 'k', { note: 'wildcards in a namespace' });
    now += 1;
    await store.put(['tenant-7', 'sessions'], 'temp', { token: 'expiring' }, { ttlMs: 1_000 });

    assert.equal(
      (await store.get<{ theme: string }>(['tenant-7', 'users', 'alice'], 'prefs'))?.value.theme,
      'dark',
      name,
    );
    const tenant7 = await store.search(['tenant-7', 'users']);
    assert.deepEqual(
      tenant7.map((item) => item.namespace[2]),
      ['bob', 'alice'],
      `${name}: newest first, and tenant-70 is not under tenant-7`,
    );
    assert.deepEqual(
      (await store.search(['tenant-7'], { filter: { theme: 'dark' } })).map((item) => item.namespace[2]),
      ['alice'],
      name,
    );
    assert.deepEqual(
      (await store.search([], { filter: { level: [1, 2] } })).map((item) => item.namespace[2]).sort(),
      ['bob', 'eve'],
      `${name}: an array filter means any of`,
    );
    assert.equal((await store.search(['odd%name'])).length, 1, `${name}: LIKE wildcards are escaped`);
    assert.equal((await store.search(['odd'])).length, 0, `${name}: a partial part never matches`);

    const ranked = await store.search(['tenant-7', 'users'], { query: 'green tea' });
    assert.equal(ranked[0]?.namespace[2], 'alice', `${name}: semantic ranking`);
    assert.ok(typeof ranked[0]?.score === 'number', name);

    assert.deepEqual(
      (await store.listNamespaces({ prefix: ['tenant-7'] })).map((namespace) => namespace.join('/')).sort(),
      ['tenant-7/sessions', 'tenant-7/users/alice', 'tenant-7/users/bob'],
      name,
    );

    now += 1_000;
    assert.equal(await store.get(['tenant-7', 'sessions'], 'temp'), undefined, `${name}: expired`);
    if (store instanceof PostgresStore) assert.equal(await store.sweep(), 1, `${name}: sweep deletes what expired`);

    await store.delete(['tenant-7', 'users', 'bob'], 'prefs');
    assert.equal(await store.get(['tenant-7', 'users', 'bob'], 'prefs'), undefined, name);
  }
});

test('without an index, a store query matches text in the stored value', async () => {
  const store = new PostgresStore(client, { table: table('store') });
  await store.migrate();
  await store.put(['notes'], 'a', { text: 'Refund issued on Monday' });
  await store.put(['notes'], 'b', { text: 'Shipping delayed' });
  assert.deepEqual(
    (await store.search(['notes'], { query: 'refund' })).map((item) => item.key),
    ['a'],
  );
});

// ── Trace store ────────────────────────────────────────────────────

function run(overrides: Partial<Run>): Run {
  return {
    id: 'r',
    traceId: 't1',
    name: 'agent',
    kind: 'agent',
    status: 'ok',
    startedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

async function traceStores(): Promise<Array<[string, TraceStore]>> {
  const postgres = new PostgresTraceStore(client, { table: table('runs') });
  await postgres.migrate();
  return [
    ['memory', new MemoryTraceStore()],
    ['postgres', postgres],
  ];
}

test('the Postgres trace store answers every query exactly as the in-memory store does', async () => {
  const runs = [
    run({ id: 'root', latencyMs: 900, cost: 0.02, tags: ['prod', 'eu'], metadata: { tenant: { id: 7 }, plan: 'pro' } }),
    run({
      id: 'model',
      parentId: 'root',
      kind: 'model',
      name: 'openai',
      model: 'gpt-5',
      provider: 'openai',
      startedAt: '2026-09-21T00:00:01.000Z',
      latencyMs: 700,
      cost: 0.019,
    }),
    run({
      id: 'tool',
      parentId: 'root',
      kind: 'tool',
      name: 'search',
      status: 'error',
      startedAt: '2026-09-21T00:00:02.000Z',
      tags: ['prod'],
      metadata: { plan: null },
    }),
    run({ id: 'other', traceId: 't2', startedAt: '2026-09-22T00:00:00.000Z', tags: ['staging'] }),
  ];
  const queries = [
    {},
    { traceId: 't1' },
    { kind: ['model', 'tool'] as Run['kind'][] },
    { kind: [] as Run['kind'][] },
    { status: 'error' as const },
    { name: 'search' },
    { model: 'gpt-5', provider: 'openai' },
    { tags: ['prod'] },
    { tags: ['prod', 'eu'] },
    { metadata: { 'tenant.id': 7 } },
    { metadata: { plan: null } },
    { metadata: { plan: undefined } },
    { metadata: { tenant: { id: 7 } } },
    { minLatencyMs: 800 },
    { minCost: 0.015 },
    { since: '2026-09-21T00:00:01.000Z', until: '2026-09-21T00:00:02.000Z' },
    { feedbackKey: 'helpful' },
    { limit: 2, offset: 1 },
    { name: '' },
  ];

  const results: Record<string, string[][]> = {};
  for (const [name, store] of await traceStores()) {
    for (const item of runs) await store.save(item);
    await store.addFeedback?.('tool', { key: 'helpful', score: 0, createdAt: '2026-09-21T01:00:00.000Z' });
    results[name] = [];
    for (const query of queries) results[name]?.push((await store.query(query)).map((item) => item.id));

    const tree = await store.tree('t1');
    assert.equal(tree?.id, 'root', name);
    assert.deepEqual(
      tree?.children.map((child) => child.id),
      ['model', 'tool'],
      name,
    );
  }
  queries.forEach((query, index) => {
    assert.deepEqual(results.postgres?.[index], results.memory?.[index], `query ${JSON.stringify(query)}`);
  });
  assert.deepEqual(results.memory?.[9], ['root'], 'metadata dot paths reach nested fields');
  assert.deepEqual(results.memory?.[12], [], 'an object never matches, as === never does');
});

test('feedback from two evaluators at the same moment is not lost, and prune removes old runs', async () => {
  const store = new PostgresTraceStore(client, { table: table('runs') });
  await store.migrate();
  await store.save(run({ id: 'r1' }));
  await store.save(run({ id: 'r2', startedAt: '2026-09-25T00:00:00.000Z' }));
  await Promise.all([
    store.addFeedback('r1', { key: 'a', score: 1, createdAt: 'x' }),
    store.addFeedback('r1', { key: 'b', score: 0, createdAt: 'y' }),
  ]);
  assert.deepEqual((await store.get('r1'))?.feedback?.map((item) => item.key).sort(), ['a', 'b']);
  assert.equal(await store.prune('2026-09-24T00:00:00.000Z'), 1);
  assert.equal(await store.get('r1'), undefined);
});

// ── Datasets and experiments ───────────────────────────────────────

test('Postgres dataset and experiment stores keep the evaluation store contracts', async () => {
  const datasetsTable = table('datasets');
  const experimentsTable = table('experiments');
  const datasets = new PostgresDatasetStore(client, { datasetsTable, experimentsTable });
  const experiments = new PostgresExperimentStore(client, { datasetsTable, experimentsTable });
  await datasets.migrate();

  for (const [name, datasetStore, experimentStore] of [
    ['memory', new MemoryDatasetStore(), new MemoryExperimentStore()],
    ['postgres', datasets, experiments],
  ] as const) {
    const v1 = createDataset({
      name: 'qa',
      examples: [{ id: 'a', inputs: 1 }],
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    const v2 = createDataset({
      name: 'qa',
      examples: [{ id: 'a', inputs: 2 }],
      now: () => new Date('2026-09-02T00:00:00Z'),
    });
    await datasetStore.save(v1);
    await datasetStore.save(v2);
    assert.equal((await datasetStore.get('qa'))?.version, v2.version, `${name}: newest by default`);
    assert.equal((await datasetStore.get('qa', v1.version))?.examples[0]?.inputs, 1, name);
    assert.deepEqual((await datasetStore.list())[0]?.versions.sort(), [v1.version, v2.version].sort(), name);

    for (const [label, day] of [
      ['baseline', '01'],
      ['candidate', '02'],
    ] as const) {
      await evaluate((inputs: number) => inputs, v2, [], {
        name: label,
        store: experimentStore,
        now: () => new Date(`2026-09-${day}T00:00:00Z`),
      });
    }
    assert.deepEqual(
      (await experimentStore.list({ dataset: 'qa' })).map((experiment) => experiment.name),
      ['candidate', 'baseline'],
      name,
    );
    const first = (await experimentStore.list({ name: 'baseline' }))[0];
    assert.equal((await experimentStore.get(first?.id as string))?.name, 'baseline', name);
  }
});

// ── Circuit state ──────────────────────────────────────────────────

test('a provider failure in one process opens the circuit in another, through Postgres', async () => {
  const store = new PostgresCircuitStateStore(client, { table: table('circuits') });
  await store.migrate();
  const settings = { enabled: true, failureThreshold: 2, resetTimeoutMs: 60_000, syncIntervalMs: 0, store };
  const api = new CircuitBreaker({ ...settings, workerId: 'api' });
  const batch = new CircuitBreaker({ ...settings, workerId: 'batch' });

  api.recordFailure('anthropic', new Error('529 overloaded'));
  api.recordFailure('anthropic', new Error('529 overloaded'));
  await api.flush();
  await batch.sync();
  assert.deepEqual(batch.openProviders(), ['anthropic']);

  assert.equal(await store.claimProbe('anthropic', 'api', 1_000), true);
  assert.equal(await store.claimProbe('anthropic', 'batch', 1_000), false);
  await store.write({ providerName: 'anthropic', state: 'closed', updatedAt: 1, updatedBy: 'stale' });
  assert.equal((await store.read())[0]?.state, 'open', 'a stale transition does not win');
});

test('the Postgres and memory circuit stores agree on ordering and probe claims', async () => {
  const postgres = new PostgresCircuitStateStore(client, { table: table('circuits'), now: () => 1_000 });
  await postgres.migrate();
  for (const [name, store] of [
    ['memory', new MemoryCircuitStateStore(() => 1_000)],
    ['postgres', postgres],
  ] as const) {
    await store.write({ providerName: 'p', state: 'open', openedAt: 5, updatedAt: 5, updatedBy: 'a' });
    await store.write({ providerName: 'p', state: 'closed', updatedAt: 5, updatedBy: 'b' });
    assert.equal((await store.read())[0]?.state, 'closed', `${name}: an equal stamp replaces`);
    assert.equal(await store.claimProbe('p', 'a', 500), true, name);
    assert.equal(await store.claimProbe('p', 'b', 500), false, name);
    await store.write({ providerName: 'p', state: 'open', openedAt: 9, updatedAt: 9, updatedBy: 'a' });
    assert.equal(await store.claimProbe('p', 'b', 500), true, `${name}: a transition releases the claim`);
  }
});

// ── Migrations and the client contract ─────────────────────────────

test('the combined migration script runs on an empty database and the helpers refuse bad names', async () => {
  const fresh = new PGlite({ extensions: { vector } });
  try {
    await fresh.exec(postgresMigration({ vectorDimensions: 8 }));
    await fresh.exec(postgresMigration({ vectorDimensions: 8 }));
    const { rows } = await fresh.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_name like 'nexus_%'",
    );
    assert.equal(rows[0]?.count, 9, 'six tables, plus three for prompts');
    assert.doesNotMatch(postgresMigration({ adapters: ['traces'] }), /nexus_operations/);
  } finally {
    await fresh.close();
  }

  assert.equal(quoteTable('audit.nexus_runs'), '"audit"."nexus_runs"');
  assert.throws(() => quoteTable('runs; drop table users'), /not a valid table name/);
  assert.throws(() => new PostgresStore(client, { table: 'bad name' }), /not a valid table name/);
});

test('fromPostgresJs adapts a tagged-template client to the query contract', async () => {
  const calls: unknown[] = [];
  const sql = {
    unsafe: async (text: string, values?: never[]) => {
      calls.push([text, values]);
      return Object.assign([{ doc: '{"id":"x"}' }], { count: 1 });
    },
  };
  const adapted = fromPostgresJs(sql);
  const result = await adapted.query('select 1', [1]);
  assert.deepEqual(result, { rows: [{ doc: '{"id":"x"}' }], rowCount: 1 });
  assert.deepEqual(calls, [['select 1', [1]]]);
});
