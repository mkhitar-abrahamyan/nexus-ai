/**
 * One phone agent on both providers, Twilio and Telnyx, end to end: a call comes in and is answered
 * the same way on each, recorded, and streamed to a realtime session through the bridge; the caller
 * speaks, the agent answers aloud, texts the caller a receipt, and transfers them to a person. The
 * recording is then kept in every asset store (in memory, on disk, and in an S3 bucket), deleted at
 * the provider, and expires on schedule: still there the day before its retention ends, gone the
 * day after.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { OperationLifecycle } from '../src/core/lifecycle.js';
import { FilesystemAssetStore, S3AssetStore, type S3LikeClient } from '../src/images/asset-stores.js';
import type { AssetStore } from '../src/images/asset-support.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { RealtimeSession } from '../src/realtime/session.js';
import { defineTool } from '../src/realtime/tools.js';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeTransport,
  RealtimeTransportEvents,
} from '../src/realtime/types.js';
import { TelephonyManager } from '../src/telephony/manager.js';
import { TelnyxTelephonyProvider } from '../src/telephony/providers/telnyx.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';
import { createTelephonyRealtimeBridge, twilioRealtimeAudioOptions } from '../src/telephony/realtime-bridge.js';
import { recordingKeeper } from '../src/telephony/recordings.js';
import type { TelephonyProvider } from '../src/types/telephony.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-phone-agent-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Sent {
  method: string;
  url: string;
  body?: string;
}

/** A provider's API in this process, recording each request. */
function api(respond: (request: Sent, path: string) => { status?: number; json?: unknown; bytes?: Uint8Array }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const request: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      ...(init.body !== undefined ? { body: String(init.body) } : {}),
    };
    sent.push(request);
    const answer = respond(request, decodeURIComponent(new URL(request.url).pathname));
    if (answer.bytes) return new Response(answer.bytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    const status = answer.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(answer.json ?? {}), { status });
  }) as typeof globalThis.fetch;
  return { sent, fetch: fetchImpl };
}

const AUDIO = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 9]);

interface Line {
  name: 'twilio' | 'telnyx';
  callId: string;
  provider: TelephonyProvider;
  sent: Sent[];
  start: Record<string, unknown>;
  media: (payload: string) => Record<string, unknown>;
  stop: Record<string, unknown>;
  recordingCallback: string | Record<string, unknown>;
}

function lines(): Line[] {
  const twilio = api((_request, pathname) => {
    const route = pathname.replace('/2010-04-01/Accounts/AC1', '');
    if (route === '/Calls/CA1.json') return { json: { sid: 'CA1', status: 'in-progress' } };
    if (route === '/Calls/CA1/Recordings.json') return { json: { sid: 'RE1' } };
    if (route === '/Recordings/RE1.mp3') return { bytes: AUDIO };
    if (route === '/Recordings/RE1.json') return { status: 204 };
    if (route === '/Messages.json') return { json: { sid: 'SM1', status: 'queued' } };
    return { status: 404 };
  });
  const telnyx = api((request, pathname) => {
    const route = pathname.replace('/v2', '');
    if (route.startsWith('/calls/v3:call-1/actions/')) return { json: { data: { result: 'ok' } } };
    if (request.url === 'https://s3.telnyx.example/rec-1.mp3') return { bytes: AUDIO };
    if (route === '/recordings/rec-1') return { status: 204 };
    if (route === '/messages')
      return { json: { data: { id: 'msg-1', to: [{ phone_number: '+15550001', status: 'queued' }] } } };
    return { status: 404 };
  });
  return [
    {
      name: 'twilio',
      callId: 'CA1',
      provider: new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 'token', fetch: twilio.fetch }),
      sent: twilio.sent,
      start: {
        event: 'start',
        streamSid: 'MZ1',
        start: {
          callSid: 'CA1',
          streamSid: 'MZ1',
          tracks: ['inbound'],
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      },
      media: (payload) => ({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload } }),
      stop: { event: 'stop', streamSid: 'MZ1', stop: { callSid: 'CA1' } },
      recordingCallback:
        'RecordingSid=RE1&CallSid=CA1&RecordingStatus=completed&RecordingDuration=95&RecordingUrl=https%3A%2F%2Fapi.twilio.com%2F2010-04-01%2FAccounts%2FAC1%2FRecordings%2FRE1',
    },
    {
      name: 'telnyx',
      callId: 'v3:call-1',
      provider: new TelnyxTelephonyProvider({ apiKey: 'KEY', connectionId: 'app-1', fetch: telnyx.fetch }),
      sent: telnyx.sent,
      start: {
        event: 'start',
        stream_id: 's-1',
        start: { call_control_id: 'v3:call-1', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } },
      },
      media: (payload) => ({ event: 'media', stream_id: 's-1', media: { track: 'inbound', payload } }),
      stop: { event: 'stop', stream_id: 's-1', stop: { call_control_id: 'v3:call-1' } },
      recordingCallback: {
        data: {
          event_type: 'call.recording.saved',
          payload: {
            call_control_id: 'v3:call-1',
            recording_id: 'rec-1',
            recording_started_at: '2026-10-18T10:00:00Z',
            recording_ended_at: '2026-10-18T10:01:35Z',
            recording_urls: { mp3: 'https://s3.telnyx.example/rec-1.mp3' },
          },
        },
      },
    },
  ];
}

/** The realtime model's end of the session: it hears the caller and answers as a model would. */
class Model implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  readonly heard: ArrayBuffer[] = [];
  readonly sent: RealtimeClientEvent[] = [];
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ) {
    return this.emitter.on(event, listener);
  }
  async connect() {
    this.emitter.emit('connected', { sessionId: 'model', transport: this.kind, timestamp: 0 });
  }
  sendAudio(chunk: ArrayBuffer) {
    this.heard.push(chunk);
  }
  sendEvent(event: RealtimeClientEvent) {
    this.sent.push(event);
  }
  interrupt() {}
  async disconnect() {
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  emit(event: RealtimeServerEvent) {
    this.emitter.emit('data', { event, raw: event });
  }
  /** Answers aloud, then calls the tools: a receipt by text, and a transfer to a person. */
  answer() {
    this.emit({ type: 'response.created', response: { id: 'resp_1' } });
    this.emit({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'item_1', delta: 'f39/fw==' });
    this.emit({
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'text_receipt', arguments: '{"text":"Order 42: $18.50"}' },
          { type: 'function_call', call_id: 'call_2', name: 'transfer_to_person', arguments: '{}' },
        ],
      },
    });
  }
}

const DAY = 86_400_000;

test('proof: one phone agent answers on Twilio and on Telnyx, and its recording expires on schedule from every store', async () => {
  for (const line of lines()) {
    const operations: string[] = [];
    const telephony = new TelephonyManager(
      { providers: { [line.name]: line.provider } },
      {
        lifecycle: new OperationLifecycle({
          config: {
            authorize: (operation) => {
              operations.push(`${operation.family}:${operation.operation}`);
              return true;
            },
          },
        }),
      },
    );

    // The call comes in, and the same answer works on either provider.
    const reply = await telephony.answer({
      provider: line.name,
      callId: line.callId,
      say: 'Connecting you to the assistant.',
      stream: { url: 'wss://agent.example/media', mode: 'bidirectional' },
    });
    if (line.name === 'twilio') assert.match(reply.body, /<Connect><Stream url="wss:\/\/agent\.example\/media">/);
    else
      assert.deepEqual(
        [reply.body, line.sent.map((request) => request.url.split('/').pop())],
        ['{}', ['answer', 'speak']],
      );
    await telephony.startRecording({
      provider: line.name,
      callId: line.callId,
      statusCallbackUrl: 'https://app.example/recordings',
    });

    // The phone agent: a realtime session with two tools, bridged to the call's media stream.
    const model = new Model();
    const textReceipt = defineTool({
      name: 'text_receipt',
      description: 'Texts the caller a receipt',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async ({ text }) =>
        telephony.sendMessage({ provider: line.name, to: '+15550001', from: '+15559999', body: String(text) }),
    });
    const transferToPerson = defineTool({
      name: 'transfer_to_person',
      description: 'Transfers the caller to a person',
      parameters: { type: 'object', properties: {} },
      execute: async () => telephony.transferCall({ provider: line.name, callId: line.callId, to: '+15551234' }),
    });
    const session = new RealtimeSession({
      model: 'gpt-realtime',
      transport: model,
      audio: twilioRealtimeAudioOptions(),
      tools: [textReceipt, transferToPerson],
      conversation: { captureTranscripts: true },
    });
    const toCaller: string[] = [];
    const bridge = createTelephonyRealtimeBridge({
      session,
      telephony,
      provider: line.name,
      send: (message) => void toCaller.push(message.body),
    });
    await bridge.handleMessage(line.start);
    assert.equal(bridge.callId, line.callId, `${line.name}: the stream belongs to the call`);
    await bridge.handleMessage(line.media('f39/fw=='));
    assert.equal(model.heard.length, 1, `${line.name}: the caller's audio reached the model`);

    model.answer();
    await session.whenIdle();
    await bridge.flush();
    const audioOut = JSON.parse(toCaller[0] ?? '{}');
    assert.equal(audioOut.media?.payload, 'f39/fw==', `${line.name}: the model's audio reached the caller`);
    if (line.name === 'twilio') assert.equal(audioOut.streamSid, 'MZ1', 'Twilio names the stream in each message');
    const urls = line.sent.map((request) => request.url);
    assert.ok(
      urls.some((url) => /\/(Messages\.json|messages)$/.test(url)),
      `${line.name}: the receipt was texted`,
    );
    assert.ok(
      line.name === 'twilio'
        ? line.sent.some(
            (request) =>
              request.url.endsWith('/Calls/CA1.json') && /<Dial>/.test(decodeURIComponent(request.body ?? '')),
          )
        : urls.some((url) => url.endsWith('/actions/transfer')),
      `${line.name}: the caller was transferred`,
    );
    assert.ok(operations.includes('messaging:sendMessage'), `${line.name}: the text is a messaging operation`);
    assert.ok(operations.includes('telephony:transferCall'), `${line.name}: the transfer a telephony one`);
    await bridge.handleMessage(line.stop);
    assert.equal(bridge.closed, true);

    // The recording is kept in every store, deleted at the provider, and expires on schedule.
    for (const [storeName, open] of stores()) {
      let now = Date.parse('2026-10-18T12:00:00Z');
      const clock = () => new Date(now);
      const { store, count } = open(clock);
      const keeper = recordingKeeper({ telephony, store, retention: { days: 30 }, tenantId: 'acme', now: clock });
      const at = `${line.name}, ${storeName}`;
      const kept = await keeper.handle(line.name, line.recordingCallback);
      assert.ok(kept, `${at}: kept`);
      assert.equal(kept.bytes, AUDIO.byteLength, at);
      assert.equal(kept.recording.durationSeconds, 95, at);
      assert.equal(kept.deletedFromProvider, true, `${at}: deleted at the provider`);
      assert.equal(kept.expiresAt, new Date(now + 30 * DAY).toISOString(), at);
      assert.equal(
        await keeper.handle(line.name, line.recordingCallback),
        undefined,
        `${at}: a retried callback keeps it once`,
      );
      const stored = await store.get(kept.assetId, 'acme');
      assert.deepEqual(
        stored?.location.kind === 'bytes' ? Array.from(stored.location.data) : [],
        Array.from(AUDIO),
        at,
      );

      now += 29 * DAY;
      assert.equal(await keeper.sweep(), 0, `${at}: the day before retention ends, nothing is removed`);
      assert.ok(await store.get(kept.assetId, 'acme'), `${at}: and the recording is there`);
      now += 2 * DAY;
      assert.equal(await keeper.sweep(), 1, `${at}: the day after, it is removed`);
      assert.equal(await store.get(kept.assetId, 'acme'), undefined, at);
      assert.equal(count(), 0, `${at}: and nothing of it is left in the store`);
    }
    const deletes = line.sent.filter((request) => request.method === 'DELETE');
    assert.equal(deletes.length, 3, `${line.name}: one provider delete per store`);
  }
});

let fresh = 0;
function stores(): Array<[string, (now: () => Date) => { store: AssetStore; count: () => number }]> {
  return [
    [
      'memory',
      (now) => {
        const store = new MemoryAssetStore({ now });
        return { store, count: () => (store as unknown as { entries: Map<string, unknown> }).entries.size };
      },
    ],
    [
      'filesystem',
      (now) => {
        fresh += 1;
        const root = path.join(scratch, `store-${fresh}`);
        const store = new FilesystemAssetStore({ directory: root, now });
        return {
          store,
          count: () => readdirSync(root).filter((file) => /\.(bin|json)$/.test(file)).length,
        };
      },
    ],
    [
      's3',
      (now) => {
        const objects = new Map<string, Uint8Array>();
        const metadata = new Map<string, Record<string, string>>();
        const client: S3LikeClient = {
          async putObject({ bucket, key, body, metadata: meta }) {
            objects.set(`${bucket}/${key}`, body);
            if (meta) metadata.set(`${bucket}/${key}`, meta);
          },
          async getObject({ bucket, key }) {
            const body = objects.get(`${bucket}/${key}`);
            if (!body) throw new Error('NoSuchKey');
            return { body, metadata: metadata.get(`${bucket}/${key}`) };
          },
          async deleteObject({ bucket, key }) {
            objects.delete(`${bucket}/${key}`);
            metadata.delete(`${bucket}/${key}`);
          },
          async listObjects({ bucket, prefix }) {
            return [...objects.keys()]
              .filter((key) => key.startsWith(`${bucket}/${prefix}`))
              .map((key) => ({ key: key.slice(bucket.length + 1) }));
          },
        };
        return { store: new S3AssetStore({ client, bucket: 'recordings', now }), count: () => objects.size };
      },
    ],
  ];
}
