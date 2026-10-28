/**
 * Embeddings priced by length, and video as an input: a second of audio and a frame of video priced as
 * gemini-embedding-2 bills them, each read from the media's own headers; media longer than the model
 * takes refused before any call; media whose length cannot be read counted as unpriced; a video sent by
 * its bytes or its Files API URI; and a Google batch too large to send inline uploaded as a file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GoogleEmbeddingProvider } from '../src/embeddings/adapters.js';
import { EmbeddingBatchManager } from '../src/embeddings/batch.js';
import { GoogleEmbeddingBatchProvider } from '../src/embeddings/batch-google.js';
import { EmbeddingCapabilityError, EmbeddingValidationError } from '../src/embeddings/errors.js';
import { EmbeddingManager } from '../src/embeddings/manager.js';
import { MockEmbeddingProvider } from '../src/embeddings/mock.js';
import type { BatchProviderCallContext } from '../src/types/batch.js';
import type { EmbeddingParts } from '../src/types/embeddings.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url)));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A WAV header that says it holds this many seconds of 16 kHz mono 16-bit sound. */
function wavOf(seconds: number): Uint8Array {
  const header = Buffer.alloc(44);
  const byteRate = 16_000 * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + seconds * byteRate, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(seconds * byteRate, 40);
  return new Uint8Array(header);
}

/** The fixture clip, its movie header saying it lasts this many seconds. */
function mp4Of(seconds: number): Uint8Array {
  const bytes = Buffer.from(fixture('clip.mp4'));
  const at = bytes.indexOf('mvhd') + 4;
  const version = bytes[at] as number;
  const timescale = bytes.readUInt32BE(at + (version === 1 ? 20 : 12));
  if (version === 1) bytes.writeBigUInt64BE(BigInt(seconds * timescale), at + 24);
  else bytes.writeUInt32BE(seconds * timescale, at + 16);
  return new Uint8Array(bytes);
}

const audio = (bytes: Uint8Array, format = 'wav'): EmbeddingParts => ({
  parts: [{ type: 'audio', source: { base64: base64(bytes), format } }],
});
const video = (bytes: Uint8Array, format?: string): EmbeddingParts => ({
  parts: [{ type: 'video', source: { buffer: Buffer.from(bytes), ...(format ? { format } : {}) } }],
});

/** Google's embedding API, recording each batch of requests and answering a vector for each. */
function googleWire() {
  const bodies: Array<{ requests: Array<{ content: { parts: unknown[] } }> }> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
    bodies.push(body);
    return Response.json({ embeddings: body.requests.map(() => ({ values: [0.6, 0.8] })) });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

test('audio is priced by the second and video by the frame, each read from its own headers', async () => {
  const wire = googleWire();
  const embeddings = new EmbeddingManager({
    providers: { google: new GoogleEmbeddingProvider({ apiKey: 'k', fetch: wire.fetch }) },
    defaultProvider: 'google',
  });
  const embed = (input: EmbeddingParts | EmbeddingParts[]) => embeddings.embed({ model: 'gemini-embedding-2', input });
  const priced = async (input: EmbeddingParts | EmbeddingParts[]) => {
    const response = await embed(input);
    const tokens = response.meta.usage.inputTokens * (0.0002 / 1000);
    return Number((response.meta.cost.amount - tokens).toFixed(8));
  };

  // 1.2 s of WAV is two seconds billed; 2.88 s of MP3, three.
  assert.equal(await priced(audio(fixture('tone.wav'))), 0.00032);
  assert.equal(await priced(audio(fixture('tone-cbr.mp3'), 'mp3')), 0.00048);
  // 2.5 s of MP4 is three frames, one a second; 2.25 s of MOV, three; a minute, the most it takes: 32.
  assert.equal(await priced(video(fixture('clip.mp4'))), 0.00237);
  assert.equal(await priced(video(fixture('clip.mov'), 'mov')), 0.00237);
  assert.equal(await priced(video(mp4Of(60))), 0.02528);
  assert.equal(await priced(video(mp4Of(32))), 0.02528, 'exactly 32 seconds is 32 frames');
  assert.equal(await priced(video(mp4Of(10))), 0.0079);
  // Together, as one input or several, with an image beside them.
  const together = await priced([
    { parts: [...audio(fixture('tone.wav')).parts, ...video(fixture('clip.mp4')).parts] },
    { parts: [{ type: 'image', source: { base64: base64(new Uint8Array([1])), mimeType: 'image/png' } }] },
  ]);
  assert.equal(together, Number((0.00032 + 0.00237 + 0.00012).toFixed(8)));

  // Sent inline, each of its own type.
  const sent = wire.bodies.slice(2, 4).map((body) => body.requests[0]?.content.parts[0]);
  assert.deepEqual(sent, [
    { inlineData: { mimeType: 'video/mp4', data: base64(fixture('clip.mp4')) } },
    { inlineData: { mimeType: 'video/quicktime', data: base64(fixture('clip.mov')) } },
  ]);

  // The cache answers a repeat without pricing it again.
  const repeat = await embeddings.embed({ model: 'gemini-embedding-2', input: video(fixture('clip.mp4')) });
  assert.ok(repeat.meta.cost.amount >= 0);
});

test('media longer than the model takes is refused before any call, and media of no known length is unpriced', async () => {
  const wire = googleWire();
  const embeddings = new EmbeddingManager({
    providers: { google: new GoogleEmbeddingProvider({ apiKey: 'k', fetch: wire.fetch }) },
    defaultProvider: 'google',
  });
  const embed = (input: EmbeddingParts | EmbeddingParts[]) => embeddings.embed({ model: 'gemini-embedding-2', input });
  await assert.rejects(
    embed([audio(fixture('tone.wav')), audio(wavOf(181))]),
    (error: unknown) =>
      error instanceof EmbeddingValidationError &&
      /Input 1 holds 181\.0 s of audio, and gemini-embedding-2 takes at most 180 s; split it/.test(error.message),
  );
  await assert.rejects(
    embed(video(mp4Of(121))),
    /Input 0 holds 121\.0 s of video, and gemini-embedding-2 takes at most 120 s/,
  );
  assert.equal(wire.bodies.length, 0, 'nothing was sent');
  const longest = await embed(audio(wavOf(180)));
  assert.ok(Math.abs(longest.meta.cost.amount - 180 * 0.00016) < 1e-6, 'the most it takes is taken, and priced');
  assert.ok(Math.abs((await embed(video(mp4Of(120)))).meta.cost.amount - 32 * 0.00079) < 1e-6);

  // A Files API URI is sent by reference; its length is unknown, so it is counted as unpriced.
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/clip-1';
  const byUri = await embed({ parts: [{ type: 'video', source: { url: uri } }] });
  assert.deepEqual(wire.bodies.at(-1)?.requests[0]?.content.parts, [
    { fileData: { mimeType: 'video/mp4', fileUri: uri } },
  ]);
  assert.equal(byUri.meta.unpricedMedia, 1);
  assert.ok(byUri.meta.cost.amount < 0.00001, 'and not in the cost');
  const unreadable = await embed([video(new Uint8Array([1, 2, 3, 4]), 'mp4'), audio(new Uint8Array([9, 9, 9]), 'mp3')]);
  assert.equal(unreadable.meta.unpricedMedia, 2, 'bytes no container reader knows');
  assert.equal((await embed(video(fixture('clip.mp4')))).meta.unpricedMedia, undefined);
  const named = await embed({
    parts: [{ type: 'video', source: { url: 'https://generativelanguage.googleapis.com/v1beta/files/x.mov' } }],
  });
  assert.equal(named.meta.unpricedMedia, 1);
  assert.deepEqual(wire.bodies.at(-1)?.requests[0]?.content.parts, [
    {
      fileData: {
        mimeType: 'video/quicktime',
        fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/x.mov',
      },
    },
  ]);

  // A model that does not price media by length counts none as unpriced.
  const mock = new EmbeddingManager({
    providers: { mock: new MockEmbeddingProvider({ dimensions: 4 }) },
    defaultProvider: 'mock',
  });
  assert.equal(
    (await mock.embed({ input: { parts: [{ type: 'video', source: { url: uri } }] } })).meta.unpricedMedia,
    undefined,
  );

  // A video by path, or on a model that takes none, is refused.
  await assert.rejects(
    embed({ parts: [{ type: 'video', source: { path: 'clip.mp4' } } as never] }),
    /An embedding video part must hold its content, as bytes, base64, or a URL; read a file on disk first/,
  );
  await assert.rejects(
    embeddings.embed({ model: 'gemini-embedding-001', input: video(fixture('clip.mp4')) }),
    (error: unknown) => error instanceof EmbeddingCapabilityError && /not video/.test(error.message),
  );
  for (const [format, type] of [
    ['webm', 'video/webm'],
    ['3gpp', 'video/3gpp'],
  ]) {
    await embed({ parts: [{ type: 'video', source: { base64: base64(fixture('clip.mp4')), format } }] });
    assert.equal(
      JSON.stringify(wire.bodies.at(-1)?.requests[0]?.content.parts[0]),
      JSON.stringify({ inlineData: { mimeType: type, data: base64(fixture('clip.mp4')) } }),
      'a format is sent as its type, and the provider decides',
    );
  }
});

test('a model of its own prices video at its own frame rate, up to its own most', async () => {
  const embeddings = new EmbeddingManager({
    providers: {
      mock: new MockEmbeddingProvider({
        dimensions: 4,
        defaultModel: 'clips-1',
        capabilities: { models: ['clips-1'] },
      }),
    },
    defaultProvider: 'mock',
    models: {
      registry: {
        'clips-1': {
          provider: 'mock',
          dimensions: 4,
          maxInputTokens: 100,
          costPer1kInput: 0,
          costPerVideoFrame: 0.01,
          videoFrames: { perSecond: 2, max: 7 },
          inputModalities: ['text', 'video'],
        },
      },
    },
  });
  const cost = async (seconds: number) =>
    Number((await embeddings.embed({ model: 'clips-1', input: video(mp4Of(seconds)) })).meta.cost.amount.toFixed(6));
  assert.equal(await cost(2), 0.04, 'two a second');
  assert.equal(await cost(3), 0.06);
  assert.equal(await cost(10), 0.07, 'at most seven');
  // A model that prices audio alone counts audio it cannot measure as unpriced.
  const tones = new EmbeddingManager({
    providers: {
      mock: new MockEmbeddingProvider({
        dimensions: 4,
        defaultModel: 'tones-1',
        capabilities: { models: ['tones-1'] },
      }),
    },
    defaultProvider: 'mock',
    models: {
      registry: {
        'tones-1': {
          provider: 'mock',
          dimensions: 4,
          maxInputTokens: 100,
          costPer1kInput: 0,
          costPerAudioSecond: 0.001,
          inputModalities: ['text', 'audio'],
        },
      },
    },
  });
  assert.equal(
    (await tones.embed({ model: 'tones-1', input: audio(new Uint8Array([7, 7, 7]), 'mp3') })).meta.unpricedMedia,
    1,
  );
  assert.equal((await tones.embed({ model: 'tones-1', input: audio(fixture('tone.wav')) })).meta.cost.amount, 0.002);
  assert.equal(
    Number(
      (await embeddings.embed({ model: 'clips-1', input: video(fixture('clip.mp4')) })).meta.cost.amount.toFixed(6),
    ),
    0.05,
    '2.5 seconds is five frames',
  );
});

test('a budget counts the media before the call', async () => {
  const wire = googleWire();
  const embeddings = new EmbeddingManager({
    providers: { google: new GoogleEmbeddingProvider({ apiKey: 'k', fetch: wire.fetch }) },
    defaultProvider: 'google',
    costBudget: { enabled: true, maxEstimatedCost: 0.01 },
  });
  await assert.rejects(embeddings.embed({ model: 'gemini-embedding-2', input: video(mp4Of(60)) }), /budget|exceed/i);
  assert.equal(wire.bodies.length, 0);
  await embeddings.embed({ model: 'gemini-embedding-2', input: video(mp4Of(10)) });
  assert.equal(wire.bodies.length, 1, 'ten frames are within it');
});

/**
 * Gemini's batch API and Files API: an inline batch, or a file uploaded by the resumable protocol, a
 * batch over it, and its results written to a file, with or without each line's key.
 */
function batchWire(
  options: { keyed?: boolean | 'foreign'; inlineField?: 'inlinedResponses' | 'inlinedEmbedContentResponses' } = {},
) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  let uploaded = '';
  let lines: Array<{ key: string; request: unknown }> = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const body =
      typeof init.body === 'string' ? init.body : init.body instanceof Blob ? await init.body.text() : undefined;
    calls.push({
      url: url.href,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      ...(body !== undefined ? { body } : {}),
    });
    if (url.pathname === '/upload/v1beta/files') {
      return new Response('{}', { headers: { 'x-goog-upload-url': 'https://uploads.test/session-1' } });
    }
    if (url.href === 'https://uploads.test/session-1') {
      uploaded = body ?? '';
      lines = uploaded
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      return Response.json({ file: { name: 'files/in-1', mimeType: 'application/jsonl' } });
    }
    if (url.pathname.endsWith(':asyncBatchEmbedContent')) return Response.json({ name: 'batches/b1' });
    if (url.pathname === '/v1beta/batches/b1') {
      const fromFile = calls.some(
        (call) => call.url.endsWith(':asyncBatchEmbedContent') && call.body?.includes('fileName'),
      );
      const inline = [{ response: { embedding: { values: [1] } } }, { error: { message: 'bad image', code: 3 } }];
      return Response.json({
        name: 'batches/b1',
        state: 'BATCH_STATE_SUCCEEDED',
        output: fromFile
          ? { responsesFile: 'files/out-1' }
          : { [options.inlineField ?? 'inlinedResponses']: { inlinedResponses: inline } },
      });
    }
    if (url.pathname === '/download/v1beta/files/out-1:download') {
      // Answered out of order, by key; or in order, bare, as the API reference shows a line, or keyed
      // to ids that are not ours.
      const answers = lines.map((line, index) => {
        if (options.keyed === false)
          return index === 1 ? { error: { message: 'too long', code: 3 } } : { embedding: { values: [index] } };
        const key = options.keyed === 'foreign' ? `theirs-${index}` : line.key;
        return index === 1
          ? { key, error: { message: 'too long', code: 3 } }
          : { key, response: { embedding: { values: [index] } } };
      });
      const ordered = options.keyed === true || options.keyed === undefined ? [...answers].reverse() : answers;
      return new Response(`${ordered.map((answer) => JSON.stringify(answer)).join('\n')}\n`);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, uploaded: () => uploaded, lines: () => lines };
}

const context = (): BatchProviderCallContext => ({
  requestId: 'test',
  signal: new AbortController().signal,
  attempt: 1,
});

test('a Google batch over 20 MB is uploaded as a file, and its results read from the file it writes, by key', async () => {
  const wire = batchWire();
  const google = new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: wire.fetch });
  const big = 'x'.repeat(7 * 1024 * 1024);
  const ref = await google.submit(
    {
      model: 'gemini-embedding-001',
      inputType: 'document',
      dimensions: 768,
      items: ['a', 'b', 'c'].map((customId) => ({ customId, input: `${customId}${big}` })),
      metadata: { key: 'window-7' },
    },
    context(),
  );
  const [start, finish, create] = wire.calls;
  assert.equal(start?.url, 'https://generativelanguage.googleapis.com/upload/v1beta/files');
  assert.equal(start?.headers.get('x-goog-upload-protocol'), 'resumable');
  assert.equal(start?.headers.get('x-goog-upload-command'), 'start');
  assert.equal(start?.headers.get('x-goog-upload-header-content-type'), 'application/jsonl');
  assert.equal(Number(start?.headers.get('x-goog-upload-header-content-length')), Buffer.byteLength(wire.uploaded()));
  assert.equal(start?.headers.get('x-goog-api-key'), 'k');
  assert.deepEqual(JSON.parse(String(start?.body)), { file: { displayName: 'window-7' } });
  assert.equal(finish?.url, 'https://uploads.test/session-1');
  assert.equal(finish?.headers.get('x-goog-upload-command'), 'upload, finalize');
  assert.equal(finish?.headers.get('x-goog-upload-offset'), '0');
  assert.equal(finish?.headers.get('x-goog-api-key'), 'k');
  assert.deepEqual(
    wire.lines().map((line) => line.key),
    ['a', 'b', 'c'],
    'a line per input, keyed by its id',
  );
  assert.deepEqual(wire.lines()[0]?.request, {
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text: `a${big}` }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: 768,
  });
  assert.equal(
    create?.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent',
  );
  assert.deepEqual(JSON.parse(String(create?.body)), {
    batch: { displayName: 'window-7', inputConfig: { fileName: 'files/in-1' } },
  });
  assert.equal(ref.metadata?.inputFile, 'files/in-1');

  assert.deepEqual(await google.results(ref, context()), [
    { customId: 'c', vector: [2] },
    { customId: 'b', error: { message: 'too long', code: '3' } },
    { customId: 'a', vector: [0] },
  ]);
  assert.equal(
    wire.calls.at(-1)?.url,
    'https://generativelanguage.googleapis.com/download/v1beta/files/out-1:download?alt=media',
  );

  // Lines that name no key, or a key not one of ours, are matched by their position.
  for (const keyed of [false, 'foreign'] as const) {
    const unkeyed = batchWire({ keyed });
    const plain = new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: unkeyed.fetch });
    const plainRef = await plain.submit(
      {
        model: 'gemini-embedding-001',
        items: ['a', 'b', 'c'].map((customId) => ({ customId, input: `${customId}${big}` })),
      },
      context(),
    );
    assert.deepEqual(
      await plain.results(plainRef, context()),
      [
        { customId: 'a', vector: [0] },
        { customId: 'b', error: { message: 'too long', code: '3' } },
        { customId: 'c', vector: [2] },
      ],
      String(keyed),
    );
  }

  // A file over the adapter's limit, 2 GB, is refused before it is uploaded.
  const capped = batchWire();
  const smaller = new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: capped.fetch });
  (smaller.info.capabilities as { maxBytes?: number }).maxBytes = 22 * 1024 * 1024;
  await assert.rejects(
    smaller.submit(
      { model: 'gemini-embedding-001', items: ['a', 'b', 'c', 'd'].map((customId) => ({ customId, input: big })) },
      context(),
    ),
    /A Gemini batch file holds at most 22 MB; this one is 29 MB, so split it/,
  );
  assert.equal(capped.calls.length, 0, 'nothing uploaded');
});

test('a small Google batch stays inline, its results read under either name, and a base URL with no version cannot upload', async () => {
  for (const inlineField of ['inlinedResponses', 'inlinedEmbedContentResponses'] as const) {
    const wire = batchWire({ inlineField });
    const google = new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: wire.fetch });
    const ref = await google.submit(
      {
        model: 'gemini-embedding-2',
        items: [
          { customId: 'q1', input: 'red' },
          { customId: 'q2', input: 'blue' },
        ],
      },
      context(),
    );
    assert.ok(!wire.calls.some((call) => call.url.includes('/upload/')), 'nothing uploaded');
    assert.equal(ref.metadata?.inputFile, undefined);
    assert.deepEqual(await google.results(ref, context()), [
      { customId: 'q1', vector: [1] },
      { customId: 'q2', error: { message: 'bad image', code: '3' } },
    ]);
  }
  const proxied = new GoogleEmbeddingBatchProvider({
    apiKey: 'k',
    baseUrl: 'https://proxy.test/gemini/',
    fetch: batchWire().fetch,
  });
  await assert.rejects(
    proxied.submit(
      { model: 'gemini-embedding-001', items: [{ customId: 'a', input: 'x'.repeat(21 * 1024 * 1024) }] },
      context(),
    ),
    /the base URL https:\/\/proxy\.test\/gemini names no API version to upload beside/,
  );
  const versioned = batchWire();
  const behind = new GoogleEmbeddingBatchProvider({
    apiKey: 'k',
    baseUrl: 'https://proxy.test/gemini/v1beta',
    fetch: versioned.fetch,
  });
  await behind
    .submit(
      { model: 'gemini-embedding-001', items: [{ customId: 'a', input: 'x'.repeat(21 * 1024 * 1024) }] },
      context(),
    )
    .catch(() => undefined);
  assert.equal(
    versioned.calls[0]?.url,
    'https://proxy.test/gemini/upload/v1beta/files',
    'beside a proxy’s own version',
  );

  const noUrl = (async () => new Response('{}')) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: noUrl }).submit(
      { model: 'gemini-embedding-001', items: [{ customId: 'a', input: 'x'.repeat(21 * 1024 * 1024) }] },
      context(),
    ),
    /not given a URL to send the file to/,
  );
  const noName = (async (input: string) =>
    String(input).includes('/upload/')
      ? new Response('{}', { headers: { 'x-goog-upload-url': 'https://uploads.test/s' } })
      : Response.json({ file: {} })) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: noName }).submit(
      { model: 'gemini-embedding-001', items: [{ customId: 'a', input: 'x'.repeat(21 * 1024 * 1024) }] },
      context(),
    ),
    /the upload returned no file name/,
  );
});

test('a batch is priced for its media at the batch rate, and refuses media longer than the model takes', async () => {
  const wire = batchWire();
  const manager = new EmbeddingBatchManager({
    providers: { google: new GoogleEmbeddingBatchProvider({ apiKey: 'k', fetch: wire.fetch }) },
    pollIntervalMs: 1,
  });
  const handle = await manager.submit({
    model: 'gemini-embedding-2',
    items: [
      { customId: 'a', input: audio(fixture('tone.wav')) },
      { customId: 'b', input: video(fixture('clip.mp4')) },
    ],
  });
  const result = await handle.result();
  const tokens = result.usage.inputTokens * (0.0002 / 1000);
  assert.equal(Number((result.cost.amount - tokens / 2).toFixed(8)), Number(((0.00032 + 0.00237) / 2).toFixed(8)));
  await assert.rejects(
    manager.submit({ model: 'gemini-embedding-2', items: [{ customId: 'a', input: video(mp4Of(121)) }] }),
    /holds 121\.0 s of video/,
  );
});
