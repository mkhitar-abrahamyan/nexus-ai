import type { RealtimeSession } from '../realtime/session.js';
import type { RealtimeAudioOptions } from '../realtime/types.js';
import type {
  TelephonyDtmfEvent,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyStartEvent,
  TelephonyStopEvent,
} from '../types/telephony.js';
import { TelephonyProviderError } from './errors.js';
import type { TelephonyManager } from './manager.js';

/**
 * Audio settings that match what Twilio Media Streams actually send and accept: 8 kHz G.711 µ-law.
 *
 * Passing these to a realtime session lets the provider consume and produce telephony audio directly,
 * so the bridge forwards payloads without resampling or transcoding. Overriding them means the app
 * becomes responsible for converting every frame in both directions.
 */
export function twilioRealtimeAudioOptions(overrides: RealtimeAudioOptions = {}): RealtimeAudioOptions {
  return {
    ...overrides,
    input: {
      ...overrides.input,
      format: { type: 'audio/pcmu', rate: 8000, ...overrides.input?.format },
    },
    output: {
      ...overrides.output,
      format: { type: 'audio/pcmu', rate: 8000, ...overrides.output?.format },
    },
  };
}

export interface TelephonyRealtimeBridgeOptions {
  /** The realtime session driving the call. The bridge does not create it, so tools and instructions stay app-owned. */
  session: RealtimeSession;
  telephony: TelephonyManager;
  /** Registered provider name. Defaults to `twilio`. */
  provider?: string;
  /** Sends one framed message back over the provider's media socket. Awaited, so ordering is preserved. */
  send(message: TelephonyOutboundAudioMessage): void | Promise<void>;
  /** Connect the session on the provider's `start` event. Defaults to true. */
  autoConnect?: boolean;
  /**
   * On caller speech, discard audio already buffered at the provider and cancel the in-flight response.
   * Defaults to true. Without it the assistant keeps talking over the caller for as long as the
   * provider has audio queued.
   */
  bargeIn?: boolean;
  /** Disconnect the session when the provider's stream stops. Defaults to true. */
  autoDisconnect?: boolean;
  onStart?(event: TelephonyStartEvent): void | Promise<void>;
  onStop?(event: TelephonyStopEvent): void | Promise<void>;
  onDtmf?(event: TelephonyDtmfEvent): void | Promise<void>;
  /** Receives errors from message handling and outbound sends, which are never thrown at the socket. */
  onError?(error: unknown): void;
}

export interface TelephonyRealtimeBridge {
  /** Provider call identifier, available once the stream has started. */
  readonly callId: string | undefined;
  readonly streamId: string | undefined;
  /** Custom `<Parameter>` values from the provider's stream instruction. */
  readonly parameters: Record<string, string>;
  readonly closed: boolean;
  /** Feeds one raw media-socket message through the bridge. Safe to call before `start`. */
  handleMessage(message: string | Record<string, unknown>): Promise<void>;
  /** Resolves once every queued outbound message has been sent. Send failures surface via `onError`. */
  flush(): Promise<void>;
  /** Detaches session listeners and, unless disabled, disconnects the session. Idempotent. */
  close(): Promise<void>;
}

/**
 * Connects a provider media stream to a realtime session: caller audio in, assistant audio out,
 * barge-in, playback marks, and stream lifecycle.
 *
 * The bridge owns only the audio path. Session configuration, tools, authorization, and any
 * post-call persistence stay with the application.
 */
export function createTelephonyRealtimeBridge(options: TelephonyRealtimeBridgeOptions): TelephonyRealtimeBridge {
  const provider = options.provider || 'twilio';
  const bargeIn = options.bargeIn !== false;
  const autoConnect = options.autoConnect !== false;
  const autoDisconnect = options.autoDisconnect !== false;

  let streamId: string | undefined;
  let callId: string | undefined;
  let parameters: Record<string, string> = {};
  let closed = false;
  let markCounter = 0;
  /** Marks emitted after a response's first audio chunk, awaiting the provider's echo. */
  const pendingPlaybackMarks = new Set<string>();
  let awaitingFirstChunk = true;

  // Sends are chained so assistant audio reaches the caller in the order the model produced it.
  let sendQueue: Promise<void> = Promise.resolve();

  const reportError = (error: unknown) => {
    options.onError?.(error);
  };

  const enqueueSend = (message: TelephonyOutboundAudioMessage) => {
    sendQueue = sendQueue.then(() => options.send(message)).catch(reportError);
    return sendQueue;
  };

  const onAudioDelta = (event: { audio: ArrayBuffer }) => {
    if (closed || !streamId || event.audio.byteLength === 0) return;

    const payload = Buffer.from(new Uint8Array(event.audio)).toString('base64');
    enqueueSend(options.telephony.formatAudioMessage(provider, streamId, payload));

    // One mark per response is enough to learn when playback began; marks after that add no signal.
    if (awaitingFirstChunk) {
      awaitingFirstChunk = false;
      markCounter += 1;
      const markName = `nexus-playback-${markCounter}`;
      pendingPlaybackMarks.add(markName);
      enqueueSend(options.telephony.formatAudioMessage(provider, streamId, markName, { event: 'mark', markName }));
    }
  };

  const onResponseCreated = () => {
    awaitingFirstChunk = true;
  };

  const onSpeechStarted = () => {
    if (closed || !bargeIn || !streamId) return;

    // Order matters: drop the provider's queued audio first, then cancel the response that produced it.
    enqueueSend(options.telephony.formatAudioMessage(provider, streamId, '', { event: 'clear' }));
    pendingPlaybackMarks.clear();
    awaitingFirstChunk = true;

    try {
      options.session.interrupt('barge_in');
    } catch (error) {
      reportError(error);
    }
  };

  const unsubscribes = [
    options.session.on('assistant.audio.delta', onAudioDelta),
    options.session.on('assistant.response.created', onResponseCreated),
    options.session.on('speech.started', onSpeechStarted),
  ];

  const detach = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    detach();

    try {
      await sendQueue;
    } catch (error) {
      reportError(error);
    }

    if (autoDisconnect) {
      try {
        await options.session.disconnect();
      } catch (error) {
        reportError(error);
      }
    }
  };

  const handleEvent = async (event: TelephonyMediaStreamEvent): Promise<void> => {
    switch (event.event) {
      case 'start': {
        streamId = event.streamId;
        callId = event.callId;
        parameters = event.parameters || {};
        if (autoConnect) await options.session.connect();
        await options.onStart?.(event);
        return;
      }

      case 'media': {
        // Outbound frames are the assistant's own audio echoed back; feeding them in would loop.
        if (event.track === 'outbound' || !event.payload) return;
        const audio = Buffer.from(event.payload, 'base64');
        options.session.sendAudio(
          audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer,
        );
        return;
      }

      case 'mark': {
        if (pendingPlaybackMarks.delete(event.name)) options.session.markAudioPlayed();
        return;
      }

      case 'dtmf': {
        await options.onDtmf?.(event);
        return;
      }

      case 'stop': {
        await options.onStop?.(event);
        await close();
        return;
      }

      default:
        return;
    }
  };

  return {
    get callId() {
      return callId;
    },
    get streamId() {
      return streamId;
    },
    get parameters() {
      return parameters;
    },
    get closed() {
      return closed;
    },

    async handleMessage(message: string | Record<string, unknown>): Promise<void> {
      if (closed) return;

      try {
        const event = options.telephony.parseMediaStreamEvent(provider, message);
        if (event) await handleEvent(event);
      } catch (error) {
        reportError(
          error instanceof TelephonyProviderError
            ? error
            : new TelephonyProviderError('Telephony realtime bridge failed to handle a media message', provider, error),
        );
      }
    },

    async flush(): Promise<void> {
      await sendQueue;
    },

    close,
  };
}
