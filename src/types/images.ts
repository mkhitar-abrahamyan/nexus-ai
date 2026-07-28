export type ImageOperation = 'generate' | 'edit';

export type AssetLocationKind = 'bytes' | 'url' | 'stored';

export interface AssetBytesLocation {
  kind: 'bytes';
  data: Uint8Array;
}

export interface AssetUrlLocation {
  kind: 'url';
  url: string;
  /** ISO-8601 timestamp supplied by the provider, when the URL is temporary. */
  expiresAt?: string;
}

export interface AssetStoredLocation {
  kind: 'stored';
  uri: string;
  assetId: string;
}

export type AssetLocation = AssetBytesLocation | AssetUrlLocation | AssetStoredLocation;

export interface AssetChecksum {
  algorithm: string;
  value: string;
}

export interface AssetInput {
  location: AssetLocation;
  mimeType: string;
  filename?: string;
  checksum?: AssetChecksum;
  metadata?: Record<string, unknown>;
}

export interface AssetProvenance {
  provider: string;
  model?: string;
  operation: ImageOperation;
  requestId: string;
  parentAssetIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface AssetDescriptor extends AssetInput {
  width?: number;
  height?: number;
  byteLength?: number;
  provenance: AssetProvenance;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp' | 'avif' | (string & {});
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | (string & {});
export type ImageBackground = 'auto' | 'opaque' | 'transparent';

export type ImageDelivery =
  | { kind: 'bytes'; format?: ImageOutputFormat }
  | { kind: 'url'; format?: ImageOutputFormat; expiresInSeconds?: number }
  | { kind: 'stored'; format?: ImageOutputFormat; store?: string };

export interface ImageMaskInput extends AssetInput {
  polarity: 'white-is-editable' | 'black-is-editable';
  resizeMode?: 'reject' | 'contain' | 'cover' | 'stretch';
}

export interface ImageRequestBase {
  provider?: string;
  model?: string;
  prompt: string;
  negativePrompt?: string;
  count?: number;
  dimensions?: ImageDimensions;
  aspectRatio?: string;
  quality?: ImageQuality;
  outputFormat?: ImageOutputFormat;
  delivery?: ImageDelivery;
  background?: ImageBackground;
  seed?: number;
  requestId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerateRequest extends ImageRequestBase {}

export interface ImageEditRequest extends ImageRequestBase {
  input: AssetInput;
  mask?: ImageMaskInput;
  references?: AssetInput[];
}

export interface MediaUsage {
  inputImages?: number;
  outputImages?: number;
  inputBytes?: number;
  outputBytes?: number;
  megapixels?: number;
  providerUnits?: Record<string, number>;
}

export interface MediaSafetyFinding {
  id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: 'allow' | 'review' | 'block';
  source: 'input' | 'output';
  confidence?: number;
  assetIndex?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageWarning {
  code: string;
  message: string;
  option?: string;
  requestedValue?: unknown;
}

export interface OperationMeta {
  operationId: string;
  requestId: string;
  provider: string;
  model?: string;
  route?: string[];
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  cost?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageResult {
  assets: AssetDescriptor[];
  usage?: MediaUsage;
  safetyFindings?: MediaSafetyFinding[];
  warnings?: ImageWarning[];
  meta: OperationMeta;
  raw?: unknown;
}

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'expired';

export interface OperationEventBase {
  operationId: string;
  sequence: number;
  timestamp: string;
}

export interface OperationErrorDescriptor {
  name: string;
  message: string;
  code?: string;
}

export type OperationEvent<TResult> =
  | (OperationEventBase & { type: 'queued'; status: 'queued' })
  | (OperationEventBase & { type: 'running'; status: 'running' })
  | (OperationEventBase & { type: 'cancelling'; status: 'cancelling'; reason?: string })
  | (OperationEventBase & { type: 'succeeded'; status: 'succeeded'; result: TResult })
  | (OperationEventBase & { type: 'failed'; status: 'failed'; error: OperationErrorDescriptor })
  | (OperationEventBase & { type: 'cancelled'; status: 'cancelled'; reason?: string })
  | (OperationEventBase & { type: 'expired'; status: 'expired'; error?: OperationErrorDescriptor });

export interface OperationHandle<TResult> {
  readonly id: string;
  status(): OperationStatus;
  result(): Promise<TResult>;
  cancel(reason?: string): boolean;
  events(): AsyncIterable<OperationEvent<TResult>>;
}

export interface ImageProviderCapabilities {
  operations: readonly ImageOperation[];
  models?: readonly string[];
  inputLocationKinds?: readonly AssetLocationKind[];
  deliveryKinds?: readonly AssetLocationKind[];
  inputMimeTypes?: readonly string[];
  outputFormats?: readonly ImageOutputFormat[];
  dimensions?: readonly ImageDimensions[];
  aspectRatios?: readonly string[];
  qualities?: readonly ImageQuality[];
  minCount?: number;
  maxCount?: number;
  supportsMask?: boolean;
  supportsReferences?: boolean;
  maxReferences?: number;
  supportsTransparency?: boolean;
  supportsSeed?: boolean;
  supportsNegativePrompt?: boolean;
}

export interface ImageProviderInfo {
  name: string;
  isLocal?: boolean;
  version?: string;
  capabilities: ImageProviderCapabilities;
}

export interface ImageProviderCallContext {
  operationId: string;
  requestId: string;
  signal: AbortSignal;
  deadline?: number;
  idempotencyKey?: string;
  traceContext?: Record<string, string>;
}

export interface ImageProvider {
  readonly info: ImageProviderInfo;
  generate?(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult>;
  edit?(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult>;
}

export interface ImageSafetyContext extends ImageProviderCallContext {
  operation: ImageOperation;
  provider: string;
  model?: string;
}

export interface ImageSafetyPolicy {
  inspectInput?(
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageSafetyContext,
  ): readonly MediaSafetyFinding[] | Promise<readonly MediaSafetyFinding[]>;
  inspectOutput?(
    result: ImageResult,
    context: ImageSafetyContext,
  ): readonly MediaSafetyFinding[] | Promise<readonly MediaSafetyFinding[]>;
}

export interface ImageConfig {
  defaultProvider?: string;
  providers?: Record<string, ImageProvider>;
  safety?: ImageSafetyPolicy;
  createOperationId?: () => string;
  now?: () => Date;
}

/** @deprecated Prefer `ImageConfig`; retained as an explicit manager-local alias. */
export type ImageManagerConfig = ImageConfig;

export type ImageOperationSubmission =
  | { operation: 'generate'; request: ImageGenerateRequest }
  | { operation: 'edit'; request: ImageEditRequest };
