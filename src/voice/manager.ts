import type { CompletionRequest, Message } from '../types/messages.js';
import type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  VoiceConfig,
  VoiceProvider,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from '../types/voice.js';
import type { NexusResponse } from '../types/response.js';
import { VoiceCapabilityError, VoiceProviderError } from './errors.js';

export interface VoiceCompletionClient {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

export class VoiceManager {
  private providers = new Map<string, VoiceProvider>();

  constructor(private config: VoiceConfig = {}) {
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
    const provider = this.resolveProvider('transcription', request.provider || this.config.defaultTranscriptionProvider);
    if (!provider.transcribe) throw new VoiceCapabilityError(provider.info.name, 'transcription');

    try {
      return await provider.transcribe(request);
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError(
        `Voice transcription failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async speak(request: SpeechRequest): Promise<SpeechResponse> {
    const provider = this.resolveProvider('speech', request.provider || this.config.defaultSpeechProvider);
    if (!provider.speak) throw new VoiceCapabilityError(provider.info.name, 'speech');

    try {
      return await provider.speak(request);
    } catch (error) {
      if (error instanceof VoiceProviderError) throw error;
      throw new VoiceProviderError(
        `Voice speech generation failed for provider "${provider.info.name}"`,
        provider.info.name,
        error,
      );
    }
  }

  async runTurn(request: VoiceTurnRequest, client: VoiceCompletionClient): Promise<VoiceTurnResponse> {
    const transcript = request.transcript !== undefined
      ? undefined
      : await this.requireTranscription(request);
    const transcriptText = request.transcript ?? transcript?.text ?? '';
    const completion = this.withTranscript(request.completion, transcriptText, request.transcriptMessage);
    const response = await client.complete(completion);
    const speech = request.speech === undefined || request.speech === false
      ? undefined
      : await this.speak({ ...request.speech, text: response.content });

    return {
      transcript,
      transcriptText,
      response,
      speech,
    };
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

  private resolveProvider(
    capability: 'transcription' | 'speech',
    preferred?: string,
  ): VoiceProvider {
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
