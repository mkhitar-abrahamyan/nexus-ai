import { OpenAIWebRTCTransport, type OpenAIWebRTCTransportOptions } from './openai-webrtc.transport.js';
import { OpenAIWebSocketTransport, type OpenAIWebSocketTransportOptions } from './openai-websocket.transport.js';
import { RealtimeSession } from './session.js';
import type {
  AnyRealtimeTool,
  RealtimeAudioOptions,
  RealtimeInterruptionOptions,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportKind,
  RealtimeTurnDetectionOptions,
} from './types.js';

/** Creates transports for one realtime provider. */
export interface RealtimeTransportProvider {
  /** The provider's name, recorded on sessions. */
  readonly name: string;
  /** Creates a transport of the given kind, or the provider's default. */
  createTransport(kind?: RealtimeTransportKind): RealtimeTransport;
}

/** Options for the OpenAI realtime provider. */
export interface OpenAIRealtimeProviderOptions {
  /** Transport used when a session names none. Defaults to `webrtc`. */
  defaultTransport?: 'webrtc' | 'websocket';
  /** Your server endpoint for WebRTC session negotiation, shared by every WebRTC transport. */
  sessionEndpoint?: string;
  /** API key for WebSocket transports. Keep it on a server. */
  apiKey?: string;
  /** Options for every WebRTC transport. */
  webrtc?: OpenAIWebRTCTransportOptions;
  /** Options for every WebSocket transport. */
  websocket?: OpenAIWebSocketTransportOptions;
}

/** OpenAI's realtime API, over WebRTC in a browser or WebSocket on a server. */
export class OpenAIRealtimeProvider implements RealtimeTransportProvider {
  /** Always `openai`. */
  readonly name = 'openai';

  constructor(private readonly options: OpenAIRealtimeProviderOptions = {}) {}

  /** Creates a WebRTC or WebSocket transport. Throws for any other kind. */
  createTransport(kind: RealtimeTransportKind = this.options.defaultTransport || 'webrtc'): RealtimeTransport {
    if (kind === 'webrtc') {
      return new OpenAIWebRTCTransport({
        ...this.options.webrtc,
        sessionEndpoint: this.options.webrtc?.sessionEndpoint || this.options.sessionEndpoint,
      });
    }
    if (kind === 'websocket') {
      return new OpenAIWebSocketTransport({
        ...this.options.websocket,
        apiKey: this.options.websocket?.apiKey || this.options.apiKey,
      });
    }
    throw new Error(`OpenAI realtime provider does not support transport "${kind}"`);
  }

  /** Creates a session on this provider, with a transport by kind or one you supply. */
  createSession(
    config: Omit<RealtimeSessionConfig, 'provider' | 'transport'> & {
      transport?: 'webrtc' | 'websocket' | RealtimeTransport;
    },
  ): RealtimeSession {
    const transport =
      typeof config.transport === 'object' && config.transport
        ? config.transport
        : this.createTransport(config.transport || this.options.defaultTransport);
    return new RealtimeSession({ ...config, provider: this.name, transport });
  }
}

/** Voice settings for `createRealtimeAgent()`. */
export interface RealtimeAgentVoiceOptions {
  /** Transport kind, or a transport you supply. */
  transport?: RealtimeTransportKind | RealtimeTransport;
  /** Barge-in handling. */
  interruption?: boolean | RealtimeInterruptionOptions;
  /** How the provider decides the user finished speaking. */
  turnDetection?: RealtimeTurnDetectionOptions;
  /** Voice the model speaks in. */
  voice?: string;
  /** Full audio settings, merged with the fields above. */
  audio?: RealtimeAudioOptions;
}

/**
 * Options for `createRealtimeAgent()`: a session's configuration, with the provider and voice
 * settings kept separate.
 */
export interface CreateRealtimeAgentOptions
  extends Omit<RealtimeSessionConfig, 'provider' | 'transport' | 'tools' | 'audio' | 'interruption'> {
  /** Provider to create the transport from. */
  provider: RealtimeTransportProvider;
  /** Tools the agent may call. */
  tools?: AnyRealtimeTool[];
  /** Voice settings. */
  voice?: RealtimeAgentVoiceOptions;
}

/**
 * Creates a voice agent: a realtime session on a provider, with its voice settings folded into the
 * session's audio configuration.
 */
export function createRealtimeAgent(options: CreateRealtimeAgentOptions): RealtimeSession {
  const requestedTransport = options.voice?.transport;
  const transport =
    typeof requestedTransport === 'object' && requestedTransport
      ? requestedTransport
      : options.provider.createTransport(requestedTransport);
  const voiceAudio = options.voice?.audio;
  const audio: RealtimeAudioOptions | undefined =
    voiceAudio || options.voice?.turnDetection !== undefined || options.voice?.voice
      ? {
          ...voiceAudio,
          input: {
            ...voiceAudio?.input,
            ...(options.voice?.turnDetection === undefined ? {} : { turnDetection: options.voice.turnDetection }),
          },
          output: {
            ...voiceAudio?.output,
            ...(options.voice?.voice ? { voice: options.voice.voice } : {}),
          },
        }
      : undefined;

  return new RealtimeSession({
    ...options,
    provider: options.provider.name,
    transport,
    tools: options.tools,
    audio,
    interruption: options.voice?.interruption,
  });
}
