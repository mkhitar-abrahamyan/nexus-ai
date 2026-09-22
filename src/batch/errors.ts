/** Base class for batch errors, each with a stable `code`. */
export class BatchError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `BATCH_VALIDATION_ERROR`. */
    public readonly code: string,
    /** The underlying error. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

/** Raised when a batch request is invalid before anything is sent. */
export class BatchValidationError extends BatchError {
  constructor(message: string, cause?: unknown) {
    super(message, 'BATCH_VALIDATION_ERROR', cause);
    this.name = 'BatchValidationError';
  }
}

/** Raised when a batch provider fails. */
export class BatchProviderError extends BatchError {
  constructor(
    message: string,
    /** The provider. */
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'BATCH_PROVIDER_ERROR', cause);
    this.name = 'BatchProviderError';
  }
}

/** Raised when no provider, or no provider by the requested name, is registered. */
export class BatchProviderNotFoundError extends BatchProviderError {
  constructor(provider?: string) {
    super(provider ? `Batch provider "${provider}" is not registered` : 'No batch provider is registered', provider);
    this.name = 'BatchProviderNotFoundError';
  }
}

/** Raised when a batch asks for something the provider does not support. */
export class BatchCapabilityError extends BatchProviderError {
  /** Always `BATCH_CAPABILITY_ERROR`. */
  override readonly code = 'BATCH_CAPABILITY_ERROR';

  constructor(
    provider: string,
    /** The unsupported option. */
    public readonly option: string,
    detail?: string,
  ) {
    super(detail ?? `Batch provider "${provider}" does not support ${option}`, provider);
    this.name = 'BatchCapabilityError';
  }
}

/** Raised when a provider's response does not have the shape the adapter expects. */
export class BatchProviderResponseError extends BatchProviderError {
  /** Always `BATCH_PROVIDER_RESPONSE_ERROR`. */
  override readonly code = 'BATCH_PROVIDER_RESPONSE_ERROR';

  constructor(provider: string, message: string, cause?: unknown) {
    super(`Invalid batch response from provider "${provider}": ${message}`, provider, cause);
    this.name = 'BatchProviderResponseError';
  }
}
