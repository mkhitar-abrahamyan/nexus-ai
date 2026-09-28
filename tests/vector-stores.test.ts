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
import { QdrantError, QdrantVectorStore } from '../src/rag/qdrant.js';

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
  return [
    ['memory', new MemoryVectorStore(embed)],
    ['pgvector (hnsw)', postgres],
    ['pgvector (exact)', exact],
    ['qdrant', qdrant],
  ];
}

const passages = [
  {
    id: 'refunds#0',
    content: 'Refunds are issued within fourteen days of a return',
    source: 'policy.md',
    metadata: { tenant: 'acme', page: 3 },
  },
  {
    id: 'shipping#0',
    content: 'Orders ship from the warehouse within two business days',
    source: 'policy.md',
    metadata: { tenant: 'acme' },
  },
  { id: 'refunds#1', content: 'A refund goes back to the original payment method', metadata: { tenant: 'globex' } },
  { id: 'careers#0', content: 'We are hiring engineers in three offices' },
];

test('every vector store ranks, filters, replaces, and deletes the same way', async () => {
  for (const [name, store] of await stores()) {
    await store.add(passages);

    const refunds = await store.search('how long do refunds take', { topK: 2 });
    assert.equal(refunds[0]?.id, 'refunds#0', `${name}: the closest passage ranks first`);
    assert.equal(refunds.length, 2, `${name}: topK limits the results`);
    assert.ok(refunds[0].score > refunds[1].score, `${name}: best first`);
    assert.equal(refunds[0].source, 'policy.md', `${name}: the source comes back`);
    assert.deepEqual(refunds[0].metadata, { tenant: 'acme', page: 3 }, `${name}: metadata comes back whole`);

    const globex = await store.search('refund', { filter: { tenant: 'globex' } });
    assert.deepEqual(
      globex.map((result) => result.id),
      ['refunds#1'],
      `${name}: a metadata filter narrows the search`,
    );

    const strict = await store.search('how long do refunds take', { minScore: 0.99 });
    assert.equal(strict.length, 0, `${name}: minScore drops weak matches`);

    const [queryVector] = embed(['orders ship from the warehouse']);
    const byVector = await store.searchVector(queryVector, { topK: 1 });
    assert.equal(byVector[0]?.id, 'shipping#0', `${name}: a precomputed vector searches too`);

    await store.add([
      { id: 'careers#0', content: 'Refunds for event tickets are not available', metadata: { tenant: 'acme' } },
    ]);
    const replaced = await store.search('event tickets refunds', { topK: 10 });
    assert.equal(
      replaced.filter((result) => result.id === 'careers#0').length,
      1,
      `${name}: adding an existing id replaces it rather than duplicating it`,
    );
    assert.match(replaced.find((result) => result.id === 'careers#0')?.content ?? '', /event tickets/);

    await store.delete(['refunds#0', 'not-stored']);
    const afterDelete = await store.search('how long do refunds take', { topK: 10 });
    assert.equal(
      afterDelete.some((result) => result.id === 'refunds#0'),
      false,
      `${name}: a deleted chunk is gone`,
    );
    await store.delete([]);
    await store.add([]);
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
