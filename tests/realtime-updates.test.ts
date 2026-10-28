/**
 * A Gemini Live session changed mid-conversation: Gemini is configured once, at setup, so an update
 * is a new setup on a new socket, resumed from the latest handle at a point Gemini can resume from,
 * with what is sent meanwhile held and delivered after. And images in the conversation record: kept,
 * by content or by digest, given back to a resumed session, and video frames left out.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GeminiLiveTransport } from '../src/realtime/gemini-live.transport.js';
import type { RealtimeWebSocketLike } from '../src/realtime/openai-websocket.transport.js';
import { GeminiLiveProvider } from '../src/realtime/provider.js';
import { replayRealtimeConversation } from '../src/realtime/conversation.js';
import { RealtimeSession } from '../src/realtime/session.js';
import { defineTool } from '../src/realtime/tools.js';
import type { RealtimeServerEvent, RealtimeSessionConfig } from '../src/realtime/types.js';

// biome-ignore lint/suspicious/noExplicitAny: the other side of the wire has no types to borrow.
type Message = Record<string, any>;

/** Gemini's end of a socket: it answers a setup, and records the rest. */
class Wire implements RealtimeWebSocketLike {
  readyState = 0;
  binaryType?: string;
  readonly sent: Message[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(private readonly answerSetup: (wire: Wire) => void) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', { type: 'open' });
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    const message = JSON.parse(String(data)) as Message;
    this.sent.push(message);
    if (message.setup) this.answerSetup(this);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }

  reply(message: Message): void {
    this.dispatch('message', { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
  }
}

const tick = async (times = 10) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A transport whose sockets answer setups, the n-th of them as `setupAnswer` says. */
function gemini(setupAnswer: (wire: Wire, index: number) => void = (wire) => wire.reply({ setupComplete: {} })) {
  const wires: Wire[] = [];
  const transport = new GeminiLiveTransport({
    apiKey: 'k',
    webSocketFactory: () => {
      const index = wires.length;
      const wire = new Wire((socket) => setupAnswer(socket, index));
      wires.push(wire);
      return wire;
    },
  });
  const events: RealtimeServerEvent[] = [];
  const drops: unknown[] = [];
  transport.on('data', ({ event }) => events.push(event));
  transport.on('disconnected', (event) => drops.push(event));
  return { transport, wires, events, drops };
}

const CONFIG = {
  id: 's1',
  model: 'gemini-live-2.5-flash-preview',
  instructions: 'You take orders.',
  audio: { output: { voice: 'Puck' }, input: { language: 'en-US' } },
} as RealtimeSessionConfig;

test('a Gemini Live update waits for a point Gemini can resume from, then sets up again from the latest handle', async () => {
  const { transport, wires, events, drops } = gemini();
  await transport.connect(CONFIG);
  const first = wires[0] as Wire;
  // An update that changes nothing, as the session sends after it connects, opens nothing.
  transport.sendEvent({
    type: 'session.update',
    session: { type: 'realtime', model: CONFIG.model, instructions: 'You take orders.' },
  });
  first.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  assert.equal(wires.length, 1, 'no new socket for an update that changes nothing');

  // While the model answers, no handle is resumable: the update waits.
  first.reply({ sessionResumptionUpdate: { resumable: false } });
  transport.sendEvent({
    type: 'session.update',
    session: { instructions: 'You take orders, in French.', audio: { output: { voice: 'Kore' } } },
  });
  await tick();
  assert.equal(wires.length, 1, 'not mid-turn');

  // Between turns, Gemini says so, and the session is set up again from that handle.
  first.reply({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  transport.sendAudio(new Uint8Array([1, 2]).buffer);
  await tick();
  assert.equal(first.readyState, 3, 'the old socket closed');
  assert.equal(wires.length, 2);
  const second = wires[1] as Wire;
  const setup = second.sent[0]?.setup;
  assert.deepEqual(setup.sessionResumption, { handle: 'h2' });
  assert.deepEqual(setup.systemInstruction, { parts: [{ text: 'You take orders, in French.' }] });
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(setup.generationConfig.speechConfig.languageCode, 'en-US', 'what the update did not change, kept');
  assert.deepEqual(
    second.sent[1],
    { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: 'AQI=' } } },
    'audio sent meanwhile, after the setup',
  );
  assert.equal(events.at(-1)?.type, 'session.updated');
  assert.deepEqual(drops, [], 'no drop: the conversation carries on');
  assert.equal(transport.state, 'connected');

  // Later updates build on the earlier: tools, turn detection, modalities, and Gemini's own fields.
  second.reply({ sessionResumptionUpdate: { newHandle: 'h3', resumable: true } });
  transport.sendEvent({
    type: 'session.update',
    session: {
      tools: [
        {
          type: 'function',
          name: 'refund',
          description: 'Refunds an order',
          parameters: { type: 'object', properties: {} },
        },
      ],
      audio: { input: { turn_detection: null, transcription: { language: 'fr-FR' } } },
      output_modalities: ['text'],
      contextWindowCompression: { slidingWindow: {} },
    },
  });
  await tick();
  const third = wires[2]?.sent[0]?.setup;
  assert.deepEqual(third.sessionResumption, { handle: 'h3' });
  assert.deepEqual(third.tools, [
    {
      functionDeclarations: [
        { name: 'refund', description: 'Refunds an order', parameters: { type: 'object', properties: {} } },
      ],
    },
  ]);
  assert.deepEqual(third.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
  assert.deepEqual(third.generationConfig.responseModalities, ['TEXT']);
  assert.deepEqual(third.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(
    third.systemInstruction,
    { parts: [{ text: 'You take orders, in French.' }] },
    'the earlier update kept',
  );
  assert.equal(third.generationConfig.speechConfig.languageCode, 'fr-FR');

  // Turning detection back on, a new voice by its old name, a model, and instructions removed.
  wires[2]?.reply({ sessionResumptionUpdate: { newHandle: 'h4', resumable: true } });
  transport.sendEvent({
    type: 'session.update',
    session: {
      audio: { input: { turn_detection: { type: 'server_vad' } } },
      voice: 'Aoede',
      model: 'gemini-live-3',
      instructions: null,
    },
  });
  await tick();
  const fourth = wires[3]?.sent[0]?.setup;
  assert.equal(fourth.realtimeInputConfig, undefined, 'turn detection on again');
  assert.equal(fourth.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.equal(fourth.model, 'models/gemini-live-3');
  assert.equal(fourth.systemInstruction, undefined);
  await transport.disconnect();
});

/** The voice a setup asks for. */
const voiceOf = (setup: Message) => setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName;

test('updates build on what waits or moves, a move waits for a fresh point, and it is announced as an update', async () => {
  let release: (() => void) | undefined;
  const { transport, wires, events } = gemini((wire, index) => {
    // The second socket is set up only when the test lets it be.
    if (index === 1) release = () => wire.reply({ setupComplete: {} });
    else wire.reply({ setupComplete: {} });
  });
  let connected = 0;
  transport.on('connected', () => {
    connected += 1;
  });
  await transport.connect(CONFIG);
  // Two updates while there is no point to resume from: the second builds on the first.
  transport.sendEvent({ type: 'session.update', session: { instructions: 'First.' } });
  transport.sendEvent({ type: 'session.update', session: { audio: { output: { voice: 'Kore' } } } });
  wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  assert.equal(wires.length, 2);
  assert.deepEqual(wires[1]?.sent[0]?.setup.systemInstruction, { parts: [{ text: 'First.' }] });
  assert.equal(voiceOf(wires[1]?.sent[0]?.setup), 'Kore', 'both waiting updates');
  // While it moves, another update builds on where it goes, and waits for a point of the new socket's own.
  transport.sendEvent({
    type: 'session.update',
    session: { audio: { input: { transcription: { language: 'de-DE' } } } },
  });
  release?.();
  await tick();
  assert.equal(wires.length, 2, 'the handle the move used is spent: it waits for a new one');
  wires[1]?.reply({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  await tick();
  assert.equal(wires.length, 3);
  const third = wires[2]?.sent[0]?.setup;
  assert.deepEqual(third.systemInstruction, { parts: [{ text: 'First.' }] }, 'built on the move before it');
  assert.equal(voiceOf(third), 'Kore');
  assert.equal(third.generationConfig.speechConfig.languageCode, 'de-DE');
  assert.deepEqual(third.sessionResumption, { handle: 'h2' });
  assert.equal(connected, 1, 'a move is an update, not a new connection');
  assert.equal(events.filter((event) => event.type === 'session.created').length, 1);
  assert.equal(events.filter((event) => event.type === 'session.updated').length, 2);
  await transport.disconnect();
});

test('one move at a time, though the new socket says it can be resumed before it is set up', async () => {
  let release: (() => void) | undefined;
  const { transport, wires } = gemini((wire, index) => {
    if (index === 1) {
      wire.reply({ sessionResumptionUpdate: { newHandle: 'early', resumable: true } });
      release = () => wire.reply({ setupComplete: {} });
    } else wire.reply({ setupComplete: {} });
  });
  await transport.connect(CONFIG);
  wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  transport.sendEvent({ type: 'session.update', session: { instructions: 'First.' } });
  await tick();
  transport.sendEvent({ type: 'session.update', session: { instructions: 'Second.' } });
  await tick();
  assert.equal(wires.length, 2, 'the second waits for the first to finish');
  release?.();
  await tick();
  assert.equal(wires.length, 3, 'then follows, from the point the new socket gave');
  assert.deepEqual(wires[2]?.sent[0]?.setup.sessionResumption, { handle: 'early' });
  assert.deepEqual(wires[2]?.sent[0]?.setup.systemInstruction, { parts: [{ text: 'Second.' }] });
  await transport.disconnect();
});

test('an update the transport cannot carry: resumption off, a handle not yet given, or a new setup that fails', async () => {
  // Without session resumption, Gemini keeps its setup.
  const plain = gemini();
  const off = new GeminiLiveTransport({
    apiKey: 'k',
    sessionResumption: false,
    webSocketFactory: () => {
      const wire = new Wire((socket) => socket.reply({ setupComplete: {} }));
      plain.wires.push(wire);
      return wire;
    },
  });
  await off.connect(CONFIG);
  plain.wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  off.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  await tick();
  assert.equal(plain.wires.length, 1);
  await off.disconnect();

  // An update before any handle waits for one.
  const early = gemini();
  await early.transport.connect(CONFIG);
  early.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  await tick();
  assert.equal(early.wires.length, 1, 'no handle to resume from yet');
  early.wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  assert.equal(early.wires.length, 2, 'set up once one arrives');
  // An update reverted before it was made is not made.
  early.wires[1]?.reply({ sessionResumptionUpdate: { resumable: false } });
  early.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed again' } });
  early.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  early.wires[1]?.reply({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  await tick();
  assert.equal(early.wires.length, 2, 'back to what it is');
  await early.transport.disconnect();

  // An update still waiting when the socket drops is lost with it.
  const dropped = gemini();
  await dropped.transport.connect(CONFIG);
  dropped.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  dropped.wires[0]?.close(1011, 'gone');
  await dropped.transport.connect(CONFIG);
  dropped.wires[1]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  await tick();
  assert.equal(dropped.wires.length, 2, 'no move for the lost update');
  await dropped.transport.disconnect();

  // A new setup that fails is a drop the session's reconnect policy decides on.
  const failing = gemini((wire, index) =>
    index === 1 ? wire.close(1011, 'overloaded') : wire.reply({ setupComplete: {} }),
  );
  const errors: string[] = [];
  failing.transport.on('error', (error) => errors.push(error.code ?? ''));
  await failing.transport.connect(CONFIG);
  failing.wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  failing.transport.sendAudio(new Uint8Array([1]).buffer);
  failing.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  failing.transport.sendAudio(new Uint8Array([2]).buffer);
  await tick();
  assert.deepEqual(errors, ['session_update_failed']);
  assert.equal((failing.drops[0] as { expected: boolean; retryable: boolean }).expected, false);
  assert.equal((failing.drops[0] as { retryable: boolean }).retryable, true);
  assert.equal(failing.transport.state, 'failed');
  assert.deepEqual(failing.wires[1]?.sent.slice(1), [], 'what waited is not sent to a socket that was never set up');
  await failing.transport.connect(CONFIG);
  assert.equal(failing.wires.length, 3, 'a reconnect follows as for any drop');
  failing.wires[2]?.reply({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  failing.transport.sendEvent({ type: 'session.update', session: { instructions: 'Changed' } });
  await tick();
  assert.equal(failing.wires.length, 4);
  assert.deepEqual(failing.wires[3]?.sent.slice(1), [], 'the audio that waited for the failed setup is never sent');
  assert.deepEqual(
    failing.wires[2]?.sent[0]?.setup.systemInstruction,
    { parts: [{ text: 'You take orders.' }] },
    'from the session’s configuration',
  );
});

test('a session’s updateSession() reaches Gemini Live through the move, and its tools keep running', async () => {
  const wires: Wire[] = [];
  const provider = new GeminiLiveProvider({
    apiKey: 'k',
    webSocketFactory: () => {
      const wire = new Wire((socket) => socket.reply({ setupComplete: {} }));
      wires.push(wire);
      return wire;
    },
  });
  const lookup = defineTool({
    name: 'lookup',
    description: 'Looks an order up',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ found: true }),
  });
  const session = provider.createSession({
    model: 'gemini-live-2.5-flash-preview',
    instructions: 'Help.',
    tools: [lookup],
  });
  await session.connect();
  await tick();
  assert.equal(wires.length, 1, 'the session’s own update after connecting changes nothing');
  wires[0]?.reply({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  session.updateSession({ instructions: 'Help, briefly.' });
  await tick();
  assert.equal(wires.length, 2);
  assert.deepEqual(wires[1]?.sent[0]?.setup.systemInstruction, { parts: [{ text: 'Help, briefly.' }] });
  assert.deepEqual(
    wires[1]?.sent[0]?.setup.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name),
    ['lookup'],
    'the tools the setup declared, still declared',
  );
  wires[1]?.reply({ toolCall: { functionCalls: [{ id: 'fc_9', name: 'lookup', args: {} }] } });
  await tick(30);
  assert.deepEqual(wires[1]?.sent.find((message) => message.toolResponse)?.toolResponse, {
    functionResponses: [{ id: 'fc_9', name: 'lookup', response: { found: true } }],
  });
  await session.disconnect();
});

test('an image is kept in the record, by content or by digest, and given back to a resumed session', async () => {
  const wires: Wire[] = [];
  const provider = new GeminiLiveProvider({
    apiKey: 'k',
    webSocketFactory: () => {
      const wire = new Wire((socket) => socket.reply({ setupComplete: {} }));
      wires.push(wire);
      return wire;
    },
  });
  const photo = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const digest = createHash('sha256').update(photo).digest('hex');
  const url = `data:image/png;base64,${Buffer.from(photo).toString('base64')}`;
  const session = provider.createSession({
    model: 'gemini-live-2.5-flash-preview',
    conversation: { captureTranscripts: true },
  });
  const shown: unknown[] = [];
  session.on('message.image', (event) => shown.push(event));
  await session.connect();
  session.sendImage(photo, { mimeType: 'image/png', text: 'What is this?' });
  session.sendImage(Buffer.from(photo).toString('base64'), { mimeType: 'image/png' });
  session.sendVideoFrame(new Uint8Array([9, 9, 9]));
  await tick(20);
  const record = session.getConversation();
  const images = record.items.filter((item) => item.type === 'image');
  assert.deepEqual(
    images.map((item) => ({ ...item, id: undefined, createdAt: undefined })),
    [
      { id: undefined, createdAt: undefined, type: 'image', role: 'user', mimeType: 'image/png', digest, url },
      { id: undefined, createdAt: undefined, type: 'image', role: 'user', mimeType: 'image/png', digest, url },
    ],
    'both images, and no video frame',
  );
  assert.equal(shown.length, 2);
  assert.deepEqual(
    record.items.map((item) => item.type),
    ['image', 'image', 'text_message'],
    'each image as it was sent, then the words the provider gave back',
  );
  const exported = session.export('text') as string;
  assert.match(exported, /\[User showed an image, image\/png\]\nUser: What is this\?/);
  assert.equal((session.export('analytics') as { itemCounts: { image: number } }).itemCounts.image, 2);
  await session.disconnect();

  // A resumed session gives the image back, as it was.
  const replay = replayRealtimeConversation(record);
  assert.deepEqual(replay[0], {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: url }],
      id: replay[0]?.item && (replay[0].item as { id: string }).id,
    },
  });
  const resumed = provider.createSession({ model: 'gemini-live-2.5-flash-preview', resume: record });
  await resumed.connect();
  await tick(20);
  const turns = (wires.at(-1) as Wire).sent.filter((message) => message.clientContent?.turns);
  assert.deepEqual(turns[0]?.clientContent.turns[0].parts, [
    { inlineData: { mimeType: 'image/png', data: Buffer.from(photo).toString('base64') } },
  ]);
  assert.equal(
    resumed.getConversation().items.filter((item) => item.type === 'image').length,
    2,
    'given back, not recorded twice',
  );
  await resumed.disconnect();

  // By digest alone, the record holds no picture, and nothing is given back.
  const lean = provider.createSession({
    model: 'gemini-live-2.5-flash-preview',
    conversation: { recordImages: 'digest' },
  });
  await lean.connect();
  lean.sendImage(photo, { mimeType: 'image/png' });
  const kept = lean.getConversation().items.find((item) => item.type === 'image');
  assert.deepEqual(
    kept && {
      mimeType: (kept as { mimeType: string }).mimeType,
      digest: (kept as { digest: string }).digest,
      url: (kept as { url?: string }).url,
    },
    {
      mimeType: 'image/png',
      digest,
      url: undefined,
    },
  );
  assert.deepEqual(replayRealtimeConversation(lean.getConversation()), []);
  await lean.disconnect();
});

test('an image sent to a session without its own transport events is recorded, and stored with the record', async () => {
  const saved: unknown[] = [];
  const session = new RealtimeSession({
    model: 'gpt-realtime',
    transport: {
      kind: 'websocket',
      on: () => () => undefined,
      connect: async () => undefined,
      sendAudio: () => undefined,
      sendEvent: () => undefined,
      interrupt: () => undefined,
      disconnect: async () => undefined,
    },
    conversationStore: {
      put: async (conversation: unknown) => {
        saved.push(conversation);
      },
      get: async () => undefined,
    } as never,
  });
  await session.connect();
  assert.equal(session.sendVideoFrame(new Uint8Array([7])), true);
  assert.deepEqual(session.getConversation().items, [], 'a frame, sent as an image, is not kept');
  session.sendImage(new Uint8Array([1]), { mimeType: 'image/jpeg' });
  await tick(10);
  assert.equal(session.getConversation().items[0]?.type, 'image');
  assert.ok(saved.length >= 1, 'an image is committed to the store, as a finished message is');
});
