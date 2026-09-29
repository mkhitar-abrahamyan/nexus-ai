import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { compareExperiments } from '../src/evaluate/compare.js';
import { createDataset, FileDatasetStore, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { recallAtK, reciprocalRank } from '../src/evaluate/evaluators.js';
import { evaluate } from '../src/evaluate/run.js';
import { createHashEmbeddings, MemoryVectorStore, type VectorSearchResult } from '../src/hallucination/retrieval.js';
import { loadCsv } from '../src/loaders/csv.js';
import { loadHtml } from '../src/loaders/html.js';
import { loadIntoStore } from '../src/loaders/index.js';
import { loadMarkdown } from '../src/loaders/markdown.js';
import { RedisVectorStore } from '../src/rag/redis.js';
import {
  hybridRetriever,
  KeywordIndex,
  maximalMarginalRelevance,
  mmrRetriever,
  modelQueryVariants,
  modelReranker,
  multiQueryRetriever,
  parentDocumentRetriever,
  type Retriever,
  reciprocalRankFusion,
  rerankRetriever,
  splitParentChild,
  tokenize,
  vectorRetriever,
} from '../src/rag/retrievers.js';
import { SqliteVectorStore } from '../src/sqlite/vectors.js';
import type { CompletionRequest } from '../src/types/messages.js';
import { redisStub } from './vector-stubs.js';

const DIMENSIONS = 64;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);
const datasets = mkdtempSync(path.join(tmpdir(), 'nexus-retrieval-'));
after(() => rmSync(datasets, { recursive: true, force: true }));

const result = (id: string, score = 1, extra: Partial<VectorSearchResult> = {}): VectorSearchResult => ({
  id,
  content: id,
  score,
  ...extra,
});
const fixed = (results: VectorSearchResult[]): Retriever & { asked: number[] } => {
  const asked: number[] = [];
  return {
    asked,
    retrieve: async (_query, options = {}) => {
      asked.push(options.topK ?? 5);
      return results.slice(0, options.topK ?? 5);
    },
  };
};

test('the keyword index ranks by BM25, filters, and replaces by id', async () => {
  const index = new KeywordIndex();
  index.add([
    { id: 'a', content: 'Error E4012 means the card was declined', metadata: { tenant: 'acme' } },
    { id: 'b', content: 'The card page lists every card and every card error', metadata: { tenant: 'acme' } },
    { id: 'c', content: 'Shipping takes two days', metadata: { tenant: 'globex' } },
  ]);
  assert.deepEqual(tokenize('Straße E-4012, ok!'), ['straße', 'e', '4012', 'ok']);
  const hits = await index.retrieve('what does E4012 mean');
  assert.equal(hits[0]?.id, 'a', 'the rare term decides');
  assert.equal((await index.retrieve('card', { filter: { tenant: 'globex' } })).length, 0);
  index.add([{ id: 'c', content: 'Returns take two days' }]);
  assert.equal(index.size(), 3);
  assert.equal((await index.retrieve('shipping')).length, 0, 'the replaced text no longer matches');
  index.delete(['a', 'missing']);
  assert.equal((await index.retrieve('E4012')).length, 0);
  assert.deepEqual(await new KeywordIndex().retrieve('anything'), []);
});

test('reciprocal rank fusion combines rankings by rank, with weights', () => {
  const fused = reciprocalRankFusion([
    [result('a', 9), result('b', 8)],
    [result('b', 0.2), result('c', 0.1)],
  ]);
  assert.deepEqual(
    fused.map((item) => item.id),
    ['b', 'a', 'c'],
    'appearing in both beats ranking first in one',
  );
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  const weighted = reciprocalRankFusion([[result('a')], [result('c')]], { weights: [1, 3], topK: 1 });
  assert.deepEqual(
    weighted.map((item) => item.id),
    ['c'],
  );
});

test('hybrid, rerank, MMR, parent-document, and multi-query retrievers compose over any retriever', async () => {
  const vector = fixed([result('a'), result('b'), result('c')]);
  const keyword = fixed([result('c'), result('d')]);
  const hybrid = await hybridRetriever([vector, keyword], { topK: 2 }).retrieve('q');
  assert.deepEqual(
    hybrid.map((item) => item.id),
    ['c', 'a'],
  );
  assert.deepEqual(vector.asked, [8], 'each retriever is asked for four times topK');
  assert.throws(() => hybridRetriever([]), /at least one/);

  const reranked = await rerankRetriever(
    vector,
    (_query, chunks) => chunks.map((chunk) => (chunk.id === 'c' ? 5 : 1)),
    {
      topK: 2,
      candidates: 3,
      minScore: 0,
    },
  ).retrieve('q');
  assert.deepEqual(
    reranked.map((item) => [item.id, item.score]),
    [
      ['c', 5],
      ['a', 1],
    ],
  );
  await assert.rejects(rerankRetriever(vector, () => [1]).retrieve('q'), /1 scores for 3 chunks/);

  const near = fixed([
    { id: 'x1', content: 'refund policy refund window', score: 0.9 },
    { id: 'x2', content: 'refund policy refund window', score: 0.89 },
    { id: 'y', content: 'shipping carrier tracking', score: 0.5 },
  ]);
  const diverse = await mmrRetriever(near, { embed, topK: 2, lambda: 0.3 }).retrieve('refund policy');
  assert.deepEqual(
    diverse.map((item) => item.id),
    ['x1', 'y'],
    'a near-duplicate gives way to other evidence',
  );
  assert.deepEqual(
    maximalMarginalRelevance(
      [1, 0],
      [
        [1, 0],
        [0.99, 0.1],
        [0, 1],
      ],
      { lambda: 1, topK: 2 },
    ),
    [0, 1],
  );

  const { parents, children } = splitParentChild([{ id: 'guide', text: 'a'.repeat(900) }], {
    parent: { chunkSize: 500, overlap: 0 },
    child: { chunkSize: 100, overlap: 0 },
  });
  assert.equal(parents.length, 2);
  assert.ok(children.every((child) => parents.some((parent) => parent.id === child.metadata?.documentId)));
  const parentMap = new Map(parents.map((parent) => [parent.id, parent]));
  const childHits = fixed([
    { ...children[0], score: 0.9 },
    { ...children[1], score: 0.8 },
    { ...children[children.length - 1], score: 0.7 },
    result('orphan', 0.1),
  ]);
  const fromMap = await parentDocumentRetriever(childHits, { parents: parentMap, topK: 5 }).retrieve('q');
  assert.deepEqual(
    fromMap.map((item) => [item.id, item.score]),
    [
      [parents[0].id, 0.9],
      [parents[1].id, 0.7],
      ['orphan', 0.1],
    ],
    'each parent once, in the order of its best child; a child without a parent passes through',
  );
  const fetched: string[][] = [];
  await parentDocumentRetriever(childHits, {
    parents: async (ids) => {
      fetched.push([...ids]);
      return parents.filter((parent) => ids.includes(parent.id));
    },
    topK: 1,
  }).retrieve('q');
  assert.deepEqual(fetched, [[parents[0].id]], 'only the parents returned are fetched');

  const phrasings: string[] = [];
  const recorder: Retriever = {
    retrieve: async (query) => {
      phrasings.push(query);
      return query === 'refund window' ? [result('r')] : [result('a')];
    },
  };
  const multi = await multiQueryRetriever(recorder, () => ['refund window', 'money back']).retrieve('refunds');
  assert.deepEqual(phrasings, ['refunds', 'refund window', 'money back']);
  assert.deepEqual(
    multi.map((item) => item.id),
    ['a', 'r'],
  );
});

test('the model reranker and query variants read the model reply, and tolerate a bad one', async () => {
  const replies = ['Scores: [2, 9]', 'not json', '["refund window", 3, "money back"]', 'nope'];
  const requests: unknown[] = [];
  const client = {
    complete: async (request: unknown) => {
      requests.push(request);
      return { content: replies.shift() ?? '' };
    },
  };
  const chunks = [result('a'), result('b')];
  assert.deepEqual(await modelReranker(client, { model: 'judge' })('q', chunks), [2, 9]);
  assert.deepEqual(await modelReranker(client, { model: 'judge' })('q', chunks), [0, 0]);
  assert.deepEqual(await modelQueryVariants(client, { model: 'writer', count: 2 })('refunds'), [
    'refund window',
    'money back',
  ]);
  assert.deepEqual(await modelQueryVariants(client, { model: 'writer' })('refunds'), []);
  assert.equal((requests[0] as { model: string }).model, 'judge');
});

test('proof: loaded into three stores, hybrid retrieval with reranking beats vector-only on a stored dataset', async () => {
  const codes = ['E4012', 'E4013', 'E4020', 'E4031', 'E4044', 'E4051', 'E4062', 'E4077', 'E4089', 'E4090'];
  const causes = [
    'the issuing bank declined the card',
    'the card has expired',
    'the billing address did not match',
    'the security code was wrong',
    'the daily spending limit was reached',
    'the currency is not supported',
    'the merchant account is paused',
    'the card was reported stolen',
    'the payment timed out at the bank',
    'three failed attempts locked the card',
  ];
  const markdown = codes.map((code, index) => ({
    source: `errors/${code}.md`,
    content: `---\ntopic: errors\n---\n# ${code}\n\nError ${code}: ${causes[index]}.`,
  }));
  // Pages that share the questions' common words but not their codes: what vector-only search trips on.
  const faq = [
    'question,answer',
    ...codes.map(
      (_, index) =>
        `"What does this error code mean for my payment?","What an error code means for your payment and what to do when a payment error code appears, part ${index + 1}."`,
    ),
  ].join('\n');
  const html = {
    source: 'help.html',
    content:
      '<title>Payment help</title><main><p>What does an error code mean? Every payment error code is listed for my payment.</p></main>',
  };
  const loaders = () => [loadMarkdown(markdown), loadCsv({ source: 'faq.csv', content: faq }), loadHtml(html)];

  const sqlite = new SqliteVectorStore(new DatabaseSync(':memory:'), { dimensions: DIMENSIONS, embed });
  await sqlite.migrate();
  const redis = new RedisVectorStore(redisStub().client, { dimensions: DIMENSIONS, embed });
  await redis.migrate();
  const stores = [
    ['memory', new MemoryVectorStore(embed)],
    ['sqlite', sqlite],
    ['redis', redis],
  ] as const;

  const datasetStore = new FileDatasetStore(datasets);
  await datasetStore.save(
    createDataset({
      name: 'error-codes',
      version: '1',
      examples: codes.map((code) => ({
        id: code,
        inputs: `what does error code ${code} mean for my payment`,
        expected: `errors/${code}.md-1-1`,
      })),
    }),
  );
  const dataset = await datasetStore.get('error-codes');
  assert.ok(dataset, 'the dataset is read back from disk');

  // A stand-in for a cross-encoder: rates a passage by the identifiers it shares with the question.
  const judge = {
    complete: async (request: CompletionRequest) => {
      const prompt = String(request.messages[1].content);
      const question = /Question: (.*)/.exec(prompt)?.[1] ?? '';
      const identifiers = question.match(/\b[A-Z]\d{4}\b/g) ?? [];
      const passages = [...prompt.matchAll(/^\[\d+\] (.*)$/gm)].map((match) => match[1]);
      return {
        content: JSON.stringify(passages.map((passage) => (identifiers.some((id) => passage.includes(id)) ? 10 : 1))),
      };
    },
  };

  for (const [name, store] of stores) {
    const keywords = new KeywordIndex();
    const loaded = await loadIntoStore([store, keywords], loaders(), { splitOnMarkdownHeadings: true, batchSize: 4 });
    assert.equal(loaded.documents, 21, `${name}: ten Markdown pages, ten CSV rows, one HTML page`);

    const vectorOnly = vectorRetriever(store);
    // The distractors rank well in both searches, so fusion alone puts them above the right page; the
    // reranker's default of twenty candidates is what reaches past them.
    const candidate = rerankRetriever(
      hybridRetriever([vectorOnly, keywords]),
      modelReranker(judge, { model: 'judge' }),
    );
    const experiments = new MemoryExperimentStore();
    const scorers = [recallAtK({ k: 1 }), reciprocalRank()];
    const baseline = await evaluate((query) => vectorOnly.retrieve(String(query)), dataset, scorers, {
      name: `${name}-vector`,
      store: experiments,
    });
    const improved = await evaluate((query) => candidate.retrieve(String(query)), dataset, scorers, {
      name: `${name}-hybrid-rerank`,
      store: experiments,
    });
    const comparison = compareExperiments(baseline, improved);
    const recall = comparison.metrics.find((metric) => metric.key === 'recall@1');
    assert.equal(recall?.candidate, 1, `${name}: every question finds its page first`);
    assert.ok((recall?.baseline ?? 1) < 0.5, `${name}: vector-only misses most of them (${recall?.baseline})`);
    assert.equal(recall?.verdict, 'better', `${name}: the comparison calls it a real improvement`);
    assert.equal(comparison.metrics.find((metric) => metric.key === 'reciprocal-rank')?.verdict, 'better');
    assert.equal(comparison.regressed, false);
  }
});
