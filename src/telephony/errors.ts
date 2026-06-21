export class TelephonyProviderError extends Error {
  constructor(
    message: string,
    public readonly provider?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TelephonyProviderError';
  }
}

export class TelephonyCapabilityError extends TelephonyProviderError {
  constructor(provider: string, capability: string) {
    super(`Telephony provider "${provider}" does not support ${capability}`, provider);
    this.name = 'TelephonyCapabilityError';
  }
}
