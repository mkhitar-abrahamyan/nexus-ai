/**
 * Video as an input: a video extended or edited through the same contract on every provider.
 *
 * Gemini Omni Flash, on the Interactions API, makes a video and then extends it from its own
 * interaction, with nothing uploaded, and edits a video of the application's own. Veo on Vertex AI
 * extends a video it wrote to Cloud Storage. Runway extends a video one of its tasks made, and Aleph
 * edits one given inline. Each runs as a durable generation, its input kept with the operation, and
 * each request a model cannot make is refused before anything is sent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAssetStream } from '../src/images/asset-support.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { GoogleVideoProvider } from '../src/video/google.js';
import { runVideoConformance, VIDEO_PRICES, VideoManager, type VideoResult } from '../src/video/index.js';
import { MockVideoProvider } from '../src/video/mock.js';
import { RunwayVideoProvider } from '../src/video/runway.js';

const MP4 = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 9, 9, 9, 9]);
const clip = { location: { kind: 'bytes' as const, data: MP4 }, mimeType: 'video/mp4' };
const png = { location: { kind: 'bytes' as const, data: new Uint8Array([137, 80, 78, 71]) }, mimeType: 'image/png' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const VERTEX = 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google';

type Call = { url: string; method: string; headers: Headers; body?: Record<string, unknown> };
const recorder = () => {
  const calls: Call[] = [];
  const record = (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    return call;
  };
  return { calls, record };
};

/**
 * The Interactions API as Gemini Omni Flash answers it: an interaction in the background, in progress
 * on its first read and then done, its video inline, or by a Files API URI when asked.
 */
function interactionsApi(options: { uri?: boolean; fail?: { code: number; message: string; status: string } } = {}) {
  const { calls, record } = recorder();
  const reads = new Map<string, number>();
  const cancelled = new Set<string>();
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = record(input, init);
    const base = 'https://generativelanguage.googleapis.com/v1beta';
    if (call.url === `${base}/files/f1:download?alt=media`) {
      return new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) } });
    }
    if (call.url === `${base}/interactions` && call.method === 'POST') {
      const id = `int-${calls.filter((item) => item.url === `${base}/interactions`).length}`;
      reads.set(id, 0);
      return json({ id, status: 'in_progress', model: call.body?.model });
    }
    const match = /\/interactions\/([^/]+)(\/cancel)?$/.exec(call.url);
    const id = match?.[1];
    if (!id || !reads.has(id)) return json({ error: { message: `no interaction at ${call.url}` } }, 404);
    if (match?.[2]) {
      cancelled.add(id);
      return json({ id, status: 'cancelled' });
    }
    if (call.method === 'DELETE') return json({});
    if (cancelled.has(id)) return json({ id, status: 'cancelled' });
    const count = (reads.get(id) ?? 0) + 1;
    reads.set(id, count);
    if (count === 1) return json({ id, status: 'in_progress' });
    if (options.fail) {
      return json({ id, status: 'failed', steps: [{ type: 'model_output', error: options.fail }] });
    }
    const video = options.uri
      ? { type: 'video', mime_type: 'video/mp4', uri: `${base}/files/f1:download?alt=media` }
      : { type: 'video', mime_type: 'video/mp4', data: Buffer.from(MP4).toString('base64') };
    return json({
      id,
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] },
        { type: 'model_output', content: [video] },
      ],
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Veo on Vertex AI, writing each video to Cloud Storage: an operation done on its second read. */
function vertexApi() {
  const { calls, record } = recorder();
  const reads = new Map<string, number>();
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = record(input, init);
    if (call.url.startsWith('https://storage.googleapis.com/'))
      return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
    if (call.url.endsWith(':predictLongRunning')) {
      const name = `projects/p/locations/l/operations/op-${calls.filter((item) => item.url.endsWith(':predictLongRunning')).length}`;
      reads.set(name, 0);
      return json({ name });
    }
    if (call.url.endsWith(':fetchPredictOperation')) {
      const name = String(call.body?.operationName);
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      if (count === 1) return json({ name, done: false });
      return json({
        name,
        done: true,
        response: { videos: [{ gcsUri: `gs://clips/out/${name.split('/').pop()}.mp4`, mimeType: 'video/mp4' }] },
      });
    }
    return json({ error: { message: `no route for ${call.url}` } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Runway's task API, video to video included: a task done on its second read, its video at a signed URL. */
function runwayApi() {
  const { calls, record } = recorder();
  const reads = new Map<string, number>();
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = record(input, init);
    if (call.url.startsWith('https://cdn.example/'))
      return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
    const route = call.url.replace('https://api.dev.runwayml.com', '');
    if (['/v1/text_to_video', '/v1/image_to_video', '/v1/video_to_video'].includes(route)) {
      const id = `task-${reads.size + 1}`;
      reads.set(id, 0);
      return json({ id });
    }
    const id = /\/v1\/tasks\/([^/]+)$/.exec(route)?.[1];
    if (id && reads.has(id)) {
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      if (count === 1) return json({ id, status: 'RUNNING', progress: 0.5 });
      return json({ id, status: 'SUCCEEDED', output: [`https://cdn.example/${id}.mp4?signature=s`] });
    }
    return json({ error: `no route for ${call.url}` }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** The bytes of a stored video. */
async function bytesOf(store: MemoryAssetStore, result: VideoResult): Promise<Uint8Array> {
  const asset = result.videos[0];
  assert.ok(asset?.location.kind === 'stored', 'the video is stored');
  const read = await readAssetStream(store, asset.location.assetId, 'default');
  return new Uint8Array(await new Response(read?.stream).arrayBuffer());
}

test('proof: a video extended from its own job and a video of the application’s edited, on every provider', async () => {
  const omniApi = interactionsApi();
  const veoApi = vertexApi();
  const runway = runwayApi();
  const store = new MemoryAssetStore();
  const operations = new MemoryOperationStore<VideoResult>();
  const manager = new VideoManager(
    {
      providers: {
        omni: new GoogleVideoProvider({ apiKey: 'key', fetch: omniApi.fetch }),
        veo: new GoogleVideoProvider({
          accessToken: 'token',
          baseUrl: VERTEX,
          storageUri: 'gs://clips/out',
          fetch: veoApi.fetch,
        }),
        runway: new RunwayVideoProvider({ apiKey: 'secret', fetch: runway.fetch }),
      },
      store,
      pollIntervalMs: 1,
    },
    { operations: { store: operations } },
  );
  const generate = async (request: Parameters<VideoManager['generate']>[0]) =>
    (await manager.generate(request)).result();

  // Gemini Omni Flash: made, then extended from its own interaction, then an uploaded video edited.
  const made = await generate({ provider: 'omni', prompt: 'A marble rolling down a track', durationSeconds: 6 });
  assert.equal(made.ref.model, 'gemini-omni-1.1-flash', 'Omni is the Gemini API’s default');
  assert.deepEqual(await bytesOf(store, made), MP4);
  const extended = await generate({
    provider: 'omni',
    prompt: 'The marble lands in a cup',
    video: { mode: 'extend', from: { ref: made.ref } },
    durationSeconds: 4,
  });
  const created = () => omniApi.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/interactions'));
  assert.deepEqual(created()[0]?.body, {
    model: 'gemini-omni-1.1-flash',
    input: 'A marble rolling down a track',
    response_format: { type: 'video', duration: '6s' },
    background: true,
    store: true,
  });
  assert.deepEqual(created()[1]?.body, {
    model: 'gemini-omni-1.1-flash',
    input: 'The marble lands in a cup',
    response_format: { type: 'video', duration: '4s' },
    background: true,
    store: true,
    previous_interaction_id: made.ref.id,
    generation_config: { video_config: { task: 'extend' } },
  });
  assert.equal(extended.videos.length, 1);
  await generate({ provider: 'omni', prompt: 'Make the sky purple', video: { mode: 'edit', input: clip } });
  assert.deepEqual(created()[2]?.body?.input, [
    { type: 'video', data: Buffer.from(MP4).toString('base64'), mime_type: 'video/mp4' },
    { type: 'text', text: 'Make the sky purple' },
  ]);
  assert.deepEqual(created()[2]?.body?.generation_config, { video_config: { task: 'edit' } });
  assert.ok(
    omniApi.calls.every((call) => call.headers.get('x-goog-api-key') === 'key'),
    'every call with the key',
  );
  // The finished interaction is read once to settle it and not again to download it.
  const reads = omniApi.calls.filter(
    (call) => call.method === 'GET' && call.url.endsWith(`/interactions/${made.ref.id}`),
  );
  assert.equal(reads.length, 2, 'in progress, then done; the download reads what the poll kept');
  assert.ok(Math.abs((made.cost?.amount ?? 0) - 6 * 0.10136) < 1e-9, 'priced by its output tokens per second');

  // Veo on Vertex: made into Cloud Storage, then extended from what it wrote there.
  const veoMade = await generate({ provider: 'veo', prompt: 'A lighthouse at dusk' });
  assert.equal(veoMade.ref.model, 'veo-3.1-generate-001', 'GA Veo is Vertex’s default');
  await generate({
    provider: 'veo',
    prompt: 'The light turns on',
    video: { mode: 'extend', from: { ref: veoMade.ref } },
    durationSeconds: 7,
  });
  // The nth prediction Veo was asked for: its instance, and its parameters.
  const prediction = (index: number) => {
    const body = veoApi.calls.filter((call) => call.url.endsWith(':predictLongRunning'))[index]?.body;
    return {
      instance: (body?.instances as Array<Record<string, unknown>> | undefined)?.[0],
      parameters: body?.parameters as Record<string, unknown> | undefined,
    };
  };
  assert.deepEqual(prediction(1).instance?.video, { gcsUri: 'gs://clips/out/op-1.mp4', mimeType: 'video/mp4' });
  assert.equal(prediction(1).parameters?.durationSeconds, 7);
  // A video of its own in Cloud Storage, by its gs:// URL.
  await generate({
    provider: 'veo',
    prompt: 'The tide comes in',
    video: { mode: 'extend', input: { location: { kind: 'url', url: 'gs://mine/beach.mp4' }, mimeType: 'video/mp4' } },
  });
  assert.deepEqual(prediction(2).instance?.video, { gcsUri: 'gs://mine/beach.mp4', mimeType: 'video/mp4' });

  // Runway: Omni extends a task's video by its signed URL; Aleph edits one given inline.
  const first = await generate({ provider: 'runway', model: 'gemini_omni_flash_1.1', prompt: 'A kite in the wind' });
  await generate({
    provider: 'runway',
    model: 'gemini_omni_flash_1.1',
    prompt: 'The kite climbs into the clouds',
    video: { mode: 'extend', from: { ref: first.ref } },
    durationSeconds: 5,
  });
  await generate({
    provider: 'runway',
    model: 'aleph2',
    prompt: 'Make it winter',
    video: { mode: 'edit', input: clip },
  });
  const tasks = runway.calls.filter((call) => call.url.endsWith('/v1/video_to_video'));
  assert.deepEqual(tasks[0]?.body, {
    model: 'gemini_omni_flash_1.1',
    videoUri: `https://cdn.example/${first.ref.id}.mp4?signature=s`,
    promptText: 'The kite climbs into the clouds',
    mode: 'extend',
    duration: 5,
  });
  assert.deepEqual(tasks[1]?.body, {
    model: 'aleph2',
    videoUri: `data:video/mp4;base64,${Buffer.from(MP4).toString('base64')}`,
    promptText: 'Make it winter',
  });

  // Every generation was a durable operation, its video input kept with it as JSON.
  const records = operations.list();
  assert.equal(records.length, 9);
  assert.ok(
    records.every((record) => record.status === 'succeeded'),
    'every generation succeeded',
  );
  assert.equal(store.snapshot().entries, 9, 'nine videos stored');
});

test('a video a model cannot work from is refused before anything is sent', async () => {
  const omniApi = interactionsApi();
  const runway = runwayApi();
  const veoApi = vertexApi();
  const providers = {
    omni: new GoogleVideoProvider({ apiKey: 'key', fetch: omniApi.fetch }),
    veo: new GoogleVideoProvider({ accessToken: 'token', baseUrl: VERTEX, fetch: veoApi.fetch }),
    runway: new RunwayVideoProvider({ apiKey: 'secret', fetch: runway.fetch }),
    mock: new MockVideoProvider(),
  };
  const manager = new VideoManager({ providers, pollIntervalMs: 1 });
  const omniRef = {
    provider: 'google',
    id: 'int-9',
    model: 'gemini-omni-1.1-flash',
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const runwayRef = { provider: 'runway', id: 'task-9', model: 'gen4.5', createdAt: '2026-10-20T00:00:00.000Z' };
  const big = {
    location: { kind: 'bytes' as const, data: new Uint8Array(5 * 1024 * 1024 + 1) },
    mimeType: 'video/mp4',
  };
  const refused: Array<[string, Parameters<VideoManager['start']>[0], RegExp]> = [
    [
      'extending on a model that does not',
      { provider: 'runway', prompt: 'x', video: { mode: 'extend', input: clip } },
      /extending a video with "gen4.5"/,
    ],
    [
      'editing on Veo',
      { provider: 'veo', prompt: 'x', video: { mode: 'edit', input: clip } },
      /editing a video with "veo-3.1-generate-001"/,
    ],
    [
      'a job of another provider',
      { provider: 'omni', prompt: 'x', video: { mode: 'extend', from: { ref: runwayRef } } },
      /names a job of "runway"/,
    ],
    [
      'an input and a job',
      { provider: 'omni', prompt: 'x', video: { mode: 'extend', input: clip, from: { ref: omniRef } } },
      /an input or a job .* not both/,
    ],
    ['neither', { provider: 'omni', prompt: 'x', video: { mode: 'extend' } }, /an input or a job/],
    [
      'a mode it does not know',
      { provider: 'mock', prompt: 'x', video: { mode: 'loop' as 'edit', input: clip } },
      /mode must be/,
    ],
    [
      'continuing without Cloud Storage',
      { provider: 'veo', prompt: 'x', video: { mode: 'extend', from: { ref: omniRef } } },
      /continuing a job/,
    ],
    [
      'eight seconds added by Veo',
      { provider: 'veo', prompt: 'x', video: { mode: 'extend', input: clip }, durationSeconds: 8 },
      /8 seconds added .* it takes 7/,
    ],
    [
      'Aleph with nothing to edit',
      { provider: 'runway', model: 'aleph2', prompt: 'x' },
      /"aleph2" needs edit in every request/,
    ],
    [
      'an image as the video',
      { provider: 'omni', prompt: 'x', video: { mode: 'edit', input: png } },
      /video.input of type image\/png/,
    ],
    [
      'a negative index',
      { provider: 'omni', prompt: 'x', video: { mode: 'extend', from: { ref: omniRef, index: -1 } } },
      /whole number from 0/,
    ],
  ];
  for (const [name, request, pattern] of refused) {
    await assert.rejects(manager.start(request), pattern, name);
  }
  // The provider refuses what only it can see: Veo's input not in Cloud Storage, Runway's too large inline.
  await assert.rejects(
    manager.start({ provider: 'veo', prompt: 'x', video: { mode: 'extend', input: clip } }),
    /extends a video in Cloud Storage: give it as a gs:\/\/ URL/,
  );
  await assert.rejects(
    manager.start({ provider: 'runway', model: 'aleph2', prompt: 'x', video: { mode: 'edit', input: big } }),
    /inline up to 5 MB/,
  );
  const sent = [...omniApi.calls, ...runway.calls, ...veoApi.calls].filter((call) => call.method === 'POST');
  assert.deepEqual(sent, [], 'nothing was submitted');
});

test('Gemini Omni Flash: a failed, a cancelled, and a removed interaction, and a video by URI', async () => {
  const context = { requestId: 'r', signal: new AbortController().signal, attempt: 1 };
  const failing = new GoogleVideoProvider({
    apiKey: 'key',
    fetch: interactionsApi({
      fail: { code: 3, message: 'The prompt was blocked for safety', status: 'INVALID_ARGUMENT' },
    }).fetch,
  });
  const ref = await failing.submit({ prompt: 'x', model: 'gemini-omni-1.1-flash' }, context);
  assert.equal((await failing.poll(ref, context)).status, 'running');
  const failed = await failing.poll(ref, context);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, {
    message: 'The prompt was blocked for safety',
    code: 'INVALID_ARGUMENT',
    retryable: false,
    safety: true,
  });

  const api = interactionsApi({ uri: true });
  const omni = new GoogleVideoProvider({ apiKey: 'key', fetch: api.fetch });
  assert.equal(omni.info.capabilities.supportsCancel, true);
  const running = await omni.submit({ prompt: 'x', model: 'gemini-omni-1.1-flash' }, context);
  await omni.cancel(running, context);
  assert.equal((await omni.poll(running, context)).status, 'cancelled');
  assert.ok(
    api.calls.some((call) => call.method === 'POST' && call.url.endsWith(`/interactions/${running.id}/cancel`)),
  );

  const done = await omni.submit(
    { prompt: 'x', model: 'gemini-omni-1.1-flash', aspectRatio: '9:16', resolution: '1080p' },
    context,
  );
  assert.deepEqual(api.calls.at(-1)?.body?.response_format, {
    type: 'video',
    aspect_ratio: '9:16',
    resolution: '1080p',
  });
  await omni.poll(done, context);
  const completed = await omni.poll(done, context);
  assert.equal(completed.status, 'completed');
  assert.match(JSON.stringify(completed.raw), /files\/f1:download/, 'the URI is kept as it is');
  // A video returned inline is not kept in the raw state, which an operation may store.
  const inline = new GoogleVideoProvider({ apiKey: 'key', fetch: interactionsApi().fetch });
  const held = await inline.submit({ prompt: 'x', model: 'gemini-omni-1.1-flash' }, context);
  await inline.poll(held, context);
  const settled = JSON.stringify((await inline.poll(held, context)).raw);
  assert.ok(!settled.includes(Buffer.from(MP4).toString('base64')), 'no video bytes in the raw state');
  assert.match(settled, /\(omitted\)/);
  assert.equal((await inline.download(held, 0, context)).byteLength, MP4.byteLength, 'the bytes are still downloaded');
  const content = await omni.download(done, 0, context);
  assert.equal(content.byteLength, MP4.byteLength);
  const download = api.calls.at(-1);
  assert.equal(download?.url, 'https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media');
  assert.equal(download?.headers.get('x-goog-api-key'), 'key', 'a Files API URI is read with the key');
  await omni.remove(done, context);
  assert.equal(api.calls.at(-1)?.method, 'DELETE');
  await assert.rejects(omni.download(done, 1, context), /has no video 1/);

  // An Omni ref of 2.16, with no metadata, is still read as an interaction by its model.
  const { metadata: _metadata, ...older } = done;
  assert.equal((await omni.poll(older, context)).status, 'completed');
});

test('the conformance suite checks extending and editing, and continuing a job, where a model takes them', async () => {
  const mock = new MockVideoProvider();
  const report = await runVideoConformance(mock, { pollIntervalMs: 1, video: { mode: 'extend', input: clip } });
  assert.deepEqual(report.failures, []);
  assert.ok(report.passed.includes('extend a video'));
  assert.ok(report.passed.includes('extend its own job'));
  const omni = new GoogleVideoProvider({ apiKey: 'key', fetch: interactionsApi().fetch });
  const omniReport = await runVideoConformance(omni, {
    pollIntervalMs: 1,
    video: { mode: 'edit', input: clip },
    checkCancel: true,
  });
  assert.deepEqual(omniReport.failures, []);
  assert.ok(omniReport.passed.includes('edit a video'));
  // A model that continues jobs but takes no video is incoherent.
  const incoherent = new MockVideoProvider({ capabilities: { inputs: ['image'], continuesJobs: true } });
  const bad = await runVideoConformance(incoherent, { pollIntervalMs: 1 });
  assert.match(bad.failures.join(), /continues jobs, but takes no video/);
  assert.equal(VIDEO_PRICES['gemini-omni-1.1-flash'] !== undefined, true);
});
