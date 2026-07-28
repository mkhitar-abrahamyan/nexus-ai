import type { MediaSafetyFinding } from '../types/images.js';

export class ImageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

export class ImageValidationError extends ImageError {
  constructor(message: string, cause?: unknown) {
    super(message, 'IMAGE_VALIDATION_ERROR', cause);
    this.name = 'ImageValidationError';
  }
}

export class ImageProviderError extends ImageError {
  constructor(
    message: string,
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'IMAGE_PROVIDER_ERROR', cause);
    this.name = 'ImageProviderError';
  }
}

export class ImageProviderNotFoundError extends ImageProviderError {
  constructor(provider?: string) {
    super(provider ? `Image provider "${provider}" is not registered` : 'No image provider is registered', provider);
    this.name = 'ImageProviderNotFoundError';
  }
}

export class ImageCapabilityError extends ImageProviderError {
  readonly code = 'IMAGE_CAPABILITY_ERROR';

  constructor(
    provider: string,
    public readonly option: string,
    public readonly requestedValue?: unknown,
    detail?: string,
  ) {
    super(
      detail ??
        `Image provider "${provider}" does not support the requested ${option}${
          requestedValue === undefined ? '' : `: ${formatValue(requestedValue)}`
        }`,
      provider,
    );
    this.name = 'ImageCapabilityError';
  }
}

export class ImageProviderResponseError extends ImageProviderError {
  readonly code = 'IMAGE_PROVIDER_RESPONSE_ERROR';

  constructor(provider: string, message: string, cause?: unknown) {
    super(`Invalid image response from provider "${provider}": ${message}`, provider, cause);
    this.name = 'ImageProviderResponseError';
  }
}

export class ImageOperationCancelledError extends ImageError {
  constructor(
    public readonly operationId: string,
    public readonly reason?: string,
  ) {
    super(
      reason
        ? `Image operation "${operationId}" was cancelled: ${reason}`
        : `Image operation "${operationId}" was cancelled`,
      'IMAGE_OPERATION_CANCELLED',
    );
    this.name = 'ImageOperationCancelledError';
  }
}

export class ImageSafetyError extends ImageError {
  constructor(
    message: string,
    public readonly findings: readonly MediaSafetyFinding[] = [],
    cause?: unknown,
  ) {
    super(message, 'IMAGE_SAFETY_ERROR', cause);
    this.name = 'ImageSafetyError';
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
