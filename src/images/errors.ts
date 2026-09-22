import type { MediaSafetyFinding } from '../types/images.js';

/** Base class for image errors, each with a stable `code`. */
export class ImageError extends Error {
  constructor(
    message: string,
    /** Stable code, such as `IMAGE_VALIDATION_ERROR`. */
    public readonly code: string,
    /** The underlying error. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageError';
  }
}

/** Raised when a request or an input is invalid before anything is sent. */
export class ImageValidationError extends ImageError {
  constructor(message: string, cause?: unknown) {
    super(message, 'IMAGE_VALIDATION_ERROR', cause);
    this.name = 'ImageValidationError';
  }
}

/** Raised when an image provider fails. */
export class ImageProviderError extends ImageError {
  constructor(
    message: string,
    /** The provider. */
    public readonly provider?: string,
    cause?: unknown,
  ) {
    super(message, 'IMAGE_PROVIDER_ERROR', cause);
    this.name = 'ImageProviderError';
  }
}

/** Raised when no provider, or no provider by the requested name, is registered. */
export class ImageProviderNotFoundError extends ImageProviderError {
  constructor(provider?: string) {
    super(provider ? `Image provider "${provider}" is not registered` : 'No image provider is registered', provider);
    this.name = 'ImageProviderNotFoundError';
  }
}

/** Raised when a request asks for something the provider does not support. */
export class ImageCapabilityError extends ImageProviderError {
  /** Always `IMAGE_CAPABILITY_ERROR`. */
  readonly code = 'IMAGE_CAPABILITY_ERROR';

  constructor(
    provider: string,
    /** The unsupported option, such as `size` or `mask`. */
    public readonly option: string,
    /** The value requested. */
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

/** Raised when a provider's response does not have the shape the adapter expects. */
export class ImageProviderResponseError extends ImageProviderError {
  /** Always `IMAGE_PROVIDER_RESPONSE_ERROR`. */
  readonly code = 'IMAGE_PROVIDER_RESPONSE_ERROR';

  constructor(provider: string, message: string, cause?: unknown) {
    super(`Invalid image response from provider "${provider}": ${message}`, provider, cause);
    this.name = 'ImageProviderResponseError';
  }
}

/** Raised when work continues on a cancelled image operation. */
export class ImageOperationCancelledError extends ImageError {
  constructor(
    /** The operation. */
    public readonly operationId: string,
    /** Why it was cancelled. */
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

/** Raised when moderation refuses a prompt, an input, or an output. */
export class ImageSafetyError extends ImageError {
  constructor(
    message: string,
    /** What moderation found. */
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
