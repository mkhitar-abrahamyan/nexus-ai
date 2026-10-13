/**
 * Embeddings beyond text: images, audio, and documents as input, on the models that take them, and
 * refused before any call on the ones that do not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CohereEmbeddingProvider, GoogleEmbeddingProvider } from '../src/embeddings/adapters.js';
import { EmbeddingCapabilityError, EmbeddingValidationError } from '../src/embeddings/errors.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import { MemoryVectorStore } from '../src/hallucination/retrieval.js';
import type { EmbeddingParts, EmbeddingProviderMediaPart } from '../src/types/embeddings.js';

const image = (bytes: string, mimeType = 'image/png'): EmbeddingParts => ({
  parts: [{ type: 'image', source: { base64: Buffer.from(bytes).toString('base64'), mimeType } }],
});

/** A wire stand-in: records each request body and answers with one vector per input. */
function recording(answer: (body: Record<string, unknown>) => unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify(answer(body)), { status: 200 });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

test('proof: a text query finds the image it describes, through one vector space', async () => {
  // A stand-in for a multimodal model: each image embeds as its caption would, so image and text
  // share a space as they do in gemini-embedding-2 or embed-v4.0.
  const captions: Record<string, string> = {
    bicycle: 'a red bicycle leaning on a brick wall',
    harbour: 'fishing boats in a harbour at sunset',
    receipt: 'a printed receipt for a coffee and a croissant',
  };
  const describeMedia = (part: EmbeddingProviderMediaPart) =>
    captions[Buffer.from(part.data ?? '', 'base64').toString()] ?? '';
  const embeddings = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 128, describeMedia }) },
    defaultProvider: 'mock',
  });
  const names = Object.keys(captions);
  const stored = await embeddings.embed({ input: names.map((name) => image(name)), inputType: 'document' });
  const store = new MemoryVectorStore();
  await store.add(
    names.map((name, index) => ({
      id: name,
      content: `image:${name}`,
      embedding: stored.vectors[index],
      metadata: { mimeType: 'image/png' },
    })),
  );
  for (const [query, expected] of [
    ['red bicycle', 'bicycle'],
    ['boats at sunset', 'harbour'],
    ['receipt for coffee', 'receipt'],
  ] as const) {
    const [vector] = (await embeddings.embed({ input: query, inputType: 'query' })).vectors;
    const [best] = await store.searchVector(vector as number[], { topK: 1 });
    assert.equal(best?.id, expected, query);
  }
});

test('media is refused before any call on a model that takes text only', async () => {
  const provider = new MockEmbeddingProvider({ capabilities: { inputModalities: ['text'] } });
  const embeddings = new EmbeddingManager({ providers: { mock: provider }, defaultProvider: 'mock' });
  await assert.rejects(embeddings.embed({ input: [image('x'), 'text'] }), (error: unknown) => {
    assert.ok(error instanceof EmbeddingCapabilityError);
    assert.match(String(error.message), /takes text input, not image/);
    return true;
  });
  assert.equal(provider.calls.length, 0);

  // A registry entry decides for its model: gemini-embedding-001 takes text, whatever the adapter can.
  const google = new GoogleEmbeddingProvider({ apiKey: 'k', fetch: recording(() => ({})).fetch });
  const registry = new EmbeddingManager({ providers: { google }, defaultProvider: 'google' });
  await assert.rejects(registry.embed({ input: image('x'), model: 'gemini-embedding-001' }), EmbeddingCapabilityError);
});

test('a part must hold its content, and be a kind an embedding takes', async () => {
  const embeddings = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider() },
    defaultProvider: 'mock',
  });
  const refused: EmbeddingParts[] = [
    { parts: [{ type: 'image', source: { path: '/tmp/cat.png' } }] },
    { parts: [{ type: 'audio', source: { transcript: 'hello' } }] },
    { parts: [{ type: 'document', source: { path: 'report.pdf' } }] },
    { parts: [] },
    { parts: [{ type: 'text', text: '' }] },
    { parts: [{ type: 'video', source: { path: 'clip.mp4' } } as never] },
  ];
  for (const input of refused) await assert.rejects(embeddings.embed({ input }), EmbeddingValidationError);
});

test('Google: media goes inline, and gemini-embedding-2 reads its task from a prefix', async () => {
  const wire = recording((body) => ({
    embeddings: (body.requests as unknown[]).map(() => ({ values: [0.6, 0.8] })),
  }));
  const google = new GoogleEmbeddingProvider({ apiKey: 'k', fetch: wire.fetch });
  const embeddings = new EmbeddingManager({ providers: { google }, defaultProvider: 'google' });
  const audio = Buffer.from('mp3 bytes').toString('base64');
  const response = await embeddings.embed({
    model: 'gemini-embedding-2',
    inputType: 'query',
    input: [
      { parts: [{ type: 'text', text: 'red bicycle' }, ...image('png bytes').parts] },
      { parts: [{ type: 'audio', source: { base64: audio, format: 'mp3' } }] },
      'plain text',
    ],
  });
  assert.equal(response.vectors.length, 3);
  const requests = wire.bodies[0]?.requests as Array<{ content: { parts: unknown[] }; taskType?: string }>;
  assert.deepEqual(requests[0]?.content.parts, [
    { text: 'task: search result | query: red bicycle' },
    { inlineData: { mimeType: 'image/png', data: Buffer.from('png bytes').toString('base64') } },
  ]);
  assert.deepEqual(requests[1]?.content.parts, [{ inlineData: { mimeType: 'audio/mpeg', data: audio } }]);
  assert.deepEqual(requests[2]?.content.parts, [{ text: 'task: search result | query: plain text' }]);
  assert.ok(
    requests.every((request) => request.taskType === undefined),
    'no task type on gemini-embedding-2',
  );
  // The one image is priced at the registry's price per image, beside the text's tokens.
  assert.ok(response.meta.cost.amount >= 0.00012 && response.meta.cost.amount < 0.0002);

  await embeddings.embed({ model: 'gemini-embedding-001', inputType: 'document', input: 'a text' });
  const older = wire.bodies[1]?.requests as Array<{ content: { parts: unknown[] }; taskType?: string }>;
  assert.deepEqual(older[0]?.content.parts, [{ text: 'a text' }]);
  assert.equal(older[0]?.taskType, 'RETRIEVAL_DOCUMENT');

  await embeddings.embed({ model: 'gemini-embedding-2', inputType: 'document', input: 'a page' });
  const document = wire.bodies[2]?.requests as Array<{ content: { parts: unknown[] } }>;
  assert.deepEqual(document[0]?.content.parts, [{ text: 'title: none | text: a page' }]);

  await assert.rejects(
    embeddings.embed({
      model: 'gemini-embedding-2',
      input: { parts: [{ type: 'image', source: { url: 'https://example.com/cat.png' } }] },
    }),
    /Files API URI/,
  );
});

test('Cohere: media goes as inputs of text and data-URI images', async () => {
  const wire = recording((body) => ({
    embeddings: { float: ((body.inputs ?? body.texts) as unknown[]).map(() => [1, 0]) },
    meta: { billed_units: { input_tokens: 4 } },
  }));
  const cohere = new CohereEmbeddingProvider({ apiKey: 'k', fetch: wire.fetch });
  const embeddings = new EmbeddingManager({ providers: { cohere }, defaultProvider: 'cohere' });
  await embeddings.embed({
    model: 'embed-v4.0',
    input: [{ parts: [{ type: 'text', text: 'invoice' }, ...image('jpeg bytes', 'image/jpeg').parts] }, 'text only'],
  });
  const body = wire.bodies[0] as { inputs: unknown[]; texts?: unknown };
  assert.equal(body.texts, undefined);
  assert.deepEqual(body.inputs, [
    {
      content: [
        { type: 'text', text: 'invoice' },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}` },
        },
      ],
    },
    { content: [{ type: 'text', text: 'text only' }] },
  ]);

  await embeddings.embed({ model: 'embed-v4.0', input: ['a', 'b'] });
  assert.deepEqual((wire.bodies[1] as { texts: string[] }).texts, ['a', 'b'], 'text alone still goes as texts');
  await assert.rejects(
    embeddings.embed({
      model: 'embed-v4.0',
      input: { parts: [{ type: 'image', source: { url: 'https://x.test/a.png' } }] },
    }),
    /data URI/,
  );
  await assert.rejects(
    embeddings.embed({ model: 'embed-v4.0', input: { parts: [{ type: 'audio', source: { base64: 'AA==' } }] } }),
    EmbeddingCapabilityError,
  );
});

test('a repeated image is embedded once, and its cache key is its content, never its bytes', async () => {
  const provider = new MockEmbeddingProvider();
  const embeddings = new EmbeddingManager({
    providers: { mock: provider },
    defaultProvider: 'mock',
    cache: { enabled: true },
  });
  const first = await embeddings.embed({ input: [image('same'), image('same'), image('other')] });
  assert.equal(first.meta.deduplicatedInputs, 1);
  assert.equal(provider.calls[0]?.contents?.length, 2);
  const again = await embeddings.embed({ input: [image('same'), 'new text'] });
  assert.equal(again.meta.cachedInputs, 1, 'the same bytes are a cache hit');
  assert.deepEqual(again.vectors[0], first.vectors[0]);
});

test('a fallback that cannot take the media is skipped', async () => {
  const primary = new MockEmbeddingProvider({ name: 'primary', failOn: { attempt: 1, error: new Error('boom') } });
  const textOnly = new MockEmbeddingProvider({ name: 'text', capabilities: { inputModalities: ['text'] } });
  const embeddings = new EmbeddingManager({
    providers: { primary, text: textOnly },
    defaultProvider: 'primary',
    fallback: [{ provider: 'text' }],
  });
  await assert.rejects(embeddings.embed({ input: image('x') }), /All embedding attempts failed/);
  assert.equal(textOnly.calls.length, 0);
  await embeddings.embed({ input: 'plain' });
});
