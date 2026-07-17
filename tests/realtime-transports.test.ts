import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeError } from '../src/realtime/errors.js';
import {
  createOpenAIRealtimeCall,
  createOpenAIRealtimeClientSecret,
  createOpenAIRealtimeSessionEndpoint,
  type FormDataLike,
  type OpenAIRealtimeServerFetch,
} from '../src/realtime/openai-server.js';
import {
  OpenAIWebRTCTransport,
  type RealtimeDataChannelLike,
  type RealtimeFetchLike,
  type RealtimeMediaDevicesLike,
  type RealtimeMediaStreamLike,
  type RealtimeMediaTrackLike,
  type RealtimePeerConnectionLike,
  type RealtimeSessionDescriptionLike,
} from '../src/realtime/openai-webrtc.transport.js';
import {
  type OpenAIWebSocketFactoryOptions,
  OpenAIWebSocketTransport,
  type RealtimeWebSocketLike,
} from '../src/realtime/openai-websocket.transport.js';
import type { EventTargetLike, TimerPlatform } from '../src/realtime/transport-utils.js';
import type { RealtimeServerEvent, RealtimeSessionConfig } from '../src/realtime/types.js';

class FakeEventTarget implements EventTargetLike {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) || new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = { type }): void {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size || 0;
  }
}

class ManualTimers implements TimerPlatform {
  nowMs = 100;
  private nextId = 0;
  private readonly pending = new Map<number, () => void>();

  setTimeout(handler: () => void): number {
    const id = ++this.nextId;
    this.pending.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.pending.delete(handle);
  }

  now(): number {
    return this.nowMs;
  }

  run(handle: number): void {
    const callback = this.pending.get(handle);
    this.pending.delete(handle);
    callback?.();
  }

  get size(): number {
    return this.pending.size;
  }
}

class FakeSocket extends FakeEventTarget implements RealtimeWebSocketLike {
  readyState = 0;
  binaryType?: string;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', { type: 'open' });
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }
}

class FakeTrack extends FakeEventTarget implements RealtimeMediaTrackLike {
  readonly kind = 'audio';
  readyState = 'live';
  stopCalls = 0;

  stop(): void {
    this.stopCalls += 1;
    this.readyState = 'ended';
  }
}

class FakeStream implements RealtimeMediaStreamLike {
  constructor(readonly tracks: RealtimeMediaTrackLike[]) {}

  getTracks(): RealtimeMediaTrackLike[] {
    return [...this.tracks];
  }

  getAudioTracks(): RealtimeMediaTrackLike[] {
    return [...this.tracks];
  }
}

class FakeMediaDevices extends FakeEventTarget implements RealtimeMediaDevicesLike {
  readonly constraints: Record<string, unknown>[] = [];

  constructor(private readonly stream: RealtimeMediaStreamLike | Error) {
    super();
  }

  async getUserMedia(constraints: Record<string, unknown>): Promise<RealtimeMediaStreamLike> {
    this.constraints.push(constraints);
    if (this.stream instanceof Error) throw this.stream;
    return this.stream;
  }
}

class FakeDataChannel extends FakeEventTarget implements RealtimeDataChannelLike {
  readonly label = 'oai-events';
  readyState = 'open';
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  closeCalls = 0;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('data channel is not open');
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
    this.emit('close', { type: 'close' });
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }
}

class FakePeerConnection extends FakeEventTarget implements RealtimePeerConnectionLike {
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: RealtimeSessionDescriptionLike | null = null;
  readonly addedTracks: RealtimeMediaTrackLike[] = [];
  readonly remoteDescriptions: RealtimeSessionDescriptionLike[] = [];
  closeCalls = 0;

  constructor(readonly channel: FakeDataChannel) {
    super();
  }

  createDataChannel(): RealtimeDataChannelLike {
    return this.channel;
  }

  addTrack(track: RealtimeMediaTrackLike): unknown {
    this.addedTracks.push(track);
    return {};
  }

  async createOffer(): Promise<RealtimeSessionDescriptionLike> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async setLocalDescription(description: RealtimeSessionDescriptionLike): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RealtimeSessionDescriptionLike): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = 'closed';
  }
}

function config(
  transport: RealtimeSessionConfig['transport'],
  overrides: Partial<RealtimeSessionConfig> = {},
): RealtimeSessionConfig {
  return {
    id: 'session_transport',
    provider: 'openai',
    model: 'gpt-realtime',
    transport,
    ...overrides,
  };
}

test('OpenAI WebSocket transport uses its injected socket, handles JSON/audio, and cleans up deterministically', async () => {
  const timers = new ManualTimers();
  const socket = new FakeSocket();
  let factoryUrl = '';
  let factoryOptions: OpenAIWebSocketFactoryOptions | undefined;
  const transport = new OpenAIWebSocketTransport({
    apiKey: 'server-test-key',
    url: 'wss://example.test/realtime?tenant=one',
    timers,
    now: () => 456,
    webSocketFactory: (url, options) => {
      factoryUrl = url;
      factoryOptions = options;
      return socket;
    },
  });
  const connected: number[] = [];
  const received: RealtimeServerEvent[] = [];
  const errors: RealtimeError[] = [];
  const disconnected: Array<{ expected?: boolean; code?: number }> = [];
  transport.on('connected', (event) => connected.push(event.timestamp));
  transport.on('data', ({ event }) => received.push(event));
  transport.on('error', (error) => errors.push(error));
  transport.on('disconnected', (event) => disconnected.push(event));

  const connecting = transport.connect(config(transport));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(factoryUrl, 'wss://example.test/realtime?tenant=one&model=gpt-realtime');
  assert.equal(factoryOptions?.headers.authorization, 'Bearer server-test-key');
  assert.equal(factoryOptions?.headers['openai-beta'], 'realtime=v1');
  assert.equal(socket.binaryType, 'arraybuffer');
  socket.open();
  await connecting;

  assert.equal(transport.state, 'connected');
  assert.deepEqual(connected, [456]);
  transport.sendEvent({ type: 'session.update', session: { instructions: 'concise' } });
  transport.sendAudio(new Uint8Array([1, 2, 3]).buffer);
  transport.interrupt();
  assert.deepEqual(
    socket.sent.map((value) => JSON.parse(String(value)).type),
    ['session.update', 'input_audio_buffer.append', 'response.cancel'],
  );
  assert.equal(JSON.parse(String(socket.sent[1])).audio, 'AQID');

  socket.message(JSON.stringify({ type: 'session.created', session: { id: 'provider_session' } }));
  socket.message(new TextEncoder().encode(JSON.stringify({ type: 'response.created', response: { id: 'r1' } })));
  socket.message('not-json');
  assert.deepEqual(
    received.map((event) => event.type),
    ['session.created', 'response.created'],
  );
  assert.equal(errors.at(-1)?.code, 'invalid_websocket_event');

  await transport.disconnect();
  assert.equal(transport.state, 'disconnected');
  assert.deepEqual(socket.closeCalls.at(-1), { code: 1000, reason: 'client disconnect' });
  assert.deepEqual(disconnected, [
    {
      transport: 'websocket',
      timestamp: 456,
      code: 1000,
      reason: 'client disconnect',
      expected: true,
      retryable: false,
      raw: { code: 1000, reason: 'client disconnect' },
    },
  ]);
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(timers.size, 0);
});

test('OpenAI WebSocket transport rejects oversized audio and maps abnormal closure as retryable', async () => {
  const socket = new FakeSocket();
  const timers = new ManualTimers();
  const transport = new OpenAIWebSocketTransport({
    webSocketFactory: () => socket,
    timers,
    maxAudioChunkBytes: 2,
  });
  const errors: RealtimeError[] = [];
  const disconnected = new Promise<boolean>((resolve) => {
    transport.on('disconnected', (event) => resolve(event.retryable === true));
  });
  transport.on('error', (error) => errors.push(error));
  const connecting = transport.connect(config(transport));
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.open();
  await connecting;

  assert.throws(
    () => transport.sendAudio(new Uint8Array([1, 2, 3]).buffer),
    (error) => {
      assert.ok(error instanceof RealtimeError);
      assert.equal(error.code, 'audio_too_large');
      return true;
    },
  );
  assert.equal(errors.at(-1)?.code, 'audio_too_large');
  socket.readyState = 3;
  socket.emit('close', { code: 1006, reason: 'network lost' });
  assert.equal(await disconnected, true);
  assert.equal(transport.state, 'failed');
});

test('OpenAI WebRTC unified SDP transport attaches structural media, emits events, and releases owned resources', async () => {
  const timers = new ManualTimers();
  const channel = new FakeDataChannel();
  const peer = new FakePeerConnection(channel);
  const localTrack = new FakeTrack();
  const localStream = new FakeStream([localTrack]);
  const mediaDevices = new FakeMediaDevices(localStream);
  const remoteTrack = new FakeTrack();
  const remoteStream = new FakeStream([remoteTrack]);
  const requests: Array<{ url: string; init?: Parameters<RealtimeFetchLike>[1] }> = [];
  const fetch: RealtimeFetchLike = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'x-request-id' ? 'request_1' : null) },
      text: async () => 'answer-sdp',
    };
  };
  const transport = new OpenAIWebRTCTransport({
    sessionEndpoint: '/api/realtime/session',
    sessionMode: 'unified-sdp',
    peerConnectionFactory: () => peer,
    mediaDevices,
    fetch,
    timers,
    now: () => 789,
  });
  const data: RealtimeServerEvent[] = [];
  const audio: unknown[] = [];
  const errors: RealtimeError[] = [];
  transport.on('data', ({ event }) => data.push(event));
  transport.on('audio', (event) => audio.push(event));
  transport.on('error', (error) => errors.push(error));
  const audioElement = {
    srcObject: undefined as unknown,
    autoplay: false,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
    },
  };

  await transport.connect(
    config(transport, {
      connection: { microphone: { echoCancellation: true }, audioElement },
    }),
  );

  assert.equal(transport.state, 'connected');
  assert.deepEqual(mediaDevices.constraints, [{ audio: { echoCancellation: true } }]);
  assert.deepEqual(peer.addedTracks, [localTrack]);
  assert.deepEqual(peer.remoteDescriptions, [{ type: 'answer', sdp: 'answer-sdp' }]);
  assert.equal(requests[0]?.url, '/api/realtime/session');
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal(requests[0]?.init?.headers?.['content-type'], 'application/sdp');
  assert.equal(requests[0]?.init?.body, 'offer-sdp');
  assert.equal(timers.size, 0);

  channel.message(JSON.stringify({ type: 'session.created', session: { id: 'provider_1' } }));
  peer.emit('track', { streams: [remoteStream], track: remoteTrack });
  mediaDevices.emit('devicechange', { type: 'devicechange' });
  localTrack.emit('ended', { type: 'ended' });
  assert.deepEqual(
    data.map((event) => event.type),
    ['session.created', 'nexus.audio.device_changed', 'nexus.microphone.ended'],
  );
  assert.equal(audio.length, 1);
  assert.equal(audioElement.srcObject, remoteStream);
  assert.equal(audioElement.autoplay, true);
  assert.equal(audioElement.playCalls, 1);
  assert.equal(errors.at(-1)?.code, 'microphone_ended');

  transport.sendEvent({ type: 'session.update', session: { instructions: 'brief' } });
  transport.sendAudio(new Uint8Array([4, 5]).buffer);
  transport.interrupt();
  assert.deepEqual(
    channel.sent.map((value) => JSON.parse(String(value)).type),
    ['session.update', 'input_audio_buffer.append', 'response.cancel'],
  );
  assert.equal(JSON.parse(String(channel.sent[1])).audio, 'BAU=');

  await transport.disconnect();
  assert.equal(transport.state, 'disconnected');
  assert.equal(localTrack.stopCalls, 1);
  assert.equal(channel.closeCalls, 1);
  assert.equal(peer.closeCalls, 1);
  assert.equal(audioElement.pauseCalls, 1);
  assert.equal(audioElement.srcObject, undefined);
  assert.equal(channel.listenerCount('message'), 0);
});

test('OpenAI WebRTC ephemeral mode obtains a client token before posting SDP and maps permission errors', async () => {
  const channel = new FakeDataChannel();
  const peer = new FakePeerConnection(channel);
  const timers = new ManualTimers();
  const requests: Array<{ url: string; init?: Parameters<RealtimeFetchLike>[1] }> = [];
  const fetch: RealtimeFetchLike = async (url, init) => {
    requests.push({ url, init });
    return url === '/api/realtime/token'
      ? { ok: true, status: 200, text: async () => '{"value":"sess_ephemeral"}' }
      : { ok: true, status: 200, text: async () => '{"sdp":"answer","session_id":"provider_ephemeral"}' };
  };
  const transport = new OpenAIWebRTCTransport({
    sessionMode: 'ephemeral-token',
    sessionEndpoint: '/api/realtime/token',
    realtimeEndpoint: 'https://api.openai.test/v1/realtime/calls',
    peerConnectionFactory: () => peer,
    fetch,
    timers,
  });
  await transport.connect(config(transport));

  assert.deepEqual(
    requests.map((request) => request.url),
    ['/api/realtime/token', 'https://api.openai.test/v1/realtime/calls'],
  );
  assert.equal(requests[0]?.init?.headers?.['content-type'], 'application/json');
  assert.equal(requests[1]?.init?.headers?.authorization, 'Bearer sess_ephemeral');
  assert.equal(requests[1]?.init?.body, 'offer-sdp');
  await transport.disconnect();

  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const deniedChannel = new FakeDataChannel();
  const deniedPeer = new FakePeerConnection(deniedChannel);
  const deniedTransport = new OpenAIWebRTCTransport({
    sessionEndpoint: '/session',
    peerConnectionFactory: () => deniedPeer,
    mediaDevices: new FakeMediaDevices(denied),
    fetch,
    timers: new ManualTimers(),
  });
  await assert.rejects(
    () => deniedTransport.connect(config(deniedTransport, { connection: { microphone: true } })),
    (error) => {
      assert.ok(error instanceof RealtimeError);
      assert.equal(error.code, 'permission_denied');
      assert.equal(error.category, 'permission');
      return true;
    },
  );
  assert.equal(deniedTransport.state, 'failed');
  assert.equal(deniedChannel.closeCalls, 1);
  assert.equal(deniedPeer.closeCalls, 1);
});

test('secure OpenAI server helpers build authenticated requests, parse client secrets, and redact HTTP errors', async () => {
  const formValues = new Map<string, string>();
  const form: FormDataLike = {
    set(name, value) {
      formValues.set(name, value);
    },
  };
  const calls: Array<{ input: string; init: Parameters<OpenAIRealtimeServerFetch>[1] }> = [];
  const fetch: OpenAIRealtimeServerFetch = async (input, init) => {
    calls.push({ input, init });
    return { ok: true, status: 200, text: async () => 'answer-sdp' };
  };
  const options = {
    apiKey: 'sk-server-test',
    model: 'gpt-realtime',
    session: { instructions: 'Be concise' },
    baseUrl: 'https://api.openai.test/v1/',
    safetyIdentifier: 'hashed-user',
    fetch,
    formDataFactory: () => form,
  };
  const signal = new AbortController().signal;
  const answer = await createOpenAIRealtimeCall('offer-sdp', options, signal);

  assert.equal(answer, 'answer-sdp');
  assert.equal(calls[0]?.input, 'https://api.openai.test/v1/realtime/calls');
  assert.equal(calls[0]?.init.headers?.Authorization, 'Bearer sk-server-test');
  assert.equal(calls[0]?.init.headers?.['OpenAI-Safety-Identifier'], 'hashed-user');
  assert.equal(calls[0]?.init.signal, signal);
  assert.equal(formValues.get('sdp'), 'offer-sdp');
  assert.deepEqual(JSON.parse(formValues.get('session') || ''), {
    type: 'realtime',
    model: 'gpt-realtime',
    instructions: 'Be concise',
  });
  const endpoint = createOpenAIRealtimeSessionEndpoint(options);
  assert.equal(await endpoint('second-offer'), 'answer-sdp');

  const secretCalls: Array<{ input: string; init: Parameters<OpenAIRealtimeServerFetch>[1] }> = [];
  const secret = await createOpenAIRealtimeClientSecret({
    ...options,
    fetch: async (input, init) => {
      secretCalls.push({ input, init });
      return {
        ok: true,
        status: 200,
        text: async () => '{"value":"sess_client","expires_at":{"epoch_seconds":12345}}',
      };
    },
  });
  assert.equal(secret.value, 'sess_client');
  assert.equal(secret.expiresAt, 12_345);
  assert.equal(secretCalls[0]?.input, 'https://api.openai.test/v1/realtime/client_secrets');
  assert.equal(secretCalls[0]?.init.headers?.['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(secretCalls[0]?.init.body)), {
    session: { type: 'realtime', model: 'gpt-realtime', instructions: 'Be concise' },
  });

  await assert.rejects(
    () =>
      createOpenAIRealtimeClientSecret({
        apiKey: 'sk-private-value',
        model: 'gpt-realtime',
        fetch: async () => ({
          ok: false,
          status: 401,
          text: async () => '{"token":"sess-private-token","message":"key sk-private-value rejected"}',
        }),
      }),
    (error) => {
      assert.ok(error instanceof RealtimeError);
      assert.equal(error.category, 'authentication');
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /sess-private-token|sk-private-value/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
  await assert.rejects(() => createOpenAIRealtimeCall(' ', options), /SDP offer is required/);
  await assert.rejects(
    () => createOpenAIRealtimeClientSecret({ ...options, apiKey: ' ' }),
    /server-side OpenAI API key is required/,
  );
});
