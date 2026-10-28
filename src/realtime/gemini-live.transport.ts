/**
 * Gemini Live behind the realtime session: a transport that speaks Gemini's Live API over a WebSocket
 * and translates, both ways, between it and the events the session speaks. The session, its tools,
 * its conversation record, and its lifecycle are the same on either provider.
 *
 * What the session sends becomes Gemini's: its configuration the `setup` message, audio and video
 * frames `realtimeInput`, conversation items `clientContent` turns, and a tool's result a
 * `toolResponse`. What Gemini sends becomes the session's: audio and text as response deltas,
 * transcriptions as transcripts, a `toolCall` as a finished response that calls the tools, and a turn's
 * end as a finished response with its usage.
 */
import { RealtimeError, toRealtimeError } from './errors.js';
import { TypedEventEmitter } from './events.js';
import type {
  OpenAIEphemeralTokenProvider,
  OpenAIWebSocketFactory,
  RealtimeWebSocketLike,
} from './openai-websocket.transport.js';
import {
  type AbortSignalLike,
  defaultTimerPlatform,
  defaultUtf8Codec,
  encodeBase64,
  eventPayload,
  isRecord,
  listen,
  onAbort,
  PortableAbortController,
  safeJsonParse,
  type TimerPlatform,
  type TransportCleanup,
  type Utf8Codec,
  waitForTransportOperation,
} from './transport-utils.js';
import type {
  AnyRealtimeTool,
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from './types.js';

const API_KEY_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const TOKEN_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
const DEFAULT_MAX_AUDIO_BYTES = 15 * 1024 * 1024;

/** Options for the Gemini Live transport. */
export interface GeminiLiveTransportOptions {
  /** Gemini API key, sent as the `key` query parameter. Keep it on a server; a browser uses an ephemeral token. */
  apiKey?: string;
  /** An ephemeral token already issued, sent as `access_token` to the constrained endpoint. */
  ephemeralToken?: string;
  /** Fetches an ephemeral token when connecting. */
  ephemeralTokenProvider?: OpenAIEphemeralTokenProvider;
  /** The Live endpoint. Defaults to the Gemini API's, for a key or a token. */
  url?: string;
  /** Opens the socket. Defaults to the global `WebSocket`. */
  webSocketFactory?: OpenAIWebSocketFactory;
  /** Setup fields beyond what the session's configuration says, such as `contextWindowCompression`. */
  setup?: Record<string, unknown>;
  /**
   * Asks Gemini for session-resumption handles and reconnects with the latest, so a dropped socket
   * picks the conversation up where Gemini left it. Defaults to true.
   */
  sessionResumption?: boolean;
  /** Fails the connection if it is not set up within this many milliseconds. Defaults to 10 seconds. */
  connectTimeoutMs?: number;
  /** How long `disconnect()` waits for the socket to close cleanly. Defaults to 1 second. */
  disconnectTimeoutMs?: number;
  /** Largest audio chunk `sendAudio()` accepts, in bytes. Defaults to 15 MiB. */
  maxAudioChunkBytes?: number;
  /** Decodes binary frames, for runtimes without `TextDecoder`. */
  codec?: Utf8Codec;
  /** Replaces timers, for tests. */
  timers?: TimerPlatform;
  /** Replaces the system clock, for tests. */
  now?: () => number;
}

type GeminiEventMap = RealtimeTransportEvents & Record<string, unknown>;
type GeminiPart = Record<string, unknown>;

/**
 * Gemini Live over a WebSocket, behind the realtime session. Pass it as a session's `transport`, with
 * `provider: 'google'`, or create sessions through `GeminiLiveProvider` from `nexus-ai-pro/realtime`.
 */
export class GeminiLiveTransport implements RealtimeTransport {
  /** Always `websocket`. */
  readonly kind = 'websocket' as const;
  /** Current connection state. */
  state: RealtimeTransportState = 'idle';

  private readonly emitter = new TypedEventEmitter<GeminiEventMap>();
  private readonly cleanups: TransportCleanup[] = [];
  private socket?: RealtimeWebSocketLike;
  private generation = 0;
  private expectedClose = false;
  private disconnectEmitted = false;
  private connectAbort?: PortableAbortController;
  private inputRate = 16_000;
  /** The latest handle Gemini gave for resuming this session. */
  private resumptionHandle?: string;
  /** Whether the latest handle can resume the session now, between turns. */
  private resumable = false;
  /** The configuration the socket was set up with, which an update changes. */
  private config?: RealtimeSessionConfig;
  /** A configuration an update asked for, waiting for a point Gemini can resume from. */
  private pendingConfig?: RealtimeSessionConfig;
  /** The configuration the latest move set up, which an update made while it moves builds on. */
  private target?: RealtimeSessionConfig;
  /** Set while the socket is replaced for an update: what is sent meanwhile waits, in order. */
  private moving = false;
  private readonly outbox: string[] = [];
  /** Tool calls Gemini is waiting on, by id, with their names, which a response must carry back. */
  private readonly pendingCalls = new Map<string, string>();
  /** Tool calls Gemini cancelled, whose results it no longer wants. */
  private readonly cancelledCalls = new Set<string>();
  /** The names of the tool calls a resumed session gave back, for their results. */
  private readonly replayedCalls = new Map<string, string>();
  private sentItems = 0;
  /** Set when a tool's result was sent: Gemini goes on by itself, so the session's next ask is dropped. */
  private toolResponded = false;
  private turns = 0;
  private responseId?: string;
  private assistantItemId?: string;
  private assistantTranscript = '';
  private assistantText = '';
  /** The person's turn while they speak. */
  private userItemId?: string;
  private userTranscript = '';
  /** The person's turn the model is answering, whose transcript may still be arriving. */
  private heardItemId?: string;
  private heardTranscript = '';
  private usage?: Record<string, unknown>;

  constructor(private readonly options: GeminiLiveTransportOptions = {}) {}

  /** Subscribes to a transport event. Returns a function that unsubscribes. */
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Opens the socket, sends the setup the session's configuration describes, and resolves once Gemini has it. */
  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting' || this.state === 'disconnecting') throw this.invalidState('connect');
    this.cleanupListeners();
    this.state = 'connecting';
    this.expectedClose = false;
    this.disconnectEmitted = false;
    this.resetTurn();
    this.inputRate = config.audio?.input?.format?.rate ?? 16_000;
    this.config = config;
    this.pendingConfig = undefined;
    this.target = undefined;
    this.resumable = false;
    const generation = ++this.generation;
    const externalSignal = config.connection?.signal || config.signal;
    const controller = new PortableAbortController();
    this.connectAbort = controller;
    const signal = controller.signal;
    this.cleanups.push(
      onAbort(externalSignal, () => {
        controller.abort(externalSignal?.reason);
        if (this.state === 'connected') void this.disconnect();
      }),
    );
    try {
      await this.open(config, signal, generation);
    } catch (error) {
      const current = generation === this.generation;
      if (current) {
        this.state = 'failed';
        this.cleanupListeners();
        this.closeSocket(4000, 'connection failed');
        this.socket = undefined;
        this.connectAbort = undefined;
      }
      const normalized = toRealtimeError(error, {
        message: error instanceof RealtimeError ? error.message : 'Gemini Live connection failed',
        code: error instanceof RealtimeError ? error.code : 'websocket_connection_failed',
        category: error instanceof RealtimeError ? error.category : 'network',
        provider: 'google',
        retryable: error instanceof RealtimeError ? error.retryable : true,
      });
      if (current) this.emitter.emit('error', normalized);
      throw normalized;
    }
  }

  /** Resolves the credential, opens a socket, and sets it up with the configuration given. */
  private async open(config: RealtimeSessionConfig, signal: AbortSignalLike, generation: number): Promise<void> {
    {
      if (signal?.aborted) throw this.abortError(signal.reason);
      const token = await waitForTransportOperation(this.resolveToken(config, signal), {
        signal,
        timers: this.timers(),
        timeoutMs: this.options.connectTimeoutMs ?? 10_000,
        abortError: (reason) => this.abortError(reason),
        timeoutError: () =>
          new RealtimeError({
            message: 'Gemini Live credential resolution timed out',
            code: 'connection_timeout',
            category: 'timeout',
            provider: 'google',
            retryable: true,
          }),
      });
      if (generation !== this.generation || (this.state !== 'connecting' && !this.moving)) throw this.abortError();
      const ephemeral = token.kind === 'token';
      const browser = typeof (globalThis as { document?: unknown }).document !== 'undefined';
      if (!ephemeral && browser && !this.options.webSocketFactory) {
        throw new RealtimeError({
          message: 'A Gemini API key cannot be sent from a browser; use an ephemeral token',
          code: 'unsafe_browser_auth',
          category: 'authentication',
          provider: 'google',
        });
      }
      const base = this.options.url || (ephemeral ? TOKEN_URL : API_KEY_URL);
      const url = `${base}${base.includes('?') ? '&' : '?'}${ephemeral ? 'access_token' : 'key'}=${encodeURIComponent(token.value)}`;
      const socket = this.options.webSocketFactory
        ? this.options.webSocketFactory(url, { headers: {} })
        : this.globalSocket(url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      await this.awaitSetup(socket, config, signal, generation);
    }
  }

  /** Sends microphone audio as `realtimeInput`, at the sample rate the session's input format names. */
  sendAudio(chunk: ArrayBuffer): void {
    const limit = this.options.maxAudioChunkBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (chunk.byteLength > limit) {
      const error = new RealtimeError({
        message: `Realtime audio chunk exceeds the ${limit} byte limit`,
        code: 'audio_too_large',
        category: 'configuration',
        provider: 'google',
      });
      this.emitter.emit('error', error);
      throw error;
    }
    this.send({
      realtimeInput: { audio: { mimeType: `audio/pcm;rate=${this.inputRate}`, data: encodeBase64(chunk) } },
    });
  }

  /** Streams one frame of video as `realtimeInput`. Gemini takes about one a second. */
  sendVideo(frame: ArrayBuffer, mimeType: string): void {
    this.send({ realtimeInput: { video: { mimeType, data: encodeBase64(frame) } } });
  }

  /**
   * Translates one of the session's events into Gemini's: conversation items into turns, a tool's
   * result into a `toolResponse`, a request for a response into the end of the user's turn, and a
   * session update into a new setup, resumed. Events Gemini has no counterpart for, such as a
   * truncation, are dropped.
   */
  sendEvent(event: RealtimeClientEvent): void {
    switch (event.type) {
      case 'input_audio_buffer.append':
        if (typeof event.audio === 'string') {
          this.send({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${this.inputRate}`, data: event.audio } } });
        }
        return;
      case 'input_audio_buffer.commit':
        this.send({ realtimeInput: { audioStreamEnd: true } });
        return;
      case 'conversation.item.create':
        this.sendItem(isRecord(event.item) ? event.item : {});
        return;
      case 'session.update':
        this.update(isRecord(event.session) ? event.session : {});
        return;
      case 'response.create':
        if (this.toolResponded) {
          this.toolResponded = false;
          return;
        }
        this.send({ clientContent: { turnComplete: true } });
        return;
      default:
        // response.cancel (Gemini stops itself when the person speaks) and truncation have no
        // counterpart.
        return;
    }
  }

  /**
   * Gemini is configured once, at setup, so an update that changes the setup is made by setting up
   * again: on a new socket, with the new setup and the latest resumption handle, once Gemini says the
   * session can be resumed, between turns. The conversation carries on, and what is sent meanwhile
   * waits. An update that changes nothing, as the session's own after it connects, is passed over.
   */
  private update(session: Record<string, unknown>): void {
    const settled = this.target ?? this.config;
    const base = this.pendingConfig ?? settled;
    if (!base || !settled || this.options.sessionResumption === false) return;
    const next = configWith(base, session);
    this.pendingConfig = this.setupKey(next) === this.setupKey(settled) ? undefined : next;
    this.maybeMove();
  }

  /** The setup a configuration describes, to tell two apart. */
  private setupKey(config: RealtimeSessionConfig): string {
    return JSON.stringify(this.setupFor(config));
  }

  private maybeMove(): void {
    if (!this.pendingConfig || this.moving || this.state !== 'connected' || !this.resumable) return;
    void this.move();
  }

  /** Sets the session up again with the pending configuration, resuming where Gemini left it. */
  private async move(): Promise<void> {
    const next = this.pendingConfig as RealtimeSessionConfig;
    this.pendingConfig = undefined;
    this.target = next;
    this.moving = true;
    this.resumable = false;
    // The old socket's events are no longer this session's.
    const generation = ++this.generation;
    this.closeSocket(1000, 'session update');
    const signal = (this.connectAbort ?? new PortableAbortController()).signal;
    try {
      await this.open(next, signal, generation);
      if (generation !== this.generation) return;
      this.config = next;
      this.moving = false;
      this.inputRate = next.audio?.input?.format?.rate ?? this.inputRate;
      for (const message of this.outbox.splice(0)) this.socket?.send(message);
      this.emit({ type: 'session.updated', session: { id: next.id, model: next.model } }, { setupComplete: true });
      this.maybeMove();
    } catch (error) {
      if (generation !== this.generation) return;
      this.moving = false;
      this.outbox.length = 0;
      const normalized = new RealtimeError({
        message: `Gemini Live could not be set up again for a session update: ${error instanceof Error ? error.message : String(error)}`,
        code: 'session_update_failed',
        category: 'network',
        provider: 'google',
        retryable: true,
        cause: error,
      });
      this.emitter.emit('error', normalized);
      // The old socket is closed: the session sees a drop, and its reconnect policy decides.
      this.finishDisconnect(undefined, false, undefined, normalized.message);
    }
  }

  /** Gemini stops its own response when the person speaks; there is nothing to send. */
  interrupt(): void {}

  /** Closes the socket. Resolves once closed or after `disconnectTimeoutMs`. */
  async disconnect(): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnected') {
      this.state = 'disconnected';
      return;
    }
    if (this.state === 'disconnecting') return;
    this.state = 'disconnecting';
    this.expectedClose = true;
    ++this.generation;
    this.connectAbort?.abort('client disconnect');
    const socket = this.socket;
    if (!socket || socket.readyState === 2 || socket.readyState === 3) {
      this.finishDisconnect(undefined, true);
      return;
    }
    const timers = this.timers();
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: unknown;
      const done = () => {
        if (settled) return;
        settled = true;
        removeClose();
        if (timeout !== undefined) timers.clearTimeout(timeout);
        resolve();
      };
      const removeClose = listen(socket, 'close', done);
      timeout = timers.setTimeout(done, this.options.disconnectTimeoutMs ?? 1_000);
      try {
        socket.close(1000, 'client disconnect');
      } catch {
        done();
      }
    });
    this.finishDisconnect(undefined, true);
  }

  /** The handle Gemini last gave for resuming this session, which the next connect sends. */
  get resumption(): string | undefined {
    return this.resumptionHandle;
  }

  // ── The wire ─────────────────────────────────────────────────────

  /** The `setup` message the session's configuration describes. */
  private setupFor(config: RealtimeSessionConfig): Record<string, unknown> {
    const audio = config.modalities === undefined || config.modalities.includes('audio');
    const voice = config.audio?.output?.voice;
    const language = config.audio?.input?.language;
    const tools = (config.tools ?? []) as AnyRealtimeTool[];
    const turnDetection = config.audio?.input?.turnDetection;
    const resume = this.options.sessionResumption !== false;
    return {
      model: config.model.startsWith('models/') ? config.model : `models/${config.model}`,
      generationConfig: {
        responseModalities: [audio ? 'AUDIO' : 'TEXT'],
        ...(voice || language
          ? {
              speechConfig: {
                ...(voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } : {}),
                ...(language ? { languageCode: language } : {}),
              },
            }
          : {}),
      },
      ...(config.instructions ? { systemInstruction: { parts: [{ text: config.instructions }] } } : {}),
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  ...(tool.parameters ? { parameters: openApiSchema(tool.parameters) } : {}),
                })),
              },
            ],
          }
        : {}),
      ...(audio ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
      ...(turnDetection === null ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } } : {}),
      ...(resume ? { sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {} } : {}),
      ...this.options.setup,
      ...config.providerSession,
    };
  }

  /** A conversation item as Gemini's: a turn of the conversation, or the answer a tool call waits on. */
  private sendItem(item: Record<string, unknown>): void {
    if (item.type === 'function_call_output') {
      const callId = String(item.call_id ?? '');
      const output = parseOutput(item.output);
      if (this.cancelledCalls.delete(callId)) {
        // Gemini cancelled the call when the person spoke over it: its result, and the response the
        // session asks for after it, are not wanted.
        this.toolResponded = true;
        return;
      }
      const name = this.pendingCalls.get(callId);
      if (name !== undefined) {
        this.pendingCalls.delete(callId);
        this.toolResponded = true;
        this.send({ toolResponse: { functionResponses: [{ id: callId, name, response: output }] } });
        return;
      }
      // A result from before, given back to a resumed session: part of the history.
      this.send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: callId,
                    name: String(item.name ?? this.replayedCalls.get(callId) ?? 'tool'),
                    response: output,
                  },
                },
              ],
            },
          ],
          turnComplete: false,
        },
      });
      return;
    }
    if (item.type === 'function_call') {
      let args: unknown = {};
      try {
        args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {});
      } catch {
        args = {};
      }
      this.replayedCalls.set(String(item.call_id ?? ''), String(item.name ?? ''));
      this.send({
        clientContent: {
          turns: [{ role: 'model', parts: [{ functionCall: { id: item.call_id, name: item.name, args } }] }],
          turnComplete: false,
        },
      });
      return;
    }
    if (item.type !== 'message') return;
    const parts: GeminiPart[] = [];
    for (const value of Array.isArray(item.content) ? item.content : []) {
      const content = isRecord(value) ? value : {};
      if (typeof content.text === 'string') parts.push({ text: content.text });
      const image = typeof content.image_url === 'string' ? dataUrl(content.image_url) : undefined;
      if (image) parts.push({ inlineData: image });
    }
    if (!parts.length) return;
    this.send({
      clientContent: { turns: [{ role: item.role === 'assistant' ? 'model' : 'user', parts }], turnComplete: false },
    });
    // Gemini does not echo what it is given, as the session's record expects: the transport does.
    const id = typeof item.id === 'string' && item.id ? item.id : `gemini_message_${++this.sentItems}`;
    this.emit({ type: 'conversation.item.created', item: { ...item, id } }, { clientContent: true });
  }

  /** One message from Gemini, as the session's events. */
  private receive(message: Record<string, unknown>): void {
    if (isRecord(message.usageMetadata)) this.usage = message.usageMetadata;
    const resumption = isRecord(message.sessionResumptionUpdate) ? message.sessionResumptionUpdate : undefined;
    if (resumption?.resumable !== false && typeof resumption?.newHandle === 'string') {
      this.resumptionHandle = resumption.newHandle;
      this.resumable = true;
      this.maybeMove();
    } else if (resumption) this.resumable = false;
    if (isRecord(message.goAway)) this.emit({ type: 'session.go_away', time_left: message.goAway.timeLeft }, message);
    if (isRecord(message.toolCall)) this.receiveToolCall(message.toolCall, message);
    if (isRecord(message.toolCallCancellation)) {
      const ids = Array.isArray(message.toolCallCancellation.ids) ? message.toolCallCancellation.ids : [];
      for (const id of ids) {
        if (this.pendingCalls.delete(String(id))) this.cancelledCalls.add(String(id));
      }
      this.emit({ type: 'response.function_call_cancelled', call_ids: ids }, message);
    }
    if (isRecord(message.serverContent)) this.receiveContent(message.serverContent, message);
  }

  private receiveContent(content: Record<string, unknown>, raw: Record<string, unknown>): void {
    const heard = isRecord(content.inputTranscription) ? content.inputTranscription.text : undefined;
    if (typeof heard === 'string' && heard) {
      if (this.userItemId === undefined && (this.heardItemId !== undefined || this.responseId !== undefined)) {
        // Gemini's transcription trails the speech: words that arrive while the model answers belong
        // to the turn it is answering, not to a new one, which would read as the person speaking
        // over it. Only Gemini's own `interrupted` starts a new turn before the model's ends.
        this.heardItemId ??= `gemini_user_${++this.turns}`;
        this.heardTranscript += heard;
        this.emit(
          { type: 'conversation.item.input_audio_transcription.delta', item_id: this.heardItemId, delta: heard },
          raw,
        );
      } else {
        if (!this.userItemId) {
          this.userItemId = `gemini_user_${++this.turns}`;
          this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.userItemId }, raw);
        }
        this.userTranscript += heard;
        this.emit(
          { type: 'conversation.item.input_audio_transcription.delta', item_id: this.userItemId, delta: heard },
          raw,
        );
      }
    }
    if (content.interrupted === true) {
      // The person spoke over the model: a turn of theirs begins while the response is still the
      // model's, so the session sees the barge-in, and then the response ends, cut off.
      const response = this.responseId;
      this.responseId = undefined;
      this.completeHeard(raw);
      if (!this.userItemId) {
        this.userItemId = `gemini_user_${++this.turns}`;
        this.emit({ type: 'input_audio_buffer.speech_started', item_id: this.userItemId }, raw);
      }
      if (response) {
        this.emit({ type: 'response.done', response: { id: response, status: 'cancelled', output: [] } }, raw);
        this.endResponse();
      }
    }
    const turn = isRecord(content.modelTurn) ? content.modelTurn : undefined;
    for (const value of Array.isArray(turn?.parts) ? turn.parts : []) {
      const part = isRecord(value) ? value : {};
      const inline = isRecord(part.inlineData) ? part.inlineData : undefined;
      if (inline && typeof inline.data === 'string' && String(inline.mimeType ?? '').startsWith('audio/')) {
        this.beginResponse(raw);
        this.emit(
          {
            type: 'response.output_audio.delta',
            response_id: this.responseId,
            item_id: this.assistantItemId,
            delta: inline.data,
          },
          raw,
        );
      } else if (typeof part.text === 'string' && part.text && part.thought !== true) {
        this.beginResponse(raw);
        this.assistantText += part.text;
        this.emit(
          {
            type: 'response.output_text.delta',
            response_id: this.responseId,
            item_id: this.assistantItemId,
            delta: part.text,
          },
          raw,
        );
      }
    }
    const said = isRecord(content.outputTranscription) ? content.outputTranscription.text : undefined;
    if (typeof said === 'string' && said) {
      this.beginResponse(raw);
      this.assistantTranscript += said;
      this.emit(
        {
          type: 'response.output_audio_transcript.delta',
          response_id: this.responseId,
          item_id: this.assistantItemId,
          delta: said,
        },
        raw,
      );
    }
    if (content.turnComplete === true) this.completeResponse(raw);
  }

  /** A tool call ends Gemini's response: the session runs the tools, and their results resume it. */
  private receiveToolCall(call: Record<string, unknown>, raw: Record<string, unknown>): void {
    const output: Array<Record<string, unknown>> = [];
    for (const value of Array.isArray(call.functionCalls) ? call.functionCalls : []) {
      const fn = isRecord(value) ? value : {};
      const id = typeof fn.id === 'string' && fn.id ? fn.id : `gemini_call_${this.pendingCalls.size + 1}_${this.turns}`;
      const name = String(fn.name ?? '');
      this.pendingCalls.set(id, name);
      output.push({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(fn.args ?? {}) });
    }
    if (!output.length) return;
    this.beginResponse(raw);
    this.emit(
      { type: 'response.done', response: { id: this.responseId, status: 'completed', output, ...this.usageOf() } },
      raw,
    );
    this.endResponse();
  }

  /** The model's response begins, ending the person's turn first. */
  private beginResponse(raw: Record<string, unknown>): void {
    if (this.responseId) return;
    this.finishUserTurn(raw);
    this.responseId = `gemini_response_${++this.turns}`;
    this.assistantItemId = `gemini_item_${this.turns}`;
    this.emit({ type: 'response.created', response: { id: this.responseId } }, raw);
  }

  /** The person stopped speaking: their turn is the one the model answers. */
  private finishUserTurn(raw: Record<string, unknown>): void {
    if (!this.userItemId) return;
    this.completeHeard(raw);
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: this.userItemId }, raw);
    this.heardItemId = this.userItemId;
    this.heardTranscript = this.userTranscript;
    this.userItemId = undefined;
    this.userTranscript = '';
  }

  /** The person's answered turn is transcribed in full, once the model's turn has ended. */
  private completeHeard(raw: Record<string, unknown>): void {
    const item = this.heardItemId;
    const transcript = this.heardTranscript;
    this.heardItemId = undefined;
    this.heardTranscript = '';
    if (item === undefined || !transcript) return;
    this.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript }, raw);
  }

  private completeResponse(raw: Record<string, unknown>): void {
    if (!this.responseId) {
      this.finishUserTurn(raw);
      this.completeHeard(raw);
      return;
    }
    if (this.assistantTranscript) {
      this.emit(
        {
          type: 'response.output_audio_transcript.done',
          response_id: this.responseId,
          item_id: this.assistantItemId,
          transcript: this.assistantTranscript,
        },
        raw,
      );
    }
    if (this.assistantText) {
      this.emit(
        {
          type: 'response.output_text.done',
          response_id: this.responseId,
          item_id: this.assistantItemId,
          text: this.assistantText,
        },
        raw,
      );
    }
    this.emit(
      { type: 'response.done', response: { id: this.responseId, status: 'completed', output: [], ...this.usageOf() } },
      raw,
    );
    this.endResponse();
    this.completeHeard(raw);
  }

  private endResponse(): void {
    this.responseId = undefined;
    this.assistantItemId = undefined;
    this.assistantTranscript = '';
    this.assistantText = '';
    this.usage = undefined;
  }

  private resetTurn(): void {
    this.endResponse();
    this.userItemId = undefined;
    this.userTranscript = '';
    this.heardItemId = undefined;
    this.heardTranscript = '';
    this.toolResponded = false;
    this.pendingCalls.clear();
    this.cancelledCalls.clear();
    this.replayedCalls.clear();
  }

  /** The turn's usage, as the session reads it. */
  private usageOf(): { usage?: Record<string, number> } {
    const usage = this.usage;
    if (!usage) return {};
    const input = Number(usage.promptTokenCount);
    const output = Number(usage.responseTokenCount ?? usage.candidatesTokenCount);
    const total = Number(usage.totalTokenCount);
    return {
      usage: {
        ...(Number.isFinite(input) ? { input_tokens: input } : {}),
        ...(Number.isFinite(output) ? { output_tokens: output } : {}),
        ...(Number.isFinite(total) ? { total_tokens: total } : {}),
      },
    };
  }

  private emit(event: RealtimeServerEvent, raw: unknown): void {
    this.emitter.emit('data', { event, raw });
  }

  private send(message: Record<string, unknown>): void {
    if (this.moving) {
      this.outbox.push(JSON.stringify(message));
      return;
    }
    const socket = this.requireOpenSocket();
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      const normalized = toRealtimeError(error, {
        message: 'Failed to send a Gemini Live message',
        code: 'websocket_send_failed',
        category: 'protocol',
        provider: 'google',
      });
      this.emitter.emit('error', normalized);
      throw normalized;
    }
  }

  // ── The socket ───────────────────────────────────────────────────

  /** Opens the socket, sends the setup, and resolves on Gemini's `setupComplete`. */
  private awaitSetup(
    socket: RealtimeWebSocketLike,
    config: RealtimeSessionConfig,
    signal: AbortSignalLike,
    generation: number,
  ): Promise<void> {
    const timers = this.timers();
    return new Promise((resolve, reject) => {
      let settled = false;
      let setUp = false;
      let timeout: unknown;
      const current = () => generation === this.generation;
      const settingUp = () => !setUp && (this.state === 'connecting' || this.moving);
      const settle = (error?: RealtimeError) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) timers.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => {
        if (!current()) return;
        try {
          socket.send(JSON.stringify({ setup: this.setupFor(config) }));
        } catch (error) {
          settle(toRealtimeError(error, { code: 'websocket_send_failed', category: 'protocol', provider: 'google' }));
        }
      };
      const onMessage = (raw: unknown) => {
        if (!current()) return;
        const message = this.parse(raw);
        if (!message) return;
        if (settingUp() && 'setupComplete' in message) {
          setUp = true;
          if (this.state === 'connecting') {
            this.state = 'connected';
            this.emitter.emit('connected', {
              sessionId: config.id,
              transport: this.kind,
              timestamp: this.now(),
              raw: message,
            });
            this.emit({ type: 'session.created', session: { id: config.id, model: config.model } }, message);
          }
          settle();
          return;
        }
        this.receive(message);
      };
      const onError = (raw: unknown) => {
        if (!current()) return;
        const error = new RealtimeError({
          message: 'Gemini Live reported a network error',
          code: 'websocket_error',
          category: 'network',
          provider: 'google',
          retryable: true,
          raw: isRecord(raw) ? { message: raw.message } : undefined,
        });
        if (settingUp()) settle(error);
        else this.emitter.emit('error', error);
      };
      const onClose = (raw: unknown) => {
        if (!current() && !this.expectedClose) return;
        const close = isRecord(raw) ? raw : {};
        const code = typeof close.code === 'number' ? close.code : undefined;
        const reason = typeof close.reason === 'string' ? close.reason : undefined;
        if (settingUp()) {
          settle(
            new RealtimeError({
              message: `Gemini Live closed before it was set up${reason ? `: ${reason}` : ''}`,
              code: 'websocket_closed_during_connect',
              category: code === 1008 ? 'permission' : 'network',
              provider: 'google',
              // A refused request (1007, 1008) will be refused again.
              retryable: !this.expectedClose && code !== 1007 && code !== 1008,
            }),
          );
          return;
        }
        this.finishDisconnect(raw, this.expectedClose, code, reason);
      };
      this.cleanups.push(
        listen(socket, 'open', onOpen),
        listen(socket, 'message', onMessage),
        listen(socket, 'error', onError),
        listen(socket, 'close', onClose),
      );
      const removeAbort = onAbort(signal, () => {
        this.expectedClose = true;
        settle(this.abortError(signal?.reason));
        this.closeSocket(1000, 'aborted');
      });
      this.cleanups.push(removeAbort);
      if (socket.readyState === 1) onOpen();
      timeout = timers.setTimeout(() => {
        this.expectedClose = true;
        settle(
          new RealtimeError({
            message: 'Gemini Live was not set up in time',
            code: 'connection_timeout',
            category: 'timeout',
            provider: 'google',
            retryable: true,
          }),
        );
        this.closeSocket(4000, 'connection timeout');
      }, this.options.connectTimeoutMs ?? 10_000);
    });
  }

  private parse(message: unknown): Record<string, unknown> | undefined {
    const raw = eventPayload(message);
    try {
      const codec = this.options.codec || defaultUtf8Codec();
      const text =
        typeof raw === 'string'
          ? raw
          : raw instanceof ArrayBuffer || raw instanceof Uint8Array
            ? codec.decode(raw)
            : undefined;
      if (text === undefined) throw new Error('Unsupported WebSocket message payload');
      return safeJsonParse(text);
    } catch (error) {
      this.emitter.emit(
        'error',
        toRealtimeError(error, {
          message: 'Received a Gemini Live message that is not JSON',
          code: 'invalid_websocket_event',
          category: 'protocol',
          provider: 'google',
        }),
      );
      return undefined;
    }
  }

  private async resolveToken(
    config: RealtimeSessionConfig,
    signal?: AbortSignalLike,
  ): Promise<{ kind: 'key' | 'token'; value: string }> {
    if (this.options.ephemeralTokenProvider) {
      return { kind: 'token', value: await this.options.ephemeralTokenProvider(config, signal) };
    }
    if (this.options.ephemeralToken) return { kind: 'token', value: this.options.ephemeralToken };
    // A credential resolved for the session's tenant replaces the configured key.
    const credential = await config.credential?.();
    if (credential?.apiKey) return { kind: 'key', value: credential.apiKey };
    if (this.options.apiKey) return { kind: 'key', value: this.options.apiKey };
    throw new RealtimeError({
      message: 'Gemini Live needs an apiKey, an ephemeralToken, or an ephemeralTokenProvider',
      code: 'missing_credentials',
      category: 'authentication',
      provider: 'google',
    });
  }

  private globalSocket(url: string): RealtimeWebSocketLike {
    const Constructor = (globalThis as unknown as { WebSocket?: new (url: string) => RealtimeWebSocketLike }).WebSocket;
    if (!Constructor) {
      throw new RealtimeError({
        message: 'This environment does not provide WebSocket; inject webSocketFactory',
        code: 'unsupported_environment',
        category: 'capability',
        provider: 'google',
      });
    }
    return new Constructor(url);
  }

  private requireOpenSocket(): RealtimeWebSocketLike {
    if (this.state !== 'connected' || !this.socket || this.socket.readyState !== 1) throw this.invalidState('send');
    return this.socket;
  }

  private finishDisconnect(raw: unknown, expected: boolean, code?: number, reason?: string): void {
    if (this.disconnectEmitted) return;
    this.disconnectEmitted = true;
    this.state = expected ? 'disconnected' : 'failed';
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: this.now(),
      code,
      reason,
      expected,
      retryable: !expected && code !== 1007 && code !== 1008,
      raw,
    });
    this.cleanupListeners();
    this.socket = undefined;
    this.connectAbort = undefined;
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.socket?.close(code, reason);
    } catch {
      // Best effort.
    }
  }

  private cleanupListeners(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }

  private invalidState(action: string): RealtimeError {
    return new RealtimeError({
      message: `Cannot ${action} while the Gemini Live transport is ${this.state}`,
      code: 'invalid_state',
      category: 'configuration',
      provider: 'google',
    });
  }

  private abortError(cause?: unknown): RealtimeError {
    return new RealtimeError({
      message: 'The Gemini Live connection was aborted',
      code: 'aborted',
      category: 'abort',
      provider: 'google',
      cause,
    });
  }

  private timers(): TimerPlatform {
    return this.options.timers || defaultTimerPlatform();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** A tool's JSON Schema as the OpenAPI subset Gemini's function declarations take. */
function openApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(openApiSchema);
  if (!isRecord(schema)) return schema;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === '$id') continue;
    kept[key] = openApiSchema(value);
  }
  return kept;
}

/** A tool's output as the object a `functionResponse` carries. */
function parseOutput(output: unknown): Record<string, unknown> {
  let value: unknown = output;
  if (typeof output === 'string') {
    try {
      value = JSON.parse(output);
    } catch {
      value = output;
    }
  }
  return isRecord(value) && !Array.isArray(value) ? value : { result: value };
}

/** A `data:` URL as Gemini's inline data. */
function dataUrl(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mimeType: match[1] as string, data: match[2] as string } : undefined;
}

/**
 * A configuration with a session update's fields folded in. Instructions, voice, language, output
 * modalities, tools, turn detection, and the model change the setup they describe; any other field is
 * a setup field of Gemini's own, kept with the configuration's `providerSession`.
 */
function configWith(base: RealtimeSessionConfig, session: Record<string, unknown>): RealtimeSessionConfig {
  const next: RealtimeSessionConfig = { ...base };
  const providerSession: Record<string, unknown> = { ...base.providerSession };
  let input = { ...base.audio?.input };
  let output = { ...base.audio?.output };
  for (const [key, value] of Object.entries(session)) {
    if (key === 'instructions') {
      if (typeof value === 'string') next.instructions = value;
      else delete next.instructions;
    } else if (key === 'model' && typeof value === 'string') next.model = value;
    else if (key === 'output_modalities' && Array.isArray(value)) {
      next.modalities = value.filter((item): item is 'audio' | 'text' => item === 'audio' || item === 'text');
    } else if (key === 'voice' && typeof value === 'string') output = { ...output, voice: value };
    else if (key === 'tools') {
      next.tools = (Array.isArray(value) ? value : []).filter(isRecord).map((tool) => ({
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        ...(isRecord(tool.parameters) ? { parameters: tool.parameters } : {}),
      })) as unknown as RealtimeSessionConfig['tools'];
    } else if (key === 'audio' && isRecord(value)) {
      const audioOutput = isRecord(value.output) ? value.output : {};
      const audioInput = isRecord(value.input) ? value.input : {};
      const transcription = isRecord(audioInput.transcription) ? audioInput.transcription : {};
      if (typeof audioOutput.voice === 'string') output = { ...output, voice: audioOutput.voice };
      if (typeof transcription.language === 'string') input = { ...input, language: transcription.language };
      if ('turn_detection' in audioInput) {
        input = {
          ...input,
          turnDetection:
            audioInput.turn_detection === null
              ? null
              : (base.audio?.input?.turnDetection ?? ({ type: 'server_vad' } as const)),
        };
      }
    } else if (key !== 'type' && key !== 'tool_choice') providerSession[key] = value;
  }
  return {
    ...next,
    audio: { ...base.audio, input, output },
    ...(Object.keys(providerSession).length ? { providerSession } : {}),
  };
}
