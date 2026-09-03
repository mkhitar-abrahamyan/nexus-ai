export class BatchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

export class BatchValidationError extends BatchError {
  constructor(message: string, cause?: unknown) {
    super(message, 'BATCH_VALIDATION_ERROR', cause);
    this.name = 'BatchValidationError';
  }
}

export class BatchProviderError extends BatchError {
  constructor(
    message: string,
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'BATCH_PROVIDER_ERROR', cause);
    this.name = 'BatchProviderError';
  }
}

export class BatchProviderNotFoundError extends BatchProviderError {
  constructor(provider?: string) {
    super(provider ? `Batch provider "${provider}" is not registered` : 'No batch provider is registered', provider);
    this.name = 'BatchProviderNotFoundError';
  }
}

export class BatchCapabilityError extends BatchProviderError {
  override readonly code = 'BATCH_CAPABILITY_ERROR';

  constructor(
    provider: string,
    public readonly option: string,
    detail?: string,
  ) {
    super(detail ?? `Batch provider "${provider}" does not support ${option}`, provider);
    this.name = 'BatchCapabilityError';
  }
}

export class BatchProviderResponseError extends BatchProviderError {
  override readonly code = 'BATCH_PROVIDER_RESPONSE_ERROR';

  constructor(provider: string, message: string, cause?: unknown) {
    super(`Invalid batch response from provider "${provider}": ${message}`, provider, cause);
    this.name = 'BatchProviderResponseError';
  }
}
