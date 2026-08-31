export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export class EmbeddingValidationError extends EmbeddingError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EMBEDDING_VALIDATION_ERROR', cause);
    this.name = 'EmbeddingValidationError';
  }
}

export class EmbeddingProviderError extends EmbeddingError {
  constructor(
    message: string,
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'EMBEDDING_PROVIDER_ERROR', cause);
    this.name = 'EmbeddingProviderError';
  }
}

export class EmbeddingProviderNotFoundError extends EmbeddingProviderError {
  constructor(provider?: string) {
    super(
      provider
        ? `Embedding provider "${provider}" is not registered`
        : 'No embedding provider is registered. Configure one through providers, or register one with registerEmbeddingProvider().',
      provider,
    );
    this.name = 'EmbeddingProviderNotFoundError';
  }
}

/**
 * A requested option the target model or adapter cannot honor.
 *
 * Embeddings refuse rather than drop: a vector produced with different dimensions or a different
 * input type is silently incompatible with the vectors already in a store, and the mismatch only
 * surfaces later as bad retrieval.
 */
export class EmbeddingCapabilityError extends EmbeddingProviderError {
  override readonly code = 'EMBEDDING_CAPABILITY_ERROR';

  constructor(
    provider: string,
    public readonly option: string,
    public readonly requestedValue?: unknown,
    detail?: string,
  ) {
    super(
      detail ??
        `Embedding provider "${provider}" does not support the requested ${option}${
          requestedValue === undefined ? '' : `: ${formatValue(requestedValue)}`
        }`,
      provider,
    );
    this.name = 'EmbeddingCapabilityError';
  }
}

export class EmbeddingProviderResponseError extends EmbeddingProviderError {
  override readonly code = 'EMBEDDING_PROVIDER_RESPONSE_ERROR';

  constructor(provider: string, message: string, cause?: unknown) {
    super(`Invalid embedding response from provider "${provider}": ${message}`, provider, cause);
    this.name = 'EmbeddingProviderResponseError';
  }
}

export class EmbeddingModelNotFoundError extends EmbeddingError {
  constructor(public readonly model: string) {
    super(
      `Embedding model "${model}" is not in the registry. Add it through embeddings.models.registry, or name a provider explicitly.`,
      'EMBEDDING_MODEL_NOT_FOUND',
    );
    this.name = 'EmbeddingModelNotFoundError';
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
