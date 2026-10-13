import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  cosineSimilarity,
  createHashEmbeddings,
  MemoryVectorStore,
  normalizeVector,
} from '../src/hallucination/retrieval.js';
import type { VectorStore } from '../src/hallucination/retrieval.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { postgresMigration } from '../src/postgres/index.js';
import { PostgresVectorStore, vectorStoreMigration } from '../src/postgres/vectors.js';
import { DatabaseSync } from 'node:sqlite';
import { ChromaError, ChromaVectorStore } from '../src/rag/chroma.js';
import { PineconeVectorStore } from '../src/rag/pinecone.js';
import { QdrantError, QdrantVectorStore } from '../src/rag/qdrant.js';
import { RedisVectorStore } from '../src/rag/redis.js';
import { WeaviateError, WeaviateVectorStore } from '../src/rag/weaviate.js';
import { fromSqliteDatabase } from '../src/sqlite/client.js';
import { SqliteVectorStore, sqliteVectorStoreMigration } from '../src/sqlite/vectors.js';
import { typedFilterContract, vectorStoreContract } from './vector-contract.js';
import { concurrentWriters } from './vector-graduation.js';
import { chromaStub, pineconeStub, qdrantStub, redisStub, weaviateStub } from './vector-stubs.js';

const DIMENSIONS = 64;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);

let db: PGlite;
let client: PostgresLikeClient;
let tables = 0;

before(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  client = db as unknown as PostgresLikeClient;
});
after(async () => {
  await db.close();
});

async function stores(): Promise<Array<[string, VectorStore]>> {
  const postgres = new PostgresVectorStore(client, { dimensions: DIMENSIONS, embed, table: `vectors_${++tables}` });
  await postgres.migrate();
  const exact = new PostgresVectorStore(client, {
    dimensions: DIMENSIONS,
    embed,
    table: `vectors_${++tables}`,
    index: 'none',
  });
  await exact.migrate();
  const qdrant = new QdrantVectorStore({
    url: 'http://qdrant.test:6333/',
    collection: `chunks-${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: qdrantStub().fetch,
  });
  await qdrant.migrate({ filterFields: ['tenant'] });

  const sqlite = new DatabaseSync(':memory:');
  // sqlite-vec's vec_distance_cosine, over the same float32 blobs, so the SQL path runs without the extension.
  const floats = (blob: Uint8Array) => Array.from(new Float32Array(blob.slice().buffer));
  sqlite.function('vec_distance_cosine', { deterministic: true }, (a, b) => {
    return 1 - cosineSimilarity(normalizeVector(floats(a as Uint8Array)), normalizeVector(floats(b as Uint8Array)));
  });
  const scan = new SqliteVectorStore(sqlite, { dimensions: DIMENSIONS, embed, table: `scan_${++tables}` });
  await scan.migrate();
  const sqliteVec = new SqliteVectorStore(fromSqliteDatabase(sqlite), {
    dimensions: DIMENSIONS,
    embed,
    table: `vec_${++tables}`,
    search: 'sqlite-vec',
  });
  await sqliteVec.migrate();

  const redis = new RedisVectorStore(redisStub().client, {
    dimensions: DIMENSIONS,
    embed,
    index: `idx-${++tables}`,
    prefix: `chunk:${tables}:`,
    filterFields: ['tenant', 'page'],
  });
  await redis.migrate();
  await redis.migrate();
  // Each client shape and each way a search reply arrives: RESP2, and RESP3 as an object or a Map.
  const redisShapes = await Promise.all(
    (
      [
        ['redis (node-redis, RESP2)', { client: 'node-redis' }],
        ['redis (ioredis, RESP2)', { reply: 'resp2' }],
        ['redis (RESP3 objects)', { client: 'node-redis', reply: 'resp3-object' }],
        ['redis (RESP3 Map)', { client: 'node-redis', reply: 'resp3-map' }],
      ] as const
    ).map(async ([name, shape]) => {
      const store = new RedisVectorStore(redisStub(shape).client, {
        dimensions: DIMENSIONS,
        embed,
        index: `idx-${++tables}`,
        prefix: `chunk:${tables}:`,
        filterFields: ['tenant', 'page'],
      });
      await store.migrate();
      return [name, store] as [string, VectorStore];
    }),
  );
  const pinecone = new PineconeVectorStore({
    host: 'docs-abc.svc.pinecone.test',
    apiKey: 'pc-key',
    dimensions: DIMENSIONS,
    embed,
    fetch: pineconeStub().fetch,
  });
  const weaviate = new WeaviateVectorStore({
    url: 'http://weaviate.test:8080',
    collection: `Chunk${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: weaviateStub().fetch,
  });
  await weaviate.migrate({ filterFields: { tenant: 'text', page: 'number' } });
  const chroma = new ChromaVectorStore({
    url: 'http://chroma.test:8000',
    collection: `chunks-${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: chromaStub().fetch,
  });
  await chroma.migrate();
  const chromaDeclared = new ChromaVectorStore({
    url: 'http://chroma.test:8000',
    collection: `chunks-${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: chromaStub().fetch,
    filterFields: ['tenant', 'page'],
  });
  await chromaDeclared.migrate();
  return [
    ['memory', new MemoryVectorStore(embed)],
    ['pgvector (hnsw)', postgres],
    ['pgvector (exact)', exact],
    ['qdrant', qdrant],
    ['sqlite (scan)', scan],
    ['sqlite (sqlite-vec)', sqliteVec],
    ['redis', redis],
    ...redisShapes,
    ['pinecone', pinecone],
    ['weaviate', weaviate],
    ['chroma', chroma],
    ['chroma (declared fields)', chromaDeclared],
  ];
}

test('every vector store ranks, filters, replaces, and deletes the same way', async () => {
  for (const [name, store] of await stores()) await vectorStoreContract(name, store, embed);
});

test('a filter matches type as well as value, in every store that filters natively', async () => {
  for (const [name, store] of await stores()) {
    if (name === 'qdrant' || name.startsWith('pgvector')) continue;
    await typedFilterContract(name, store);
  }
});

test('ten writers racing on the same ids leave each id whole, in every store', async () => {
  const fields = ['writer', 'page'];
  const weaviate = new WeaviateVectorStore({
    url: 'http://weaviate.test:8080',
    collection: `Race${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: weaviateStub().fetch,
  });
  await weaviate.migrate({ filterFields: { writer: 'number', page: 'number' } });
  const postgres = new PostgresVectorStore(client, { dimensions: DIMENSIONS, embed, table: `race_${++tables}` });
  const qdrant = new QdrantVectorStore({
    url: 'http://qdrant.test:6333',
    collection: `race-${++tables}`,
    dimensions: DIMENSIONS,
    embed,
    fetch: qdrantStub().fetch,
  });
  const redis = (shape: Parameters<typeof redisStub>[0]) =>
    new RedisVectorStore(redisStub(shape).client, {
      dimensions: DIMENSIONS,
      embed,
      index: `race-${++tables}`,
      prefix: `race:${tables}:`,
      filterFields: fields,
    });
  const stores: Array<[string, VectorStore & { migrate?: () => Promise<unknown> }]> = [
    ['memory', new MemoryVectorStore(embed)],
    ['pgvector', postgres],
    ['sqlite', new SqliteVectorStore(new DatabaseSync(':memory:'), { dimensions: DIMENSIONS, embed })],
    ['qdrant', qdrant],
    // Redis and Chroma replace in more than one request unless the store makes it one step, so their
    // stand-ins answer after a seeded network delay, and writers interleave as they would for real.
    ['redis', redis({ jitterMs: 3 })],
    ['redis (node-redis)', redis({ client: 'node-redis', jitterMs: 3 })],
    [
      'pinecone',
      new PineconeVectorStore({
        host: 'race.pinecone.test',
        apiKey: 'k',
        dimensions: DIMENSIONS,
        embed,
        fetch: pineconeStub().fetch,
      }),
    ],
    ['weaviate', weaviate],
    // Without declared fields, Chroma reads before it writes, so racing writers can leave a stale
    // field: the guide says so, and declared fields are the race-free mode.
    [
      'chroma (declared fields)',
      new ChromaVectorStore({
        url: 'http://chroma.test:8000',
        collection: `race-${++tables}`,
        dimensions: DIMENSIONS,
        embed,
        fetch: chromaStub({ jitterMs: 3 }).fetch,
        filterFields: fields,
      }),
    ],
  ];
  for (const [name, store] of stores) {
    await store.migrate?.();
    await concurrentWriters(name, store);
  }
});

test('a topK that is not a positive integer is refused before it reaches a remote store', async () => {
  const stores: VectorStore[] = [
    new RedisVectorStore(redisStub().client, { dimensions: DIMENSIONS, embed }),
    new WeaviateVectorStore({ url: 'http://w.test', dimensions: DIMENSIONS, embed, fetch: weaviateStub().fetch }),
    new QdrantVectorStore({
      url: 'http://q.test',
      collection: 'c',
      dimensions: DIMENSIONS,
      embed,
      fetch: qdrantStub().fetch,
    }),
    new ChromaVectorStore({ collection: 'c', dimensions: DIMENSIONS, embed, fetch: chromaStub().fetch }),
    new PineconeVectorStore({
      host: 'p.test',
      apiKey: 'k',
      dimensions: DIMENSIONS,
      embed,
      fetch: pineconeStub().fetch,
    }),
  ];
  for (const store of stores) {
    for (const topK of [2.5, -1, Number.NaN, '5) { injected }' as unknown as number]) {
      await assert.rejects(store.search('x', { topK }), /topK must be a positive integer/);
    }
  }
  const chroma = new ChromaVectorStore({
    collection: 'declared',
    dimensions: DIMENSIONS,
    embed,
    fetch: chromaStub().fetch,
    filterFields: ['tenant'],
  });
  await chroma.migrate();
  await assert.rejects(chroma.search('x', { filter: { region: 'eu' } }), /not a filter field/);
});

test('a vector of the wrong width is refused before it reaches the store', async () => {
  for (const [name, store] of await stores()) {
    if (store instanceof MemoryVectorStore) continue;
    await assert.rejects(store.add([{ id: 'x', content: 'x', embedding: [1, 2, 3] }]), /3 dimensions/, name);
    await assert.rejects(store.searchVector([1, 2]), /2 dimensions/, name);
  }
});

test('the pgvector migration is idempotent, and joins the Postgres migration when named', async () => {
  const name = `vectors_${++tables}`;
  for (const statement of vectorStoreMigration({ dimensions: 8, table: name })) await client.query(statement);
  for (const statement of vectorStoreMigration({ dimensions: 8, table: name })) await client.query(statement);
  assert.throws(() => vectorStoreMigration({ dimensions: 0 }), /positive integer/);
  assert.throws(() => new PostgresVectorStore(client, { dimensions: 1.5 }), /positive integer/);

  assert.doesNotMatch(postgresMigration(), /nexus_vectors/, 'vectors are opt-in');
  assert.match(postgresMigration({ adapters: ['vectors'], vectorDimensions: 8 }), /vector\(8\)/);
  assert.throws(() => postgresMigration({ adapters: ['vectors'] }), /vectorDimensions/);
});

test('the Qdrant store maps ids to stable UUIDs, authenticates, and reports errors', async () => {
  const stub = qdrantStub();
  const store = new QdrantVectorStore({
    url: 'https://cluster.qdrant.test',
    collection: 'docs',
    dimensions: DIMENSIONS,
    embed,
    apiKey: 'secret-key',
    fetch: stub.fetch,
  });
  await store.migrate();
  await store.migrate();
  assert.equal(
    stub.requests.filter((request) => request.method === 'PUT' && request.url === '/collections/docs').length,
    1,
  );

  await store.add([{ id: 'a', content: 'alpha' }]);
  await store.add([{ id: 'a', content: 'alpha again' }]);
  assert.equal(stub.collections.get('docs')?.points.size, 1, 'the same chunk id maps to the same point');
  assert.ok(stub.requests.every((request) => request.headers['api-key'] === 'secret-key'));

  const missing = new QdrantVectorStore({
    url: 'https://cluster.qdrant.test',
    collection: 'absent',
    dimensions: DIMENSIONS,
    fetch: stub.fetch,
  });
  const error = await missing.search('anything').catch((caught: unknown) => caught);
  assert.ok(error instanceof QdrantError);
  assert.equal(error.status, 404);
});

test('the memory store replaces by id and keeps its size honest', async () => {
  const store = new MemoryVectorStore(embed);
  await store.add([
    { id: 'a', content: 'one' },
    { id: 'a', content: 'two' },
  ]);
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
});

test('the SQLite migration is idempotent and the Redis store refuses a filter it did not index', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(sqliteVectorStoreMigration({ table: 'chunks' }));
  sqlite.exec(sqliteVectorStoreMigration({ table: 'chunks' }));
  assert.throws(() => new SqliteVectorStore(sqlite, { dimensions: 0 }), /positive integer/);

  const redis = new RedisVectorStore(redisStub().client, { dimensions: DIMENSIONS, embed, filterFields: ['tenant'] });
  await redis.migrate();
  await assert.rejects(redis.search('x', { filter: { region: 'eu' } }), /not a filter field/);
  assert.throws(
    () => new RedisVectorStore(redisStub().client, { dimensions: 4, filterFields: ['bad field'] }),
    /filter field/,
  );
});

test('a Weaviate filter is typed by the schema, which is read once and again only for a new property', async () => {
  const stub = weaviateStub();
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return stub.fetch(input, init);
  };
  const store = new WeaviateVectorStore({
    url: 'http://w.test',
    collection: 'Typed',
    dimensions: DIMENSIONS,
    embed,
    fetch,
  });
  // A collection made elsewhere: `page` is an int, which takes `valueInt` rather than `valueNumber`.
  stub.classes.set('Typed', {
    properties: [
      { name: 'chunkId', dataType: ['text'] },
      { name: 'meta_page', dataType: ['int'] },
    ],
    objects: new Map(),
  });
  await store.add([
    { id: 'a', content: 'refunds on page three', metadata: { page: 3 } },
    { id: 'b', content: 'refunds on page four', metadata: { page: 4 } },
  ]);
  const schemaReads = () => requests.filter((request) => request === 'GET /v1/schema/Typed').length;

  await store.search('refunds');
  assert.equal(schemaReads(), 0, 'an unfiltered search never reads the schema');
  assert.deepEqual(
    (await store.search('refunds', { filter: { page: 3 } })).map((result) => result.id),
    ['a'],
  );
  const searches = requests.length;
  assert.deepEqual(await store.search('refunds', { filter: { page: 3.5 } }), []);
  assert.deepEqual(await store.search('refunds', { filter: { page: '3' } }), []);
  assert.equal(requests.length, searches, 'a value that cannot match its property is answered without a request');
  assert.equal(schemaReads(), 1, 'the schema is read once');

  stub.classes.get('Typed')?.properties.push({ name: 'meta_tenant', dataType: ['text'] });
  await store.add([{ id: 'c', content: 'refunds for acme', metadata: { tenant: 'acme', page: 5 } }]);
  assert.deepEqual(
    (await store.search('refunds', { filter: { tenant: 'acme' } })).map((result) => result.id),
    ['c'],
    'a property added after the schema was read is found',
  );
  assert.equal(schemaReads(), 2);
});

test('a Weaviate result always matches its filter, even when the index keeps a stale entry', async () => {
  const store = new WeaviateVectorStore({
    url: 'http://w.test',
    collection: 'Stale',
    dimensions: DIMENSIONS,
    embed,
    fetch: weaviateStub({ stalePostings: true }).fetch,
  });
  await store.migrate({ filterFields: { page: 'number' } });
  await store.add([
    { id: 'moved', content: 'refunds on page three', metadata: { page: 3 } },
    { id: 'stays', content: 'more about refunds and returns', metadata: { page: 3 } },
  ]);
  await store.add([{ id: 'moved', content: 'refunds on page three', metadata: { page: 4 } }]);
  // The stale entry ranks first and takes the only place; the store drops it and asks for more.
  assert.deepEqual(
    (await store.search('refunds on page three', { filter: { page: 3 }, topK: 1 })).map((result) => result.id),
    ['stays'],
  );
  assert.deepEqual(
    (await store.search('refunds on page three', { filter: { page: 4 }, topK: 5 })).map((result) => result.id),
    ['moved'],
  );
});

test('the REST stores authenticate and report errors with their status', async () => {
  const pinecone = pineconeStub();
  const store = new PineconeVectorStore({
    host: 'https://idx.pinecone.test/',
    apiKey: 'pc-key',
    dimensions: DIMENSIONS,
    embed,
    fetch: pinecone.fetch,
  });
  await store.add([{ id: 'a', content: 'alpha' }]);
  assert.equal(pinecone.headers[0]?.['Api-Key'], 'pc-key');
  assert.ok(pinecone.headers[0]?.['X-Pinecone-API-Version']);

  const chroma = new ChromaVectorStore({ collection: 'absent', dimensions: DIMENSIONS, fetch: chromaStub().fetch });
  const chromaError = await chroma.search('x').catch((caught: unknown) => caught);
  assert.ok(chromaError instanceof ChromaError);
  assert.equal(chromaError.status, 404);

  const weaviate = new WeaviateVectorStore({
    url: 'http://w.test',
    collection: 'Missing',
    dimensions: DIMENSIONS,
    fetch: weaviateStub().fetch,
  });
  await assert.rejects(weaviate.search('x'), WeaviateError);
  await assert.rejects(weaviate.add([{ id: 'a', content: 'a' }]), /refused 1 object/);
  assert.throws(
    () => new WeaviateVectorStore({ url: 'http://w.test', collection: 'lower', dimensions: 4 }),
    /capital letter/,
  );
});
