/**
 * Indexed dispatch: a claim reads the oldest few records, however long the queue. The Redis store's
 * Lua runs for real in `FakeRedis`; the Postgres and SQLite stores are checked by their query plans.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { OperationRunner } from '../src/operations/runner.js';
import { PostgresOperationStore, type PostgresLikeClient } from '../src/postgres/index.js';
import { SqliteOperationStore } from '../src/sqlite/index.js';
import type { OperationRecord } from '../src/types/operations.js';
import { queueContract } from './operation-queue-contract.js';
import { FakeRedis } from './redis-fake.js';

let redis: FakeRedis;
before(async () => {
  redis = await FakeRedis.create();
});
after(() => redis.close());

const base = Date.parse('2026-09-01T00:00:00.000Z');
function queued(index: number, overrides: Partial<OperationRecord<string>> = {}): OperationRecord<string> {
  const at = new Date(base + index * 1000).toISOString();
  return {
    id: `op-${String(index).padStart(6, '0')}`,
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    sequence: 0,
    createdAt: at,
    updatedAt: at,
    kind: 'job',
    ...overrides,
  };
}

test('the indexed Redis store keeps the queue contract, with its Lua run for real', async () => {
  const store = new RedisOperationStore<string>(redis, { prefix: 'contract:', index: true });
  await queueContract('redis indexed', store);
  const plain = new RedisOperationStore<string>(redis, { prefix: 'contract-plain:' });
  await queueContract('redis', plain);
});

test('an indexed claim reads the same few records with 1,000 or 100,000 queued', async () => {
  const readsAt = async (size: number) => {
    const prefix = `flat-${size}:`;
    const store = new RedisOperationStore<string>(redis, { prefix, index: true });
    // Filled directly, as a long-lived queue would be; then indexed once, as an upgrade would.
    const records = redis.hashes.get(`${prefix}records`) ?? new Map<string, string>();
    redis.hashes.set(`${prefix}records`, records);
    for (let index = 0; index < size; index += 1) {
      const record = queued(index);
      records.set(record.id, JSON.stringify(record));
    }
    assert.equal(await store.reindex(), size);
    const runner = new OperationRunner<string>({ store });
    redis.reads = 0;
    const handles = await runner.claimQueued(async ({ operationId }) => operationId, 5);
    assert.deepEqual(
      await Promise.all(handles.map((handle) => handle.result())),
      ['op-000000', 'op-000001', 'op-000002', 'op-000003', 'op-000004'],
      'oldest first',
    );
    return redis.reads;
  };
  const small = await readsAt(1_000);
  const large = await readsAt(100_000);
  assert.equal(large, small, `a claim read ${small} records at 1,000 and ${large} at 100,000`);
  assert.ok(small < 100, `a claim read ${small} records`);

  const unindexed = new RedisOperationStore<string>(redis, { prefix: 'flat-100000:' });
  redis.reads = 0;
  await unindexed.listQueued(5);
  assert.ok(redis.reads >= 100_000, 'without the index, a claim reads the whole queue');
});

test('held, finished, and deleted records leave the index, and recovery reads only lapsed leases', async () => {
  const store = new RedisOperationStore<string>(redis, { prefix: 'life:', index: true });
  await store.create(queued(1));
  await store.create(queued(2));
  await store.create(queued(3));
  const running = {
    ...queued(1),
    status: 'running' as const,
    sequence: 1,
    lease: { owner: 'w', expiresAt: '2000-01-01T00:00:00.000Z' },
  };
  assert.equal(await store.update(running, 0), true);
  assert.equal(redis.zscore('life:queued', 'op-000001'), null, 'a running record leaves the queue index');
  assert.notEqual(redis.zscore('life:leases', 'op-000001'), null, 'and joins the lease index');

  const done = { ...running, status: 'succeeded' as const, sequence: 2, lease: undefined };
  assert.equal(await store.update(done, 1), true);
  assert.equal(redis.zscore('life:leases', 'op-000001'), null, 'a finished record leaves both');
  assert.equal(await store.update(done, 1), false, 'a stale sequence still loses');

  await store.update(
    { ...queued(2), status: 'running', sequence: 1, lease: { owner: 'w', expiresAt: '2999-01-01T00:00:00.000Z' } },
    0,
  );
  assert.deepEqual(
    (await store.claimExpired('2026-10-01T00:00:00.000Z', 10)).map((record) => record.id),
    [],
    'a live lease is not recovered',
  );
  await store.update(
    { ...queued(2), status: 'running', sequence: 2, lease: { owner: 'w', expiresAt: '2026-09-15T00:00:00.000Z' } },
    1,
  );
  assert.deepEqual(
    (await store.claimExpired('2026-10-01T00:00:00.000Z', 10)).map((record) => record.id),
    ['op-000002'],
  );

  await store.delete('op-000003');
  assert.equal(redis.zscore('life:queued', 'op-000003'), null);
  assert.deepEqual(await store.listQueued(10), []);
});

test('an index entry another writer left behind is skipped, then removed', async () => {
  const store = new RedisOperationStore<string>(redis, { prefix: 'stale:', index: true });
  await store.create(queued(1));
  await store.create(queued(2));
  // A 2.1 worker finishes op 1 without touching the index.
  const legacy = new RedisOperationStore<string>(redis, { prefix: 'stale:' });
  await legacy.update({ ...queued(1), status: 'succeeded', sequence: 1 }, 0);
  assert.notEqual(redis.zscore('stale:queued', 'op-000001'), null);
  assert.deepEqual(
    (await store.listQueued(5)).map((record) => record.id),
    ['op-000002'],
  );
  assert.equal(redis.zscore('stale:queued', 'op-000001'), null, 'the stale entry was pruned');

  // A record written back to the queue keeps its entry: pruning checks the record, not a snapshot.
  redis.zadd('stale:queued', base, 'op-000002');
  redis.eval(
    "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return 1",
    1,
    'stale:queued',
    String(base + 2000),
    'op-000002',
  );
  assert.deepEqual(
    (await store.listQueued(5)).map((record) => record.id),
    ['op-000002'],
  );
});

test('without eval, the index is kept by separate commands and stale entries are only skipped', async () => {
  const store = new RedisOperationStore<string>(redis, { prefix: 'noeval:', index: true, useEval: false });
  await store.create(queued(1));
  await store.create(queued(2));
  await store.update({ ...queued(1), status: 'running', sequence: 1 }, 0);
  assert.deepEqual(
    (await store.listQueued(5)).map((record) => record.id),
    ['op-000002'],
  );
  assert.throws(
    () => new RedisOperationStore({ hget: () => null, hset: () => 1, hdel: () => 1, hvals: () => [] }, { index: true }),
    /needs zadd, zrem, and zrangebyscore/,
  );
  await assert.rejects(new RedisOperationStore(redis, { prefix: 'x:' }).reindex(), /index: true/);
});

test('Postgres claims queued work through the age index, without sorting the queue', async () => {
  const db = new PGlite();
  await db.waitReady;
  try {
    const client = db as unknown as PostgresLikeClient;
    const store = new PostgresOperationStore<string>(client);
    await store.migrate();
    await db.exec(`
      INSERT INTO nexus_operations (id, status, sequence, created_at, updated_at, kind, doc)
      SELECT 'op-' || lpad(n::text, 6, '0'),
             CASE WHEN n % 10 = 0 THEN 'succeeded' ELSE 'queued' END,
             0,
             to_char(timestamp '2026-09-01' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             '2026-09-01T00:00:00.000Z', 'job',
             jsonb_build_object('id', 'op-' || lpad(n::text, 6, '0'), 'status', CASE WHEN n % 10 = 0 THEN 'succeeded' ELSE 'queued' END,
               'attempt', 1, 'maxAttempts', 3, 'sequence', 0, 'kind', 'job',
               'createdAt', to_char(timestamp '2026-09-01' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'updatedAt', '2026-09-01T00:00:00.000Z')
      FROM generate_series(1, 100000) AS n;
      ANALYZE nexus_operations;
    `);
    const { rows } = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT doc::text AS doc FROM nexus_operations
       WHERE status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= '2026-10-01')
       ORDER BY created_at, id LIMIT 5`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /nexus_operations_queued/, plan);
    assert.doesNotMatch(plan, /Sort/, plan);
    assert.deepEqual(
      (await store.listQueued(3)).map((record) => record.id),
      ['op-000001', 'op-000002', 'op-000003'],
    );
  } finally {
    await db.close();
  }
});

test('SQLite claims queued work through the age index, without a temporary sort', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new SqliteOperationStore<string>(db);
  await store.migrate();
  const insert = db.prepare(
    'INSERT INTO nexus_operations (id, status, sequence, created_at, updated_at, kind, doc) VALUES (?, ?, 0, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  for (let index = 1; index <= 100_000; index += 1) {
    const record = queued(index, index % 10 === 0 ? { status: 'succeeded' } : {});
    insert.run(record.id, record.status, record.createdAt, record.updatedAt, 'job', JSON.stringify(record));
  }
  db.exec('COMMIT');
  db.exec('ANALYZE');
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT doc FROM nexus_operations
       WHERE status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY created_at, id LIMIT ?`,
    )
    .all('2026-10-01', 5)
    .map((row) => (row as { detail: string }).detail)
    .join('\n');
  assert.match(plan, /nexus_operations_queued/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  assert.deepEqual(
    (await store.listQueued(3)).map((record) => record.id),
    ['op-000001', 'op-000002', 'op-000003'],
  );
});
