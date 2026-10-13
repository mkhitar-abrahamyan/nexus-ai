/**
 * The shared embedding cache: every store keeps the same contract, a request reads and writes its
 * vectors in one round trip, and a second process embeds what the first did with no provider call.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { CacheAdapter } from '../src/cache/adapters.js';
import {
  embeddingCacheKey,
  MemoryEmbeddingCache,
  packVector,
  RedisEmbeddingCache,
  tieredEmbeddingCache,
  unpackVector,
} from '../src/embeddings/cache.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresEmbeddingCache } from '../src/postgres/embedding-cache.js';
import { SqliteEmbeddingCache } from '../src/sqlite/embedding-cache.js';
import type { EmbeddingCacheStore } from '../src/types/embeddings.js';
import { cacheContract, vector } from './embedding-cache-contract.js';
import { FakeRedis } from './redis-fake.js';

let pg: PGlite;
let redis: FakeRedis;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
});

test('every embedding cache store keeps the same contract', async () => {
  const sqlite = new SqliteEmbeddingCache(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const postgres = new PostgresEmbeddingCache(pg as unknown as PostgresLikeClient, { table: 'public.embedding_cache' });
  await postgres.migrate();
  await postgres.migrate();
  const stores: Array<[string, EmbeddingCacheStore]> = [
    ['memory', new MemoryEmbeddingCache()],
    ['redis', new RedisEmbeddingCache(redis, { prefix: 'contract:' })],
    ['redis (cluster)', new RedisEmbeddingCache(redis, { prefix: 'cluster:', multiKey: false })],
    ['sqlite', sqlite],
    ['postgres', postgres],
    ['tiered', tieredEmbeddingCache(new MemoryEmbeddingCache(), new MemoryEmbeddingCache())],
  ];
  for (const [name, store] of stores) await cacheContract(name, store);
});

test('a cached vector expires after its lifetime, in every store that keeps one', async () => {
  let now = 1_000_000;
  const clock = () => now;
  const memory = new MemoryEmbeddingCache({ now: clock });
  const sqlite = new SqliteEmbeddingCache(new DatabaseSync(':memory:'), { now: clock });
  await sqlite.migrate();
  redis.now = clock;
  const shared = new RedisEmbeddingCache(redis, { prefix: 'ttl:' });
  for (const store of [memory, sqlite, shared]) await store.setMany([{ key: 'x', vector: vector(1) }], 60);
  now += 59_000;
  for (const store of [memory, sqlite, shared]) assert.deepEqual(await store.getMany(['x']), [vector(1)]);
  now += 2_000;
  for (const store of [memory, sqlite, shared]) assert.deepEqual(await store.getMany(['x']), [undefined]);
  assert.equal(await sqlite.purgeExpired(), 1);
  redis.now = Date.now;

  const postgres = new PostgresEmbeddingCache(pg as unknown as PostgresLikeClient, { table: 'expiring_cache' });
  await postgres.migrate();
  await postgres.setMany([{ key: 'gone', vector: vector(1) }], 0.001);
  await postgres.setMany([{ key: 'kept', vector: vector(2) }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await postgres.getMany(['gone', 'kept']), [undefined, vector(2)]);
  assert.equal(await postgres.purgeExpired(), 1);
});

test('the memory cache evicts the least recently used vector', async () => {
  const cache = new MemoryEmbeddingCache({ maxEntries: 2 });
  await cache.setMany([
    { key: 'a', vector: vector(1) },
    { key: 'b', vector: vector(2) },
  ]);
  await cache.getMany(['a']);
  await cache.setMany([{ key: 'c', vector: vector(3) }]);
  assert.deepEqual(await cache.getMany(['a', 'b', 'c']), [vector(1), undefined, vector(3)]);
  assert.equal(cache.size, 2);
  assert.throws(() => new MemoryEmbeddingCache({ maxEntries: 0 }), /positive integer/);
});

test('a tiered cache answers near first, copies a far hit near, and writes to both', async () => {
  const near = new MemoryEmbeddingCache();
  const far = new MemoryEmbeddingCache();
  await far.setMany([{ key: 'far', vector: vector(9) }]);
  const tiered = tieredEmbeddingCache(near, far);
  assert.deepEqual(await tiered.getMany(['far', 'none']), [vector(9), undefined]);
  assert.deepEqual(await near.getMany(['far']), [vector(9)], 'the far hit was copied near');
  await tiered.setMany([{ key: 'new', vector: vector(4) }]);
  assert.deepEqual([await near.getMany(['new']), await far.getMany(['new'])], [[vector(4)], [vector(4)]]);
});

test('vectors pack as float32, and keys are hashes that never hold the text', () => {
  const values = [0.1, -2.5, 2.71, 1e-8];
  assert.deepEqual(unpackVector(packVector(values)), values.map(Math.fround));
  assert.equal(packVector(values).byteLength, 16);
  assert.throws(() => unpackVector(new Uint8Array(3)), /whole number/);
  const context = { provider: 'openai', model: 'text-embedding-3-small' };
  const key = embeddingCacheKey(context, 'a confidential contract clause');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(
    key,
    embeddingCacheKey({ model: 'text-embedding-3-small', provider: 'openai' }, 'a confidential contract clause'),
  );
  assert.notEqual(key, embeddingCacheKey({ ...context, dimensions: 512 }, 'a confidential contract clause'));
});

test('proof: a second process embeds a 2,000-text batch with no provider call and one cache read', async () => {
  const shared = await FakeRedis.create();
  const texts = Array.from({ length: 2_000 }, (_, index) => `document chunk ${index} about refunds and returns`);
  const process = () => {
    const provider = new MockEmbeddingProvider({ dimensions: 64 });
    const manager = new EmbeddingManager({
      providers: { mock: provider },
      defaultProvider: 'mock',
      cache: { store: new RedisEmbeddingCache(shared), ttlSeconds: 86_400 },
    });
    return { provider, manager };
  };

  const first = process();
  const written = await first.manager.embed({ input: texts });
  assert.ok(first.provider.calls.length > 0);
  assert.equal(shared.roundTrips, 2, 'the first process reads once and writes once');

  shared.roundTrips = 0;
  const second = process();
  const read = await second.manager.embed({ input: texts });
  assert.equal(second.provider.calls.length, 0, 'no provider call');
  assert.equal(shared.roundTrips, 1, 'one cache read for the whole batch');
  assert.equal(read.meta.cachedInputs, 2_000);
  assert.equal(read.meta.cacheHit, true);
  assert.deepEqual(
    read.vectors,
    written.vectors.map((values) => values.map(Math.fround)),
    'the same vectors, at the float32 precision providers send',
  );
  const keys = [...shared.strings.keys()];
  assert.equal(keys.length, 2_000);
  assert.ok(
    keys.every((key) => /^nexus:embedding:[0-9a-f]{64}$/.test(key)),
    'every key is a hash, never the text',
  );

  // A changed input is the only one embedded.
  const changed = [...texts.slice(0, 1_999), 'a new chunk'];
  const third = process();
  const partial = await third.manager.embed({ input: changed });
  assert.equal(partial.meta.cachedInputs, 1_999);
  assert.deepEqual(
    third.provider.calls.flatMap((call) => call.input),
    ['a new chunk'],
  );
  shared.close();
});

test('a cache adapter is asked for every input at once, not one after another', async () => {
  let inFlight = 0;
  let most = 0;
  const values = new Map<string, number[]>();
  const adapter: CacheAdapter<number[]> = {
    async get(key) {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
  const manager = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider() },
    defaultProvider: 'mock',
    cache: { enabled: true, adapter },
  });
  await manager.embed({ input: Array.from({ length: 50 }, (_, index) => `text ${index}`) });
  assert.equal(most, 50);
  const again = await manager.embed({ input: Array.from({ length: 50 }, (_, index) => `text ${index}`) });
  assert.equal(again.meta.cachedInputs, 50);
});
