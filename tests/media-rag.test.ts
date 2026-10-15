/**
 * Media search and RAG: what media say and show is indexed in a vector store, a search finds the
 * media a question is about, and the media themselves go to the model.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddingCapabilityError } from '../src/embeddings/errors.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import { compareExperiments } from '../src/evaluate/compare.js';
import { createDataset, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { evaluate } from '../src/evaluate/run.js';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { MediaError, type MediaInput, MediaManager } from '../src/media/index.js';
import { MockMediaProvider } from '../src/media/mock.js';
import { answerFromMedia, createMediaIndex, type MediaIndexEntry } from '../src/media/rag.js';
import { MemoryStore } from '../src/store/memory.js';
import type { Evaluator } from '../src/types/evaluate.js';
import type { VectorDocument, VectorStore } from '../src/hallucination/retrieval.js';

const bytesOf = (media: MediaInput) => {
  const source = media.source as { base64?: string; url?: string };
  return source.base64 ? Buffer.from(source.base64, 'base64').toString() : (source.url ?? '');
};
const image = (name: string): MediaInput => ({
  type: 'image',
  source: { base64: Buffer.from(name).toString('base64'), mimeType: 'image/png' },
});
const pdf = (name: string): MediaInput => ({
  type: 'document',
  source: { base64: Buffer.from(name).toString('base64'), mimeType: 'application/pdf' },
  filename: `${name}.pdf`,
});

function setup(options: { read?: (media: MediaInput) => string[]; describe?: (media: MediaInput) => string } = {}) {
  const provider = new MockMediaProvider({
    read: options.read ?? ((media) => [`text of ${bytesOf(media)}`]),
    describe: options.describe ?? ((media) => `a photo of ${bytesOf(media)}`),
  });
  const media = new MediaManager({ providers: { mock: provider } });
  const embeddings = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 256 }) },
    defaultProvider: 'mock',
  });
  const vectors = new MemoryVectorStore();
  const assets = { store: new MemoryAssetStore(), tenantId: 'acme' };
  return { provider, media, embeddings, vectors, assets };
}

test('a medium is indexed as its pages, its caption, and where it is kept', async () => {
  const { media, embeddings, vectors, assets } = setup({
    read: (medium) => (medium.type === 'document' ? ['invoice 17 total 42 EUR', 'thank you for your order'] : ['STOP']),
  });
  const index = createMediaIndex({ vectors, media, embeddings, assets });
  const report = await index.add([
    { id: 'invoice-17', media: pdf('invoice'), source: 'mail/invoice.pdf', metadata: { tenant: 'acme', year: 2026 } },
    { id: 'sign', media: image('stop sign'), metadata: { tenant: 'acme' } },
    { id: 'remote', media: { type: 'image', source: { url: 'https://example.com/cat.png' } } },
  ]);
  assert.deepEqual(report, {
    media: 3,
    unchanged: 0,
    pages: 4,
    captions: 2,
    vectors: 0,
    ids: {
      'invoice-17': ['invoice-17#p0', 'invoice-17#p1'],
      sign: ['sign#p0', 'sign#caption'],
      remote: ['remote#p0', 'remote#caption'],
    },
  });
  assert.equal(vectors.size(), 6);
  assert.equal(assets.store.snapshot().entries, 2, 'media held as bytes are kept; one at a URL is not');

  const [hit] = await index.search('what is the total on invoice 17', { topK: 1 });
  assert.equal(hit?.id, 'invoice-17');
  assert.equal(hit?.kind, 'page');
  assert.equal(hit?.page, 0);
  assert.equal(hit?.source, 'mail/invoice.pdf');
  assert.deepEqual(hit?.metadata, { tenant: 'acme', year: 2026 }, "the medium's own metadata, without the index's");
  const resolved = await index.resolve(hit as NonNullable<typeof hit>);
  assert.deepEqual(resolved, pdf('invoice'), 'the medium comes back as it went in');

  const photos = await index.search('a photo of a cat', { topK: 5 });
  assert.equal(new Set(photos.map((found) => found.id)).size, photos.length, 'each medium once');
  const cat = photos.find((found) => found.id === 'remote');
  assert.equal(cat?.kind, 'caption');
  assert.deepEqual(await index.resolve(cat as NonNullable<typeof cat>), {
    type: 'image',
    source: { url: 'https://example.com/cat.png' },
  });
  assert.deepEqual(
    (await index.search('anything', { filter: { year: 2026 } })).map((found) => found.id),
    ['invoice-17'],
  );
  await assets.store.delete(hit?.reference.assetId as string, 'acme');
  assert.equal(await index.resolve(hit as NonNullable<typeof hit>), undefined, 'a medium whose asset is gone');
});

test('a medium must hold its content, and one held as bytes needs a store to keep it', async () => {
  const { media, embeddings, vectors } = setup();
  const index = createMediaIndex({ vectors, media, embeddings });
  await assert.rejects(index.add([{ id: 'a', media: image('x') }]), (error: unknown) => {
    assert.ok(error instanceof MediaError);
    assert.match(error.message, /asset store/);
    return true;
  });
  await assert.rejects(
    index.add([{ id: 'b', media: { type: 'image', source: { path: '/tmp/x.png' } } }]),
    /must hold its content/,
  );
});

test("a medium's own vector is indexed by a model that takes it, and refused by one that does not", async () => {
  const { media, vectors, assets } = setup();
  const multimodal = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 64, describeMedia: () => 'a red bicycle' }) },
    defaultProvider: 'mock',
  });
  const index = createMediaIndex({
    vectors,
    media,
    embeddings: multimodal,
    assets,
    index: { pages: false, captions: false, vectors: true },
  });
  const report = await index.add([{ id: 'bike', media: image('bicycle.png') }]);
  assert.deepEqual(report.ids, { bike: ['bike#image'] });
  const [hit] = await index.search('a red bicycle');
  assert.equal(hit?.kind, 'image');

  const textOnly = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ capabilities: { inputModalities: ['text'] } }) },
    defaultProvider: 'mock',
  });
  const refused = createMediaIndex({
    vectors: new MemoryVectorStore(),
    media,
    embeddings: textOnly,
    assets,
    index: { vectors: true },
  });
  await assert.rejects(refused.add([{ id: 'bike', media: image('bicycle.png') }]), EmbeddingCapabilityError);
});

test('a long page is split at paragraphs into chunks of the size asked', async () => {
  const paragraph = (index: number) => `Paragraph ${index}. ${'word '.repeat(60).trim()}`;
  const { media, embeddings, vectors, assets } = setup({
    read: () => [Array.from({ length: 6 }, (_, index) => paragraph(index)).join('\n\n')],
  });
  const index = createMediaIndex({
    vectors,
    media,
    embeddings,
    assets,
    maxChunkChars: 700,
    index: { captions: false },
  });
  const report = await index.add([{ id: 'long', media: pdf('report') }]);
  assert.deepEqual(report.ids.long, ['long#p0', 'long#p0-1', 'long#p0-2']);
});

test('proof: answers grounded in the retrieved media beat answers from their text alone', async () => {
  // Six charts that read alike: their text and captions say what each chart is, not what it shows.
  const years = [2020, 2021, 2022, 2023, 2024, 2025];
  const tallest = ['Q3', 'Q1', 'Q4', 'Q2', 'Q2', 'Q1'];
  const chart = (year: number) => image(`revenue-${year}`);
  const yearOf = (medium: MediaInput) => Number(bytesOf(medium).slice('revenue-'.length));
  const vision = new MockMediaProvider({
    read: (medium) => [`Revenue by quarter, ${yearOf(medium)}. Bars for Q1, Q2, Q3, and Q4.`],
    describe: (medium) => `a bar chart of revenue by quarter for ${yearOf(medium)}`,
    // A stand-in for a vision model: it sees which bar is tallest in the chart it is handed.
    answer: (media) => `The tallest bar is ${tallest[years.indexOf(yearOf(media[0] as MediaInput))]}.`,
  });
  const media = new MediaManager({ providers: { vision } });
  const embeddings = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 512 }) },
    defaultProvider: 'mock',
  });
  const index = createMediaIndex({
    vectors: new MemoryVectorStore(),
    media,
    embeddings,
    assets: { store: new MemoryAssetStore(), tenantId: 'acme' },
  });
  await index.add(years.map((year) => ({ id: `chart-${year}`, media: chart(year), metadata: { year } })));

  const dataset = createDataset({
    name: 'charts',
    version: '1',
    examples: years.map((year, position) => ({
      id: String(year),
      inputs: `In the revenue by quarter chart for ${year}, which quarter has the tallest bar?`,
      expected: tallest[position] as string,
    })),
  });
  const correct: Evaluator = ({ output, example }) => {
    const right = String(output).includes(String(example.expected));
    return { key: 'correct', score: right ? 1 : 0, passed: right };
  };
  const experiments = new MemoryExperimentStore();
  // The text-alone baseline retrieves the same hits and answers from what they say.
  const fromText = await evaluate(
    async (question) => {
      const hits = await index.search(String(question), { topK: 1 });
      const said = hits.map((hit) => hit.text).join(' ');
      const named = /tallest[^.]*\b(Q[1-4])\b/.exec(said)?.[1];
      return named ? `The tallest bar is ${named}.` : 'The text does not say which bar is tallest.';
    },
    dataset,
    [correct],
    { name: 'text-alone', store: experiments },
  );
  const fromMedia = await evaluate(
    async (question) => (await answerFromMedia(media, index, String(question), { topK: 1 })).answer,
    dataset,
    [correct],
    { name: 'media', store: experiments },
  );

  const comparison = compareExperiments(fromText, fromMedia);
  const metric = comparison.metrics.find((entry) => entry.key === 'correct');
  assert.equal(metric?.candidate, 1, 'every chart question is answered from the chart itself');
  assert.equal(metric?.baseline, 0, 'the text never says which bar is tallest');
  assert.equal(metric?.verdict, 'better');
  assert.equal(comparison.regressed, false);
  const handed = vision.calls
    .filter((call) => call.task === 'answer')
    .map((call) => bytesOf(call.media[0] as MediaInput));
  assert.deepEqual(
    handed,
    years.map((year) => `revenue-${year}`),
    'the model was handed each question’s own chart',
  );
});

// ── The manifest ──────────────────────────────────────────────────────

/** A vector store that keeps chunk ids and counts writes, and dies when told to. */
class TrackedVectors implements VectorStore {
  readonly chunks = new Map<string, VectorDocument>();
  writes = 0;
  crash?: (method: 'add' | 'delete') => boolean;

  async add(documents: VectorDocument[]): Promise<void> {
    if (this.crash?.('add')) throw new Error('the process died');
    this.writes += 1;
    for (const document of documents) this.chunks.set(document.id, document);
  }
  async delete(ids: readonly string[]): Promise<void> {
    if (this.crash?.('delete')) throw new Error('the process died');
    this.writes += 1;
    for (const id of ids) this.chunks.delete(id);
  }
  async search(): Promise<never[]> {
    return [];
  }
  async searchVector(): Promise<never[]> {
    return [];
  }
}

function manifestSetup(pages: Record<string, string[]>) {
  const base = setup({ read: (medium) => pages[bytesOf(medium)] ?? [`text of ${bytesOf(medium)}`] });
  const vectors = new TrackedVectors();
  const manifest = new MemoryStore();
  const reads = { count: 0 };
  const media = {
    read: (request: Parameters<MediaManager['read']>[0]) => {
      reads.count += 1;
      return base.media.read(request);
    },
    describe: (request: Parameters<MediaManager['describe']>[0]) => base.media.describe(request),
  };
  const make = () => createMediaIndex({ ...base, media, vectors, manifest, name: 'library' });
  return { ...base, vectors, manifest, reads, make };
}

const chunkIdsOf = (vectors: TrackedVectors, medium: string) =>
  [...vectors.chunks.keys()].filter((id) => id.startsWith(`${medium}#`)).sort();

test('with a manifest, an unchanged medium writes nothing, a changed one replaces exactly its chunks, and a deleted one leaves none', async () => {
  const { vectors, assets, reads, make } = manifestSetup({
    invoice: ['invoice 17 total 42 EUR', 'thank you'],
    'invoice v2': ['invoice 17 total 40 EUR'],
  });
  const index = make();
  const first = await index.add([
    { id: 'invoice-17', media: pdf('invoice'), source: 'mail/invoice.pdf' },
    { id: 'sign', media: image('stop sign') },
  ]);
  assert.equal(first.media, 2);
  assert.deepEqual(chunkIdsOf(vectors, 'invoice-17'), ['invoice-17#p0', 'invoice-17#p1']);
  assert.equal(assets.store.snapshot().entries, 2);

  const writes = vectors.writes;
  const again = await index.add([
    { id: 'invoice-17', media: pdf('invoice'), source: 'mail/invoice.pdf' },
    { id: 'sign', media: image('stop sign') },
  ]);
  assert.deepEqual([again.media, again.unchanged], [0, 2], 'nothing changed, so nothing was indexed');
  assert.equal(vectors.writes, writes, 'and nothing was written');
  assert.equal(reads.count, 2, 'or read');
  assert.deepEqual(again.ids['invoice-17'], ['invoice-17#p0', 'invoice-17#p1']);

  const before = (await index.describe('invoice-17')) as MediaIndexEntry;
  await index.add([{ id: 'invoice-17', media: pdf('invoice v2'), source: 'mail/invoice.pdf' }]);
  assert.deepEqual(chunkIdsOf(vectors, 'invoice-17'), ['invoice-17#p0'], 'the page it lost is gone');
  assert.match(String(vectors.chunks.get('invoice-17#p0')?.content), /total 40/);
  const after = (await index.describe('invoice-17')) as MediaIndexEntry;
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.pages, 1);
  assert.deepEqual(after.chunkIds, ['invoice-17#p0']);
  assert.deepEqual(after.reader, { provider: 'mock-media', model: 'mock' });
  assert.equal(after.createdAt, before.createdAt);
  assert.notEqual(after.reference.assetId, before.reference.assetId);
  assert.equal(await assets.store.get(before.reference.assetId as string, 'acme'), undefined, 'the old asset is gone');
  assert.equal(assets.store.snapshot().entries, 2);
  assert.deepEqual((await index.list()).map((entry) => entry.id).sort(), ['invoice-17', 'sign']);

  const readsBefore = reads.count;
  const reindexed = await index.reindex(['sign']);
  assert.equal(reindexed.media, 1);
  assert.equal(reads.count, readsBefore + 1, 'a reindex reads the medium again, from where it is kept');
  assert.equal(assets.store.snapshot().entries, 2, 'and keeps the asset it has');

  assert.equal(await index.delete(['invoice-17', 'nothing']), 1);
  assert.deepEqual(chunkIdsOf(vectors, 'invoice-17'), []);
  assert.equal(await index.describe('invoice-17'), undefined);
  assert.equal(assets.store.snapshot().entries, 1);
  await assert.rejects(createMediaIndex({ ...setup(), vectors }).delete(['sign']), /needs a manifest to delete by id/);
});

test('proof: a medium indexed, changed, or deleted with a crash halfway through each ends exactly as without one', async () => {
  const expectClean = async (
    label: string,
    context: ReturnType<typeof manifestSetup>,
    medium: string,
    chunkIds: string[],
    assetCount: number,
  ) => {
    assert.deepEqual(chunkIdsOf(context.vectors, medium), chunkIds, `${label}: exactly its chunks`);
    assert.equal(context.assets.store.snapshot().entries, assetCount, `${label}: exactly its assets`);
    const entry = await context.make().describe(medium);
    assert.equal(entry?.pending, undefined, `${label}: nothing left pending`);
  };
  /** The first call that `when` picks dies, as a process would mid-write. */
  const once = (when: (method: 'add' | 'delete') => boolean) => {
    let done = false;
    return (method: 'add' | 'delete') => {
      if (done || !when(method)) return false;
      done = true;
      return true;
    };
  };
  const pages = { invoice: ['one', 'two'], 'invoice v2': ['one again'] };

  // Indexed for the first time, dying as the chunks are written.
  {
    const context = manifestSetup(pages);
    context.vectors.crash = once((method) => method === 'add');
    await assert.rejects(context.make().add([{ id: 'invoice', media: pdf('invoice') }]), /the process died/);
    await context.make().add([{ id: 'invoice', media: pdf('invoice') }]);
    await expectClean('first index', context, 'invoice', ['invoice#p0', 'invoice#p1'], 1);
  }

  // Changed, dying at each write in turn: the chunks, the stale chunks, and the record of the change.
  const points = ['chunks', 'stale chunks', 'record'] as const;
  for (const point of points) {
    const context = manifestSetup(pages);
    await context.make().add([{ id: 'invoice', media: pdf('invoice') }]);
    if (point === 'chunks') context.vectors.crash = once((method) => method === 'add');
    if (point === 'stale chunks') context.vectors.crash = once((method) => method === 'delete');
    const put = context.manifest.put.bind(context.manifest);
    let dying = point === 'record';
    context.manifest.put = (async (namespace, key, value, options) => {
      if (dying && !(value as MediaIndexEntry).pending) {
        dying = false;
        throw new Error('the process died');
      }
      return put(namespace, key, value, options);
    }) as typeof context.manifest.put;
    await assert.rejects(context.make().add([{ id: 'invoice', media: pdf('invoice v2') }]), /the process died/);
    await context.make().add([{ id: 'invoice', media: pdf('invoice v2') }]);
    await expectClean(`changed, dying at the ${point}`, context, 'invoice', ['invoice#p0'], 1);
    assert.match(String(context.vectors.chunks.get('invoice#p0')?.content), /one again/);
  }

  // Deleted, dying as the chunks go: a second delete finishes it.
  {
    const context = manifestSetup(pages);
    await context.make().add([{ id: 'invoice', media: pdf('invoice') }]);
    context.vectors.crash = once((method) => method === 'delete');
    await assert.rejects(context.make().delete(['invoice']), /the process died/);
    assert.ok(await context.make().describe('invoice'), 'the entry outlives the crash');
    assert.equal(await context.make().delete(['invoice']), 1);
    assert.deepEqual(chunkIdsOf(context.vectors, 'invoice'), []);
    assert.equal(context.assets.store.snapshot().entries, 0);
    assert.equal(await context.make().describe('invoice'), undefined);
  }
});
