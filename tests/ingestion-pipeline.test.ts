/**
 * Durable ingestion. A manifest records each document's version, its chunking, the embedding model,
 * and each chunk's version, so a run embeds only what is new or changed and deletes what is gone.
 *
 * The proof: an ingestion of 100,000 documents dies halfway inside a durable operation. The retry
 * starts at the document the first attempt stopped on and embeds no chunk that had finished. A second
 * run after ten documents are edited re-embeds exactly those ten.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { OperationRunner } from '../src/operations/runner.js';
import type { DocumentSource } from '../src/rag/ingestion.js';
import { createIngestionPipeline, type IngestionReport, ingestionExecutor } from '../src/rag/pipeline.js';
import { KeywordIndex } from '../src/rag/retrievers.js';
import { MemoryStore } from '../src/store/memory.js';

/** An embedding function that counts what it embeds, and can be told to die partway. */
function countingEmbed() {
  const embedded: string[] = [];
  let failAfter = Number.POSITIVE_INFINITY;
  return {
    embedded,
    failAfter(count: number) {
      failAfter = count;
    },
    embed: async (texts: string[]) => {
      if (embedded.length + texts.length > failAfter) {
        failAfter = Number.POSITIVE_INFINITY;
        throw new Error('the worker died while embedding');
      }
      embedded.push(...texts);
      return texts.map((text) => [text.length % 7, text.length % 11, 1]);
    },
  };
}

/** One Markdown section, one chunk. */
const section = (title: string, body: string) => `# ${title}\n${body.padEnd(90, '.')}`;
/** A document of Markdown sections. */
const sections = (doc: string, count: number) =>
  Array.from({ length: count }, (_, index) => section(`${doc} ${index}`, `${doc} section ${index} `)).join('\n\n');

test('a run embeds only new and changed chunks, deletes what is gone, and re-embeds on a new model', async () => {
  const vectors = new MemoryVectorStore();
  const keywords = new KeywordIndex();
  const manifest = new MemoryStore();
  const counter = countingEmbed();
  const options = {
    name: 'kb',
    manifest,
    vectors,
    keywords: [keywords],
    embed: counter.embed,
    embeddingModel: 'm1',
    chunking: { chunkSize: 200, overlap: 0, splitOnMarkdownHeadings: true },
  };
  const pipeline = createIngestionPipeline(options);
  const corpus: DocumentSource[] = [
    { id: 'guide', text: sections('guide', 5), metadata: { area: 'docs' } },
    { id: 'faq', text: sections('faq', 2) },
    { source: 'https://kb.test/notes', text: 'Notes kept by source.' },
  ];

  const first = await pipeline.run(corpus);
  assert.deepEqual(
    { added: first.added, embedded: first.chunksEmbedded, unchanged: first.unchanged },
    { added: 3, embedded: 8, unchanged: 0 },
  );
  assert.equal(keywords.size(), 8, 'keyword indexes are kept in step');
  const recorded = await pipeline.document('guide');
  assert.equal(recorded?.model, 'm1');
  assert.equal(Object.keys(recorded?.chunks ?? {}).length, 5);
  assert.ok(
    Object.keys(recorded?.chunks ?? {}).every((id) => id.startsWith('guide#')),
    'chunks are named by their text',
  );

  // Nothing changed: nothing is embedded.
  const again = await pipeline.run(corpus);
  assert.deepEqual({ unchanged: again.unchanged, embedded: again.chunksEmbedded }, { unchanged: 3, embedded: 0 });

  // One section rewritten, and one added at the top: only those two chunks are embedded.
  counter.embedded.length = 0;
  const parts = sections('guide', 5).split('\n\n');
  parts[3] = section('guide 3', 'guide section three, rewritten ');
  const edited: DocumentSource[] = [
    { ...(corpus[0] as DocumentSource), text: [section('preface', 'guide preface '), ...parts].join('\n\n') },
    ...corpus.slice(1),
  ];
  const third = await pipeline.run(edited);
  assert.equal(third.updated, 1);
  assert.equal(third.chunksEmbedded, 2, 'the new and the rewritten section');
  assert.equal(third.chunksKept, 4, 'the rest keep their embeddings, though their positions moved');
  assert.equal(third.chunksDeleted, 1, 'the old text of the rewritten section is gone');
  assert.deepEqual(counter.embedded.map((text) => text.split('\n')[0]).sort(), ['# guide 3', '# preface']);
  assert.equal((await vectors.search('rewritten', { topK: 20 })).length, 9);

  // A document the corpus no longer has is removed from every store and the manifest.
  const fourth = await pipeline.run(edited.slice(0, 2));
  assert.deepEqual({ deleted: fourth.deleted, chunksDeleted: fourth.chunksDeleted }, { deleted: 1, chunksDeleted: 1 });
  assert.equal(await pipeline.document('https://kb.test/notes'), undefined);
  assert.equal(keywords.size(), 8);
  // A partial load leaves the rest alone.
  const partial = await pipeline.run([edited[1] as DocumentSource], { deleteMissing: false });
  assert.deepEqual({ unchanged: partial.unchanged, deleted: partial.deleted }, { unchanged: 1, deleted: 0 });

  // A new embedding model, or new chunking, re-embeds everything.
  const upgraded = await createIngestionPipeline({ ...options, embeddingModel: 'm2' }).run(edited.slice(0, 2));
  assert.equal(upgraded.chunksEmbedded, 8);
  const rechunked = await createIngestionPipeline({
    ...options,
    embeddingModel: 'm2',
    chunking: { chunkSize: 400, overlap: 0 },
  }).run(edited.slice(0, 2));
  assert.equal(rechunked.updated, 2);

  assert.equal(await pipeline.remove(['faq']), 1);
  assert.equal(await pipeline.document('faq'), undefined);
  await assert.rejects(pipeline.run([{ text: 'no id' }]), /needs a document id/);
  assert.throws(() => createIngestionPipeline({ ...options, batchSize: 0 }), /batchSize/);
});

test('100,000 documents killed halfway resume without re-embedding, and an edit of ten re-embeds ten', async () => {
  const total = 100_000;
  const corpus = (edited = new Set<number>()) =>
    (function* () {
      for (let index = 0; index < total; index += 1) {
        const revised = edited.has(index) ? ' (revised)' : '';
        yield { id: `doc-${index}`, text: `Article ${index}${revised}: how to configure feature ${index % 97}.` };
      }
    })();
  const vectors = new MemoryVectorStore();
  // One manifest item per document: a MemoryStore holds 10,000 unless told otherwise.
  const manifest = new MemoryStore({ maxItems: 200_000 });
  const counter = countingEmbed();
  const pipeline = createIngestionPipeline({
    name: 'corpus',
    manifest,
    vectors,
    embed: counter.embed,
    embeddingModel: 'm1',
    batchSize: 1_000,
  });

  // The first attempt dies a little past halfway, in the middle of a batch.
  counter.failAfter(50_500);
  const runner = new OperationRunner<IngestionReport>({
    store: new MemoryOperationStore(),
    retry: { maxAttempts: 2, baseDelayMs: 1 },
  });
  const handle = await runner.submit(
    ingestionExecutor(pipeline, () => corpus()),
    { idempotencyKey: 'corpus' },
  );
  const report = await handle.result();

  // The retry started at the document the first attempt stopped on: 50,000 finished, 50,000 left.
  assert.equal(report.resumed, 50_000, 'the retry skipped straight past the finished documents');
  assert.equal(report.added, 50_000);
  assert.equal(counter.embedded.length, total, 'every document embedded exactly once across both attempts');
  assert.equal(new Set(counter.embedded).size, total, 'and no finished chunk was embedded again');
  let recorded = 0;
  for (let offset = 0; ; offset += 5_000) {
    const page = await manifest.search(['nexus', 'ingestion', 'corpus', 'documents'], { limit: 5_000, offset });
    recorded += page.length;
    if (page.length < 5_000) break;
  }
  assert.equal(recorded, total);

  // A second run after editing ten documents re-embeds only those ten.
  counter.embedded.length = 0;
  const edited = new Set([3, 17, 999, 25_000, 49_999, 50_000, 50_001, 77_777, 88_888, 99_999]);
  const second = await pipeline.run(corpus(edited));
  assert.equal(second.updated, 10);
  assert.equal(second.unchanged, total - 10);
  assert.equal(second.chunksEmbedded, 10);
  assert.deepEqual(
    counter.embedded.map((text) => Number(/Article (\d+)/.exec(text)?.[1])).sort((a, b) => a - b),
    [...edited].sort((a, b) => a - b),
  );
  assert.equal(second.chunksDeleted, 10, 'the old versions of the ten are gone');
});
