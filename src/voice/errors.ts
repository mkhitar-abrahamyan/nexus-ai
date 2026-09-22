/** Raised when a voice provider fails, or none is registered for an operation. */
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    /** The provider. */
    public provider?: string,
    /** The underlying error. */
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

/** Raised when a provider does not support transcription, speech, or realtime. */
export class VoiceCapabilityError extends VoiceProviderError {
  constructor(provider: string, capability: 'transcription' | 'speech' | 'realtime') {
    super(`Voice provider "${provider}" does not support ${capability}`, provider);
    this.name = 'VoiceCapabilityError';
  }
}
