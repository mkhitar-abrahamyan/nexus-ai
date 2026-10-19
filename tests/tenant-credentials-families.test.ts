/**
 * Credentials per tenant in every family: realtime, telephony, video, voice, media understanding, and
 * batches, as completions, embeddings, and images have had since 2.13.
 *
 * Each family runs through one lifecycle whose resolver reads `acme/<provider>` from a secret
 * manager, against a stand-in for its provider's API that records the key each request carried.
 * Every call of acme's, and every later call on a job or batch acme started, by its ref, after a
 * restart, carries acme's key; a call with no tenant carries the configured one; a key a provider
 * quotes back in an error is found nowhere in what reaches the caller.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicBatchProvider } from '../src/batch/anthropic.js';
import { BatchManager } from '../src/batch/manager.js';
import { OpenAIBatchProvider } from '../src/batch/openai.js';
import { OperationLifecycle } from '../src/core/lifecycle.js';
import { memorySecrets, tenantCredentials } from '../src/credentials/index.js';
import { EmbeddingBatchManager } from '../src/embeddings/batch.js';
import { GoogleEmbeddingBatchProvider } from '../src/embeddings/batch-google.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { MediaManager, modelMediaProvider } from '../src/media/index.js';
import { MistralOcrProvider } from '../src/media/mistral.js';
import { GeminiLiveTransport } from '../src/realtime/gemini-live.transport.js';
import { OpenAIWebSocketTransport } from '../src/realtime/openai-websocket.transport.js';
import { RealtimeSession } from '../src/realtime/session.js';
import { residency } from '../src/residency/index.js';
import { TelephonyManager } from '../src/telephony/manager.js';
import { TelnyxTelephonyProvider } from '../src/telephony/providers/telnyx.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';
import type { BatchJobRef } from '../src/types/batch.js';
import type { LifecycleConfig } from '../src/types/lifecycle.js';
import { GoogleVideoProvider } from '../src/video/google.js';
import { VideoManager } from '../src/video/index.js';
import { RunwayVideoProvider } from '../src/video/runway.js';
import { VoiceManager } from '../src/voice/manager.js';
import { OpenAIVoiceProvider } from '../src/voice/providers/openai.js';

const secrets = () =>
  memorySecrets({
    'acme/runway': 'rw-acme',
    'acme/google': 'g-acme',
    'acme/mistral-ocr': 'ms-acme',
    'acme/anthropic': 'an-acme',
    'acme/openai': 'oa-acme',
    'acme/twilio': 'ACacme:tw-acme',
    'acme/telnyx': 'tx-acme',
  });

function lifecycle(extra: Partial<LifecycleConfig> = {}) {
  return new OperationLifecycle({
    config: { credentials: tenantCredentials({ secrets: secrets(), missing: 'config' }), ...extra },
  });
}

/** One provider's stand-in API: what each request carried, and a route table for its answers. */
function api(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; key: string }> = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const key =
      headers.get('x-goog-api-key') ??
      headers.get('x-api-key') ??
      headers.get('authorization')?.replace(/^(Bearer|Basic) /, '') ??
      '';
    seen.push({ url, key });
    return route(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, seen, keys: () => seen.map((call) => call.key) };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const basic = (value: string) => Buffer.from(value, 'base64').toString();
/** An error's message and every cause's, as anything that records it would read them. */
const chain = (error: unknown): string =>
  error instanceof Error ? `${error.message} | ${chain((error as { cause?: unknown }).cause)}` : String(error ?? '');

test('video: a job a tenant starts carries its key through every later call on its ref, durable or not', async () => {
  let polls = 0;
  const runway = api((url, init) => {
    if (url.endsWith('/v1/text_to_video')) return json({ id: 'task-1' });
    if (url.startsWith('https://cdn.example/')) return new Response(new Uint8Array([0, 0, 0, 24]));
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    polls += 1;
    return json(
      polls < 2
        ? { id: 'task-1', status: 'RUNNING' }
        : { id: 'task-1', status: 'SUCCEEDED', output: ['https://cdn.example/1.mp4'] },
    );
  });
  const manager = new VideoManager(
    {
      providers: { runway: new RunwayVideoProvider({ apiKey: 'rw-shared', fetch: runway.fetch }) },
      store: new MemoryAssetStore(),
      pollIntervalMs: 1,
    },
    { lifecycle: lifecycle() },
  );

  // Started for acme, its ref records the tenant: status, cancel, and resume, from any process, use acme's key.
  const ref = await manager.start({ prompt: 'a lighthouse', model: 'gen4.5', tenantId: 'acme' });
  assert.equal((ref.metadata?.video as { tenant?: string } | undefined)?.tenant, 'acme');
  const restarted = new VideoManager(
    { providers: { runway: new RunwayVideoProvider({ apiKey: 'rw-shared', fetch: runway.fetch }) }, pollIntervalMs: 1 },
    { lifecycle: lifecycle() },
  );
  await restarted.status(JSON.parse(JSON.stringify(ref)));
  await restarted.cancel(ref);
  await restarted.resume(ref, { delivery: 'bytes' });
  // A durable generation runs as acme's operation.
  polls = 0;
  const handle = await manager.generate({ prompt: 'a harbor', model: 'gen4.5', tenantId: 'acme' });
  await handle.result();
  const api_ = runway.seen.filter((call) => !call.url.startsWith('https://cdn.example/'));
  assert.ok(api_.length >= 7, `every call recorded: ${api_.length}`);
  assert.deepEqual([...new Set(api_.map((call) => call.key))], ['rw-acme'], 'acme’s key on every API call');

  // With no tenant, the configured key.
  await manager.start({ prompt: 'a field', model: 'gen4.5' });
  assert.equal(runway.seen.at(-1)?.key, 'rw-shared');
});

test('video: Google sends the tenant’s key in place of the configured key or token', async () => {
  const google = api((url) =>
    url.includes(':predictLongRunning')
      ? json({ name: 'models/veo/operations/1' })
      : json({ name: 'models/veo/operations/1', done: false }),
  );
  const manager = new VideoManager(
    { providers: { veo: new GoogleVideoProvider({ accessToken: 'ya29.shared', fetch: google.fetch }) } },
    { lifecycle: lifecycle() },
  );
  const ref = await manager.start({ prompt: 'a lighthouse', model: 'veo-3.1-generate-preview', tenantId: 'acme' });
  await manager.status(ref);
  assert.deepEqual(google.keys(), ['g-acme', 'g-acme']);
  await manager.start({ prompt: 'a field', model: 'veo-3.1-generate-preview' });
  assert.equal(google.keys().at(-1), 'ya29.shared', 'the configured token without a tenant');
});

test('a continued call is held to the tenant’s regions and cleaned of its key', async () => {
  const runway = api((url) =>
    url.endsWith('/v1/text_to_video') ? json({ id: 'task-9' }) : json({ error: 'key rw-acme is suspended' }, 401),
  );
  const regions = residency({
    regions: { 'eu-west': { providers: ['mistral'] }, 'us-east': { providers: ['runway-us'] } },
    tenants: { acme: 'us-east', globex: 'eu-west' },
  });
  const manager = new VideoManager(
    { providers: { 'runway-us': new RunwayVideoProvider({ apiKey: 'rw-shared', fetch: runway.fetch }) } },
    { lifecycle: lifecycle({ residency: regions }) },
  );
  await assert.rejects(
    manager.start({ prompt: 'x', model: 'gen4.5', tenantId: 'globex' }),
    /provider runway-us runs in us-east, outside the regions tenant globex may reach/,
  );
  assert.equal(runway.seen.length, 0, 'nothing sent for a tenant outside the region');
  const ref = await manager.start({ prompt: 'x', model: 'gen4.5', tenantId: 'acme' });
  assert.equal(ref.provider, 'runway', 'the ref names the adapter; its registered name is found');
  await assert.rejects(manager.status(ref), (error: unknown) => {
    const text = `${(error as Error).message} ${(error as Error).stack} ${JSON.stringify(error)}`;
    assert.ok(!text.includes('rw-acme'), `the key is cleaned: ${(error as Error).message}`);
    assert.match((error as Error).message, /\[redacted\]/);
    return true;
  });
});

test('media understanding: an OCR call carries the tenant’s key', async () => {
  const mistral = api(() => json({ pages: [{ index: 0, markdown: 'hello' }], model: 'mistral-ocr-latest' }));
  const manager = new MediaManager(
    { providers: { ocr: new MistralOcrProvider({ apiKey: 'ms-shared', fetch: mistral.fetch }) } },
    { lifecycle: lifecycle() },
  );
  const media = {
    type: 'document' as const,
    source: { url: 'https://docs.example/a.pdf' },
    mimeType: 'application/pdf',
  };
  assert.equal((await manager.read({ media: media as never, tenantId: 'acme' })).text, 'hello');
  await manager.read({ media: media as never });
  assert.deepEqual(mistral.keys(), ['ms-acme', 'ms-shared']);

  const asked: Array<string | undefined> = [];
  const vision = modelMediaProvider(
    {
      complete: async (request) => {
        asked.push(request.tenantId);
        return { content: '{"pages":[{"index":0,"text":"hi"}]}', role: 'assistant', meta: {} } as never;
      },
    },
    { model: 'gpt-5' },
  );
  const viaModel = new MediaManager({ providers: { vision } }, { lifecycle: lifecycle() });
  await viaModel.read({ media: media as never, tenantId: 'acme' });
  assert.deepEqual(asked, ['acme']);
});

test('batches: a batch runs, and is looked at later by its ref, on the tenant’s key', async () => {
  const anthropic = api((url) => {
    if (url.endsWith('/results')) return new Response('');
    return json({ id: 'msgbatch-1', processing_status: 'ended', request_counts: { succeeded: 0, errored: 0 } });
  });
  const manager = new BatchManager(
    {
      providers: {
        anthropic: new AnthropicBatchProvider({
          apiKey: 'an-shared',
          fetch: anthropic.fetch,
          defaultModel: 'claude-sonnet-5-5',
        }),
      },
    },
    { lifecycle: lifecycle() },
  );
  const handle = await manager.submit({
    items: [{ customId: 'a', request: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] } }],
    tenantId: 'acme',
  });
  const result = await handle.result();
  const ref = (result as { ref: BatchJobRef }).ref;
  assert.deepEqual(ref.metadata?.batch, { tenantId: 'acme' }, 'its ref records the tenant');
  await manager.status(ref);
  await manager.cancel(ref);
  // A ref made before refs recorded a tenant is resumed as the one named.
  await manager.resume({ id: 'msgbatch-1', provider: 'anthropic' }, { tenantId: 'acme' });
  assert.deepEqual([...new Set(anthropic.keys())], ['an-acme']);
  await manager.status({ id: 'msgbatch-1', provider: 'anthropic' });
  assert.equal(anthropic.keys().at(-1), 'an-shared');

  const openai = api(() =>
    json({ id: 'batch_1', status: 'in_progress', request_counts: { total: 1, completed: 0, failed: 0 } }),
  );
  const openaiBatches = new BatchManager(
    { providers: { openai: new OpenAIBatchProvider({ apiKey: 'oa-shared', fetch: openai.fetch }) } },
    { lifecycle: lifecycle() },
  );
  await openaiBatches.status({ id: 'batch_1', provider: 'openai', metadata: { batch: { tenantId: 'acme' } } });
  assert.deepEqual(openai.keys(), ['oa-acme']);

  // An embedding batch tier the same way.
  let finished = false;
  const google = api((url) =>
    url.includes(':asyncBatchEmbedContent')
      ? json({ name: 'batches/1' })
      : json(
          finished
            ? {
                name: 'batches/1',
                state: 'BATCH_STATE_SUCCEEDED',
                output: {
                  inlinedEmbedContentResponses: { inlinedResponses: [{ response: { embedding: { values: [1, 0] } } }] },
                },
              }
            : { name: 'batches/1', state: 'BATCH_STATE_RUNNING' },
        ),
  );
  const embeddings = new EmbeddingBatchManager(
    { providers: { google: new GoogleEmbeddingBatchProvider({ apiKey: 'g-shared', fetch: google.fetch }) } },
    { lifecycle: lifecycle() },
  );
  const started = await embeddings.start({
    items: [{ customId: 'a', input: 'hello' }],
    model: 'gemini-embedding-001',
    tenantId: 'acme',
  });
  await embeddings.status(started);
  assert.deepEqual(google.keys(), ['g-acme', 'g-acme']);
  // A durable embedding batch runs as the tenant's operation.
  finished = true;
  const durable = await embeddings.submit({
    items: [{ customId: 'a', input: 'hello' }],
    model: 'gemini-embedding-001',
    tenantId: 'acme',
  });
  await durable.result();
  assert.deepEqual([...new Set(google.keys())], ['g-acme']);
});

test('voice: speech and transcription carry the tenant’s key', async () => {
  const openai = api((url) =>
    url.endsWith('/audio/speech')
      ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })
      : json({ text: 'hi' }),
  );
  const voice = new VoiceManager(
    { providers: { openai: new OpenAIVoiceProvider({ apiKey: 'oa-shared', fetch: openai.fetch }) } },
    { lifecycle: lifecycle() },
  );
  await voice.speak({ text: 'hello', tenantId: 'acme' });
  await voice.transcribe({ audio: { buffer: new Uint8Array([1, 2]), mimeType: 'audio/wav' }, tenantId: 'acme' });
  await voice.speak({ text: 'hello' });
  assert.deepEqual(openai.keys(), ['oa-acme', 'oa-acme', 'oa-shared']);
});

test('telephony: a tenant’s calls and messages go out on its own account', async () => {
  const twilio = api((url) =>
    url.endsWith('/Messages.json')
      ? json({ sid: 'SM1', status: 'queued', from: '+15550001', to: '+15550002' }, 201)
      : json({ sid: 'CA1', status: 'queued' }, 201),
  );
  const telnyx = api(() => json({ data: { call_control_id: 'v3:1', is_alive: true } }));
  const telephony = new TelephonyManager(
    {
      providers: {
        twilio: new TwilioTelephonyProvider({ accountSid: 'ACshared', authToken: 'tw-shared', fetch: twilio.fetch }),
        telnyx: new TelnyxTelephonyProvider({ apiKey: 'tx-shared', fetch: telnyx.fetch }),
      },
      defaultProvider: 'twilio',
    },
    { lifecycle: lifecycle() },
  );
  await telephony.createCall({
    to: '+15550002',
    from: '+15550001',
    webhookUrl: 'https://app.example/voice',
    tenantId: 'acme',
  });
  await telephony.sendMessage({ to: '+15550002', from: '+15550001', body: 'hi', tenantId: 'acme' });
  await telephony.createCall({ to: '+15550002', from: '+15550001', webhookUrl: 'https://app.example/voice' });
  assert.deepEqual(
    twilio.seen.map((call) => [new URL(call.url).pathname.split('/')[3], basic(call.key)]),
    [
      ['ACacme', 'ACacme:tw-acme'],
      ['ACacme', 'ACacme:tw-acme'],
      ['ACshared', 'ACshared:tw-shared'],
    ],
    'the subaccount in the path and in the credentials',
  );
  await telephony.getCall({ provider: 'telnyx', callId: 'v3:1', tenantId: 'acme' });
  await telephony.endCall({ provider: 'telnyx', callId: 'v3:1', tenantId: 'acme' });
  assert.deepEqual(telnyx.keys(), ['tx-acme', 'tx-acme']);
});

test('realtime: a session connects with the tenant’s key, and a SIP call with its project’s', async () => {
  const connected: Array<{ url: string; headers: Record<string, string> }> = [];
  const refuse = (url: string, options: { headers: Record<string, string> }) => {
    connected.push({ url, headers: options.headers });
    throw new Error(`refused ${url} with ${options.headers.authorization ?? ''}`);
  };
  const health: string[] = [];
  const watched = lifecycle();
  const session = new RealtimeSession({
    model: 'gpt-realtime',
    transport: new OpenAIWebSocketTransport({ apiKey: 'oa-shared', webSocketFactory: refuse }),
    lifecycle: Object.assign(watched, {
      reportHealth: (_provider: string, outcome: { error?: unknown }) => void health.push(chain(outcome.error)),
    }),
    tenantId: 'acme',
    reconnect: { maxAttempts: 1 },
  });
  const events: string[] = [];
  session.on('error', (error) => void events.push(chain(error)));
  await assert.rejects(session.connect(), (error: unknown) => {
    assert.ok(!String((error as Error).message).includes('oa-acme'), 'the key is cleaned from the error');
    return true;
  });
  assert.ok(events.length > 0 && health.length > 0, 'the error was reported');
  for (const message of [...events, ...health])
    assert.ok(!message.includes('oa-acme'), `cleaned before it was reported: ${message}`);
  assert.equal(connected[0]?.headers.authorization, 'Bearer oa-acme');

  const gemini = new RealtimeSession({
    model: 'gpt-realtime',
    provider: 'google',
    transport: new GeminiLiveTransport({ apiKey: 'g-shared', webSocketFactory: refuse as never }),
    lifecycle: lifecycle(),
    tenantId: 'acme',
  });
  await assert.rejects(gemini.connect(), (error: unknown) => {
    assert.ok(!String((error as Error).message).includes('g-acme'), 'the key in the URL is cleaned too');
    return true;
  });
  assert.equal(new URL(connected[1]?.url ?? '').searchParams.get('key'), 'g-acme');

  // A transport that throws without reporting the error itself: the session cleans it before it reports it.
  const silentHealth: string[] = [];
  const silentEvents: string[] = [];
  const silent = new RealtimeSession({
    model: 'gpt-realtime',
    transport: {
      kind: 'websocket',
      async connect(config) {
        const credential = await config.credential?.();
        throw new Error(`refused with ${credential?.apiKey}`);
      },
      sendAudio: () => undefined,
      sendEvent: () => undefined,
      interrupt: () => undefined,
      disconnect: async () => undefined,
      on: () => () => undefined,
    },
    lifecycle: Object.assign(lifecycle(), {
      reportHealth: (_provider: string, outcome: { error?: unknown }) => void silentHealth.push(chain(outcome.error)),
    }),
    tenantId: 'acme',
  });
  silent.on('error', (error) => void silentEvents.push(chain(error)));
  await assert.rejects(silent.connect());
  assert.ok(silentEvents.length > 0 && silentHealth.length > 0, 'the error was reported');
  for (const message of [...silentEvents, ...silentHealth]) {
    assert.ok(!message.includes('oa-acme'), `cleaned before it was reported: ${message}`);
  }

  // A connection that drops, and whose reconnect is refused: the reconnect's error is cleaned too.
  const handlers: Record<string, (event: never) => void> = {};
  let attempts = 0;
  const dropping = new RealtimeSession({
    model: 'gpt-realtime',
    transport: {
      kind: 'websocket',
      async connect(config) {
        attempts += 1;
        if (attempts === 1) return;
        const credential = await config.credential?.();
        throw new Error(`refused with ${credential?.apiKey}`);
      },
      sendAudio: () => undefined,
      sendEvent: () => undefined,
      interrupt: () => undefined,
      disconnect: async () => undefined,
      on: (event, handler) => {
        handlers[event] = handler as (event: never) => void;
        return () => undefined;
      },
    },
    lifecycle: lifecycle(),
    tenantId: 'acme',
    reconnect: { enabled: true, maxAttempts: 1, initialDelayMs: 0 },
  });
  const reconnectFailed = new Promise<string>((resolve) => dropping.on('error', (error) => resolve(chain(error))));
  await dropping.connect();
  handlers.disconnected?.({ reason: 'dropped', expected: false } as never);
  const reported = await reconnectFailed;
  assert.match(reported, /refused with/, 'the reconnect’s error, with its cause');
  assert.ok(!reported.includes('oa-acme'), `cleaned: ${reported}`);

  // A SIP call belongs to the project that received it.
  const sip = new RealtimeSession({
    model: 'gpt-realtime',
    transport: new OpenAIWebSocketTransport({ apiKey: 'oa-project', callId: 'rtc_1', webSocketFactory: refuse }),
    lifecycle: lifecycle(),
    tenantId: 'acme',
  });
  await assert.rejects(sip.connect());
  assert.equal(connected[2]?.headers.authorization, 'Bearer oa-project');

  // A session with no tenant connects with the configured key.
  const shared = new RealtimeSession({
    model: 'gpt-realtime',
    transport: new OpenAIWebSocketTransport({ apiKey: 'oa-shared', webSocketFactory: refuse }),
    lifecycle: lifecycle(),
  });
  await assert.rejects(shared.connect());
  assert.equal(connected[3]?.headers.authorization, 'Bearer oa-shared');
});
