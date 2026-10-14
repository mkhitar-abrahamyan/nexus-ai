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
import { answerFromMedia, createMediaIndex } from '../src/media/rag.js';
import type { Evaluator } from '../src/types/evaluate.js';

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
