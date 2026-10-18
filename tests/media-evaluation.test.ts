/**
 * Media you can evaluate: images, documents, audio, and video as the subject of an evaluation.
 *
 * Checks read the media themselves, wherever they are (bytes, base64, a data URL, a fetched URL, an
 * asset store), for format, size, dimensions, aspect ratio, and duration. A judge model is shown the
 * media, a stored asset sent as its bytes, beside the rubric and the brief. Media are found in the
 * output, or in what the run's trace says it produced, and an experiment scores a target that draws.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataset } from '../src/evaluate/datasets.js';
import { mediaChecks, mediaJudge, mediaOf, resolveMedia } from '../src/evaluate/media.js';
import { declaredProvenance } from '../src/evaluate/provenance.js';
import { evaluate } from '../src/evaluate/run.js';
import { traceEvidence } from '../src/evaluate/trace.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { readImageDimensions } from '../src/images/image-header.js';
import type { EvaluationContext, EvaluationScore } from '../src/types/evaluate.js';
import type { CompletionRequest, ContentPart } from '../src/types/messages.js';
import type { RunTree } from '../src/types/tracing.js';

/** A PNG's signature and header: enough for anything that reads its size. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}
function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([...'GIF89a'].map((char) => char.charCodeAt(0)));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}
/** A WAV header for `ms` of 16 kHz mono 16-bit audio, with that many bytes of silence. */
function wav(ms: number): Uint8Array {
  const byteRate = 32_000;
  const size = Math.round((byteRate * ms) / 1000);
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) =>
    bytes.set(
      [...text].map((char) => char.charCodeAt(0)),
      at,
    );
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, size, true);
  return bytes;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const context = (output: unknown, inputs: unknown = { brief: 'a banner' }): EvaluationContext => ({
  example: { id: 'ex-1', inputs },
  output,
  latencyMs: 10,
  run: 0,
});
const byKey = (scores: unknown) => new Map((scores as EvaluationScore[]).map((score) => [score.key, score]));
/** The parts of a judge request's user message. */
const userContent = (request: CompletionRequest | undefined) => (request?.messages[1]?.content ?? []) as ContentPart[];

function storeWith(bytes: Uint8Array) {
  const store = new MemoryAssetStore();
  const stat = store.put(
    { location: { kind: 'bytes', data: bytes }, mimeType: 'image/png' },
    { tenantId: 'acme', provenance: { provider: 'mock', operation: 'generate', requestId: 'r1' } },
  );
  return { store, descriptor: stat.descriptor };
}

test('checks read the media themselves: format, size, dimensions, and aspect ratio, wherever they are', async () => {
  const { store, descriptor } = storeWith(png(1920, 1080));
  const output = { images: [descriptor], thumbnail: { type: 'image', source: { base64: b64(gif(300, 300)) } } };
  const checks = mediaChecks({
    kinds: ['image'],
    mimeTypes: ['image/png'],
    width: { min: 1024 },
    aspectRatio: { ratio: 16 / 9 },
    bytes: { max: 1_000 },
    assets: { store, tenantId: 'acme' },
  });
  const scores = byKey(await checks(context(output)));
  assert.deepEqual(
    ['media', 'media.count', 'media.format', 'media.size', 'media.dimensions', 'media.aspect'].map((key) => [
      key,
      scores.get(key)?.score,
    ]),
    [
      ['media', 0.5],
      ['media.count', 1],
      ['media.format', 0.5],
      ['media.size', 1],
      ['media.dimensions', 0.5],
      ['media.aspect', 0.5],
    ],
    'the stored PNG passes; the square GIF thumbnail fails format, width, and aspect',
  );
  assert.match(scores.get('media.format')?.comment ?? '', /#2: image\/gif is not image or image\/png/);
  assert.match(scores.get('media.dimensions')?.comment ?? '', /#2: 300×300 is not at least 1024px wide/);
  assert.equal(scores.get('media')?.passed, false);

  // A stored asset with no store to read it from: its measurements are unknown, which fails, or
  // passes when told to.
  const blind = byKey(await mediaChecks({ width: { min: 1 } })(context({ images: [descriptor] })));
  assert.equal(blind.get('media.dimensions')?.score, 0);
  assert.match(blind.get('media.dimensions')?.comment ?? '', /no asset store was given/);
  const lenient = byKey(await mediaChecks({ width: { min: 1 }, unknown: 'pass' })(context({ images: [descriptor] })));
  assert.equal(lenient.get('media.dimensions')?.score, 1);

  // Nothing to judge fails the count, and everything with it.
  const empty = byKey(await mediaChecks({ kinds: ['image'] })(context({ text: 'no picture' })));
  assert.deepEqual([empty.get('media')?.score, empty.get('media.count')?.score], [0, 0]);
  const anyImage = byKey(
    await mediaChecks({ mimeTypes: ['image/*'], assets: { store, tenantId: 'acme' } })(context(output)),
  );
  assert.equal(anyImage.get('media.format')?.score, 1, 'image/* takes the PNG and the GIF');
  const two = byKey(await mediaChecks({ count: { min: 2, max: 2 } })(context(output)));
  assert.equal(two.get('media.count')?.passed, true);
});

test('audio, documents, and URLs: a WAV’s duration, a PDF in a data URL, and a fetch only when given one', async () => {
  const clip = { type: 'audio' as const, source: { base64: b64(wav(1_500)) } };
  const audio = byKey(await mediaChecks({ durationMs: { max: 1_000 }, kinds: ['audio'] })(context({ clip })));
  assert.deepEqual([audio.get('media.format')?.score, audio.get('media.duration')?.score], [1, 0]);
  assert.match(audio.get('media.duration')?.comment ?? '', /1500 ms is not at most 1000 ms/);

  const pdf = `data:application/pdf;base64,${b64(new TextEncoder().encode('%PDF-1.7\n%…'))}`;
  const document = await resolveMedia({ type: 'document', source: { url: pdf } });
  assert.deepEqual([document.kind, document.mimeType, document.bytes?.length], ['document', 'application/pdf', 13]);

  const fetched: string[] = [];
  const remote = { type: 'image' as const, source: { url: 'https://cdn.test/banner.png' } };
  const unread = await resolveMedia(remote);
  assert.deepEqual([unread.url, unread.bytes], ['https://cdn.test/banner.png', undefined], 'nothing fetched unasked');
  const read = await resolveMedia(remote, {
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(new Blob([png(800, 600)]));
    }) as unknown as typeof fetch,
  });
  assert.deepEqual([read.width, read.height, read.mimeType, fetched], [800, 600, 'image/png', [remote.source.url]]);
  await assert.doesNotReject(async () => {
    const big = await resolveMedia({ type: 'image', source: { base64: b64(png(1, 1)) } }, { maxBytes: 8 });
    assert.match(big.unreadable ?? '', /over the 8-byte limit/);
  });
});

test('a judge is shown the media themselves, a stored asset as its bytes, beside the rubric and the brief', async () => {
  const { store, descriptor } = storeWith(png(1920, 1080));
  const requests: CompletionRequest[] = [];
  // A vision model of the test's: it looks at each image it is shown and likes the large ones.
  const client = {
    async complete(request: CompletionRequest) {
      requests.push(request);
      const content = request.messages[1]?.content as ContentPart[];
      const images = content.filter((part) => part.type === 'image');
      const widths = images.map(
        (part) => readImageDimensions(Buffer.from((part.source as { base64: string }).base64, 'base64'))?.width ?? 0,
      );
      const large = widths.length > 0 && widths.every((width) => width >= 1024);
      return {
        content: JSON.stringify({ score: large ? 0.9 : 0.2, passed: large, rationale: `widths ${widths.join(',')}` }),
      } as never;
    },
  };
  const judge = mediaJudge({
    client,
    model: 'vision-judge',
    rubric: 'Sharp, on brand, legible at a glance.',
    key: 'banner-quality',
    assets: { store, tenantId: 'acme' },
  });
  const photo = { type: 'image', source: { base64: b64(png(64, 64)) } };
  const score = (await judge(context({ banner: descriptor }, { brief: 'a launch banner', photo }))) as EvaluationScore;
  assert.deepEqual([score.key, score.score, score.passed, score.comment], ['banner-quality', 0.9, true, 'widths 1920']);

  const [request] = requests;
  const [text, image] = userContent(request);
  assert.equal(request?.model, 'vision-judge');
  assert.match((text as { text: string }).text, /Rubric:\nSharp, on brand, legible at a glance\./);
  assert.match(
    (text as { text: string }).text,
    /What the media were made for:\n\{"brief":"a launch banner","photo":"\[medium\]"\}/,
    'the brief, with the media in it named rather than spelled out',
  );
  assert.deepEqual(image, { type: 'image', source: { base64: b64(png(1920, 1080)), mimeType: 'image/png' } });

  // The input's photo too, when asked; a small one fails.
  const both = (await mediaJudge({ client, model: 'vision-judge', rubric: 'x', from: 'all' })(
    context({ banner: { type: 'image', source: { base64: b64(png(2000, 1000)) } } }, { photo }),
  )) as EvaluationScore;
  assert.deepEqual([both.score, both.comment], [0.2, 'widths 64,2000']);

  // At most `maxMedia`, and nothing to judge is a failure, or no score.
  await mediaJudge({ client, model: 'vision-judge', rubric: 'x', maxMedia: 1 })(
    context([photo, photo, { type: 'image', source: { base64: b64(png(3000, 1)) } }]),
  );
  assert.equal(userContent(requests.at(-1)).filter((part) => part.type === 'image').length, 1);
  const missing = (await judge(context({ text: 'none' }))) as EvaluationScore;
  assert.deepEqual([missing.score, missing.passed], [0, false]);
  assert.deepEqual(await mediaJudge({ client, model: 'm', rubric: 'x', whenMissing: 'skip' })(context({})), []);
  assert.equal(requests.length, 3, 'no call with nothing to judge');

  // A stored asset the judge cannot read is named in the text instead.
  await mediaJudge({ client, model: 'vision-judge', rubric: 'x' })(context({ banner: descriptor }));
  assert.match(
    (userContent(requests.at(-1))[0] as { text: string }).text,
    /Medium 1 \(image\/png\) could not be shown: asset .* is stored, and no asset store was given/,
  );
  assert.deepEqual(declaredProvenance(judge)?.judge?.model, 'vision-judge');
  assert.equal(declaredProvenance(judge)?.rubric, 'Sharp, on brand, legible at a glance.');
});

test('with nothing in the output, the media are the ones the run’s trace says it produced', async () => {
  const at = '2026-10-18T12:00:00.000Z';
  const tree: RunTree = {
    id: 'root',
    traceId: 't',
    name: 'designer',
    kind: 'agent',
    status: 'ok',
    startedAt: at,
    inputs: { brief: 'a poster', reference: { type: 'image', source: { base64: b64(png(10, 10)) } } },
    outputs: { done: true },
    children: [
      {
        id: 'tool',
        traceId: 't',
        parentId: 'root',
        name: 'draw',
        kind: 'tool',
        status: 'ok',
        startedAt: at,
        outputs: { type: 'tool_output', content: [{ type: 'image', source: { base64: b64(png(1200, 1600)) } }] },
        children: [],
      },
    ],
  };
  const traced: EvaluationContext = { ...context({ done: true }, tree.inputs), trace: traceEvidence(tree) };
  const produced = mediaOf(traced);
  assert.equal(produced.length, 1);
  assert.equal((await resolveMedia(produced[0] as never)).width, 1200);
  assert.equal((await resolveMedia(mediaOf(traced, 'input')[0] as never)).width, 10);
  const scores = byKey(await mediaChecks({ height: { min: 1000 } })(traced));
  assert.equal(scores.get('media.dimensions')?.score, 1);
});

test('an experiment scores a target that draws, with checks and a judge, and records the judge', async () => {
  const dataset = createDataset({
    name: 'banners',
    examples: [
      { id: 'wide', inputs: { brief: 'a wide banner', width: 1600, height: 900 } },
      { id: 'square', inputs: { brief: 'a banner, by mistake square', width: 900, height: 900 } },
    ],
  });
  const draw = (inputs: { width: number; height: number }) => ({
    image: { type: 'image', source: { base64: b64(png(inputs.width, inputs.height)), mimeType: 'image/png' } },
  });
  const judge = mediaJudge({
    client: {
      async complete(request: CompletionRequest) {
        const image = userContent(request).find((part) => part.type === 'image') as { source: { base64: string } };
        const size = readImageDimensions(Buffer.from(image.source.base64, 'base64'));
        return { content: `{"score": ${size && size.width > size.height ? 1 : 0}}` } as never;
      },
    },
    model: 'vision-judge',
    rubric: 'A banner is wider than it is tall.',
    key: 'banner',
  });
  const experiment = await evaluate(draw, dataset, [mediaChecks({ aspectRatio: { ratio: 16 / 9 } }), judge]);
  const scores = new Map(experiment.results.map((result) => [result.exampleId, byKey(result.scores)]));
  assert.deepEqual(
    ['wide', 'square'].map((id) => [scores.get(id)?.get('media.aspect')?.score, scores.get(id)?.get('banner')?.score]),
    [
      [1, 1],
      [0, 0],
    ],
  );
  assert.ok(
    experiment.evaluators?.some((item) => item.judge?.model === 'vision-judge'),
    'the experiment says which model judged',
  );
});
