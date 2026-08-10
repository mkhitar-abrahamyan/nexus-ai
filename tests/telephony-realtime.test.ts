import assert from 'node:assert/strict';
import test from 'node:test';
import { TelephonyManager } from '../src/telephony/manager.js';
import { TwilioTelephonyProvider } from '../src/telephony/providers/twilio.js';
import { createTelephonyRealtimeBridge, twilioRealtimeAudioOptions } from '../src/telephony/realtime-bridge.js';
import type { RealtimeSession } from '../src/realtime/session.js';
import type { TelephonyOutboundAudioMessage } from '../src/types/telephony.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Twilio provider reads call details and hangs up through call control', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const provider = new TwilioTelephonyProvider({
    accountSid: 'AC123',
    authToken: 'secret',
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body });
      return jsonResponse({
        sid: 'CA123',
        status: 'completed',
        direction: 'inbound',
        from: '+15551230000',
        to: '+15557650000',
        duration: '137',
        start_time: 'Tue, 10 Aug 2026 10:00:00 +0000',
        end_time: 'Tue, 10 Aug 2026 10:02:17 +0000',
        price: '-0.017',
        price_unit: 'USD',
      });
    },
  });

  const details = await provider.getCall({ callId: 'CA123' });
  const ended = await provider.endCall({ callId: 'CA123' });

  assert.match(requests[0].url, /\/Accounts\/AC123\/Calls\/CA123\.json$/);
  assert.equal(requests[0].method, 'GET');
  assert.equal(details.durationSeconds, 137, 'duration drives usage metering');
  assert.equal(details.direction, 'inbound');
  assert.equal(details.price, -0.017);
  assert.equal(details.priceUnit, 'USD');

  assert.equal(requests[1].method, 'POST');
  assert.equal((requests[1].body as URLSearchParams).get('Status'), 'completed');
  assert.equal(ended.status, 'completed');
});

test('Twilio provider maps outbound-api direction to outbound', async () => {
  const provider = new TwilioTelephonyProvider({
    accountSid: 'AC123',
    authToken: 'secret',
    fetch: async () => jsonResponse({ sid: 'CA1', status: 'in-progress', direction: 'outbound-api' }),
  });

  const details = await provider.getCall({ callId: 'CA1' });
  assert.equal(details.direction, 'outbound');
});

test('Twilio provider parses status callbacks into a billable record', () => {
  const provider = new TwilioTelephonyProvider({ accountSid: 'AC123', authToken: 'secret' });

  const parsed = provider.parseStatusCallback(
    new URLSearchParams({
      CallSid: 'CA999',
      CallStatus: 'completed',
      Direction: 'inbound',
      From: '+15551230000',
      To: '+15557650000',
      CallDuration: '92',
    }),
  );

  assert.equal(parsed?.callId, 'CA999');
  assert.equal(parsed?.status, 'completed');
  assert.equal(parsed?.durationSeconds, 92);
  assert.equal(parsed?.from, '+15551230000');

  assert.equal(provider.parseStatusCallback({}), undefined, 'a body without a call id is not a status callback');
});

test('Twilio provider lists and repoints phone numbers', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const provider = new TwilioTelephonyProvider({
    accountSid: 'AC123',
    authToken: 'secret',
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body });
      const payload = {
        sid: 'PN123',
        phone_number: '+15557650000',
        friendly_name: 'Support line',
        voice_url: 'https://api.example.com/voice/incoming',
        voice_method: 'post',
        status_callback: 'https://api.example.com/voice/status',
        status_callback_method: 'POST',
        capabilities: { voice: true, sms: false, mms: false },
      };
      return String(url).includes('/IncomingPhoneNumbers.json')
        ? jsonResponse({ incoming_phone_numbers: [payload] })
        : jsonResponse(payload);
    },
  });

  const numbers = await provider.listPhoneNumbers({ phoneNumber: '+15557650000' });
  const updated = await provider.updatePhoneNumber({
    id: 'PN123',
    voiceUrl: 'https://api.example.com/voice/incoming',
    statusCallbackUrl: 'https://api.example.com/voice/status',
  });

  assert.match(requests[0].url, /PhoneNumber=%2B15557650000/);
  assert.equal(numbers.length, 1);
  assert.equal(numbers[0].id, 'PN123');
  assert.equal(numbers[0].voiceMethod, 'POST', 'lowercase provider methods are normalized');
  assert.equal(numbers[0].capabilities?.voice, true);

  const body = requests[1].body as URLSearchParams;
  assert.equal(body.get('VoiceUrl'), 'https://api.example.com/voice/incoming');
  assert.equal(body.get('StatusCallback'), 'https://api.example.com/voice/status');
  assert.equal(updated.phoneNumber, '+15557650000');
});

test('Twilio provider rejects an empty phone number update', async () => {
  const provider = new TwilioTelephonyProvider({ accountSid: 'AC123', authToken: 'secret' });
  await assert.rejects(() => provider.updatePhoneNumber({ id: 'PN123' }), /at least one field/);
});

test('telephony manager reports missing call-control capability', async () => {
  const manager = new TelephonyManager({
    defaultProvider: 'bare',
    providers: { bare: { info: { name: 'bare' } } },
  });

  await assert.rejects(() => manager.endCall({ callId: 'CA1' }), /does not support call control/);
});

test('twilioRealtimeAudioOptions pins both directions to 8 kHz mu-law', () => {
  const options = twilioRealtimeAudioOptions({ output: { voice: 'alloy' } });

  assert.equal(options.input?.format?.type, 'audio/pcmu');
  assert.equal(options.input?.format?.rate, 8000);
  assert.equal(options.output?.format?.type, 'audio/pcmu');
  assert.equal(options.output?.format?.rate, 8000);
  assert.equal(options.output?.voice, 'alloy', 'caller overrides survive');
});

/** Minimal stand-in exposing only what the bridge touches. */
class FakeRealtimeSession {
  connected = 0;
  disconnected = 0;
  interruptions: string[] = [];
  audioIn: string[] = [];
  playbackMarks = 0;
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();

  on(event: string, listener: (payload: never) => void): () => void {
    const set = this.listeners.get(event) || new Set<(payload: never) => void>();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) || [])]) {
      (listener as (payload: unknown) => void)(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size || 0;
  }

  async connect(): Promise<void> {
    this.connected += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.audioIn.push(Buffer.from(new Uint8Array(chunk)).toString('base64'));
  }

  interrupt(reason: string): void {
    this.interruptions.push(reason);
  }

  markAudioPlayed(): void {
    this.playbackMarks += 1;
  }
}

function createBridgeHarness(options: { bargeIn?: boolean } = {}) {
  const session = new FakeRealtimeSession();
  const telephony = new TelephonyManager({
    defaultProvider: 'twilio',
    providers: { twilio: new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 'secret' }) },
  });
  const sent: TelephonyOutboundAudioMessage[] = [];
  const errors: unknown[] = [];

  const bridge = createTelephonyRealtimeBridge({
    session: session as unknown as RealtimeSession,
    telephony,
    bargeIn: options.bargeIn,
    send: (message) => {
      sent.push(message);
    },
    onError: (error) => errors.push(error),
  });

  return { session, bridge, sent, errors };
}

const startMessage = JSON.stringify({
  event: 'start',
  streamSid: 'MZ1',
  start: {
    streamSid: 'MZ1',
    callSid: 'CA1',
    customParameters: { workerId: 'worker-7' },
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  },
});

test('bridge connects on start and exposes call identity and custom parameters', async () => {
  const { session, bridge } = createBridgeHarness();

  await bridge.handleMessage(startMessage);

  assert.equal(session.connected, 1);
  assert.equal(bridge.callId, 'CA1');
  assert.equal(bridge.streamId, 'MZ1');
  assert.equal(bridge.parameters.workerId, 'worker-7', 'stream parameters carry app tenancy');
});

test('bridge forwards inbound caller audio and ignores the outbound echo track', async () => {
  const { session, bridge } = createBridgeHarness();
  await bridge.handleMessage(startMessage);

  await bridge.handleMessage(
    JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload: 'aGVsbG8=' } }),
  );
  await bridge.handleMessage(
    JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { track: 'outbound', payload: 'd29ybGQ=' } }),
  );

  assert.deepEqual(session.audioIn, ['aGVsbG8='], 'only caller audio reaches the model');
});

test('bridge frames assistant audio back to the provider and marks playback once per response', async () => {
  const { session, bridge, sent } = createBridgeHarness();
  await bridge.handleMessage(startMessage);

  session.emit('assistant.response.created', { responseId: 'resp-1' });
  session.emit('assistant.audio.delta', { audio: new Uint8Array([1, 2, 3]).buffer });
  session.emit('assistant.audio.delta', { audio: new Uint8Array([4, 5, 6]).buffer });
  await bridge.flush();
  await bridge.handleMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: 'nexus-playback-1' } }));

  const media = sent.filter((message) => message.event === 'media');
  const marks = sent.filter((message) => message.event === 'mark');

  assert.equal(media.length, 2);
  assert.equal(JSON.parse(media[0].body).media.payload, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(marks.length, 1, 'one mark per response is enough to time playback');
  assert.equal(session.playbackMarks, 1, 'the provider echo resolves the mark');
});

test('bridge clears queued audio and cancels the response when the caller interrupts', async () => {
  const { session, bridge, sent } = createBridgeHarness();
  await bridge.handleMessage(startMessage);

  session.emit('assistant.response.created', { responseId: 'resp-1' });
  session.emit('assistant.audio.delta', { audio: new Uint8Array([1, 2, 3]).buffer });
  session.emit('speech.started', { timestamp: 1 });
  await bridge.flush();

  const clears = sent.filter((message) => message.event === 'clear');
  assert.equal(clears.length, 1, 'buffered provider audio is dropped');
  assert.deepEqual(session.interruptions, ['barge_in']);

  // A mark echoed after the interruption belongs to discarded audio and must not count as playback.
  await bridge.handleMessage(JSON.stringify({ event: 'mark', streamSid: 'MZ1', mark: { name: 'nexus-playback-1' } }));
  assert.equal(session.playbackMarks, 0);
});

test('bridge leaves audio alone when barge-in is disabled', async () => {
  const { session, bridge, sent } = createBridgeHarness({ bargeIn: false });
  await bridge.handleMessage(startMessage);

  session.emit('speech.started', { timestamp: 1 });
  await bridge.flush();

  assert.equal(sent.filter((message) => message.event === 'clear').length, 0);
  assert.deepEqual(session.interruptions, []);
});

test('bridge stops on the provider stop event and detaches its listeners', async () => {
  const { session, bridge } = createBridgeHarness();
  await bridge.handleMessage(startMessage);

  await bridge.handleMessage(JSON.stringify({ event: 'stop', streamSid: 'MZ1', stop: { callSid: 'CA1' } }));

  assert.equal(bridge.closed, true);
  assert.equal(session.disconnected, 1);
  assert.equal(session.listenerCount('assistant.audio.delta'), 0, 'a closed bridge holds no session listeners');

  await bridge.handleMessage(startMessage);
  assert.equal(session.connected, 1, 'messages after close are ignored');
});

test('bridge reports malformed provider messages instead of throwing at the socket', async () => {
  const { bridge, errors } = createBridgeHarness();

  await bridge.handleMessage('{not json');

  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /failed to handle a media message/);
});

test('bridge surfaces send failures through onError without breaking the stream', async () => {
  const session = new FakeRealtimeSession();
  const telephony = new TelephonyManager({
    defaultProvider: 'twilio',
    providers: { twilio: new TwilioTelephonyProvider({ accountSid: 'AC1', authToken: 'secret' }) },
  });
  const errors: unknown[] = [];
  const bridge = createTelephonyRealtimeBridge({
    session: session as unknown as RealtimeSession,
    telephony,
    send: () => {
      throw new Error('socket closed');
    },
    onError: (error) => errors.push(error),
  });

  await bridge.handleMessage(startMessage);
  session.emit('assistant.audio.delta', { audio: new Uint8Array([1]).buffer });
  await bridge.close();

  assert.equal(errors.length > 0, true);
  assert.match(String((errors[0] as Error).message), /socket closed/);
});
