/** Raised when a telephony provider fails, or none is registered for an operation. */
export class TelephonyProviderError extends Error {
  constructor(
    message: string,
    /** The provider. */
    public readonly provider?: string,
    /** The underlying error. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TelephonyProviderError';
  }
}

/** Raised when a provider does not support an operation. */
export class TelephonyCapabilityError extends TelephonyProviderError {
  constructor(provider: string, capability: string) {
    super(`Telephony provider "${provider}" does not support ${capability}`, provider);
    this.name = 'TelephonyCapabilityError';
  }
}
