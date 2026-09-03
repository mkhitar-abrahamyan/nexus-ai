import type {
  AssetInput,
  ImageConfig,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageOperationSubmission,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderCapabilities,
  ImageResult,
  ImageSafetyContext,
  MediaSafetyFinding,
  OperationHandle,
} from '../types/images.js';
import {
  ImageCapabilityError,
  ImageError,
  ImageOperationCancelledError,
  ImageProviderError,
  ImageProviderNotFoundError,
  ImageProviderResponseError,
  ImageSafetyError,
  ImageValidationError,
} from './errors.js';
import { LocalOperationHandle } from '../operations/handle.js';
import { FamilyTelemetry, type FamilyRuntime } from '../ops/family-telemetry.js';

type ImageRequest = ImageGenerateRequest | ImageEditRequest;

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

  hasImageProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listImageProviders(): string[] {
    return [...this.providers.keys()];
  }

  generate(request: ImageGenerateRequest): Promise<ImageResult> {
    return this.submit({ operation: 'generate', request }).result();
  }

  edit(request: ImageEditRequest): Promise<ImageResult> {
    return this.submit({ operation: 'edit', request }).result();
  }

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
      },
      () => this.runOperation(submission, operationId, signal),
    );
  }

  private async runOperation(
    submission: ImageOperationSubmission,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ImageResult> {
    const { operation, request } = submission;
    validateRequest(operation, request);
    const [registeredName, provider] = this.resolveProvider(operation, request.provider);
    assertCapabilities(registeredName, provider, operation, request);

    const requestId = request.requestId?.trim() || operationId;
    const context: ImageProviderCallContext = {
      operationId,
      requestId,
      signal,
      idempotencyKey: request.idempotencyKey,
    };
    const startedAt = this.now();
    const safetyContext: ImageSafetyContext = {
      ...context,
      operation,
      provider: registeredName,
      model: request.model,
    };
    const inputSafetyFindings = await this.inspectInputSafety(request, safetyContext);
    assertSafetyFindings('Image request was blocked by input safety policy', inputSafetyFindings);

    try {
      const result =
        operation === 'generate'
          ? await provider.generate?.({ ...request, signal }, context)
          : await provider.edit?.({ ...(request as ImageEditRequest), signal }, context);

      if (!result) {
        throw new ImageProviderResponseError(registeredName, `the ${operation} method returned no result`);
      }
      const expectedProvider = provider.info.name?.trim() || registeredName;
      validateResult(registeredName, expectedProvider, operation, request, context, provider.info.capabilities, result);
      const outputSafetyFindings = await this.inspectOutputSafety(result, safetyContext);
      const safetyFindings = [...inputSafetyFindings, ...(result.safetyFindings ?? []), ...outputSafetyFindings];
      assertSafetyFindings('Generated image was blocked by output safety policy', safetyFindings);

      const completedAt = this.now();
      return {
        ...result,
        safetyFindings: safetyFindings.length > 0 ? safetyFindings : undefined,
        meta: {
          ...result.meta,
          operationId,
          requestId,
          provider: expectedProvider,
          startedAt: result.meta.startedAt ?? startedAt.toISOString(),
          completedAt: result.meta.completedAt ?? completedAt.toISOString(),
          latencyMs: result.meta.latencyMs ?? Math.max(0, completedAt.getTime() - startedAt.getTime()),
        },
      };
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageProviderError(`Image ${operation} failed for provider "${registeredName}"`, registeredName, error);
    }
  }

  private resolveProvider(operation: ImageOperation, preferred?: string): [string, ImageProvider] {
    const selected = preferred?.trim() || this.config.defaultProvider;
    if (selected) {
      const provider = this.providers.get(selected);
      if (!provider) throw new ImageProviderNotFoundError(selected);
      return [selected, provider];
    }

    for (const entry of this.providers.entries()) {
      const [name, provider] = entry;
      if (provider.info.capabilities.operations.includes(operation) && hasProviderMethod(provider, operation)) {
        return [name, provider];
      }
    }

    if (this.providers.size === 0) throw new ImageProviderNotFoundError();
    const names = [...this.providers.keys()].join(', ');
    throw new ImageCapabilityError(
      names,
      'operation',
      operation,
      `No registered image provider supports the "${operation}" operation`,
    );
  }

  private async inspectInputSafety(
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageSafetyContext,
  ): Promise<readonly MediaSafetyFinding[]> {
    const inspect = this.config.safety?.inspectInput;
    if (!inspect) return [];
    try {
      return (await inspect(request, context)) ?? [];
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageSafetyError('Image input safety inspection failed', [], error);
    }
  }

  private async inspectOutputSafety(
    result: ImageResult,
    context: ImageSafetyContext,
  ): Promise<readonly MediaSafetyFinding[]> {
    const inspect = this.config.safety?.inspectOutput;
    if (!inspect) return [];
    try {
      return (await inspect(result, context)) ?? [];
    } catch (error) {
      if (error instanceof ImageError) throw error;
      throw new ImageSafetyError('Image output safety inspection failed', [], error);
    }
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

function validateRequest(operation: ImageOperation, request: ImageRequest): void {
  if (!request || typeof request !== 'object') throw new ImageValidationError('Image request is required');
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new ImageValidationError('Image prompt must not be empty');
  }
  if (request.provider !== undefined && !request.provider.trim()) {
    throw new ImageValidationError('Image provider must not be empty');
  }
  if (request.model !== undefined && !request.model.trim()) {
    throw new ImageValidationError('Image model must not be empty');
  }
  if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1)) {
    throw new ImageValidationError('Image count must be a positive integer');
  }
  if (request.dimensions) validateDimensions(request.dimensions, 'dimensions');
  if (request.aspectRatio !== undefined && !request.aspectRatio.trim()) {
    throw new ImageValidationError('Image aspectRatio must not be empty');
  }
  if (request.seed !== undefined && !Number.isSafeInteger(request.seed)) {
    throw new ImageValidationError('Image seed must be a safe integer');
  }
  if (request.negativePrompt !== undefined && !request.negativePrompt.trim()) {
    throw new ImageValidationError('Image negativePrompt must not be empty when provided');
  }
  if (request.delivery?.kind === 'url' && request.delivery.expiresInSeconds !== undefined) {
    if (!Number.isFinite(request.delivery.expiresInSeconds) || request.delivery.expiresInSeconds <= 0) {
      throw new ImageValidationError('Image URL delivery expiresInSeconds must be positive');
    }
  }
  if (request.outputFormat && request.delivery?.format && request.outputFormat !== request.delivery.format) {
    throw new ImageValidationError('outputFormat and delivery.format must match when both are provided');
  }

  if (operation === 'edit') {
    if (!('input' in request)) throw new ImageValidationError('Image edit requires an input asset');
    validateAsset(request.input, 'input');
    if (request.mask) validateAsset(request.mask, 'mask');
    if (request.references !== undefined) {
      if (!Array.isArray(request.references)) throw new ImageValidationError('Image references must be an array');
      request.references.forEach((asset, index) => {
        validateAsset(asset, `references[${index}]`);
      });
    }
  }
}

function validateDimensions(dimensions: { width: number; height: number }, option: string): void {
  if (!Number.isInteger(dimensions.width) || dimensions.width < 1) {
    throw new ImageValidationError(`${option}.width must be a positive integer`);
  }
  if (!Number.isInteger(dimensions.height) || dimensions.height < 1) {
    throw new ImageValidationError(`${option}.height must be a positive integer`);
  }
}

function validateAsset(asset: AssetInput, option: string): void {
  if (!asset || typeof asset !== 'object' || !asset.location) {
    throw new ImageValidationError(`${option} must contain an asset location`);
  }
  if (typeof asset.mimeType !== 'string' || !asset.mimeType.trim()) {
    throw new ImageValidationError(`${option}.mimeType must not be empty`);
  }

  const location = asset.location;
  if (location.kind === 'bytes') {
    if (!(location.data instanceof Uint8Array) || location.data.byteLength === 0) {
      throw new ImageValidationError(`${option}.location.data must be a non-empty Uint8Array`);
    }
    return;
  }
  if (location.kind === 'url') {
    try {
      const url = new URL(location.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw new ImageValidationError(`${option}.location.url must be an absolute HTTP(S) URL`);
    }
    return;
  }
  if (location.kind === 'stored') {
    if (!location.uri.trim() || !location.assetId.trim()) {
      throw new ImageValidationError(`${option}.location stored uri and assetId must not be empty`);
    }
    return;
  }
  throw new ImageValidationError(`${option}.location has an unsupported kind`);
}

function assertCapabilities(
  providerName: string,
  provider: ImageProvider,
  operation: ImageOperation,
  request: ImageRequest,
): void {
  const capabilities = provider.info.capabilities;
  if (!capabilities.operations.includes(operation) || !hasProviderMethod(provider, operation)) {
    throw new ImageCapabilityError(providerName, 'operation', operation);
  }

  const count = request.count ?? 1;
  const minimum = capabilities.minCount ?? 1;
  const maximum = capabilities.maxCount ?? 1;
  if (count < minimum || count > maximum) {
    throw new ImageCapabilityError(
      providerName,
      'count',
      count,
      `Image provider "${providerName}" supports a count from ${minimum} to ${maximum}`,
    );
  }
  if (request.model && request.model !== 'auto' && !capabilities.models?.includes(request.model)) {
    throw new ImageCapabilityError(providerName, 'model', request.model);
  }
  if (request.dimensions && !includesDimensions(capabilities.dimensions, request.dimensions)) {
    throw new ImageCapabilityError(providerName, 'dimensions', request.dimensions);
  }
  if (request.aspectRatio && !capabilities.aspectRatios?.includes(request.aspectRatio)) {
    throw new ImageCapabilityError(providerName, 'aspectRatio', request.aspectRatio);
  }
  if (request.quality && !capabilities.qualities?.includes(request.quality)) {
    throw new ImageCapabilityError(providerName, 'quality', request.quality);
  }

  const outputFormat = request.outputFormat ?? request.delivery?.format;
  if (outputFormat && !capabilities.outputFormats?.includes(outputFormat)) {
    throw new ImageCapabilityError(providerName, 'outputFormat', outputFormat);
  }
  if (request.delivery && !capabilities.deliveryKinds?.includes(request.delivery.kind)) {
    throw new ImageCapabilityError(providerName, 'delivery', request.delivery.kind);
  }
  if (request.background === 'transparent' && !capabilities.supportsTransparency) {
    throw new ImageCapabilityError(providerName, 'background', request.background);
  }
  if (request.seed !== undefined && !capabilities.supportsSeed) {
    throw new ImageCapabilityError(providerName, 'seed', request.seed);
  }
  if (request.negativePrompt !== undefined && !capabilities.supportsNegativePrompt) {
    throw new ImageCapabilityError(providerName, 'negativePrompt');
  }

  if (operation === 'edit') {
    const editRequest = request as ImageEditRequest;
    assertAssetCapabilities(providerName, capabilities, editRequest.input, 'input');
    if (editRequest.mask) {
      if (!capabilities.supportsMask) throw new ImageCapabilityError(providerName, 'mask');
      assertAssetCapabilities(providerName, capabilities, editRequest.mask, 'mask');
    }
    const references = editRequest.references ?? [];
    if (references.length > 0 && !capabilities.supportsReferences) {
      throw new ImageCapabilityError(providerName, 'references', references.length);
    }
    if (capabilities.maxReferences !== undefined && references.length > capabilities.maxReferences) {
      throw new ImageCapabilityError(
        providerName,
        'references',
        references.length,
        `Image provider "${providerName}" supports at most ${capabilities.maxReferences} reference assets`,
      );
    }
    references.forEach((asset, index) => {
      assertAssetCapabilities(providerName, capabilities, asset, `references[${index}]`);
    });
  }
}

function assertAssetCapabilities(
  providerName: string,
  capabilities: ImageProviderCapabilities,
  asset: AssetInput,
  option: string,
): void {
  if (!capabilities.inputLocationKinds?.includes(asset.location.kind)) {
    throw new ImageCapabilityError(providerName, `${option}.location`, asset.location.kind);
  }
  if (!supportsMimeType(capabilities.inputMimeTypes, asset.mimeType)) {
    throw new ImageCapabilityError(providerName, `${option}.mimeType`, asset.mimeType);
  }
}

function supportsMimeType(supported: readonly string[] | undefined, requested: string): boolean {
  if (!supported) return false;
  const normalized = requested.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return supported.some((candidate) => {
    const value = candidate.toLowerCase();
    if (value === '*/*' || value === normalized) return true;
    return value.endsWith('/*') && normalized.startsWith(value.slice(0, -1));
  });
}

function includesDimensions(
  supported: readonly { width: number; height: number }[] | undefined,
  requested: { width: number; height: number },
): boolean {
  return supported?.some((item) => item.width === requested.width && item.height === requested.height) ?? false;
}

function hasProviderMethod(provider: ImageProvider, operation: ImageOperation): boolean {
  return operation === 'generate' ? typeof provider.generate === 'function' : typeof provider.edit === 'function';
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

function validateResult(
  providerName: string,
  expectedProvider: string,
  operation: ImageOperation,
  request: ImageRequest,
  context: ImageProviderCallContext,
  capabilities: ImageProviderCapabilities,
  result: ImageResult,
): void {
  if (!Array.isArray(result.assets) || result.assets.length === 0) {
    throw new ImageProviderResponseError(providerName, 'assets must be a non-empty array');
  }
  const expectedCount = request.count ?? 1;
  if (result.assets.length !== expectedCount) {
    throw new ImageProviderResponseError(
      providerName,
      `asset count ${result.assets.length} does not match requested count ${expectedCount}`,
    );
  }
  if (!result.meta || typeof result.meta !== 'object') {
    throw new ImageProviderResponseError(providerName, 'meta is required');
  }
  if (result.meta.operationId !== context.operationId) {
    throw new ImageProviderResponseError(providerName, 'meta.operationId does not match the call context');
  }
  if (result.meta.requestId !== context.requestId) {
    throw new ImageProviderResponseError(providerName, 'meta.requestId does not match the call context');
  }
  if (result.meta.provider !== expectedProvider) {
    throw new ImageProviderResponseError(
      providerName,
      `meta.provider must match the declared provider name "${expectedProvider}"`,
    );
  }

  const requestedFormat = request.outputFormat ?? request.delivery?.format;
  const expectedMimeType = knownImageMimeType(requestedFormat);
  result.assets.forEach((asset, index) => {
    try {
      validateAsset(asset, `assets[${index}]`);
      if (!asset.provenance) throw new ImageValidationError(`assets[${index}].provenance is required`);
      if (!asset.mimeType.toLowerCase().startsWith('image/')) {
        throw new ImageValidationError(`assets[${index}].mimeType must be an image MIME type`);
      }
      if (expectedMimeType && normalizeMimeType(asset.mimeType) !== expectedMimeType) {
        throw new ImageValidationError(`assets[${index}].mimeType must be "${expectedMimeType}"`);
      }
      if (request.delivery && asset.location.kind !== request.delivery.kind) {
        throw new ImageValidationError(
          `assets[${index}].location.kind must match requested delivery kind "${request.delivery.kind}"`,
        );
      }
      if (capabilities.deliveryKinds && !capabilities.deliveryKinds.includes(asset.location.kind)) {
        throw new ImageValidationError(`assets[${index}].location.kind is not declared by the provider capabilities`);
      }
      if (asset.provenance.provider !== expectedProvider) {
        throw new ImageValidationError(
          `assets[${index}].provenance.provider must match the declared provider name "${expectedProvider}"`,
        );
      }
      if (asset.provenance.operation !== operation) {
        throw new ImageValidationError(`assets[${index}].provenance.operation must be "${operation}"`);
      }
      if (asset.provenance.requestId !== context.requestId) {
        throw new ImageValidationError(`assets[${index}].provenance.requestId does not match the call context`);
      }
      if (asset.location.kind === 'bytes' && asset.byteLength !== undefined) {
        if (asset.byteLength !== asset.location.data.byteLength) {
          throw new ImageValidationError(`assets[${index}].byteLength does not match its byte payload`);
        }
      }
    } catch (error) {
      throw new ImageProviderResponseError(
        providerName,
        error instanceof Error ? error.message : `asset ${index} is invalid`,
        error,
      );
    }
  });
}

function knownImageMimeType(format: string | undefined): string | undefined {
  switch (format?.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    default:
      return undefined;
  }
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function assertSafetyFindings(message: string, findings: readonly MediaSafetyFinding[]): void {
  const blocked = findings.filter((finding) => finding.action === 'block');
  if (blocked.length > 0) throw new ImageSafetyError(message, blocked);
}

function abortReason(signal: AbortSignal | undefined): string | undefined {
  if (!signal) return undefined;
  const reason: unknown = signal.reason;
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  return reason === undefined ? undefined : String(reason);
}
