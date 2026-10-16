/**
 * Gemini Live behind the realtime session, proved: one agent definition (its instructions, its tool,
 * its conversation settings) runs on OpenAI's realtime API and on Gemini Live, each over its own wire
 * protocol, and the two conversations come out the same: what the person said, the tool the model
 * called and what it returned, what the model answered, and what it all cost. Then Gemini's own: its
 * setup, credentials, session resumption, interruptions, cancelled tool calls, video, and a resumed
 * conversation given back as Gemini turns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiLiveTransport } from '../src/realtime/gemini-live.transport.js';
import type { RealtimeWebSocketLike } from '../src/realtime/openai-websocket.transport.js';
import {
  createRealtimeAgent,
  GeminiLiveProvider,
  OpenAIRealtimeProvider,
  type RealtimeTransportProvider,
} from '../src/realtime/provider.js';
import { RealtimeSession } from '../src/realtime/session.js';
import { defineTool } from '../src/realtime/tools.js';
import type {
  RealtimeClientEvent,
  RealtimeConversation,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportEvents,
} from '../src/realtime/types.js';
import { TypedEventEmitter } from '../src/realtime/events.js';

// biome-ignore lint/suspicious/noExplicitAny: the other side of the wire has no types to borrow.
type Message = Record<string, any>;

/** A provider's end of the socket: it hears what the transport sends and answers as the provider would. */
class Wire implements RealtimeWebSocketLike {
  readyState = 0;
  binaryType?: string;
  readonly sent: Message[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    private readonly server: (wire: Wire, message: Message) => void,
  ) {
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
    this.server(this, message);
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

/** What happens in the conversation, whichever provider carries it. */
const SCRIPT = {
  said: ['Where is ', 'order 42?'],
  call: { name: 'track_order', args: { order: 42 } },
  answer: ['Order 42 ', 'shipped on Monday.'],
  /** Tokens for the turn that calls the tool, and for the one that answers. */
  usage: [
    { input: 10, output: 2 },
    { input: 20, output: 8 },
  ],
};

/** OpenAI's realtime API, playing the script. */
function openAIServer() {
  const wires: Wire[] = [];
  let answered = false;
  const server = (wire: Wire, message: Message) => {
    if (message.type === 'session.update') wire.reply({ type: 'session.updated', session: message.session });
    if (message.type === 'response.create' && wire.sent.some((sent) => sent.item?.type === 'function_call_output')) {
      if (answered) return;
      answered = true;
      wire.reply({ type: 'response.created', response: { id: 'resp_2' } });
      wire.reply({ type: 'response.output_audio.delta', response_id: 'resp_2', item_id: 'item_2', delta: 'AAAA' });
      for (const delta of SCRIPT.answer) {
        wire.reply({ type: 'response.output_audio_transcript.delta', response_id: 'resp_2', item_id: 'item_2', delta });
      }
      wire.reply({
        type: 'response.output_audio_transcript.done',
        response_id: 'resp_2',
        item_id: 'item_2',
        transcript: SCRIPT.answer.join(''),
      });
      wire.reply({
        type: 'response.done',
        response: {
          id: 'resp_2',
          status: 'completed',
          output: [],
          usage: { input_tokens: SCRIPT.usage[1]?.input, output_tokens: SCRIPT.usage[1]?.output },
        },
      });
    }
  };
  return {
    provider: new OpenAIRealtimeProvider({
      defaultTransport: 'websocket',
      apiKey: 'server-key',
      websocket: {
        webSocketFactory: (url) => {
          const wire = new Wire(url, server);
          wires.push(wire);
          return wire;
        },
      },
    }),
    wires,
    /** The person asks, and the model calls the tool. */
    speak() {
      const wire = wires.at(-1) as Wire;
      wire.reply({ type: 'session.created', session: { id: 'sess_openai' } });
      wire.reply({ type: 'input_audio_buffer.speech_started', item_id: 'user_1' });
      wire.reply({ type: 'input_audio_buffer.speech_stopped', item_id: 'user_1' });
      wire.reply({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'user_1',
        transcript: SCRIPT.said.join(''),
      });
      wire.reply({ type: 'response.created', response: { id: 'resp_1' } });
      wire.reply({
        type: 'response.done',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: SCRIPT.call.name,
              arguments: JSON.stringify(SCRIPT.call.args),
            },
          ],
          usage: { input_tokens: SCRIPT.usage[0]?.input, output_tokens: SCRIPT.usage[0]?.output },
        },
      });
    },
  };
}

/** Gemini Live, playing the same script over its own protocol. */
function geminiServer() {
  const wires: Wire[] = [];
  const usage = (turn: number) => ({
    promptTokenCount: SCRIPT.usage[turn]?.input,
    responseTokenCount: SCRIPT.usage[turn]?.output,
    totalTokenCount: (SCRIPT.usage[turn]?.input ?? 0) + (SCRIPT.usage[turn]?.output ?? 0),
  });
  const server = (wire: Wire, message: Message) => {
    if (message.setup) wire.reply({ setupComplete: {} });
    if (message.toolResponse) {
      wire.reply({
        serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } },
      });
      for (const text of SCRIPT.answer) wire.reply({ serverContent: { outputTranscription: { text } } });
      wire.reply({ serverContent: { generationComplete: true } });
      wire.reply({ serverContent: { turnComplete: true }, usageMetadata: usage(1) });
    }
  };
  return {
    provider: new GeminiLiveProvider({
      apiKey: 'server-key',
      webSocketFactory: (url) => {
        const wire = new Wire(url, server);
        wires.push(wire);
        return wire;
      },
    }),
    wires,
    /** The person asks, and the model calls the tool. */
    speak() {
      const wire = wires.at(-1) as Wire;
      for (const text of SCRIPT.said) wire.reply({ serverContent: { inputTranscription: { text } } });
      wire.reply({
        toolCall: { functionCalls: [{ id: 'fc_1', name: SCRIPT.call.name, args: SCRIPT.call.args }] },
        usageMetadata: usage(0),
      });
    },
  };
}

/** The agent: one definition, whichever provider runs it. */
const runs: unknown[] = [];
const trackOrder = defineTool({
  name: 'track_order',
  description: 'Where an order is',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { order: { type: 'number' } },
    required: ['order'],
  },
  execute: async ({ order }) => {
    runs.push(order);
    return { status: 'shipped', day: 'Monday' };
  },
});
const agent = (provider: RealtimeTransportProvider, model: string, voice: string) =>
  createRealtimeAgent({
    provider,
    model,
    instructions: 'You track orders. Answer in one sentence.',
    tools: [trackOrder],
    voice: { voice, transport: 'websocket', interruption: true },
    conversation: { captureTranscripts: true },
  });

const settle = async (session: RealtimeSession) => {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  await session.whenIdle();
};

/** A conversation as what happened in it, in order. */
const story = (conversation: RealtimeConversation) =>
  conversation.items.flatMap((item) => {
    if (item.type === 'user_speech') return [`person: ${item.transcript}`];
    if (item.type === 'assistant_speech') return [`model: ${item.transcript}`];
    if (item.type === 'tool_call') return [`calls ${item.name} ${JSON.stringify(item.arguments)}`];
    if (item.type === 'tool_result') return [`${item.name} returns ${JSON.stringify(item.result)}`];
    return [];
  });

test('proof: one agent definition holds the same conversation on OpenAI realtime and on Gemini Live', async () => {
  const providers = [
    { name: 'openai', model: 'gpt-realtime', voice: 'marin', server: openAIServer() },
    { name: 'google', model: 'gemini-live-2.5-flash-preview', voice: 'Kore', server: geminiServer() },
  ];
  const stories: string[][] = [];
  runs.length = 0;
  for (const { name, model, voice, server } of providers) {
    const session = agent(server.provider, model, voice);
    await session.connect();
    server.speak();
    await settle(session);
    const conversation = session.getConversation();
    stories.push(story(conversation));
    assert.equal(conversation.provider, name, `${name}: the record names its provider`);
    assert.equal(session.getMetrics().inputTokens, 30, `${name}: the usage of both turns`);
    assert.equal(session.getMetrics().outputTokens, 10, name);
    assert.equal(session.getMetrics().toolCalls, 1, name);
    await session.disconnect();
  }
  assert.deepEqual(stories[0], [
    'person: Where is order 42?',
    'calls track_order {"order":42}',
    'track_order returns {"status":"shipped","day":"Monday"}',
    'model: Order 42 shipped on Monday.',
  ]);
  assert.deepEqual(stories[1], stories[0], 'the same conversation on Gemini Live');
  assert.deepEqual(runs, [42, 42], 'the tool ran once on each');

  // On Gemini's wire: the setup the definition describes, and the tool's result as Gemini takes it.
  const geminiWire = providers[1]?.server.wires[0] as Wire;
  const gemini = geminiWire.sent;
  assert.match(geminiWire.url, /BidiGenerateContent\?key=server-key$/);
  assert.deepEqual(gemini[0]?.setup, {
    model: 'models/gemini-live-2.5-flash-preview',
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
    systemInstruction: { parts: [{ text: 'You track orders. Answer in one sentence.' }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: 'track_order',
            description: 'Where an order is',
            parameters: { type: 'object', properties: { order: { type: 'number' } }, required: ['order'] },
          },
        ],
      },
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
  });
  assert.deepEqual(
    gemini.slice(1),
    [
      {
        toolResponse: {
          functionResponses: [{ id: 'fc_1', name: 'track_order', response: { status: 'shipped', day: 'Monday' } }],
        },
      },
    ],
    'only the setup and the tool response: Gemini goes on by itself after a tool response',
  );
});

test('Gemini Live takes an API key on a server, an ephemeral token anywhere, and refuses a key in a browser', async () => {
  const config = { id: 's', model: 'gemini-live-2.5-flash-preview' } as RealtimeSessionConfig;
  const urls: string[] = [];
  const factory = (url: string) => {
    urls.push(url);
    return new Wire(url, (wire, message) => {
      if (message.setup) wire.reply({ setupComplete: {} });
    });
  };
  const token = new GeminiLiveTransport({
    ephemeralTokenProvider: async () => 'auth_tokens/abc',
    webSocketFactory: factory,
  });
  await token.connect(config);
  assert.match(
    urls[0] as string,
    /v1alpha\.GenerativeService\.BidiGenerateContentConstrained\?access_token=auth_tokens%2Fabc$/,
  );
  await token.disconnect();
  assert.equal(token.state, 'disconnected');

  await assert.rejects(new GeminiLiveTransport({ webSocketFactory: factory }).connect(config), {
    code: 'missing_credentials',
  });
  const scope = globalThis as { document?: unknown };
  scope.document = {};
  try {
    await assert.rejects(new GeminiLiveTransport({ apiKey: 'secret' }).connect(config), {
      code: 'unsafe_browser_auth',
    });
  } finally {
    delete scope.document;
  }

  const refused = new GeminiLiveTransport({
    apiKey: 'bad',
    webSocketFactory: (url) =>
      new Wire(url, (wire, message) => {
        if (message.setup) wire.close(1008, 'API key not valid');
      }),
  });
  await assert.rejects(refused.connect(config), (error: { code?: string; retryable?: boolean; message: string }) => {
    assert.equal(error.code, 'websocket_closed_during_connect');
    assert.equal(error.retryable, false, 'a refused key is refused again');
    assert.match(error.message, /API key not valid/);
    return true;
  });
});

test('a dropped Gemini Live socket reconnects with the latest resumption handle', async () => {
  const wires: Wire[] = [];
  const transport = new GeminiLiveTransport({
    apiKey: 'k',
    webSocketFactory: (url) => {
      const wire = new Wire(url, (socket, message) => {
        if (message.setup) socket.reply({ setupComplete: {} });
      });
      wires.push(wire);
      return wire;
    },
  });
  const seen: RealtimeServerEvent[] = [];
  const drops: Array<{ retryable?: boolean; expected?: boolean }> = [];
  transport.on('data', ({ event }) => seen.push(event));
  transport.on('disconnected', (event) => drops.push(event));
  const config = { id: 's', model: 'gemini-live-2.5-flash-preview' } as RealtimeSessionConfig;
  await transport.connect(config);
  const first = wires[0] as Wire;
  first.reply({ sessionResumptionUpdate: { newHandle: 'handle_1', resumable: true } });
  first.reply({ sessionResumptionUpdate: { newHandle: 'handle_unusable', resumable: false } });
  first.reply({ goAway: { timeLeft: '10s' } });
  assert.equal(seen.find((event) => event.type === 'session.go_away')?.time_left, '10s', 'Gemini says it will close');
  first.close(1011, 'going away');
  assert.deepEqual(
    drops.map(({ retryable, expected }) => ({ retryable, expected })),
    [{ retryable: true, expected: false }],
  );
  await transport.connect(config);
  assert.deepEqual(wires[1]?.sent[0]?.setup.sessionResumption, { handle: 'handle_1' }, 'the latest resumable handle');
  await transport.disconnect();
});

test('Gemini Live interruptions cancel the response, and a cancelled tool call is not answered', async () => {
  const server = geminiServer();
  const session = agent(server.provider, 'gemini-live-2.5-flash-preview', 'Kore');
  const cancelled: string[] = [];
  const interruptions: string[] = [];
  session.on('assistant.response.cancelled', (event) => cancelled.push(event.responseId));
  session.on('interruption', (event) => interruptions.push(event.reason));
  await session.connect();
  const wire = server.wires[0] as Wire;
  wire.reply({ serverContent: { inputTranscription: { text: 'Tell me a story' } } });
  wire.reply({
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } },
  });
  // Gemini's transcription trails the speech: the last words arrive as the model starts answering.
  wire.reply({ serverContent: { inputTranscription: { text: ' about the sea' } } });
  await settle(session);
  assert.deepEqual(interruptions, [], 'late words of the turn being answered are not the person speaking over it');
  wire.reply({ serverContent: { interrupted: true } });
  wire.reply({ serverContent: { inputTranscription: { text: 'Wait' } } });
  await settle(session);
  assert.equal(cancelled.length, 1, 'the person spoke over the model: its response is cancelled');
  assert.deepEqual(interruptions, ['barge_in'], 'and the session records the barge-in');
  wire.reply({ serverContent: { turnComplete: true } });
  await settle(session);
  assert.deepEqual(
    session
      .getConversation()
      .items.filter((item) => item.type === 'user_speech')
      .map((item) => (item as { transcript?: string }).transcript),
    ['Tell me a story about the sea', 'Wait'],
    'the late words join their turn, and what the person said over the model is a turn of its own',
  );

  wire.reply({ toolCall: { functionCalls: [{ id: 'fc_9', name: 'track_order', args: { order: 7 } }] } });
  wire.reply({ toolCallCancellation: { ids: ['fc_9'] } });
  await settle(session);
  assert.equal(
    wire.sent.filter((message) => message.toolResponse || message.clientContent?.turnComplete).length,
    0,
    'Gemini cancelled the call: neither its result nor a request for a response is sent',
  );
  await session.disconnect();
});

test('video frames stream to Gemini Live as realtime input, spaced out, and an image goes into the conversation', async () => {
  const server = geminiServer();
  let now = 1_000;
  const session = server.provider.createSession({
    model: 'gemini-live-2.5-flash-preview',
    clock: { now: () => now, sleep: async () => undefined },
    video: { minIntervalMs: 500 },
    conversation: { captureTranscripts: true },
  });
  await session.connect();
  const wire = server.wires[0] as Wire;
  assert.equal(session.sendVideoFrame(new Uint8Array([1, 2, 3])), true);
  now += 100;
  assert.equal(session.sendVideoFrame(new Uint8Array([4, 5, 6])), false, 'too soon after the last frame');
  now += 500;
  assert.equal(session.sendVideoFrame(new Uint8Array([7, 8, 9]), 'image/png'), true);
  assert.deepEqual(
    wire.sent.filter((message) => message.realtimeInput?.video).map((message) => message.realtimeInput.video),
    [
      { mimeType: 'image/jpeg', data: 'AQID' },
      { mimeType: 'image/png', data: 'BwgJ' },
    ],
  );

  session.sendImage(new Uint8Array([1, 2, 3]), { mimeType: 'image/png', text: 'What is in this picture?' });
  await settle(session);
  assert.deepEqual(wire.sent.slice(-2), [
    {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }, { text: 'What is in this picture?' }],
          },
        ],
        turnComplete: false,
      },
    },
    { clientContent: { turnComplete: true } },
  ]);
  assert.deepEqual(
    session
      .getConversation()
      .items.filter((item) => item.type === 'text_message')
      .map((item) => (item as { text: string }).text),
    ['What is in this picture?'],
    'what was asked about the image is in the record',
  );
  await session.disconnect();
});

test('on a provider without video input, frames go into the conversation as images', async () => {
  class Transport implements RealtimeTransport {
    readonly kind = 'websocket' as const;
    readonly sent: RealtimeClientEvent[] = [];
    private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();
    on<Event extends keyof RealtimeTransportEvents>(
      event: Event,
      listener: (payload: RealtimeTransportEvents[Event]) => void,
    ) {
      return this.emitter.on(event, listener);
    }
    async connect() {
      this.emitter.emit('connected', { sessionId: 'p', transport: this.kind, timestamp: 0 });
    }
    sendAudio() {}
    sendEvent(event: RealtimeClientEvent) {
      this.sent.push(event);
    }
    interrupt() {}
    async disconnect() {
      this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
    }
  }
  const transport = new Transport();
  const session = new RealtimeSession({ model: 'gpt-realtime', transport });
  await session.connect();
  assert.equal(session.sendVideoFrame(new Uint8Array([1, 2, 3])), true);
  assert.deepEqual(transport.sent.slice(1), [
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AQID' }],
      },
    },
  ]);
  await session.disconnect();
});

test('a resumed conversation is given back to Gemini Live as its turns, tool calls and all', async () => {
  const server = geminiServer();
  const session = server.provider.createSession({
    model: 'gemini-live-2.5-flash-preview',
    conversation: { captureTranscripts: true },
    resume: {
      id: 'conv_1',
      provider: 'google',
      model: 'gemini-live-2.5-flash-preview',
      startedAt: '2026-10-16T09:00:00.000Z',
      status: 'failed',
      metrics: { turns: 1 } as never,
      items: [
        {
          id: 'i1',
          createdAt: '2026-10-16T09:00:01.000Z',
          type: 'user_speech',
          transcript: 'Where is order 42?',
        } as never,
        {
          id: 'i2',
          createdAt: '2026-10-16T09:00:02.000Z',
          type: 'tool_call',
          callId: 'fc_1',
          name: 'track_order',
          arguments: { order: 42 },
          status: 'completed',
        },
        {
          id: 'i3',
          createdAt: '2026-10-16T09:00:03.000Z',
          type: 'tool_result',
          callId: 'fc_1',
          name: 'track_order',
          result: { status: 'shipped' },
          durationMs: 40,
        },
        {
          id: 'i4',
          createdAt: '2026-10-16T09:00:04.000Z',
          type: 'assistant_speech',
          transcript: 'It shipped.',
        } as never,
      ],
    },
  });
  await session.connect();
  const wire = server.wires[0] as Wire;
  assert.deepEqual(
    wire.sent.slice(1).map((message) => message.clientContent?.turns?.[0]),
    [
      { role: 'user', parts: [{ text: 'Where is order 42?' }] },
      { role: 'model', parts: [{ functionCall: { id: 'fc_1', name: 'track_order', args: { order: 42 } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'fc_1', name: 'track_order', response: { status: 'shipped' } } }],
      },
      { role: 'model', parts: [{ text: 'It shipped.' }] },
    ],
  );
  await settle(session);
  assert.equal(session.getConversation().items.length, 4, 'what was given back is not recorded twice');
  await session.disconnect();
});
