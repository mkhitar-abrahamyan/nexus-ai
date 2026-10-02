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
} from '../types/images.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
import {
  ImageCapabilityError,
  ImageError,
  ImageProviderError,
  ImageProviderNotFoundError,
  ImageProviderResponseError,
  ImageSafetyError,
  ImageValidationError,
} from './errors.js';

import { validateDimensions } from './dimensions.js';

type ImageRequest = ImageGenerateRequest | ImageEditRequest;

/** What one operation reads from the manager that runs it. */
export interface ImageOperationState {
  /** The manager's configuration. */
  config: ImageConfig;
  /** Registered providers, by name. */
  providers: ReadonlyMap<string, ImageProvider>;
  /** The manager's clock. */
  now: () => Date;
}

/**
 * Runs one image operation: validates it, resolves its inputs, chooses a provider, applies the
 * safety policy on both sides, and checks what came back. Loaded on the first operation, so a client
 * that never makes images never imports it.
 */
export async function runImageOperation(
  state: ImageOperationState,
  submission: ImageOperationSubmission,
  operationId: string,
  callContext: ProviderCallContext,
): Promise<ImageResult> {
  const { operation } = submission;
  const { signal, requestId } = callContext;
  validateRequest(operation, submission.request);
  const request = await resolveInputs(state, operation, submission.request, signal);
  const [registeredName, provider] = resolveProvider(state, operation, request.provider);
  assertCapabilities(registeredName, provider, operation, request);

  const context: ImageProviderCallContext = { ...callContext, operationId };
  const startedAt = state.now();
  const safetyContext: ImageSafetyContext = {
    ...context,
    operation,
    provider: registeredName,
    model: request.model,
  };
  const inputSafetyFindings = await inspectInputSafety(state, request, safetyContext);
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
    const outputSafetyFindings = await inspectOutputSafety(state, result, safetyContext);
    const safetyFindings = [...inputSafetyFindings, ...(result.safetyFindings ?? []), ...outputSafetyFindings];
    assertSafetyFindings('Generated image was blocked by output safety policy', safetyFindings);

    const completedAt = state.now();
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

/**
 * Resolves remote and stored inputs to validated bytes, when a resolver is configured.
 *
 * Runs before capability checks, so a provider that reads only bytes can still accept a URL input
 * — and every input, whatever its location, passes the same MIME, byte, and pixel checks.
 */
async function resolveInputs(
  state: ImageOperationState,
  operation: ImageOperation,
  request: ImageRequest,
  signal: AbortSignal,
): Promise<ImageRequest> {
  const resolver = state.config.inputResolver;
  if (!resolver || operation !== 'edit') return request;

  const edit = request as ImageEditRequest;
  const resolve = (asset: AssetInput, option: string) =>
    Promise.resolve(resolver.resolve(asset, { option, signal, tenantId: state.config.tenantId }));

  const [input, mask, references] = await Promise.all([
    resolve(edit.input, 'input'),
    edit.mask ? resolve(edit.mask, 'mask') : Promise.resolve(undefined),
    Promise.all((edit.references ?? []).map((asset, index) => resolve(asset, `references[${index}]`))),
  ]);

  return {
    ...edit,
    input,
    ...(mask ? { mask: { ...edit.mask, ...mask } as ImageEditRequest['mask'] } : {}),
    ...(edit.references ? { references } : {}),
  };
}

function resolveProvider(
  state: ImageOperationState,
  operation: ImageOperation,
  preferred?: string,
): [string, ImageProvider] {
  const selected = preferred?.trim() || state.config.defaultProvider;
  if (selected) {
    const provider = state.providers.get(selected);
    if (!provider) throw new ImageProviderNotFoundError(selected);
    return [selected, provider];
  }

  for (const entry of state.providers.entries()) {
    const [name, provider] = entry;
    if (provider.info.capabilities.operations.includes(operation) && hasProviderMethod(provider, operation)) {
      return [name, provider];
    }
  }

  if (state.providers.size === 0) throw new ImageProviderNotFoundError();
  const names = [...state.providers.keys()].join(', ');
  throw new ImageCapabilityError(
    names,
    'operation',
    operation,
    `No registered image provider supports the "${operation}" operation`,
  );
}

async function inspectInputSafety(
  state: ImageOperationState,
  request: ImageGenerateRequest | ImageEditRequest,
  context: ImageSafetyContext,
): Promise<readonly MediaSafetyFinding[]> {
  const inspect = state.config.safety?.inspectInput;
  if (!inspect) return [];
  try {
    return (await inspect(request, context)) ?? [];
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageSafetyError('Image input safety inspection failed', [], error);
  }
}

async function inspectOutputSafety(
  state: ImageOperationState,
  result: ImageResult,
  context: ImageSafetyContext,
): Promise<readonly MediaSafetyFinding[]> {
  const inspect = state.config.safety?.inspectOutput;
  if (!inspect) return [];
  try {
    return (await inspect(result, context)) ?? [];
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageSafetyError('Image output safety inspection failed', [], error);
  }
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
  // A provider that filtered some images itself reports each one as a withheld finding; those
  // account for the shortfall, so the images that did pass are not discarded with them.
  const withheld = (result.safetyFindings ?? []).filter(isWithheldFinding).length;
  if (result.assets.length !== expectedCount && result.assets.length + withheld !== expectedCount) {
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
  // A withheld output never reached the caller, so there is nothing left for it to block.
  const blocked = findings.filter((finding) => finding.action === 'block' && !isWithheldFinding(finding));
  if (blocked.length > 0) throw new ImageSafetyError(message, blocked);
}

/** An output the provider removed before returning, reported so the gap in the result is explained. */
function isWithheldFinding(finding: MediaSafetyFinding): boolean {
  return finding.source === 'output' && finding.action === 'block' && finding.metadata?.withheld === true;
}
