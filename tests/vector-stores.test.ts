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
import { chromaStub, pineconeStub, redisStub, weaviateStub } from './vector-stubs.js';

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

/**
 * An in-memory stand-in for the parts of Qdrant's REST API the store uses: collections, upserts,
 * cosine search with a score threshold and `must` match filters, deletes, and payload indexes.
 */
function qdrantStub() {
  const collections = new Map<
    string,
    { size: number; points: Map<string, { vector: number[]; payload: Record<string, unknown> }> }
  >();
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const json = (status: number, result: unknown) =>
    new Response(JSON.stringify({ status: status < 300 ? 'ok' : 'error', result }), { status });

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    requests.push({ method, url: url.pathname, headers: (init.headers ?? {}) as Record<string, string> });
    const [, , name, ...rest] = url.pathname.split('/');
    const action = rest.join('/');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const collection = collections.get(decodeURIComponent(name ?? ''));

    if (action === '' && method === 'GET') return collection ? json(200, { status: 'green' }) : json(404, null);
    if (action === '' && method === 'PUT') {
      collections.set(decodeURIComponent(name ?? ''), { size: body.vectors.size, points: new Map() });
      return json(200, true);
    }
    if (!collection) return json(404, null);
    if (action === 'index') return json(200, { status: 'acknowledged' });
    if (action === 'points' && method === 'PUT') {
      for (const point of body.points) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(point.id)) {
          return json(400, { error: `bad point id ${point.id}` });
        }
        if (point.vector.length !== collection.size) return json(400, { error: 'wrong vector size' });
        collection.points.set(point.id, { vector: point.vector, payload: point.payload });
      }
      return json(200, { status: 'completed' });
    }
    if (action === 'points/search') {
      const query = normalizeVector(body.vector);
      const must: Array<{ key: string; match: { value: unknown } }> = body.filter?.must ?? [];
      const hits = [...collection.points.entries()]
        .filter(([, point]) =>
          must.every(
            ({ key, match }) =>
              (point.payload.metadata as Record<string, unknown> | null)?.[key.replace(/^metadata\./, '')] ===
              match.value,
          ),
        )
        .map(([id, point]) => ({
          id,
          score: cosineSimilarity(query, normalizeVector(point.vector)),
          payload: point.payload,
        }))
        .filter((hit) => hit.score >= (body.score_threshold ?? -1))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.limit);
      return json(200, hits);
    }
    if (action === 'points/delete') {
      for (const id of body.points) collection.points.delete(id);
      return json(200, { status: 'completed' });
    }
    return json(404, null);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests, collections };
}

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
  return [
    ['memory', new MemoryVectorStore(embed)],
    ['pgvector (hnsw)', postgres],
    ['pgvector (exact)', exact],
    ['qdrant', qdrant],
    ['sqlite (scan)', scan],
    ['sqlite (sqlite-vec)', sqliteVec],
    ['redis', redis],
    ['pinecone', pinecone],
    ['weaviate', weaviate],
    ['chroma', chroma],
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
