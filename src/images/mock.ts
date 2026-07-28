import type {
  AssetDescriptor,
  AssetInput,
  AssetLocation,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderCapabilities,
  ImageProviderInfo,
  ImageRequestBase,
  ImageResult,
} from '../types/images.js';
import { ImageOperationCancelledError } from './errors.js';

export interface MockImageProviderOptions {
  name?: string;
  model?: string;
  latencyMs?: number;
  capabilities?: Partial<ImageProviderCapabilities>;
}

const MOCK_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73,
  69, 78, 68, 174, 66, 96, 130,
]);
const MOCK_TIME_MS = Date.UTC(2030, 0, 1);

const DEFAULT_CAPABILITIES: ImageProviderCapabilities = {
  operations: ['generate', 'edit'],
  models: ['mock-image-v1'],
  inputLocationKinds: ['bytes', 'url', 'stored'],
  deliveryKinds: ['bytes', 'url', 'stored'],
  inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  outputFormats: ['png'],
  dimensions: [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
    { width: 1536, height: 864 },
    { width: 864, height: 1536 },
  ],
  aspectRatios: ['1:1', '3:2', '2:3', '16:9', '9:16'],
  qualities: ['auto', 'low', 'medium', 'high'],
  minCount: 1,
  maxCount: 4,
  supportsMask: true,
  supportsReferences: true,
  maxReferences: 4,
  supportsTransparency: true,
  supportsSeed: true,
  supportsNegativePrompt: true,
};

/** A deterministic, network-free provider for tests, examples, and capability conformance. */
export class MockImageProvider implements ImageProvider {
  readonly info: ImageProviderInfo;
  private readonly model: string;
  private readonly latencyMs: number;

  constructor(options: MockImageProviderOptions = {}) {
    this.model = options.model ?? 'mock-image-v1';
    this.latencyMs = options.latencyMs ?? 0;
    this.info = {
      name: options.name ?? 'mock',
      isLocal: true,
      version: '1',
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...options.capabilities,
        models: options.capabilities?.models ?? [this.model],
      },
    };
  }

  async generate(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    await waitForMock(this.latencyMs, context);
    return this.createResult('generate', request, context);
  }

  async edit(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    await waitForMock(this.latencyMs, context);
    return this.createResult('edit', request, context);
  }

  private createResult(
    operation: ImageOperation,
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageProviderCallContext,
  ): ImageResult {
    assertNotAborted(context);
    const model = request.model && request.model !== 'auto' ? request.model : this.model;
    const count = request.count ?? 1;
    const dimensions = request.dimensions ?? dimensionsForAspectRatio(request.aspectRatio);
    const format = request.outputFormat ?? request.delivery?.format ?? 'png';
    const mimeType = mimeTypeForFormat(format);
    const fingerprint = requestFingerprint(operation, request);
    const parentAssetIds = operation === 'edit' ? editParentIds(request as ImageEditRequest) : undefined;
    const assets: AssetDescriptor[] = [];

    for (let index = 0; index < count; index += 1) {
      assertNotAborted(context);
      const assetId = `mock-image-${hashString(`${fingerprint}:${index}`)}`;
      const location = createLocation(request, assetId, format);
      const bytes = location.kind === 'bytes' ? location.data.byteLength : undefined;
      assets.push({
        location,
        mimeType,
        width: dimensions.width,
        height: dimensions.height,
        byteLength: bytes,
        checksum: { algorithm: 'fnv1a32', value: hashBytes(MOCK_PNG) },
        provenance: {
          provider: this.info.name,
          model,
          operation,
          requestId: context.requestId,
          parentAssetIds,
          metadata: { mock: true, fingerprint },
        },
      });
    }

    const inputAssets = operation === 'edit' ? allEditInputs(request as ImageEditRequest) : [];
    const outputBytes = assets.reduce((total, asset) => total + (asset.byteLength ?? 0), 0);
    return {
      assets,
      usage: {
        inputImages: inputAssets.length,
        outputImages: assets.length,
        inputBytes: inputAssets.reduce((total, asset) => total + assetByteLength(asset), 0),
        outputBytes,
        megapixels: (dimensions.width * dimensions.height * assets.length) / 1_000_000,
      },
      safetyFindings: [],
      warnings:
        request.delivery?.kind === 'url'
          ? [
              {
                code: 'MOCK_TEMPORARY_URL',
                message: 'Mock provider URLs are temporary delivery locations and are not durable storage.',
                option: 'delivery',
                requestedValue: 'url',
              },
            ]
          : undefined,
      meta: {
        operationId: context.operationId,
        requestId: context.requestId,
        provider: this.info.name,
        model,
        metadata: { mock: true },
      },
    };
  }
}

function createLocation(request: ImageRequestBase, assetId: string, format: string): AssetLocation {
  const kind = request.delivery?.kind ?? 'bytes';
  if (kind === 'url') {
    const expiresInSeconds = request.delivery?.kind === 'url' ? request.delivery.expiresInSeconds : undefined;
    const expiresAt =
      expiresInSeconds === undefined ? undefined : new Date(MOCK_TIME_MS + expiresInSeconds * 1_000).toISOString();
    return {
      kind: 'url',
      url: `https://mock.invalid/assets/${assetId}.${encodeURIComponent(format)}`,
      expiresAt,
    };
  }
  if (kind === 'stored') {
    return { kind: 'stored', uri: `mock://assets/${assetId}`, assetId };
  }
  return { kind: 'bytes', data: new Uint8Array(MOCK_PNG) };
}

function dimensionsForAspectRatio(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '3:2':
      return { width: 1536, height: 1024 };
    case '2:3':
      return { width: 1024, height: 1536 };
    case '16:9':
      return { width: 1536, height: 864 };
    case '9:16':
      return { width: 864, height: 1536 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function mimeTypeForFormat(format: string): string {
  return format === 'jpg' ? 'image/jpeg' : `image/${format}`;
}

function requestFingerprint(operation: ImageOperation, request: ImageGenerateRequest | ImageEditRequest): string {
  const common = {
    operation,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    model: request.model,
    count: request.count,
    dimensions: request.dimensions,
    aspectRatio: request.aspectRatio,
    quality: request.quality,
    outputFormat: request.outputFormat ?? request.delivery?.format,
    delivery: request.delivery?.kind,
    background: request.background,
    seed: request.seed,
  };
  if (operation === 'generate') return JSON.stringify(common);

  const edit = request as ImageEditRequest;
  return JSON.stringify({
    ...common,
    input: assetIdentity(edit.input),
    mask: edit.mask ? assetIdentity(edit.mask) : undefined,
    references: edit.references?.map(assetIdentity),
  });
}

function allEditInputs(request: ImageEditRequest): AssetInput[] {
  return [request.input, ...(request.mask ? [request.mask] : []), ...(request.references ?? [])];
}

function editParentIds(request: ImageEditRequest): string[] {
  return allEditInputs(request).map(assetIdentity);
}

function assetIdentity(asset: AssetInput): string {
  if (asset.location.kind === 'stored') return asset.location.assetId;
  if (asset.location.kind === 'url') return `url-${hashString(asset.location.url)}`;
  return `bytes-${hashBytes(asset.location.data)}`;
}

function assetByteLength(asset: AssetInput): number {
  return asset.location.kind === 'bytes' ? asset.location.data.byteLength : 0;
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function waitForMock(latencyMs: number, context: ImageProviderCallContext): Promise<void> {
  assertNotAborted(context);
  if (latencyMs <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      context.signal.removeEventListener('abort', onAbort);
      resolve();
    }, latencyMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError(context));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotAborted(context: ImageProviderCallContext): void {
  if (context.signal.aborted) throw cancelledError(context);
}

function cancelledError(context: ImageProviderCallContext): ImageOperationCancelledError {
  const reason: unknown = context.signal.reason;
  return new ImageOperationCancelledError(
    context.operationId,
    typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : undefined,
  );
}
