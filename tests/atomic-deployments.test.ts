/**
 * Deployment changes that are atomic across replicas. Every state store with `putIfVersion()` writes
 * a record only when the version it was decided on is still the stored one. Two replicas changing
 * one deployment in the same instant therefore never lose a change: the loser decides again on the
 * winner's record.
 *
 * Each race holds both writers until both arrive, so it never depends on timing.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import { functionAssistant } from '../src/server/assistant.js';
import { Deployments } from '../src/server/deployments.js';
import { createAgentServer } from '../src/server/server.js';
import { fromStore, MemoryServerStore } from '../src/server/state.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import type { ServerStateStore } from '../src/types/server.js';
import type { Store } from '../src/types/store.js';
import { FakeRedis } from './redis-fake.js';

let pg: PGlite;
let redis: FakeRedis;
let tables = 0;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
});

/** A fresh long-term store of every kind that has `putIfVersion()`. */
async function stores(): Promise<Array<[string, Store]>> {
  tables += 1;
  const postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: `atomic_${tables}` });
  await postgres.migrate();
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  return [
    ['memory', new MemoryStore()],
    ['redis', new RedisStore(redis as never, { prefix: `atomic-${tables}` })],
    ['postgres', postgres],
    ['sqlite', sqlite],
  ];
}

test('putIfVersion writes only on the version it was decided on, on every store', async () => {
  for (const [name, store] of await stores()) {
    const put = store.putIfVersion?.bind(store);
    assert.ok(put, `${name} has putIfVersion`);
    const ns = ['nexus', 'test'];
    assert.equal(await put(ns, 'a', { version: 1, note: 'first' }, null), true, `${name}: written when absent`);
    assert.equal(await put(ns, 'a', { version: 1, note: 'again' }, null), false, `${name}: not over a stored one`);
    assert.equal(await put(ns, 'a', { version: 2, note: 'second' }, 1), true, `${name}: on the stored version`);
    assert.equal(await put(ns, 'a', { version: 3, note: 'stale' }, 1), false, `${name}: not on a stale one`);
    assert.equal(await put(ns, 'b', { version: 1 }, 0), false, `${name}: not on a version that was never stored`);
    const item = await store.get<{ version: number; note: string }>(ns, 'a');
    assert.deepEqual(item?.value, { version: 2, note: 'second' }, name);
    assert.ok(item && item.createdAt <= item.updatedAt, `${name}: an item like any other`);
    assert.deepEqual(
      (await store.search(ns)).map((found) => found.key),
      ['a'],
      `${name}: found by search`,
    );

    // A value whose version is not a number is never matched.
    await store.put(ns, 'odd', { version: 'one' });
    assert.equal(await put(ns, 'odd', { version: 2 }, 1), false, name);

    // Ten writers deciding on the same version: exactly one writes.
    const writes = await Promise.all(
      Array.from({ length: 10 }, (_, writer) => put(ns, 'a', { version: 3, note: `writer ${writer}` }, 2)),
    );
    assert.equal(writes.filter(Boolean).length, 1, `${name}: one of ten wins`);
  }
});

test('a Redis client without eval offers no putIfVersion, and the server state says changes are not atomic', () => {
  const { eval: _eval, ...withoutEval } = redis as unknown as Record<string, unknown>;
  const store = new RedisStore(
    Object.fromEntries(
      ['get', 'set', 'del', 'sadd', 'srem', 'smembers'].map((method) => [
        method,
        (redis as unknown as Record<string, (...args: unknown[]) => unknown>)[method]?.bind(redis),
      ]),
    ) as never,
  );
  assert.equal(store.putIfVersion, undefined);
  assert.equal(fromStore(store).putIfVersion, undefined);
  assert.equal(new Deployments({ state: fromStore(store) }).atomicChanges, false);
  assert.ok(withoutEval);
});

/** Resolves once `parties` callers have arrived, and at once for every caller after that. */
function barrier(parties: number): () => Promise<void> {
  let arrived: Array<() => void> = [];
  let open = false;
  return () =>
    new Promise<void>((resolve) => {
      if (open) return resolve();
      arrived.push(resolve);
      if (arrived.length === parties) {
        open = true;
        for (const release of arrived) release();
        arrived = [];
      }
    });
}

/** The state store, with each deployment write held until the other replica's arrives too. */
function meetingAt(gate: () => Promise<void>, state: ServerStateStore, hideVersioned = false): ServerStateStore {
  return {
    get: (namespace, key) => state.get(namespace, key),
    put: async (namespace, key, value) => {
      if (namespace.includes('deployments')) await gate();
      return state.put(namespace, key, value);
    },
    delete: (namespace, key) => state.delete(namespace, key),
    list: (namespace, options) => state.list(namespace, options),
    ...(state.putIfVersion && !hideVersioned
      ? {
          putIfVersion: async (namespace, key, value, expected) => {
            if (namespace.includes('deployments')) await gate();
            return (state.putIfVersion as NonNullable<ServerStateStore['putIfVersion']>)(
              namespace,
              key,
              value,
              expected,
            );
          },
        }
      : {}),
  } as ServerStateStore;
}

const revisions = () => ({
  v1: functionAssistant(() => ({ answer: 'v1' })),
  v2: functionAssistant(() => ({ answer: 'v2' })),
  v3: functionAssistant(() => ({ answer: 'v3' })),
});

function replica(state: ServerStateStore): Deployments {
  const deployments = new Deployments({ state, cacheMs: 0 });
  deployments.assistant('support', revisions(), { live: 'v1' });
  return deployments;
}

async function serverStates(): Promise<Array<[string, ServerStateStore]>> {
  return [
    ['memory server store', new MemoryServerStore()],
    ...(await stores()).map(([name, store]) => [`${name} store`, fromStore(store)] as [string, ServerStateStore]),
  ];
}

test('two replicas changing one deployment in the same instant both land, on every state store', async () => {
  for (const [name, state] of await serverStates()) {
    const setup = replica(state);
    const start = (await setup.canary('support', 'v2', 0.1, { by: 'setup' })).version;
    assert.equal(setup.atomicChanges, true, name);

    const gate = barrier(2);
    const [a, b] = [replica(meetingAt(gate, state)), replica(meetingAt(gate, state))];
    await Promise.all([a.canary('support', 'v2', 0.5, { by: 'ada' }), b.promote('support', 'v3', { by: 'bob' })]);

    const final = await setup.get('support');
    assert.equal(final?.version, start + 2, `${name}: both changes raised the version`);
    const actions = final?.history
      .slice(0, 2)
      .map((entry) => `${entry.action}:${entry.by}`)
      .sort();
    assert.deepEqual(actions, ['canary:ada', 'promote:bob'], `${name}: both are in the history`);
    assert.deepEqual(
      final?.history.map((entry) => entry.version),
      [start + 2, start + 1, start, ...final.history.slice(3).map((entry) => entry.version)],
      `${name}: one version per change, in order`,
    );
  }
});

test('ten replicas making mixed changes at once all land, in one linear history, on every state store', async () => {
  const changes: Array<[string, (deployments: Deployments, by: string) => Promise<unknown>]> = [
    ['canary', (d, by) => d.canary('support', 'v2', 0.1, { by })],
    ['canary', (d, by) => d.canary('support', 'v3', 0.2, { by })],
    ['canary', (d, by) => d.canary('support', 'v2', 0.3, { by })],
    ['split', (d, by) => d.split('support', { v2: 0.2, v3: 0.1 }, { by })],
    ['split', (d, by) => d.split('support', { v3: 0.5 }, { by })],
    ['promote', (d, by) => d.promote('support', 'v2', { by })],
    ['promote', (d, by) => d.promote('support', 'v3', { by })],
    ['rollback', (d, by) => d.rollback('support', { to: 'v1', by })],
    ['rollback', (d, by) => d.rollback('support', { to: 'v2', by })],
    ['bucketing', (d, by) => d.bucketing('support', 'hash-v2', { by })],
  ];
  for (const [name, state] of await serverStates()) {
    const setup = replica(state);
    const start = (await setup.canary('support', 'v2', 0.05, { by: 'setup' })).version;

    // All ten read the same version, then write at once: nine lose, and decide again.
    const gate = barrier(changes.length);
    const results = (await Promise.all(
      changes.map(([, apply], index) => apply(replica(meetingAt(gate, state)), `replica-${index}`)),
    )) as Array<{ version: number }>;

    const final = await setup.get('support');
    assert.equal(final?.version, start + changes.length, `${name}: every change raised the version`);
    assert.deepEqual(
      results.map((result) => result.version).sort((a, b) => a - b),
      changes.map((_, index) => start + index + 1),
      `${name}: each change got a version of its own`,
    );
    const latest = final?.history.slice(0, changes.length) ?? [];
    assert.deepEqual(
      latest.map((entry) => entry.version),
      changes.map((_, index) => start + changes.length - index),
      `${name}: the history is one linear sequence`,
    );
    assert.deepEqual(
      latest.map((entry) => `${entry.action}:${entry.by}`).sort(),
      changes.map(([action], index) => `${action}:replica-${index}`).sort(),
      `${name}: every change is in it, once`,
    );
    // Each change was decided on the one before it: the record is the last change's result, and the
    // strategy the bucketing change chose survived every change after it.
    assert.equal(final?.live, latest[0]?.live, name);
    assert.deepEqual(final?.traffic, latest[0]?.traffic, name);
    assert.equal(final?.bucketStrategy, 'hash-v2', `${name}: no change was decided on a stale record`);
  }
});

test('without putIfVersion, the same race loses a change, which is why such a store is reported', async () => {
  const state = new MemoryServerStore();
  const setup = replica(state);
  const start = (await setup.canary('support', 'v2', 0.1)).version;
  const gate = barrier(2);
  const [a, b] = [replica(meetingAt(gate, state, true)), replica(meetingAt(gate, state, true))];
  assert.equal(a.atomicChanges, false);
  await Promise.all([a.canary('support', 'v2', 0.5, { by: 'ada' }), b.promote('support', 'v3', { by: 'bob' })]);
  assert.equal((await setup.get('support'))?.version, start + 1, 'one of the two changes was lost');
});

test('a change decided on an expected version is refused when another replica changed it first', async () => {
  for (const [name, state] of await serverStates()) {
    const setup = replica(state);
    const start = (await setup.canary('support', 'v2', 0.1)).version;
    const gate = barrier(2);
    const [a, b] = [replica(meetingAt(gate, state)), replica(meetingAt(gate, state))];
    const outcomes = await Promise.allSettled([
      a.change('support', { action: 'promote', revision: 'v2', expectedVersion: start }, 'ada'),
      b.change('support', { action: 'promote', revision: 'v3', expectedVersion: start }, 'bob'),
    ]);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(refused.length, 1, `${name}: exactly one is refused`);
    assert.equal(((refused[0] as PromiseRejectedResult).reason as { code?: string }).code, 'DEPLOYMENT_CONFLICT', name);
    assert.equal((await setup.get('support'))?.version, start + 1, name);
  }
});

test('two replicas starting at once seed one deployment, and /scaling says changes are atomic', async () => {
  for (const [name, state] of await serverStates()) {
    const report = (id: string) => () => ({
      id,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      inFlight: 0,
      claims: true,
      draining: false,
      assistants: { support: ['v1', 'v2', 'v3'] },
      queued: 0,
    });
    const [a, b] = [replica(state), replica(state)];
    await Promise.all([a.attach(report('a')), b.attach(report('b'))]);
    const seeded = await state.list<{ assistant: string; version: number }>(['nexus', 'server', 'deployments']);
    assert.deepEqual(
      seeded.map((record) => [record.assistant, record.version]),
      [['support', 0]],
      `${name}: one record, seeded once`,
    );
    await Promise.all([a.detach(), b.detach()]);

    const app = createAgentServer({ assistants: { support: revisions().v1 }, state });
    assert.equal((await app.scaling()).atomicChanges, true, name);
  }
  const plain = new MemoryServerStore() as ServerStateStore & { putIfVersion?: unknown };
  const withoutVersioned: ServerStateStore = {
    get: (namespace, key) => plain.get(namespace, key),
    put: (namespace, key, value) => plain.put(namespace, key, value),
    delete: (namespace, key) => plain.delete(namespace, key),
    list: (namespace, options) => plain.list(namespace, options),
  };
  const app = createAgentServer({ assistants: { support: revisions().v1 }, state: withoutVersioned });
  assert.equal((await app.scaling()).atomicChanges, false);
});
