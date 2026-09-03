import type { CompletionRequest, Message } from '../types/messages.js';
import type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  VoiceConfig,
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from '../types/voice.js';
import type { NexusResponse } from '../types/response.js';
import { VoiceCapabilityError, VoiceProviderError } from './errors.js';
import { FamilyTelemetry, type FamilyRuntime } from '../ops/family-telemetry.js';
import { VoiceSession, type VoiceSessionCompletionClient } from './session.js';

export interface VoiceCompletionClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export class VoiceManager {
  private providers = new Map<string, VoiceProvider>();
  private readonly telemetry: FamilyTelemetry;

  constructor(
    private config: VoiceConfig = {},
    runtime: FamilyRuntime = {},
  ) {
    this.telemetry = new FamilyTelemetry('voice', runtime);
    for (const [name, provider] of Object.entries(config.providers || {})) {
      this.registerProvider(name, provider);
    }
  }

  registerProvider(name: string, provider: VoiceProvider): this {
    this.providers.set(name, provider);
    return this;
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const provider = this.resolveProvider(
      'transcription',
      request.provider || this.config.defaultTranscriptionProvider,
    );
    const transcribe = provider.transcribe;
    if (!transcribe) throw new VoiceCapabilityError(provider.info.name, 'transcription');

    return this.telemetry.run({ operation: 'transcribe', provider: provider.info.name, model: request.model }, () =>
      this.callTranscribe(provider.info.name, transcribe.bind(provider), request),
    );
  }

  private async callTranscribe(
    providerName: string,
    transcribe: (request: TranscriptionRequest) => Promise<TranscriptionResponse>,
    request: TranscriptionRequest,
  ): Promise<TranscriptionResponse> {
    try {
      return await transcribe(request);
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError(`Voice transcription failed for provider "${providerName}"`, providerName, error);
    }
  }

  async speak(request: SpeechRequest): Promise<SpeechResponse> {
    const provider = this.resolveProvider('speech', request.provider || this.config.defaultSpeechProvider);
    const speak = provider.speak;
    if (!speak) throw new VoiceCapabilityError(provider.info.name, 'speech');

    return this.telemetry.run({ operation: 'speak', provider: provider.info.name, model: request.model }, () =>
      this.callSpeak(provider.info.name, speak.bind(provider), request),
    );
  }

  private async callSpeak(
    providerName: string,
    speak: (request: SpeechRequest) => Promise<SpeechResponse>,
    request: SpeechRequest,
  ): Promise<SpeechResponse> {
    try {
      return await speak(request);
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError(
        `Voice speech generation failed for provider "${providerName}"`,
        providerName,
        error,
      );
    }
  }

  async runTurn(request: VoiceTurnRequest, client: VoiceCompletionClient): Promise<VoiceTurnResponse> {
    const transcript = request.transcript !== undefined ? undefined : await this.requireTranscription(request);
    const transcriptText = request.transcript ?? transcript?.text ?? '';
    const completion = this.withTranscript(request.completion, transcriptText, request.transcriptMessage);
    const response = await client.complete(completion);
    const speech =
      request.speech === undefined || request.speech === false
        ? undefined
        : await this.speak({ ...request.speech, text: response.content });

    return {
      transcript,
      transcriptText,
      response,
      speech,
    };
  }

  createSession(config: VoiceSessionConfig, client: VoiceSessionCompletionClient): VoiceSession {
    return new VoiceSession(config, this, client);
  }

  private async requireTranscription(request: VoiceTurnRequest): Promise<TranscriptionResponse> {
    if (!request.audio) {
      throw new VoiceProviderError('Voice turn requires either "transcript" or "audio"');
    }

    return this.transcribe({
      ...request.transcription,
      audio: request.audio,
    });
  }

  private withTranscript(
    request: CompletionRequest,
    transcript: string,
    config = request.metadata?.voiceTranscriptMessage as VoiceTurnRequest['transcriptMessage'],
  ): CompletionRequest {
    if (!transcript || config?.append === false) return request;

    const message = this.createTranscriptMessage(transcript, config);
    return {
      ...request,
      messages: [...request.messages, message],
    };
  }

  private createTranscriptMessage(transcript: string, config?: VoiceTurnRequest['transcriptMessage']): Message {
    const template = config?.template || '{{transcript}}';
    return {
      role: config?.role || 'user',
      content: template.replace('{{transcript}}', transcript),
    };
  }

  private resolveProvider(capability: 'transcription' | 'speech', preferred?: string): VoiceProvider {
    if (preferred) {
      const provider = this.providers.get(preferred);
      if (!provider) throw new VoiceProviderError(`Voice provider "${preferred}" is not registered`, preferred);
      return provider;
    }

    for (const provider of this.providers.values()) {
      if (capability === 'transcription' && provider.transcribe) return provider;
      if (capability === 'speech' && provider.speak) return provider;
    }

    throw new VoiceProviderError(`No voice provider registered for ${capability}`);
  }
}
