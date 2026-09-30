import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { appendList, lastValue } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { OperationDuplicateError, OperationSerializationError } from '../src/operations/errors.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { fromLibsql, fromSqliteDatabase, type SqliteLikeClient } from '../src/sqlite/client.js';
import { SqliteOperationStore } from '../src/sqlite/operations.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { END } from '../src/types/graph.js';
import type { OperationRecord, OperationStore } from '../src/types/operations.js';
import type { Store } from '../src/types/store.js';
import { queueContract } from './operation-queue-contract.js';

const database = () => new DatabaseSync(':memory:');

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
  const sqlite = new SqliteOperationStore<string>(database());
  await sqlite.migrate();
  await sqlite.migrate();
  return [
    ['memory', new MemoryOperationStore<string>()],
    ['sqlite', sqlite],
  ];
}

test('the SQLite operation store keeps the operation store contract', async () => {
  for (const [name, store] of await operationStores()) {
    await store.create(record({ idempotencyKey: 'charge-42', metadata: { note: "it's quoted" } }));
    assert.equal((await store.read('op-1'))?.metadata?.note, "it's quoted", name);
    assert.equal(await store.update(record({ sequence: 1, status: 'running' }), 0), true, name);
    assert.equal(await store.update(record({ sequence: 2, status: 'running' }), 0), false, `${name}: stale write`);
    assert.equal((await store.read('op-1'))?.sequence, 1, name);
    assert.equal((await store.findByIdempotencyKey?.('charge-42'))?.id, 'op-1', name);

    const now = '2026-09-21T01:00:00.000Z';
    await store.create(
      record({ id: 'lapsed', status: 'running', lease: { owner: 'w', expiresAt: '2026-09-21T00:30:00.000Z' } }),
    );
    await store.create(
      record({ id: 'held', status: 'running', lease: { owner: 'w', expiresAt: '2026-09-21T02:00:00.000Z' } }),
    );
    await store.create(record({ id: 'orphan', status: 'running' }));
    await store.create(
      record({ id: 'done', status: 'succeeded', lease: { owner: 'w', expiresAt: '2026-09-21T00:00:00.000Z' } }),
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

test('the SQLite operation store lists queued work and counts it for autoscaling', async () => {
  const store = new SqliteOperationStore<string>(database());
  await store.migrate();
  await queueContract('sqlite', store);
});

test('SQLite enforces unique idempotency keys, and prunes finished records', async () => {
  const store = new SqliteOperationStore<string>(database());
  await store.migrate();
  await store.create(record({ id: 'first', idempotencyKey: 'k' }));
  await assert.rejects(store.create(record({ id: 'second', idempotencyKey: 'k' })), OperationDuplicateError);
  await store.create(record({ id: 'old', status: 'succeeded', updatedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(await store.prune('2026-06-01T00:00:00.000Z'), 1);
});

test('a graph thread started by one process is finished by another through the same SQLite file', async () => {
  const db = database();
  await new SqliteOperationStore(db).migrate();
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
      .compile({ checkpointer: new OperationStoreCheckpointer(new SqliteOperationStore(db) as never) });

  const paused = await build().invoke({}, { threadId: 'order-991' });
  assert.equal(paused.status, 'awaiting_input');
  const finished = await build().resumeWith('order-991', true);
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.state.log, ['drafted', 'reviewed']);
});

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

test('the SQLite store keeps the long-term memory contract', async () => {
  let now = Date.parse('2026-09-21T00:00:00Z');
  const clock = { now: () => new Date(now) };
  const sqlite = new SqliteStore(database(), { index: { embed }, now: clock.now });
  await sqlite.migrate();
  const stores: Array<[string, Store]> = [
    ['memory', new MemoryStore({ index: { embed }, now: clock.now })],
    ['sqlite', sqlite],
  ];
  for (const [name, store] of stores) {
    now = Date.parse('2026-09-21T00:00:00Z');
    await store.put(['tenant-7', 'users', 'alice'], 'prefs', { theme: 'dark', drink: 'green tea', level: 3 });
    now += 1;
    await store.put(['tenant-7', 'users', 'bob'], 'prefs', { theme: 'light', drink: 'black coffee', level: 1 });
    now += 1;
    await store.put(['tenant-70', 'users', 'eve'], 'prefs', { theme: 'dark', drink: 'water', level: 2 });
    now += 1;
    await store.put(['odd%name', 'x_y'], 'k', { note: 'wildcards in a namespace' });
    now += 1;
    await store.put(['Tenant-7', 'users'], 'shout', { note: 'another case' });
    now += 1;
    await store.put(['tenant-7', 'sessions'], 'temp', { token: 'expiring' }, { ttlMs: 1_000 });

    assert.equal(
      (await store.get<{ theme: string }>(['tenant-7', 'users', 'alice'], 'prefs'))?.value.theme,
      'dark',
      name,
    );
    assert.deepEqual(
      (await store.search(['tenant-7', 'users'])).map((item) => item.namespace[2]),
      ['bob', 'alice'],
      `${name}: newest first; tenant-70 and Tenant-7 are not under tenant-7`,
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
    assert.equal((await store.search(['odd%name'])).length, 1, `${name}: wildcards are literal`);
    assert.equal((await store.search(['odd'])).length, 0, `${name}: a partial part never matches`);
    assert.equal((await store.search(['tenant-7', 'users'], { limit: 1, offset: 1 }))[0]?.namespace[2], 'alice', name);

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
    if (store instanceof SqliteStore) assert.equal(await store.sweep(), 1, `${name}: sweep deletes what expired`);

    await store.delete(['tenant-7', 'users', 'bob'], 'prefs');
    assert.equal(await store.get(['tenant-7', 'users', 'bob'], 'prefs'), undefined, name);
  }
});

test('without an index, a SQLite store query matches text in the stored value', async () => {
  const store = new SqliteStore(database());
  await store.migrate();
  await store.put(['notes'], 'a', { text: 'Refund issued on Monday' });
  await store.put(['notes'], 'b', { text: 'Shipping delayed' });
  assert.deepEqual(
    (await store.search(['notes'], { query: 'refund' })).map((item) => item.key),
    ['a'],
  );
});

test('the libSQL adapter maps execute() onto the client contract, and table names are checked', async () => {
  const db = database();
  const sync = fromSqliteDatabase(db);
  const calls: string[] = [];
  const libsql: SqliteLikeClient = fromLibsql({
    async execute({ sql, args }) {
      calls.push(sql);
      const rows = sync.all(sql, args) as unknown[];
      const changed = /^\s*(insert|update|delete)/i.test(sql) ? await sync.run(sql, args) : { changes: 0 };
      return { rows, rowsAffected: changed.changes };
    },
    async executeMultiple(sql) {
      db.exec(sql);
    },
  });
  const store = new SqliteOperationStore<string>(libsql);
  await store.migrate();
  await store.create(record());
  assert.equal((await store.read('op-1'))?.id, 'op-1');
  assert.ok(calls.length > 0);
  assert.throws(() => new SqliteStore(db, { table: 'bad name' }), /not a valid table name/);
});
