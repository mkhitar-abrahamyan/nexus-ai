/**
 * A preview of 3.0's defaults: one switch, `useDefaults('3.0')` or `NEXUS_DEFAULTS=3.0`, turns on the
 * three settings 2.x keeps opt-in, so an application runs as 3.0 will before it upgrades: incremental
 * tracing on a durable trace store, the Redis operation store's dispatch index, and `hash-v2` for a
 * deployment first recorded. An option set explicitly wins under either; without the switch nothing
 * changes; and `nexus doctor --upgrade 3.0` says what 3.0 would change for a deployment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CHANGES, nexusDefaults, useDefaults } from '../src/core/config-builder.js';
import { diagnose } from '../src/doctor/index.js';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { functionAssistant } from '../src/server/assistant.js';
import { Deployments } from '../src/server/deployments.js';
import { MemoryServerStore } from '../src/server/state.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { TraceStore } from '../src/types/tracing.js';
import { FakeRedis } from './redis-fake.js';

/** A durable trace store: one that does not say it lives only in this process. */
function durableStore(): TraceStore & { saved: () => number } {
  const inner = new MemoryTraceStore();
  return {
    save: (run) => inner.save(run),
    get: (id) => inner.get(id),
    query: (query) => inner.query(query),
    tree: (id) => inner.tree(id),
    saved: () => inner.query({}).length,
  };
}

/** How many runs the store holds while a traced call is still running, and after. */
async function writesWhileRunning(tracer: Tracer, store: { saved: () => number }): Promise<[number, number]> {
  let during = -1;
  await tracer.trace({ name: 'answer' }, async () => {
    // Writes are queued: by the time the run has done anything, its start is written, or not at all.
    await new Promise((resolve) => setImmediate(resolve));
    during = store.saved();
  });
  return [during, store.saved()];
}

const answering = functionAssistant(() => ({ answer: 'ok' }));

test('the switch: 2.x by default, NEXUS_DEFAULTS chooses 3.0, useDefaults() wins, and anything else is refused', () => {
  const saved = process.env.NEXUS_DEFAULTS;
  try {
    delete process.env.NEXUS_DEFAULTS;
    assert.equal(nexusDefaults(), '2.x');
    process.env.NEXUS_DEFAULTS = '';
    assert.equal(nexusDefaults(), '2.x', 'an empty variable is unset');
    process.env.NEXUS_DEFAULTS = '3.0';
    assert.equal(nexusDefaults(), '3.0');
    process.env.NEXUS_DEFAULTS = '3';
    assert.throws(() => nexusDefaults(), /NEXUS_DEFAULTS takes 2\.x or 3\.0, not "3"/, 'a typo is not ignored');
    useDefaults('2.x');
    assert.equal(nexusDefaults(), '2.x', 'useDefaults() overrides the variable');
    process.env.NEXUS_DEFAULTS = '3.0';
    assert.equal(nexusDefaults(), '2.x');
    assert.throws(() => useDefaults('3.1' as never), /useDefaults\(\) takes 2\.x or 3\.0, not "3\.1"/);
    assert.deepEqual(
      DEFAULT_CHANGES.map((change) => change.setting),
      ['Tracer incremental', 'RedisOperationStore index', 'Deployments bucketStrategy'],
    );
  } finally {
    if (saved === undefined) delete process.env.NEXUS_DEFAULTS;
    else process.env.NEXUS_DEFAULTS = saved;
    useDefaults('2.x');
  }
});

test('proof: the preview turns on all three of 3.0’s defaults at once, an explicit option wins, and without it nothing changes', async () => {
  const redis = await FakeRedis.create();
  const withoutIndexCommands = { ...redis, zadd: undefined, zrem: undefined, zrangebyscore: undefined } as never;
  try {
    // 2.x: each setting as it has always been.
    useDefaults('2.x');
    const durable2 = durableStore();
    const tracer2 = new Tracer({ store: durable2 });
    assert.equal(tracer2.incremental, false);
    assert.deepEqual(await writesWhileRunning(tracer2, durable2), [0, 1], 'a trace written when its root finishes');
    assert.equal(new RedisOperationStore(redis as never).indexed, false);
    const state = new MemoryServerStore();
    const before = new Deployments({ state, cacheMs: 0 });
    before.assistant('recorded', { v1: answering, v2: answering }, { live: 'v1' });
    before.assistant('unrecorded', { v1: answering }, { live: 'v1' });
    assert.equal((await before.get('unrecorded'))?.bucketStrategy, undefined, 'fnv1a-v1, by leaving it out');
    await before.canary('recorded', 'v2', 0.5);
    assert.equal((await before.get('recorded'))?.bucketStrategy, undefined);

    // 3.0's defaults, previewed.
    useDefaults('3.0');
    const durable3 = durableStore();
    const tracer3 = new Tracer({ store: durable3 });
    assert.equal(tracer3.incremental, true, 'incremental on a durable store');
    assert.deepEqual(await writesWhileRunning(tracer3, durable3), [1, 1], 'the run is in the store while it runs');
    assert.equal(new Tracer({ store: new MemoryTraceStore() }).incremental, false, 'not on a store in memory');
    assert.equal(new RedisOperationStore(redis as never).indexed, true, 'the dispatch index on');
    assert.equal(
      new RedisOperationStore(withoutIndexCommands).indexed,
      false,
      'off, without a refusal, for a client that cannot keep it',
    );
    const after = new Deployments({ state, cacheMs: 0 });
    after.assistant('recorded', { v1: answering, v2: answering }, { live: 'v1' });
    after.assistant('fresh', { v1: answering, v2: answering }, { live: 'v1' });
    assert.equal((await after.get('fresh'))?.bucketStrategy, 'hash-v2', 'a deployment first recorded on hash-v2');
    await after.canary('fresh', 'v2', 0.5);
    const stored = (await after.list()).find((record) => record.assistant === 'fresh');
    assert.deepEqual(
      [stored?.version, stored?.bucketStrategy],
      [1, 'hash-v2'],
      'and recorded so, for every replica to read',
    );
    assert.equal((await after.get('recorded'))?.bucketStrategy, undefined, 'a recorded deployment keeps its own');

    // An option set explicitly wins under the preview, as it will under 3.0.
    assert.equal(new Tracer({ store: durableStore(), incremental: false }).incremental, false);
    assert.equal(new RedisOperationStore(redis as never, { index: false }).indexed, false);
    assert.throws(
      () => new RedisOperationStore(withoutIndexCommands, { index: true }),
      /needs zadd, zrem, and zrangebyscore/,
      'asked for explicitly, a client that cannot is still refused',
    );
    const kept = new Deployments({ state: new MemoryServerStore(), cacheMs: 0 });
    kept.assistant('support', { v1: answering }, { live: 'v1', bucketStrategy: 'fnv1a-v1' });
    assert.equal((await kept.get('support'))?.bucketStrategy, 'fnv1a-v1');

    // Back to 2.x: what is created next is as before.
    useDefaults('2.x');
    assert.equal(new Tracer({ store: durableStore() }).incremental, false);
    assert.equal(new RedisOperationStore(redis as never).indexed, false);
  } finally {
    useDefaults('2.x');
  }
});

test('nexus doctor --upgrade 3.0 says what 3.0 would change for a deployment, and what to do first', async () => {
  const redis = await FakeRedis.create();
  try {
    useDefaults('2.x');
    const deployments = new Deployments({ state: new MemoryServerStore(), cacheMs: 0 });
    deployments.assistant('support', { v1: answering }, { live: 'v1' });
    deployments.assistant('billing', { v1: answering }, { live: 'v1', bucketStrategy: 'fnv1a-v1' });
    deployments.assistant('orders', { v1: answering, v2: answering }, { live: 'v1' });
    await deployments.canary('orders', 'v2', 0.1);
    const stores = {
      tracer: new Tracer({ store: durableStore() }),
      local: new Tracer({ store: new MemoryTraceStore() }),
      queue: new RedisOperationStore(redis as never),
      deployments,
    };
    const upgrade = async (options: Parameters<typeof diagnose>[0]) =>
      (await diagnose({ nodeVersion: '24.0.0', env: {}, resolvePackage: () => true, ...options })).checks.find(
        (check) => check.id === 'upgrade',
      );
    assert.equal((await upgrade({ deployment: { replicas: 2, stores } }))?.status, 'skip', 'only when asked');
    const readiness = await upgrade({ upgrade: '3.0', deployment: { replicas: 2, stores } });
    assert.equal(readiness?.status, 'warn');
    assert.match(
      readiness?.detail ?? '',
      /tracer writes each trace when its root finishes; 3\.0 writes each run as it starts and ends, unless it is created with incremental: false/,
    );
    assert.match(
      readiness?.detail ?? '',
      /queue reads every record to find queued work; 3\.0 keeps an index, unless it is created with index: false: first run 2\.2 or later on every worker sharing its prefix, and call reindex\(\) once/,
    );
    assert.match(
      readiness?.detail ?? '',
      /deployments has not yet recorded support; 3\.0 would first record it with hash-v2, unless registered with bucketStrategy: 'fnv1a-v1'/,
    );
    assert.doesNotMatch(
      readiness?.detail ?? '',
      /local|billing|orders/,
      'a store in memory, a strategy chosen, and a deployment recorded are not changed',
    );
    assert.match(readiness?.hint ?? '', /useDefaults\('3\.0'\).*NEXUS_DEFAULTS=3\.0/);

    const ready = await upgrade({
      upgrade: '3.0',
      deployment: {
        replicas: 2,
        stores: {
          tracer: new Tracer({ store: durableStore(), incremental: true }),
          queue: new RedisOperationStore(redis as never, { index: true }),
        },
      },
    });
    assert.deepEqual([ready?.status, ready?.detail], ['ok', "Nothing described here changes under 3.0's defaults."]);
    assert.equal((await upgrade({ upgrade: '3.0' }))?.status, 'skip', 'no stores described');
    const unknown = await upgrade({ upgrade: '4.0' as never });
    assert.deepEqual([unknown?.status, unknown?.detail], ['fail', 'Readiness is checked for 3.0, not "4.0"']);

    useDefaults('3.0');
    const previewed = await upgrade({ upgrade: '3.0', deployment: { replicas: 2, stores } });
    assert.deepEqual(
      [previewed?.status, previewed?.detail],
      ['ok', "3.0's defaults are on already: what runs here is what 3.0 runs."],
    );
  } finally {
    useDefaults('2.x');
  }
});
