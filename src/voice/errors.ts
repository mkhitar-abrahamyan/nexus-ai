export class VoiceProviderError extends Error {
  constructor(
    message: string,
    public provider?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

export class VoiceCapabilityError extends VoiceProviderError {
  constructor(provider: string, capability: 'transcription' | 'speech' | 'realtime') {
    super(`Voice provider "${provider}" does not support ${capability}`, provider);
    this.name = 'VoiceCapabilityError';
  }
}
