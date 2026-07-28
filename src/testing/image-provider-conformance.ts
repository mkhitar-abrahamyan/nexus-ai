import type {
  AssetInput,
  AssetLocationKind,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageOutputFormat,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderCapabilities,
  ImageResult,
} from '../types/images.js';

interface ImageProviderConformanceCaseBase {
  name: string;
  validate?: (result: ImageResult) => boolean | Promise<boolean>;
}

export interface ImageGenerateProviderConformanceCase extends ImageProviderConformanceCaseBase {
  operation: 'generate';
  request: ImageGenerateRequest;
}

export interface ImageEditProviderConformanceCase extends ImageProviderConformanceCaseBase {
  operation: 'edit';
  request: ImageEditRequest;
}

export type ImageProviderConformanceCase = ImageGenerateProviderConformanceCase | ImageEditProviderConformanceCase;

export interface ImageProviderConformanceResult {
  providerName: string;
  model?: string;
  caseName: string;
  operation: ImageOperation;
  operationOk: boolean;
  abortOk?: boolean;
  error?: string;
}

export interface ImageProviderConformanceOptions {
  model?: string;
  fixtures?: readonly ImageProviderConformanceCase[];
  editInput?: AssetInput;
  testAbort?: boolean;
  testEdit?: boolean;
}

const PORTABLE_PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68,
  174, 66, 96, 130,
]);

const BASIC_GENERATE_FIXTURE: ImageGenerateProviderConformanceCase = {
  name: 'basic-image-generation',
  operation: 'generate',
  request: {
    prompt: 'A single solid blue square.',
    count: 1,
    outputFormat: 'png',
    delivery: { kind: 'bytes', format: 'png' },
  },
};

const BASIC_EDIT_FIXTURE: ImageEditProviderConformanceCase = {
  name: 'basic-image-edit',
  operation: 'edit',
  request: {
    prompt: 'Change the square to green.',
    count: 1,
    outputFormat: 'png',
    delivery: { kind: 'bytes', format: 'png' },
    input: portableEditInput(),
  },
};

export const IMAGE_PROVIDER_CONFORMANCE_FIXTURES: readonly ImageProviderConformanceCase[] = [
  BASIC_GENERATE_FIXTURE,
  BASIC_EDIT_FIXTURE,
];

export async function runImageProviderConformance(
  providerName: string,
  provider: ImageProvider,
  options: ImageProviderConformanceOptions = {},
): Promise<ImageProviderConformanceResult[]> {
  const fixtures = options.fixtures || defaultFixtures(provider.info.capabilities, options);
  const expectedProvider = provider.info.name || providerName;
  const declaredOperations = provider.info.capabilities.operations;
  const results: ImageProviderConformanceResult[] = [];

  for (const fixture of fixtures) {
    const request = withModel(fixture.request, options.model);
    const errors: string[] = [];
    let operationOk = false;
    let abortOk: boolean | undefined;

    if (!declaredOperations.includes(fixture.operation)) {
      errors.push(`capabilities do not declare the ${fixture.operation} operation`);
    } else if (!hasOperation(provider, fixture.operation)) {
      errors.push(`provider declares ${fixture.operation} but does not implement it`);
    } else {
      const context = createContext(providerName, fixture, request);
      const callRequest = withCallState(request, context.requestId, context.signal);

      try {
        const response = await invokeProvider(provider, fixture.operation, callRequest, context);
        const validationErrors = validateResult(
          response,
          callRequest,
          context,
          fixture.operation,
          expectedProvider,
          provider.info.capabilities,
        );
        errors.push(...validationErrors);

        if (validationErrors.length === 0 && fixture.validate) {
          const customOk = await fixture.validate(response);
          if (!customOk) errors.push('custom validation returned false');
        }

        operationOk = errors.length === 0;
      } catch (error) {
        errors.push(`operation threw: ${errorMessage(error)}`);
      }

      if (options.testAbort) {
        const abortResult = await testPreAbortedCall(provider, providerName, fixture, request);
        abortOk = abortResult.ok;
        if (abortResult.error) errors.push(abortResult.error);
      }
    }

    results.push({
      providerName,
      model: request.model,
      caseName: fixture.name,
      operation: fixture.operation,
      operationOk,
      abortOk,
      error: errors.length > 0 ? errors.join(' | ') : undefined,
    });
  }

  return results;
}

function defaultFixtures(
  capabilities: ImageProviderCapabilities,
  options: ImageProviderConformanceOptions,
): ImageProviderConformanceCase[] {
  const requestDefaults = supportedRequestDefaults(capabilities, options.model);
  const fixtures: ImageProviderConformanceCase[] = [];

  if (capabilities.operations.includes('generate')) {
    fixtures.push({
      ...BASIC_GENERATE_FIXTURE,
      request: {
        ...BASIC_GENERATE_FIXTURE.request,
        ...requestDefaults,
      },
    });
  }

  if (capabilities.operations.includes('edit') && options.testEdit !== false) {
    fixtures.push({
      ...BASIC_EDIT_FIXTURE,
      request: {
        ...BASIC_EDIT_FIXTURE.request,
        ...requestDefaults,
        input: options.editInput || portableEditInput(),
      },
    });
  }

  return fixtures;
}

function supportedRequestDefaults(
  capabilities: ImageProviderCapabilities,
  modelOverride?: string,
): Pick<ImageGenerateRequest, 'count' | 'delivery' | 'outputFormat'> &
  Partial<Pick<ImageGenerateRequest, 'aspectRatio' | 'dimensions' | 'model' | 'quality'>> {
  const outputFormat = capabilities.outputFormats?.[0] || 'png';
  const deliveryKind = capabilities.deliveryKinds?.[0] || 'bytes';
  const count = supportedCount(capabilities);
  const model = modelOverride || capabilities.models?.[0];
  const dimensions = capabilities.dimensions?.[0];
  const aspectRatio = dimensions ? undefined : capabilities.aspectRatios?.[0];

  return {
    count,
    delivery: deliveryFor(deliveryKind, outputFormat),
    outputFormat,
    model,
    dimensions: dimensions ? { ...dimensions } : undefined,
    aspectRatio,
    quality: capabilities.qualities?.[0],
  };
}

function supportedCount(capabilities: ImageProviderCapabilities): number {
  const minimum = positiveInteger(capabilities.minCount) || 1;
  const maximum = positiveInteger(capabilities.maxCount);
  return maximum === undefined ? minimum : Math.min(minimum, maximum);
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function deliveryFor(kind: AssetLocationKind, format: ImageOutputFormat): ImageGenerateRequest['delivery'] {
  if (kind === 'url') return { kind, format };
  if (kind === 'stored') return { kind, format };
  return { kind, format };
}

function portableEditInput(): AssetInput {
  return {
    location: { kind: 'bytes', data: PORTABLE_PNG_BYTES.slice() },
    mimeType: 'image/png',
    filename: 'conformance-input.png',
  };
}

function withModel<TRequest extends ImageGenerateRequest | ImageEditRequest>(
  request: TRequest,
  model?: string,
): TRequest {
  return (model ? { ...request, model } : { ...request }) as TRequest;
}

function withCallState<TRequest extends ImageGenerateRequest | ImageEditRequest>(
  request: TRequest,
  requestId: string,
  signal: AbortSignal,
): TRequest {
  return { ...request, requestId, signal };
}

function createContext(
  providerName: string,
  fixture: ImageProviderConformanceCase,
  request: ImageGenerateRequest | ImageEditRequest,
  suffix = 'operation',
  signal = request.signal || new AbortController().signal,
): ImageProviderCallContext {
  const stem = `conformance:${providerName}:${fixture.name}:${suffix}`;
  return {
    operationId: stem,
    requestId: request.requestId || `${stem}:request`,
    signal,
    idempotencyKey: request.idempotencyKey,
  };
}

function hasOperation(provider: ImageProvider, operation: ImageOperation): boolean {
  return operation === 'generate' ? typeof provider.generate === 'function' : typeof provider.edit === 'function';
}

async function invokeProvider(
  provider: ImageProvider,
  operation: ImageOperation,
  request: ImageGenerateRequest | ImageEditRequest,
  context: ImageProviderCallContext,
): Promise<ImageResult> {
  if (operation === 'generate') {
    if (!provider.generate) throw new Error('generate is not implemented');
    return provider.generate(request as ImageGenerateRequest, context);
  }

  if (!provider.edit) throw new Error('edit is not implemented');
  return provider.edit(request as ImageEditRequest, context);
}

async function testPreAbortedCall(
  provider: ImageProvider,
  providerName: string,
  fixture: ImageProviderConformanceCase,
  request: ImageGenerateRequest | ImageEditRequest,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  controller.abort(new Error('Image provider conformance pre-abort'));
  const abortRequest = { ...request, requestId: undefined, idempotencyKey: undefined };
  const context = createContext(providerName, fixture, abortRequest, 'pre-abort', controller.signal);
  const callRequest = withCallState(abortRequest, context.requestId, controller.signal);

  try {
    await invokeProvider(provider, fixture.operation, callRequest, context);
    return { ok: false, error: 'pre-aborted call resolved instead of rejecting' };
  } catch {
    return { ok: true };
  }
}

function validateResult(
  result: unknown,
  request: ImageGenerateRequest | ImageEditRequest,
  context: ImageProviderCallContext,
  operation: ImageOperation,
  expectedProvider: string,
  capabilities: ImageProviderCapabilities,
): string[] {
  const errors: string[] = [];
  if (!isRecord(result)) return ['response is not an object'];

  if (!Array.isArray(result.assets)) {
    errors.push('response assets is not an array');
  } else {
    validateAssetCount(result.assets.length, request.count, capabilities, errors);
    for (const [index, asset] of result.assets.entries()) {
      validateAsset(asset, index, request, context, operation, expectedProvider, capabilities, errors);
    }
  }

  if (!isRecord(result.meta)) {
    errors.push('response meta is not an object');
  } else {
    if (result.meta.provider !== expectedProvider) {
      errors.push(`meta provider must be "${expectedProvider}"`);
    }
    if (result.meta.operationId !== context.operationId) {
      errors.push('meta operationId does not match the call context');
    }
    if (result.meta.requestId !== context.requestId) {
      errors.push('meta requestId does not match the call context');
    }
  }

  return errors;
}

function validateAssetCount(
  actual: number,
  requested: number | undefined,
  capabilities: ImageProviderCapabilities,
  errors: string[],
): void {
  if (requested !== undefined && actual !== requested) {
    errors.push(`asset count ${actual} does not match requested count ${requested}`);
  } else if (requested === undefined && actual === 0) {
    errors.push('response contains no assets');
  }

  if (capabilities.minCount !== undefined && actual < capabilities.minCount) {
    errors.push(`asset count ${actual} is below declared minimum ${capabilities.minCount}`);
  }
  if (capabilities.maxCount !== undefined && actual > capabilities.maxCount) {
    errors.push(`asset count ${actual} exceeds declared maximum ${capabilities.maxCount}`);
  }
}

function validateAsset(
  asset: unknown,
  index: number,
  request: ImageGenerateRequest | ImageEditRequest,
  context: ImageProviderCallContext,
  operation: ImageOperation,
  expectedProvider: string,
  capabilities: ImageProviderCapabilities,
  errors: string[],
): void {
  const prefix = `asset[${index}]`;
  if (!isRecord(asset)) {
    errors.push(`${prefix} is not an object`);
    return;
  }

  validateMimeType(asset.mimeType, request.outputFormat || request.delivery?.format, prefix, errors);
  validateLocation(asset.location, request.delivery?.kind, capabilities.deliveryKinds, prefix, errors);

  if (!isRecord(asset.provenance)) {
    errors.push(`${prefix} provenance is not an object`);
    return;
  }
  if (asset.provenance.provider !== expectedProvider) {
    errors.push(`${prefix} provenance provider must be "${expectedProvider}"`);
  }
  if (asset.provenance.operation !== operation) {
    errors.push(`${prefix} provenance operation must be "${operation}"`);
  }
  if (asset.provenance.requestId !== context.requestId) {
    errors.push(`${prefix} provenance requestId does not match the call context`);
  }
}

function validateMimeType(
  mimeType: unknown,
  requestedFormat: ImageOutputFormat | undefined,
  prefix: string,
  errors: string[],
): void {
  if (typeof mimeType !== 'string' || !mimeType.toLowerCase().startsWith('image/')) {
    errors.push(`${prefix} mimeType is not an image MIME type`);
    return;
  }

  const expectedMimeType = knownMimeType(requestedFormat);
  if (expectedMimeType && mimeType.toLowerCase().split(';', 1)[0].trim() !== expectedMimeType) {
    errors.push(`${prefix} mimeType must be "${expectedMimeType}"`);
  }
}

function knownMimeType(format: ImageOutputFormat | undefined): string | undefined {
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

function validateLocation(
  location: unknown,
  requestedKind: AssetLocationKind | undefined,
  supportedKinds: readonly AssetLocationKind[] | undefined,
  prefix: string,
  errors: string[],
): void {
  if (!isRecord(location)) {
    errors.push(`${prefix} location is not an object`);
    return;
  }

  const kind = location.kind;
  if (kind !== 'bytes' && kind !== 'url' && kind !== 'stored') {
    errors.push(`${prefix} location kind is invalid`);
    return;
  }
  if (requestedKind && kind !== requestedKind) {
    errors.push(`${prefix} location kind "${kind}" does not match requested kind "${requestedKind}"`);
  }
  if (supportedKinds && !supportedKinds.includes(kind)) {
    errors.push(`${prefix} location kind "${kind}" is not declared by the provider`);
  }

  if (kind === 'bytes' && (!(location.data instanceof Uint8Array) || location.data.byteLength === 0)) {
    errors.push(`${prefix} bytes location must contain a non-empty Uint8Array`);
  }
  if (kind === 'url' && !isAbsoluteHttpUrl(location.url)) {
    errors.push(`${prefix} URL location must contain an absolute HTTP(S) URL`);
  }
  if (
    kind === 'stored' &&
    (typeof location.uri !== 'string' ||
      location.uri.length === 0 ||
      typeof location.assetId !== 'string' ||
      location.assetId.length === 0)
  ) {
    errors.push(`${prefix} stored location must contain non-empty uri and assetId values`);
  }
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
