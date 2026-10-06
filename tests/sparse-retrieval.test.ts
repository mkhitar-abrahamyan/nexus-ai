/**
 * Sparse retrieval and reranking as contracts.
 *
 * One contract runs against every keyword index: the in-memory BM25 index, Postgres full-text search
 * in its own table and over a pgvector table, and Elasticsearch through its REST API. The rerankers
 * are checked against the wire format of each API. The proof is an experiment on the stored support
 * dataset, on real Postgres (PGlite) with real full-text search and pgvector: hybrid retrieval beats
 * vector-only, and a hosted reranker and a local cross-encoder are compared in the same experiment.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { compareExperiments, formatComparison } from '../src/evaluate/compare.js';
import { createDataset } from '../src/evaluate/datasets.js';
import { recallAtK, reciprocalRank } from '../src/evaluate/evaluators.js';
import { evaluate } from '../src/evaluate/run.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { keywordIndexMigrations, PostgresKeywordIndex } from '../src/postgres/fulltext.js';
import { PostgresVectorStore } from '../src/postgres/vectors.js';
import { ElasticsearchError, ElasticsearchKeywordIndex } from '../src/rag/elasticsearch.js';
import {
  cohereReranker,
  crossEncoderReranker,
  httpReranker,
  jinaReranker,
  RerankerError,
  teiReranker,
  voyageReranker,
} from '../src/rag/rerankers.js';
import {
  hybridRetriever,
  KeywordIndex,
  type Retriever,
  rerankRetriever,
  type SparseRetriever,
  vectorRetriever,
} from '../src/rag/retrievers.js';
import { ARTICLES, conceptEmbed, QUESTIONS } from './retrieval-dataset.js';
import { elasticsearchStub } from './search-engine-stub.js';

let db: PGlite;
let client: PostgresLikeClient;
let tables = 0;

before(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  client = db as unknown as PostgresLikeClient;
});
after(async () => {
  await db.close();
});

async function indexes(): Promise<Array<[string, SparseRetriever & { size(): number | Promise<number> }]>> {
  const own = new PostgresKeywordIndex(client, { table: `keywords_${++tables}` });
  await own.migrate();
  const stub = elasticsearchStub({ apiKey: 'es-key' });
  const search = new ElasticsearchKeywordIndex({
    url: 'https://search.test',
    index: `kb-${tables}`,
    apiKey: 'es-key',
    fetch: stub.fetch,
  });
  await search.migrate();
  return [
    ['memory BM25', new KeywordIndex()],
    ['postgres full-text', own],
    ['elasticsearch', search],
  ];
}

test('every keyword index honours one contract: ranking, replacement, deletion, filters, and size', async () => {
  for (const [name, index] of await indexes()) {
    await index.add([
      {
        id: 'a',
        content: 'Error ERR-4012 appears when an upload exceeds the storage quota.',
        metadata: { area: 'files' },
      },
      { id: 'b', content: 'Refunds are issued to the original payment method.', metadata: { area: 'billing' } },
      { id: 'c', content: 'Upload limits depend on the plan.', source: 'kb', metadata: { area: 'files' } },
    ]);
    assert.equal(await index.size(), 3, name);

    const coded = await index.retrieve('ERR-4012', { topK: 3 });
    assert.equal(coded[0]?.id, 'a', `${name}: the exact code ranks first`);
    const partial = await index.retrieve('upload refunds', { topK: 3 });
    assert.deepEqual(
      partial.map((hit) => hit.id).sort(),
      ['a', 'b', 'c'],
      `${name}: any of the terms is enough, so partial matches are ranked, not dropped`,
    );
    assert.ok(
      partial.every((hit, position) => position === 0 || hit.score <= (partial[position - 1]?.score ?? 0)),
      name,
    );

    const filtered = await index.retrieve('upload', { filter: { area: 'files' } });
    assert.deepEqual(filtered.map((hit) => hit.id).sort(), ['a', 'c'], `${name}: a filter runs with the search`);
    assert.deepEqual(await index.retrieve('upload', { filter: { area: 'billing' } }), [], name);
    assert.equal((await index.retrieve('limits', { topK: 1 }))[0]?.source, 'kb', `${name}: the source comes back`);

    await index.add([{ id: 'b', content: 'Refunds now take five days.', metadata: { area: 'billing' } }]);
    assert.equal(await index.size(), 3, `${name}: an existing id is replaced`);
    assert.match(String((await index.retrieve('refunds'))[0]?.content), /five days/, name);

    await index.delete(['a', 'missing']);
    assert.equal(await index.size(), 2, `${name}: a missing id is ignored`);
    assert.deepEqual(await index.retrieve('ERR-4012'), [], name);
    assert.deepEqual(await index.retrieve(''), [], `${name}: an empty query matches nothing`);
  }
});

test('Postgres full-text search can live on a pgvector table, so hybrid search keeps one copy', async () => {
  const table = `kb_shared_${++tables}`;
  const vectors = new PostgresVectorStore(client, { dimensions: 128, embed: conceptEmbed, table, index: 'none' });
  await vectors.migrate();
  const keywords = new PostgresKeywordIndex(client, { table, shared: true });
  await keywords.migrate();
  await keywords.migrate();
  await vectors.add(ARTICLES.slice(0, 5));
  // The vector store writes; the generated column keeps keyword search current without a second write.
  assert.equal((await keywords.retrieve('ERR-5001'))[0]?.id, 'a03');
  await keywords.add([{ id: 'ignored', content: 'never stored' }]);
  await keywords.delete(['a03']);
  assert.equal(await keywords.size(), 5, 'with shared, writes are the vector store’s');
  await vectors.delete(['a03']);
  assert.ok(
    !(await keywords.retrieve('ERR-5001')).some((hit) => hit.id === 'a03'),
    'a delete in the store is a delete in the index',
  );

  const all = new PostgresKeywordIndex(client, { table: `keywords_all_${++tables}`, match: 'all', language: 'simple' });
  await all.migrate();
  await all.add([
    { id: 'x', content: 'reset the password' },
    { id: 'y', content: 'reset the router' },
  ]);
  assert.deepEqual(
    (await all.retrieve('reset password')).map((hit) => hit.id),
    ['x'],
    'all needs every term',
  );
  assert.deepEqual(
    (await all.retrieve('reset -router')).map((hit) => hit.id),
    ['x'],
    'and reads a web search query',
  );
  assert.throws(() => new PostgresKeywordIndex(client, { language: "english'; drop table x; --" }), /configuration/);
  assert.match(
    keywordIndexMigrations({ table: 't', shared: true })[0]?.statements[0] ?? '',
    /ALTER TABLE "t" ADD COLUMN IF NOT EXISTS fts/,
  );
});

test('the Elasticsearch index speaks the REST API: mappings, NDJSON bulk writes, auth, and errors', async () => {
  const stub = elasticsearchStub({ apiKey: 'es-key' });
  const index = new ElasticsearchKeywordIndex({
    url: 'https://search.test/',
    index: 'kb',
    apiKey: 'es-key',
    analyzer: 'english',
    fetch: stub.fetch,
  });
  await index.migrate();
  await index.migrate();
  const mappings = stub.indexes.get('kb')?.mappings as { properties: { content: { analyzer: string } } };
  assert.equal(mappings.properties.content.analyzer, 'english');
  assert.equal(stub.requests.filter((request) => request.method === 'PUT').length, 1, 'migrate creates the index once');

  await index.add([{ id: 'a', content: 'hello world' }]);
  const bulk = stub.requests.find((request) => request.path.startsWith('/_bulk'));
  assert.equal(bulk?.path, '/_bulk?refresh=wait_for');
  assert.equal(bulk?.contentType, 'application/x-ndjson');
  assert.ok(stub.requests.every((request) => request.authorization === 'ApiKey es-key'));

  const denied = new ElasticsearchKeywordIndex({
    url: 'https://search.test',
    index: 'kb',
    apiKey: 'wrong',
    fetch: stub.fetch,
  });
  await assert.rejects(
    denied.retrieve('hello'),
    (error: unknown) => error instanceof ElasticsearchError && error.status === 401,
  );
  const missing = new ElasticsearchKeywordIndex({
    url: 'https://search.test',
    index: 'nope',
    apiKey: 'es-key',
    fetch: stub.fetch,
  });
  await assert.rejects(missing.add([{ id: 'x', content: 'x' }]), /bulk write failed: no such index/);
  assert.deepEqual(
    await index.retrieve('hello', { filter: { tags: ['a'] } as never }),
    [],
    'a list never matches exactly',
  );
  assert.throws(() => new ElasticsearchKeywordIndex({ url: 'https://x', index: 'Bad Name' }), /index name/);

  const basic = elasticsearchStub();
  await new ElasticsearchKeywordIndex({
    url: 'https://search.test',
    index: 'b',
    username: 'elastic',
    password: 'pw',
    fetch: basic.fetch,
    refresh: false,
  }).migrate();
  assert.equal(basic.requests[0]?.authorization, `Basic ${btoa('elastic:pw')}`);
});

test('rerankers speak each API’s wire format and put scores back in the order of the chunks', async () => {
  const chunks = [
    { id: 'a', content: 'first passage', score: 0 },
    { id: 'b', content: 'second passage', score: 0 },
    { id: 'c', content: 'third passage', score: 0 },
  ];
  const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const api = (reply: unknown, status = 200) =>
    (async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({
        url: String(input),
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return new Response(JSON.stringify(reply), { status });
    }) as typeof globalThis.fetch;

  const sorted = [
    { index: 2, relevance_score: 0.9 },
    { index: 0, relevance_score: 0.4 },
  ];
  assert.deepEqual(
    await cohereReranker({ apiKey: 'k', model: 'rerank-v3.5', fetch: api({ results: sorted }) })('q', chunks),
    [0.4, 0, 0.9],
  );
  assert.equal(seen[0]?.url, 'https://api.cohere.com/v2/rerank');
  assert.deepEqual(seen[0]?.body, {
    model: 'rerank-v3.5',
    query: 'q',
    documents: ['first passage', 'second passage', 'third passage'],
    top_n: 3,
  });
  assert.equal(seen[0]?.auth, 'Bearer k');
  assert.deepEqual(
    await voyageReranker({ apiKey: 'k', model: 'rerank-2', fetch: api({ data: sorted }) })('q', chunks),
    [0.4, 0, 0.9],
  );
  assert.equal(seen[1]?.body.top_k, 3);
  assert.deepEqual(
    await jinaReranker({ apiKey: 'k', model: 'jina', fetch: api({ results: sorted }) })('q', chunks),
    [0.4, 0, 0.9],
  );
  assert.equal(seen[2]?.url, 'https://api.jina.ai/v1/rerank');
  const tei = await teiReranker({ url: 'http://localhost:8080/', fetch: api([{ index: 1, score: 0.7 }]) })('q', chunks);
  assert.deepEqual(tei, [0, 0.7, 0]);
  assert.equal(seen[3]?.url, 'http://localhost:8080/rerank');
  assert.deepEqual(seen[3]?.body, {
    query: 'q',
    texts: ['first passage', 'second passage', 'third passage'],
    raw_scores: false,
    truncate: true,
  });

  const custom = httpReranker({
    url: 'https://rerank.internal/score',
    body: (query, passages) => ({ q: query, p: passages }),
    scores: (response) => (response as number[]).map((score, index) => ({ index, score })),
    maxChunkCharacters: 5,
    fetch: api([0.1, 0.2, 0.3]),
  });
  assert.deepEqual(await custom('q', chunks), [0.1, 0.2, 0.3]);
  assert.deepEqual(seen[4]?.body.p, ['first', 'secon', 'third'], 'chunks are truncated before they are sent');
  await assert.rejects(
    async () => cohereReranker({ apiKey: 'k', model: 'm', fetch: api({ message: 'invalid' }, 401) })('q', chunks),
    (error: unknown) => error instanceof RerankerError && error.status === 401,
  );
  assert.deepEqual(await cohereReranker({ apiKey: 'k', model: 'm', fetch: api({}) })('q', []), []);

  // A cross-encoder in process: batched, optionally squashed to 0–1, and stopped by the signal.
  const batches: number[] = [];
  const local = crossEncoderReranker(
    {
      score: (pairs) => {
        batches.push(pairs.length);
        return pairs.map(([, passage]) => (passage.startsWith('third') ? 4 : -4));
      },
    },
    { batchSize: 2, sigmoid: true },
  );
  const scores = await local('q', chunks);
  assert.deepEqual(batches, [2, 1]);
  assert.ok((scores[2] ?? 0) > 0.98 && (scores[0] ?? 1) < 0.02);
  await assert.rejects(async () => local('q', chunks, AbortSignal.abort()), /abort/i);
  await assert.rejects(async () => crossEncoderReranker({ score: () => [1] })('q', chunks), /1 scores for 3 pairs/);
});

/**
 * A relevance scorer that reads the query and the passage together, as a cross-encoder does: meaning
 * from the concepts both share, and exact identifiers when both contain the same one. The hosted
 * reranker is served through Cohere's wire format; the local one runs in process with a smaller
 * weight on identifiers, as a smaller model would.
 */
function crossScore(query: string, passage: string, identifierWeight: number): number {
  const [left, right] = conceptEmbed([query, passage]) as [number[], number[]];
  const meaning = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const codes = (text: string) => new Set(text.match(/\b[A-Z][A-Z0-9_]*[-_][A-Z0-9_-]+\b|\b\d{3}\b/g) ?? []);
  const shared = [...codes(query)].filter((code) => codes(passage).has(code)).length;
  return meaning + identifierWeight * shared;
}

test('hybrid retrieval over Postgres full-text and pgvector beats vector-only, with two rerankers compared', async (t) => {
  const table = `support_${++tables}`;
  const vectors = new PostgresVectorStore(client, { dimensions: 128, embed: conceptEmbed, table, index: 'none' });
  await vectors.migrate();
  const keywords = new PostgresKeywordIndex(client, { table, shared: true });
  await keywords.migrate();
  await vectors.add(ARTICLES);

  const hosted = cohereReranker({
    apiKey: 'test',
    model: 'rerank-v3.5',
    fetch: (async (_input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { query: string; documents: string[] };
      const results = body.documents
        .map((document, index) => ({ index, relevance_score: crossScore(body.query, document, 1) }))
        .sort((a, b) => b.relevance_score - a.relevance_score);
      return new Response(JSON.stringify({ results }));
    }) as typeof globalThis.fetch,
  });
  const local = crossEncoderReranker({
    score: (pairs) => pairs.map(([query, passage]) => crossScore(query, passage, 0.5)),
  });

  const vectorOnly = vectorRetriever(vectors);
  const hybrid = hybridRetriever([vectorOnly, keywords]);
  const candidates: Array<[string, Retriever]> = [
    ['vector only', vectorOnly],
    ['keyword only', keywords],
    ['hybrid', hybrid],
    ['hybrid + hosted reranker', rerankRetriever(hybrid, hosted, { candidates: 10 })],
    ['hybrid + local cross-encoder', rerankRetriever(hybrid, local, { candidates: 10 })],
  ];
  const dataset = createDataset<{ query: string }, string>({
    name: 'support-kb',
    examples: QUESTIONS.map((question) => ({
      id: question.id,
      inputs: { query: question.query },
      expected: question.relevant,
      metadata: { kind: question.kind },
    })),
  });
  const experiments = new Map<string, Awaited<ReturnType<typeof evaluate>>>();
  for (const [name, retriever] of candidates) {
    experiments.set(
      name,
      await evaluate(
        (inputs: { query: string }) => retriever.retrieve(inputs.query, { topK: 5 }),
        dataset,
        [recallAtK({ k: 5 }), reciprocalRank({ k: 5 })],
        {
          name,
          concurrency: 4,
        },
      ),
    );
  }
  const mean = (name: string, key: string) =>
    experiments.get(name)?.metrics.find((metric) => metric.key === key)?.mean ?? Number.NaN;
  const table_ = candidates.map(
    ([name]) =>
      `${name.padEnd(30)} recall@5 ${mean(name, 'recall@5').toFixed(2)}  MRR ${mean(name, 'reciprocal-rank').toFixed(2)}`,
  );
  t.diagnostic(`\n${table_.join('\n')}`);

  const versusVectors = compareExperiments(experiments.get('vector only') as never, experiments.get('hybrid') as never);
  t.diagnostic(formatComparison(versusVectors));
  const recall = versusVectors.metrics.find((metric) => metric.key === 'recall@5');
  assert.equal(recall?.verdict, 'better', 'hybrid finds more of the right articles than vectors alone');
  assert.equal(
    versusVectors.metrics.find((metric) => metric.key === 'reciprocal-rank')?.verdict,
    'better',
    'and ranks them higher',
  );
  assert.ok(mean('hybrid', 'recall@5') > mean('keyword only', 'recall@5'), 'and more than keywords alone');
  assert.ok(mean('hybrid', 'recall@5') >= 0.9);

  for (const reranked of ['hybrid + hosted reranker', 'hybrid + local cross-encoder']) {
    const comparison = compareExperiments(experiments.get('hybrid') as never, experiments.get(reranked) as never);
    assert.equal(comparison.regressed, false, `${reranked} is no worse than hybrid`);
    assert.ok(
      mean(reranked, 'reciprocal-rank') >= mean('hybrid', 'reciprocal-rank'),
      `${reranked} puts the right article higher`,
    );
  }
});
