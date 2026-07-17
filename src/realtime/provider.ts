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

export interface RealtimeTransportProvider {
  readonly name: string;
  createTransport(kind?: RealtimeTransportKind): RealtimeTransport;
}

export interface OpenAIRealtimeProviderOptions {
  defaultTransport?: 'webrtc' | 'websocket';
  sessionEndpoint?: string;
  apiKey?: string;
  webrtc?: OpenAIWebRTCTransportOptions;
  websocket?: OpenAIWebSocketTransportOptions;
}

export class OpenAIRealtimeProvider implements RealtimeTransportProvider {
  readonly name = 'openai';

  constructor(private readonly options: OpenAIRealtimeProviderOptions = {}) {}

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

export interface RealtimeAgentVoiceOptions {
  transport?: RealtimeTransportKind | RealtimeTransport;
  interruption?: boolean | RealtimeInterruptionOptions;
  turnDetection?: RealtimeTurnDetectionOptions;
  voice?: string;
  audio?: RealtimeAudioOptions;
}

export interface CreateRealtimeAgentOptions
  extends Omit<RealtimeSessionConfig, 'provider' | 'transport' | 'tools' | 'audio' | 'interruption'> {
  provider: RealtimeTransportProvider;
  tools?: AnyRealtimeTool[];
  voice?: RealtimeAgentVoiceOptions;
}

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
