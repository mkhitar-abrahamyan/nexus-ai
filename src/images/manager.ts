import type {
  ImageConfig,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageOperationSubmission,
  ImageProvider,
  ImageProviderCapabilities,
  ImageResult,
  OperationHandle,
} from '../types/images.js';
import { ImageOperationCancelledError, ImageValidationError } from './errors.js';
import { validateDimensions } from './dimensions.js';
import { LocalOperationHandle } from '../operations/handle.js';
import { FamilyTelemetry, type FamilyRuntime } from '../ops/family-telemetry.js';

type ImageRequest = ImageGenerateRequest | ImageEditRequest;

/**
 * Routes image generation and edits to registered providers, as operations with status,
 * cancellation, and events.
 */
export class ImageManager {
  private readonly providers = new Map<string, ImageProvider>();
  private operationCounter = 0;

  private readonly telemetry: FamilyTelemetry;

  constructor(
    private readonly config: ImageConfig = {},
    runtime: FamilyRuntime = {},
  ) {
    this.telemetry = new FamilyTelemetry('images', runtime);
    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      this.registerImageProvider(name, provider);
    }
  }

  /**
   * Registers a provider under a name. Throws for a provider without declared capabilities. Returns
   * the manager, for chaining.
   */
  registerImageProvider(name: string, provider: ImageProvider): this {
    const normalizedName = name.trim();
    if (!normalizedName) throw new ImageValidationError('Image provider name must not be empty');
    if (!provider?.info?.capabilities || !Array.isArray(provider.info.capabilities.operations)) {
      throw new ImageValidationError(`Image provider "${normalizedName}" must declare capabilities`);
    }

    validateCapabilityBounds(normalizedName, provider.info.capabilities);
    this.providers.set(normalizedName, provider);
    return this;
  }

  /** Whether a provider is registered. */
  hasImageProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered provider's name. */
  listImageProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Generates images and waits for the result. */
  generate(request: ImageGenerateRequest): Promise<ImageResult> {
    return this.submit({ operation: 'generate', request }).result();
  }

  /** Edits an image and waits for the result. */
  edit(request: ImageEditRequest): Promise<ImageResult> {
    return this.submit({ operation: 'edit', request }).result();
  }

  /** Starts an image operation and returns its handle without waiting. */
  submit(submission: ImageOperationSubmission): OperationHandle<ImageResult>;
  submit(request: ImageGenerateRequest): OperationHandle<ImageResult>;
  submit(request: ImageEditRequest): OperationHandle<ImageResult>;
  submit(operation: 'generate', request: ImageGenerateRequest): OperationHandle<ImageResult>;
  submit(operation: 'edit', request: ImageEditRequest): OperationHandle<ImageResult>;
  submit(
    input: ImageOperationSubmission | ImageRequest | ImageOperation,
    request?: ImageRequest,
  ): OperationHandle<ImageResult> {
    const submission = normalizeSubmission(input, request);
    const operationId = this.createOperationId();
    // The shared handle is told to reject with the image family's own cancellation error, so this
    // refactor is invisible to existing callers catching ImageOperationCancelledError.
    const handle = new LocalOperationHandle<ImageResult>(operationId, {
      now: this.now,
      cancellationError: (id, reason) => new ImageOperationCancelledError(id, reason),
    });
    const externalSignal = submission.request.signal;
    const onAbort = (): void => {
      handle.cancel(abortReason(externalSignal));
    };
    const removeAbortListener = (): void => {
      externalSignal?.removeEventListener('abort', onAbort);
    };

    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
    void handle.result().then(removeAbortListener, removeAbortListener);

    handle.start((signal) => this.execute(submission, operationId, signal));

    return handle;
  }

  private readonly now = (): Date => this.config.now?.() ?? new Date();

  private createOperationId(): string {
    const configured = this.config.createOperationId?.();
    if (configured !== undefined) {
      if (!configured.trim()) throw new ImageValidationError('createOperationId() returned an empty value');
      return configured;
    }
    this.operationCounter += 1;
    return `image-operation-${this.operationCounter}`;
  }

  private execute(
    submission: ImageOperationSubmission,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    return this.telemetry.run(
      {
        operation: `images.${submission.operation}`,
        model: submission.request.model,
        provider: submission.request.provider,
        requestId: submission.request.requestId ?? operationId,
        metadata: { count: submission.request.count },
        signal,
        idempotencyKey: submission.request.idempotencyKey,
      },
      async (context) => {
        const { runImageOperation } = await import('./operation.js');
        return runImageOperation(
          { config: this.config, providers: this.providers, now: this.now },
          submission,
          operationId,
          context,
        );
      },
      // Only a price in dollars can count against the shared budget.
      (result) => ({
        ...(result.meta.cost !== undefined && (result.meta.currency ?? 'USD') === 'USD'
          ? { cost: result.meta.cost }
          : {}),
      }),
    );
  }
}

function normalizeSubmission(
  input: ImageOperationSubmission | ImageRequest | ImageOperation,
  request?: ImageRequest,
): ImageOperationSubmission {
  if (typeof input === 'string') {
    if (!request) throw new ImageValidationError(`submit("${input}", request) requires a request`);
    if (input === 'generate') return { operation: input, request: request as ImageGenerateRequest };
    return { operation: input, request: request as ImageEditRequest };
  }

  if ('operation' in input) return input;
  if ('input' in input) return { operation: 'edit', request: input };
  return { operation: 'generate', request: input };
}

function validateCapabilityBounds(providerName: string, capabilities: ImageProviderCapabilities): void {
  const minimum = capabilities.minCount ?? 1;
  const maximum = capabilities.maxCount ?? 1;
  if (!Number.isInteger(minimum) || minimum < 1 || !Number.isInteger(maximum) || maximum < minimum) {
    throw new ImageValidationError(
      `Image provider "${providerName}" must declare valid positive minCount/maxCount capability bounds`,
    );
  }
  capabilities.dimensions?.forEach((value, index) => {
    validateDimensions(value, `provider capabilities dimensions[${index}]`);
  });
}

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? undefined : String(reason);
}
