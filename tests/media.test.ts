/**
 * Media understanding: one contract for reading, describing, and answering about images and
 * documents, a manager that routes each task, and adapters for any vision model, Mistral OCR, and a
 * stand-in, each checked by the same conformance suite.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CompletionClientLike,
  MediaError,
  MediaManager,
  type MediaInput,
  type MediaProvider,
  modelMediaProvider,
  runMediaConformance,
} from '../src/media/index.js';
import { MistralOcrProvider } from '../src/media/mistral.js';
import { MockMediaProvider } from '../src/media/mock.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import type { OperationLifecycleLike } from '../src/types/lifecycle.js';

const png = (text: string): MediaInput => ({
  type: 'image',
  source: { base64: Buffer.from(text).toString('base64'), mimeType: 'image/png' },
});
const pdf = (text: string): MediaInput => ({
  type: 'document',
  source: { base64: Buffer.from(text).toString('base64'), mimeType: 'application/pdf' },
  filename: 'invoice.pdf',
});
const decode = (media: MediaInput) => {
  const source = media.source as { base64?: string };
  return Buffer.from(source.base64 ?? '', 'base64').toString();
};

/** A vision model stand-in: answers each task's JSON from the media's own bytes. */
function visionClient(plain = false) {
  const requests: CompletionRequest[] = [];
  const client: CompletionClientLike = {
    async complete(request) {
      requests.push(request);
      const parts = (request.messages[0]?.content ?? []) as Array<{ type: string; text?: string }>;
      const media = parts.filter((part) => part.type !== 'text') as unknown as MediaInput[];
      const instruction = parts.find((part) => part.type === 'text')?.text ?? '';
      const words = media.map(decode);
      const json = instruction.startsWith('Transcribe')
        ? { pages: words.map((text, index) => ({ index, text })) }
        : instruction.startsWith('Describe')
          ? { caption: `a picture of ${words[0]}`, altText: words[0], tags: [words[0]] }
          : { answer: `It says ${words.join(' and ')}`, pages: [0] };
      return {
        content: plain ? `plain: ${words.join(' ')}` : JSON.stringify(json),
        role: 'assistant',
        finishReason: 'stop',
        meta: {
          requestId: 'r',
          providerUsed: 'openai',
          modelUsed: request.model,
          latencyMs: 1,
          tokensInput: 100,
          tokensOutput: 20,
          tokensSaved: 0,
          cacheHit: false,
          guardrailsApplied: [],
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          cost: { amount: 0.002, currency: 'USD', basis: 'estimated' },
        },
      } satisfies NexusResponse;
    },
  };
  return { client, requests };
}

test('a manager sends each task to its default, or the first provider that can', async () => {
  const ocr = new MockMediaProvider({ name: 'ocr', tasks: ['read'], read: (media) => [`ocr:${decode(media)}`] });
  const vision = new MockMediaProvider({ name: 'vision', describe: (media) => `vision:${decode(media)}` });
  const media = new MediaManager({ providers: { ocr, vision }, defaults: { describe: 'vision' } });
  assert.equal((await media.read({ media: pdf('total 42') })).text, 'ocr:total 42', 'the first that can read');
  assert.equal((await media.describe({ media: png('a cat') })).caption, 'vision:a cat');
  assert.equal((await media.read({ media: pdf('x'), provider: 'vision' })).provider, 'vision');

  await assert.rejects(media.describe({ media: png('x'), provider: 'ocr' }), (error: unknown) => {
    assert.ok(error instanceof MediaError);
    assert.equal(error.code, 'MEDIA_UNSUPPORTED');
    return true;
  });
  await assert.rejects(media.read({ media: png('x'), provider: 'missing' }), /No media provider is registered/);
  await assert.rejects(new MediaManager().read({ media: png('x') }), /No media provider can read/);
  await assert.rejects(media.read({ media: { type: 'text', text: 'x' } as never }), /an image or a document/);
  assert.throws(() => media.answer({ media: png('x'), question: ' ' }), /must not be empty/);
  assert.deepEqual(media.listMediaProviders(), ['ocr', 'vision']);
});

test('every media call runs as one operation of the lifecycle it is given', async () => {
  const started: Array<{ family: string; operation: string; provider?: string }> = [];
  const finished: unknown[] = [];
  const lifecycle: OperationLifecycleLike = {
    async start(operation) {
      started.push({ family: operation.family, operation: operation.operation, provider: operation.provider });
      return {
        descriptor: { ...operation, requestId: 'r' } as never,
        context: { requestId: 'r', signal: new AbortController().signal },
        reserve: async () => undefined,
        succeed: async (info) => {
          finished.push(info);
        },
        fail: async () => undefined,
      };
    },
  };
  const { client } = visionClient();
  const media = new MediaManager(
    { providers: { vision: modelMediaProvider(client, { model: 'gpt-5.4' }) } },
    { lifecycle },
  );
  await media.answer({ media: [png('a receipt')], question: 'What is it?' });
  assert.deepEqual(started, [{ family: 'media', operation: 'media.answer', provider: 'vision' }]);
  assert.deepEqual(finished, [{ cost: 0.002, model: 'gpt-5.4' }]);
});

test('a vision model reads, describes, and answers through the client, asking for JSON', async () => {
  const { client, requests } = visionClient();
  const vision = modelMediaProvider(client, { model: 'gpt-5.4' });
  const media = new MediaManager({ providers: { vision } });

  const read = await media.read({ media: pdf('Invoice 17: total 42 EUR') });
  assert.deepEqual(read.pages, [{ index: 0, text: 'Invoice 17: total 42 EUR' }]);
  assert.equal(read.model, 'gpt-5.4');
  assert.deepEqual(read.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(read.cost?.amount, 0.002, "the client's own price");
  const first = requests[0] as CompletionRequest;
  assert.equal(first.model, 'gpt-5.4');
  assert.equal(first.responseFormat?.type, 'json_schema');
  assert.equal(first.temperature, 0);
  const sent = first.messages[0]?.content;
  assert.ok(Array.isArray(sent));
  assert.equal((sent as Array<{ type: string }>)[0]?.type, 'document', 'the medium itself is sent');

  const described = await media.describe({ media: png('a red bicycle'), detail: 'detailed' });
  assert.equal(described.caption, 'a picture of a red bicycle');
  assert.deepEqual(described.tags, ['a red bicycle']);
  assert.match(JSON.stringify(requests[1]?.messages), /a paragraph/);

  const answered = await media.answer({ media: [pdf('page one'), png('a chart')], question: 'What do they show?' });
  assert.equal(answered.answer, 'It says page one and a chart');
  assert.deepEqual(answered.pages, [0]);
  assert.match(JSON.stringify(requests[2]?.messages), /Question: What do they show\?/);
});

test('a model that answers in plain text still gives one page, one caption, one answer', async () => {
  const vision = modelMediaProvider(visionClient(true).client, { model: 'llava' });
  const media = new MediaManager({ providers: { vision } });
  assert.deepEqual((await media.read({ media: png('hello') })).pages, [{ index: 0, text: 'plain: hello' }]);
  assert.equal((await media.describe({ media: png('hello') })).caption, 'plain: hello');
  assert.equal((await media.answer({ media: png('hello'), question: 'q' })).answer, 'plain: hello');
});

test('Mistral OCR: a document as a data URI in, Markdown pages with sizes and image boxes out', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return Response.json({
      model: 'mistral-ocr-2512',
      pages: [
        {
          index: 0,
          markdown: '# Invoice 17\n\n| item | total |\n| --- | --- |\n| tea | 42 EUR |',
          dimensions: { dpi: 200, width: 1700, height: 2200 },
          images: [{ id: 'img-0.jpeg', top_left_x: 10, top_left_y: 20, bottom_right_x: 110, bottom_right_y: 220 }],
        },
        { index: 1, markdown: 'Thank you.', dimensions: { dpi: 200, width: 1700, height: 2200 }, images: [] },
      ],
      usage_info: { pages_processed: 2, doc_size_bytes: 1234 },
    });
  }) as typeof globalThis.fetch;
  const ocr = new MistralOcrProvider({ apiKey: 'k', fetch, pricePerPage: 0.001, tableFormat: 'markdown' });
  const media = new MediaManager({ providers: { ocr } });
  const read = await media.read({ media: pdf('%PDF-1.7'), pages: [0, 1] });
  assert.equal(sent[0]?.url, 'https://api.mistral.ai/v1/ocr');
  assert.equal(sent[0]?.headers.authorization, 'Bearer k');
  assert.deepEqual(sent[0]?.body, {
    model: 'mistral-ocr-latest',
    document: {
      type: 'document_url',
      document_url: `data:application/pdf;base64,${Buffer.from('%PDF-1.7').toString('base64')}`,
      document_name: 'invoice.pdf',
    },
    pages: [0, 1],
    include_image_base64: false,
    table_format: 'markdown',
  });
  assert.equal(read.model, 'mistral-ocr-2512');
  assert.deepEqual(read.pages[0], {
    index: 0,
    text: '# Invoice 17\n\n| item | total |\n| --- | --- |\n| tea | 42 EUR |',
    width: 1700,
    height: 2200,
    images: [{ id: 'img-0.jpeg', box: { left: 10, top: 20, right: 110, bottom: 220 } }],
  });
  assert.match(read.text, /Invoice 17[\s\S]*Thank you\./);
  assert.deepEqual(read.usage, { pages: 2 });
  assert.equal(read.cost?.amount, 0.002, 'two pages at the configured rate');

  await media.read({ media: { type: 'image', source: { url: 'https://example.com/scan.png' } } });
  assert.deepEqual(sent[1]?.body.document, { type: 'image_url', image_url: 'https://example.com/scan.png' });
  await assert.rejects(media.read({ media: { type: 'image', source: { path: '/tmp/scan.png' } } }), /not a path/);
  await assert.rejects(media.describe({ media: png('x') }), /cannot describe|No media provider can describe/);

  const failing = new MistralOcrProvider({
    apiKey: 'k',
    fetch: (async () => new Response('quota', { status: 429 })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(new MediaManager({ providers: { failing } }).read({ media: pdf('x') }), /answered 429/);
});

test('the conformance suite passes every adapter, and names what a broken one gets wrong', async () => {
  const fixtures = {
    image: png('STOP sign'),
    document: pdf('Invoice total 42'),
    expectText: /STOP|Invoice/,
    question: { ask: 'What does it say?', expect: /STOP|Invoice/ },
  };
  const ocrFetch = (async (_url: string, init: RequestInit = {}) => {
    const document = JSON.parse(String(init.body)).document as Record<string, string>;
    const uri = document.document_url ?? document.image_url ?? '';
    return Response.json({
      pages: [{ index: 0, markdown: Buffer.from(uri.split(',')[1] ?? '', 'base64').toString() }],
    });
  }) as typeof globalThis.fetch;
  const adapters: MediaProvider[] = [
    modelMediaProvider(visionClient().client, { model: 'gpt-5.4' }),
    new MistralOcrProvider({ apiKey: 'k', fetch: ocrFetch }),
    new MockMediaProvider({ read: (media) => [decode(media)], answer: (media) => decode(media[0] as MediaInput) }),
  ];
  for (const adapter of adapters) {
    const report = await runMediaConformance(adapter, fixtures);
    assert.deepEqual(report.failures, [], adapter.info.name);
    assert.ok(report.passed.length >= 2, adapter.info.name);
  }

  const broken: MediaProvider = {
    info: { name: 'broken', capabilities: { tasks: ['read', 'describe'], inputs: ['image'] } },
    read: async () => ({
      provider: 'broken',
      model: 'm',
      pages: [{ index: 0, text: 'nothing here' }],
      text: 'nothing here',
    }),
  };
  const report = await runMediaConformance(broken, fixtures);
  assert.deepEqual(report.failures, [
    'describe: declared, but not implemented',
    'read image: the text does not match /STOP|Invoice/',
  ]);
});
