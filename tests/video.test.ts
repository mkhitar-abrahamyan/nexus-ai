/**
 * Video generation, proved: the mock, Google Veo on the Gemini API and on Vertex AI, and Runway pass
 * the video conformance suite against stand-ins for their APIs; a request a model cannot make is
 * refused before any job; a generation runs through the lifecycle, streams its video into an asset
 * store, and is priced per second; a failed job is submitted again only when that may help; and a job
 * whose process dies, after submitting or after storing its video, is collected by another worker
 * with one submission and one stored video.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { FilesystemAssetStore } from '../src/images/asset-stores.js';
import { readAssetStream } from '../src/images/asset-support.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { OperationLifecycleLike } from '../src/types/lifecycle.js';
import type { OperationStore } from '../src/types/operations.js';
import { GoogleVideoProvider } from '../src/video/google.js';
import {
  priceVideo,
  runVideoConformance,
  type VideoAsset,
  VideoError,
  VideoJobFailedError,
  VideoManager,
  type VideoProvider,
  type VideoResult,
} from '../src/video/index.js';
import { type MockVideoJob, MockVideoProvider } from '../src/video/mock.js';
import { RunwayVideoProvider } from '../src/video/runway.js';

let directory: string;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'nexus-video-'));
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

const MP4 = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 1, 2, 3, 4]);
const png = { location: { kind: 'bytes' as const, data: new Uint8Array([137, 80, 78, 71]) }, mimeType: 'image/png' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const video = (bytes = MP4) => new Response(bytes, { headers: { 'content-type': 'video/mp4' } });

/** The Gemini API's Veo endpoints, or Vertex AI's: a job done on its second poll. */
function googleApi(options: { vertex?: boolean; inline?: boolean; filtered?: boolean; error?: number } = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  const polls = new Map<string, number>();
  let operations = 0;
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    if (url.endsWith(':predictLongRunning')) {
      operations += 1;
      return json({
        name: options.vertex
          ? `projects/p/locations/l/operations/op-${operations}`
          : `models/veo/operations/op-${operations}`,
      });
    }
    const name = url.endsWith(':fetchPredictOperation')
      ? (body as { operationName: string }).operationName
      : url.split('/v1beta/')[1];
    if (name && (url.endsWith(':fetchPredictOperation') || url.includes('/operations/'))) {
      const count = (polls.get(name) ?? 0) + 1;
      polls.set(name, count);
      if (count < 2) return json({ name, done: false });
      if (options.error) return json({ name, done: true, error: { code: options.error, message: 'the model failed' } });
      if (options.filtered) {
        return json({
          name,
          done: true,
          response: {
            generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['person in frame'] },
          },
        });
      }
      if (options.vertex) {
        return json({
          name,
          done: true,
          response: {
            videos: [
              options.inline
                ? { bytesBase64Encoded: Buffer.from(MP4).toString('base64'), mimeType: 'video/mp4' }
                : { gcsUri: 'gs://bucket/out/clip one.mp4', mimeType: 'video/mp4' },
            ],
          },
        });
      }
      return json({
        name,
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              { video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media' } },
            ],
          },
        },
      });
    }
    if (url.includes('files/abc:download') || url.startsWith('https://storage.googleapis.com/')) return video();
    return json({ error: { message: `no route for ${url}` } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Runway's task API: a task pending, then running, then done; its video at a signed URL. */
function runwayApi(options: { failureCode?: string } = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];
  const tasks = new Map<string, number>();
  const cancelled = new Set<string>();
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers, body });
    if (url.startsWith('https://cdn.example/')) return video();
    const route = url.replace('https://api.dev.runwayml.com', '');
    if (route === '/v1/text_to_video' || route === '/v1/image_to_video') {
      const id = `task-${tasks.size + 1}`;
      tasks.set(id, 0);
      return json({ id });
    }
    const id = /\/v1\/tasks\/([^/]+)$/.exec(route)?.[1];
    if (id && init.method === 'DELETE') {
      cancelled.add(id);
      return new Response(null, { status: 204 });
    }
    if (id && cancelled.has(id)) return json({ id, status: 'CANCELLED' });
    if (id) {
      const polls = (tasks.get(id) ?? 0) + 1;
      tasks.set(id, polls);
      if (polls === 1) return json({ id, status: 'PENDING', createdAt: '2026-10-15T09:00:00.000Z' });
      if (polls === 2) return json({ id, status: 'RUNNING', progress: 0.5 });
      if (options.failureCode)
        return json({ id, status: 'FAILED', failure: 'it did not work', failureCode: options.failureCode });
      return json({ id, status: 'SUCCEEDED', output: [`https://cdn.example/${id}.mp4?signature=s`] });
    }
    return json({ error: `no route for ${url}` }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Veo on the Gemini API, as it was served until its previews shut down on 2026-10-22. */
const VEO_PREVIEWS = ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview'];

test('the mock, Google Veo on both APIs, and Runway pass the video conformance suite', async () => {
  const providers: VideoProvider[] = [
    new MockVideoProvider(),
    new GoogleVideoProvider({ apiKey: 'key', fetch: googleApi().fetch, models: VEO_PREVIEWS }),
    new GoogleVideoProvider({
      accessToken: async () => 'token',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google',
      fetch: googleApi({ vertex: true }).fetch,
    }),
    new GoogleVideoProvider({
      accessToken: 'token',
      baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google',
      fetch: googleApi({ vertex: true, inline: true }).fetch,
    }),
    new RunwayVideoProvider({ apiKey: 'secret', fetch: runwayApi().fetch }),
  ];
  for (const provider of providers) {
    const report = await runVideoConformance(provider, { pollIntervalMs: 1, image: png, checkCancel: true });
    assert.deepEqual(report.failures, [], `${provider.info.name}: ${report.failures.join('; ')}`);
    assert.ok(report.passed.includes('download'), provider.info.name);
  }
});

test('Google: a request becomes a long-running prediction, and its video is read with the key', async () => {
  const api = googleApi();
  const veo = new GoogleVideoProvider({
    apiKey: 'key',
    fetch: api.fetch,
    personGeneration: 'allow_adult',
    models: VEO_PREVIEWS,
  });
  const manager = new VideoManager({ providers: { veo }, pollIntervalMs: 1 });
  // Started and collected as bytes: a durable generation would store the video instead.
  const result = await manager.resume(
    await manager.start({
      prompt: 'a lighthouse at dusk',
      image: png,
      lastFrame: png,
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 8,
      negativePrompt: 'text',
      seed: 7,
    }),
  );
  const submit = api.calls[0];
  assert.match(String(submit?.url), /models\/veo-3\.1-generate-preview:predictLongRunning$/);
  assert.equal(submit?.headers.get('x-goog-api-key'), 'key');
  assert.deepEqual(submit?.body, {
    instances: [
      {
        prompt: 'a lighthouse at dusk',
        image: { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
        lastFrame: { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
      },
    ],
    parameters: {
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 8,
      negativePrompt: 'text',
      seed: 7,
      personGeneration: 'allow_adult',
    },
  });
  const download = api.calls.find((call) => call.url.includes('files/abc:download'));
  assert.equal(download?.headers.get('x-goog-api-key'), 'key', 'the video is read with the key');
  assert.deepEqual((result.videos[0] as VideoAsset).location, { kind: 'bytes', data: MP4 });
  assert.equal(result.durationSeconds, 8);
  assert.deepEqual(result.cost, { amount: 3.2, currency: 'USD', basis: 'estimated', output: 3.2 });

  // On Vertex AI: polled by fetchPredictOperation, the video read from Cloud Storage with the token.
  const vertexApi = googleApi({ vertex: true });
  const vertex = new GoogleVideoProvider({
    accessToken: 'token',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google',
    storageUri: 'gs://bucket/out',
    fetch: vertexApi.fetch,
  });
  const onVertex = new VideoManager({ providers: { vertex }, pollIntervalMs: 1 });
  await onVertex.resume(await onVertex.start({ prompt: 'waves', audio: true }));
  assert.deepEqual(vertexApi.calls[0]?.body, {
    instances: [{ prompt: 'waves' }],
    parameters: { generateAudio: true, storageUri: 'gs://bucket/out' },
  });
  assert.match(String(vertexApi.calls[1]?.url), /:fetchPredictOperation$/);
  const storage = vertexApi.calls.find((call) => call.url.startsWith('https://storage.googleapis.com/'));
  assert.equal(storage?.url, 'https://storage.googleapis.com/storage/v1/b/bucket/o/out%2Fclip%20one.mp4?alt=media');
  assert.equal(storage?.headers.get('authorization'), 'Bearer token');
});

test('Google: a filtered video and a failed operation end the job, the second worth retrying', async () => {
  const context = { requestId: 'r', signal: new AbortController().signal, attempt: 1 };
  const filtered = new GoogleVideoProvider({ apiKey: 'key', fetch: googleApi({ filtered: true }).fetch });
  const ref = await filtered.submit({ prompt: 'a crowd', model: 'veo-3.1-generate-preview' }, context);
  assert.equal((await filtered.poll(ref, context)).status, 'running');
  assert.deepEqual(await filtered.poll(ref, context).then(({ raw: _raw, ...state }) => state), {
    status: 'failed',
    filtered: 1,
    error: { message: 'person in frame', safety: true, retryable: false },
  });
  const failing = new GoogleVideoProvider({ apiKey: 'key', fetch: googleApi({ error: 13 }).fetch });
  const failed = await failing.submit({ prompt: 'x', model: 'veo-3.1-generate-preview' }, context);
  await failing.poll(failed, context);
  assert.deepEqual((await failing.poll(failed, context)).error, {
    message: 'the model failed',
    code: '13',
    retryable: true,
  });
});

test('Runway: a request becomes a task in its own vocabulary, and its video is read without the secret', async () => {
  const api = runwayApi();
  const runway = new RunwayVideoProvider({ apiKey: 'secret', fetch: api.fetch });
  const manager = new VideoManager({
    providers: { runway },
    pollIntervalMs: 1,
    prices: { 'gen4.5': { perSecond: 0.12 } },
  });
  const result = await manager.resume(await manager.start({ prompt: 'a paper boat', seed: 3 }));
  const [submit] = api.calls;
  assert.equal(submit?.url, 'https://api.dev.runwayml.com/v1/text_to_video');
  assert.equal(submit?.headers.get('authorization'), 'Bearer secret');
  assert.equal(submit?.headers.get('x-runway-version'), '2024-11-06');
  assert.deepEqual(submit?.body, {
    model: 'gen4.5',
    promptText: 'a paper boat',
    duration: 5,
    ratio: '1280:720',
    seed: 3,
  });
  const download = api.calls.find((call) => call.url.startsWith('https://cdn.example/'));
  assert.equal(download?.headers.get('authorization'), null, 'a signed URL is fetched without the API secret');
  assert.equal(result.durationSeconds, 5);
  assert.ok(Math.abs((result.cost?.amount ?? 0) - 0.6) < 1e-9, 'priced at the rate the account sets');

  // An image, on Veo through Runway: image to video, the shape and size as Runway's ratio.
  await manager.resume(
    await manager.start({
      prompt: 'animate it',
      model: 'veo3.1',
      image: png,
      aspectRatio: '9:16',
      resolution: '1080p',
      durationSeconds: 4,
      audio: true,
    }),
  );
  const imageTask = api.calls.find((call) => call.url.endsWith('/v1/image_to_video'));
  assert.deepEqual(imageTask?.body, {
    model: 'veo3.1',
    promptText: 'animate it',
    duration: 4,
    ratio: '1080:1920',
    audio: true,
    promptImage: 'data:image/png;base64,iVBORw==',
  });

  const context = { requestId: 'r', signal: new AbortController().signal, attempt: 1 };
  for (const [code, retryable, safety] of [
    ['SAFETY.INPUT.TEXT', false, true],
    ['INTERNAL.BAD_OUTPUT.CODE01', true, false],
    ['ASSET.INVALID', false, false],
  ] as const) {
    const failing = new RunwayVideoProvider({ apiKey: 'secret', fetch: runwayApi({ failureCode: code }).fetch });
    const ref = await failing.submit({ prompt: 'x', model: 'gen4.5' }, context);
    await failing.poll(ref, context);
    await failing.poll(ref, context);
    const state = await failing.poll(ref, context);
    assert.deepEqual(state.error, { message: 'it did not work', code, retryable, safety }, code);
  }
  await runway.cancel(result.ref, context);
  assert.equal(api.calls.at(-1)?.method, 'DELETE');
});

test('a request a model cannot make is refused before any job is submitted', async () => {
  const mock = new MockVideoProvider();
  const google = new GoogleVideoProvider({ apiKey: 'key', fetch: googleApi().fetch, models: VEO_PREVIEWS });
  const runway = new RunwayVideoProvider({ apiKey: 'secret', fetch: runwayApi().fetch });
  const manager = new VideoManager({ providers: { mock, google, runway } });
  const refused: Array<[string, Parameters<VideoManager['start']>[0], RegExp]> = [
    ['an unknown model', { prompt: 'x', model: 'other' }, /does not take the model "other"/],
    ['a length it does not make', { prompt: 'x', durationSeconds: 5 }, /5-second videos .* it takes 4, 8/],
    ['a shape', { prompt: 'x', aspectRatio: '1:1' }, /aspect ratio "1:1"/],
    ['too many references', { prompt: 'x', references: [png, png, png, png] }, /4 reference images/],
    ['too many videos', { prompt: 'x', count: 3 }, /3 videos/],
    ['an empty prompt', { prompt: '  ' }, /needs a prompt, an image to animate, or a video/],
    ['silence from a model that always speaks', { prompt: 'x', provider: 'google', audio: false }, /silent video/],
    [
      'a 4k Lite video',
      { prompt: 'x', provider: 'google', model: 'veo-3.1-lite-generate-preview', resolution: '4k' },
      /resolution "4k"/,
    ],
    [
      'an image by URL on Veo',
      {
        prompt: 'x',
        provider: 'google',
        image: { location: { kind: 'url', url: 'https://a.example/i.png' }, mimeType: 'image/png' },
      },
      /image as url/,
    ],
    ['a seed on Gemini Omni', { prompt: 'x', provider: 'runway', model: 'gemini_omni_flash_1.1', seed: 1 }, /a seed/],
    ['a last frame on Runway', { prompt: 'x', provider: 'runway', lastFrame: png }, /a last frame/],
    [
      'a video that is not an image',
      { prompt: 'x', image: { ...png, mimeType: 'video/mp4' } },
      /image of type video\/mp4/,
    ],
    [
      'a stored image without a store',
      { prompt: 'x', image: { location: { kind: 'stored', uri: 'memory://a', assetId: 'a' }, mimeType: 'image/png' } },
      /does not hold/,
    ],
    [
      'a provider that does not exist',
      { prompt: 'x', provider: 'nobody' },
      /No video provider is registered as "nobody"/,
    ],
  ];
  for (const [label, request, message] of refused) {
    await assert.rejects(manager.start(request), (error: unknown) => {
      assert.ok(error instanceof VideoError, label);
      assert.match(error.message, message, label);
      return true;
    });
  }
  assert.equal(mock.jobs.size, 0, 'no job was submitted');
  await assert.rejects(new VideoManager().start({ prompt: 'x' }), /No video provider is registered/);
  await assert.rejects(
    new VideoManager({ providers: { mock } }).resume(await manager.start({ prompt: 'x' }), { delivery: 'store' }),
    /needs a store/,
  );
});

test('a generation runs through the lifecycle, streams its video into a store, and is priced per second', async () => {
  const started: Array<{ family: string; operation: string; provider?: string; model?: string }> = [];
  const finished: unknown[] = [];
  const lifecycle: OperationLifecycleLike = {
    async start(operation) {
      started.push({
        family: operation.family,
        operation: operation.operation,
        provider: operation.provider,
        model: operation.model,
      });
      return {
        descriptor: { ...operation, requestId: operation.requestId ?? 'r' } as never,
        context: { requestId: operation.requestId ?? 'r', signal: new AbortController().signal },
        reserve: async () => undefined,
        succeed: async (info) => {
          finished.push(info);
        },
        fail: async () => undefined,
      };
    },
  };
  const store = new FilesystemAssetStore({ directory: path.join(directory, 'videos') });
  const mock = new MockVideoProvider({ bytes: 3 * 1024 * 1024, chunkBytes: 256 * 1024, pollsToComplete: 2 });
  const manager = new VideoManager(
    {
      providers: { mock },
      store,
      tenantId: 'acme',
      ttlSeconds: 3600,
      pollIntervalMs: 1,
      prices: { 'mock-video': { perSecond: { '720p': 0.05, '1080p': 0.1 } } },
    },
    { lifecycle },
  );
  const handle = await manager.generate({
    prompt: 'a lighthouse',
    durationSeconds: 8,
    resolution: '1080p',
    metadata: { campaign: 'autumn' },
  });
  const result = await handle.result();
  assert.deepEqual(started, [{ family: 'video', operation: 'video.generate', provider: 'mock', model: 'mock-video' }]);
  assert.deepEqual(finished, [{ cost: 0.8 }]);
  assert.deepEqual(result.cost, { amount: 0.8, currency: 'USD', basis: 'estimated', output: 0.8 });
  const [stored] = result.videos;
  assert.equal(stored?.location.kind, 'stored');
  assert.equal(stored?.mimeType, 'video/mp4');
  assert.equal(stored?.durationSeconds, 8);
  assert.equal(stored?.provenance.operation, 'generate');
  assert.deepEqual(stored?.provenance.metadata, { kind: 'video', job: result.ref.id, index: 0, campaign: 'autumn' });
  assert.ok(stored?.location.kind === 'stored');
  const assetId = stored.location.assetId;
  const read = await readAssetStream(store, assetId, 'acme', { range: { start: 4, end: 7 } });
  assert.equal(new TextDecoder().decode(await new Response(read?.stream).arrayBuffer()), 'ftyp');
  assert.equal((await store.stat(assetId, 'acme'))?.descriptor.byteLength, 3 * 1024 * 1024);
  assert.ok((await store.stat(assetId, 'acme'))?.expiresAt, 'kept for its ttl');
});

test('a job is started, collected from its ref in another manager, and read, cancelled, and removed by it', async () => {
  const jobs = new Map<string, MockVideoJob>();
  const first = new VideoManager({ providers: { mock: new MockVideoProvider({ jobs }) } });
  const ref = await first.start({ prompt: 'x', count: 2 });
  const elsewhere = new VideoManager({
    providers: { mock: new MockVideoProvider({ jobs }) },
    pollIntervalMs: 1,
    removeFromProvider: true,
  });
  const parsed = JSON.parse(JSON.stringify(ref));
  assert.equal((await elsewhere.status(parsed)).status, 'running');
  const result = await elsewhere.resume(parsed, { delivery: 'bytes' });
  assert.equal(result.videos.length, 2);
  assert.equal(result.durationSeconds, 4, "the model's default length, recorded with the job");
  assert.equal(result.cost, undefined, 'a model without a price is not recorded as free');
  assert.equal(jobs.get(ref.id)?.removed, true, "the provider's copy was deleted once collected");

  const another = await first.start({ prompt: 'y' });
  await elsewhere.cancel(another);
  await assert.rejects(elsewhere.resume(another), (error: unknown) => {
    assert.ok(error instanceof VideoJobFailedError);
    assert.equal(error.state.status, 'cancelled');
    assert.equal(error.retryable, false);
    return true;
  });

  const content = await first.download(
    await first.start({ prompt: 'z' }).then(async (job) => {
      await first.status(job);
      await first.status(job);
      return job;
    }),
  );
  assert.equal(content.mimeType, 'video/mp4');
  const plain = new MockVideoProvider();
  Object.assign(plain, { cancel: undefined });
  await assert.rejects(new VideoManager({ providers: { plain } }).cancel(ref), /cannot cancel/);
});

test('a video returned as bytes is held to maxBytes, and one streamed into a store is not', async () => {
  const mock = new MockVideoProvider({ bytes: 1024 * 1024 });
  const store = new FilesystemAssetStore({ directory: path.join(directory, 'large') });
  const manager = new VideoManager({ providers: { mock }, store, pollIntervalMs: 1, maxBytes: 512 * 1024 });
  await assert.rejects(
    manager.resume(await manager.start({ prompt: 'x' }), { delivery: 'bytes' }),
    (error: unknown) => error instanceof VideoError && error.code === 'VIDEO_TOO_LARGE',
  );
  const result = await (await manager.generate({ prompt: 'x' })).result();
  assert.equal(result.videos[0]?.byteLength, 1024 * 1024, 'streamed whole into the store');
  await assert.rejects(new VideoManager({ providers: { mock } }).generate({ prompt: 'x' }), /give the manager a store/);
  await assert.rejects(manager.generate({ prompt: 'x', delivery: 'bytes' }), /start\(\) and resume\(\)/);
});

test('a failed job is submitted again when that may help, and not when it was refused', async () => {
  let failures = 0;
  const retrying = new MockVideoProvider({
    fail: () => (failures++ === 0 ? { message: 'a fault on our side', code: 'INTERNAL', retryable: true } : undefined),
  });
  const manager = new VideoManager(
    { providers: { retrying }, store: new MemoryAssetStore(), pollIntervalMs: 1 },
    { operations: { retry: { baseDelayMs: 1, maxAttempts: 3 } } },
  );
  const result = await (await manager.generate({ prompt: 'x' })).result();
  assert.equal(result.videos.length, 1);
  assert.equal(retrying.jobs.size, 2, 'the failed job was submitted again');

  const refused = new MockVideoProvider({
    fail: { message: 'the prompt was refused', code: 'SAFETY', retryable: false, safety: true },
  });
  const strict = new VideoManager(
    { providers: { refused }, store: new MemoryAssetStore(), pollIntervalMs: 1 },
    { operations: { retry: { baseDelayMs: 1, maxAttempts: 3 } } },
  );
  await assert.rejects((await strict.generate({ prompt: 'x' })).result(), /ended failed: the prompt was refused/);
  assert.equal(refused.jobs.size, 1, 'a refused job is not submitted again, and not billed again');
});

/** A process's view of a shared store or provider, which stops answering the moment it dies. */
function mortal<T extends object>(
  target: T,
  life: { dead: boolean },
  onCall?: (name: string, args: unknown[]) => void,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (life.dead) throw new Error('the process died');
        onCall?.(String(property), args);
        if (life.dead) throw new Error('the process died');
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

test('proof: a job whose process dies is collected by another worker, submitted once and stored once', async () => {
  for (const point of ['after submitting', 'after storing the video'] as const) {
    const jobs = new Map<string, MockVideoJob>();
    const operations = new MemoryOperationStore<VideoResult>();
    const store = new MemoryAssetStore();
    const life = { dead: false };
    const prices = { 'mock-video': { perSecond: 0.05 } };
    const doomed = new MockVideoProvider({ jobs, pollsToComplete: 2 });
    const dying = new VideoManager(
      {
        providers: {
          mock: mortal(doomed as VideoProvider, life, (name) => {
            // Dies polling its job, which it has recorded.
            if (point === 'after submitting' && name === 'poll' && jobs.size === 1) life.dead = true;
          }),
        },
        store: mortal(store, life),
        pollIntervalMs: 1,
        prices,
      },
      {
        operations: {
          store: mortal(operations as OperationStore<VideoResult>, life, (name, args) => {
            // Dies as it records the result, its video already stored.
            const record = args[0] as { status?: string } | undefined;
            if (point === 'after storing the video' && name === 'update' && record?.status === 'succeeded')
              life.dead = true;
          }),
          leaseMs: 100,
        },
      },
    );
    const handle = await dying.generate({ prompt: 'a lighthouse', durationSeconds: 8 });
    await assert.rejects(handle.result(), /the process died/, point);
    assert.equal(jobs.size, 1, `${point}: one job was submitted`);

    // Another worker, sharing the operation store, the asset store, and the provider, takes it over.
    const survivor = new MockVideoProvider({ jobs, pollsToComplete: 2 });
    const worker = new VideoManager(
      { providers: { mock: survivor }, store, pollIntervalMs: 1, prices },
      { operations: { store: operations, leaseMs: 100 } },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const recovered = await worker.recover();
    assert.equal(recovered.length, 1, `${point}: the generation was taken over`);
    const result = await recovered[0]?.result();
    assert.equal(jobs.size, 1, `${point}: the job was collected, never submitted again`);
    assert.equal(store.snapshot().entries, 1, `${point}: one video stored`);
    assert.equal(survivor.downloads, point === 'after storing the video' ? 0 : 1, `${point}: downloads`);
    assert.equal(result?.videos[0]?.location.kind, 'stored');
    assert.ok(Math.abs((result?.cost?.amount ?? 0) - 0.4) < 1e-9, `${point}: priced at eight seconds`);
    assert.equal((await operations.read(handle.id))?.status, 'succeeded');
  }
});

test('priceVideo prices by frame size, defaults to 720p, and leaves an unknown model unpriced', () => {
  assert.equal(priceVideo('veo-3.1-generate-preview', 8, { resolution: '4k' })?.amount, 4.8);
  assert.ok(Math.abs((priceVideo('veo-3.1-fast-generate-preview', 8)?.amount ?? 0) - 0.8) < 1e-9);
  assert.equal(priceVideo('unknown', 8), undefined);
  assert.equal(
    priceVideo('veo-3.1-lite-generate-preview', 8, { resolution: '4k' }),
    undefined,
    'a size it does not price',
  );
  assert.equal(
    priceVideo('m', 10, { audio: false, prices: { m: { perSecond: 0.2, perSecondSilent: 0.1 } } })?.amount,
    1,
  );
});
