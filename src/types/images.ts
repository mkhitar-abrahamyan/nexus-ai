/** What an image request does: create an image from a prompt, or change an existing one. */
export type ImageOperation = 'generate' | 'edit';

/** Where an asset's content lives: in memory, at a URL, or in an asset store. */
export type AssetLocationKind = 'bytes' | 'url' | 'stored';

/** An asset held in memory. */
export interface AssetBytesLocation {
  /** Discriminates this location in `AssetLocation`. */
  kind: 'bytes';
  /** The encoded image bytes. */
  data: Uint8Array;
}

/** An asset reachable at a URL, such as one a provider hosts for a limited time. */
export interface AssetUrlLocation {
  /** Discriminates this location in `AssetLocation`. */
  kind: 'url';
  /** Where the asset can be fetched. */
  url: string;
  /** ISO-8601 timestamp supplied by the provider, when the URL is temporary. */
  expiresAt?: string;
}

/** An asset kept in an `AssetStore`, referenced rather than carried. */
export interface AssetStoredLocation {
  /** Discriminates this location in `AssetLocation`. */
  kind: 'stored';
  /** The store's URI for the asset, such as `s3://bucket/key` or `file:///…`. */
  uri: string;
  /** The store's id for the asset. */
  assetId: string;
}

/**
 * Where an asset's content lives. A discriminated union rather than optional fields, so a location
 * is always exactly one of the three.
 */
export type AssetLocation = AssetBytesLocation | AssetUrlLocation | AssetStoredLocation;

/** A digest of an asset's bytes, for integrity checks and deduplication. */
export interface AssetChecksum {
  /** Hash algorithm, such as `sha256`. */
  algorithm: string;
  /** The digest, hex-encoded. */
  value: string;
}

/** An image supplied to a request, by content or by reference. */
export interface AssetInput {
  /** Where the image's content lives. */
  location: AssetLocation;
  /** MIME type, such as `image/png`. */
  mimeType: string;
  /** File name, used when a provider's API uploads files by name. */
  filename?: string;
  /** Digest of the content, when known. */
  checksum?: AssetChecksum;
  /** Application data carried with the asset. */
  metadata?: Record<string, unknown>;
}

/** Where a generated asset came from, so it can be traced back to the request that made it. */
export interface AssetProvenance {
  /** The provider that produced it. */
  provider: string;
  /** The model that produced it. */
  model?: string;
  /** Whether it was generated or edited. */
  operation: ImageOperation;
  /** The request that produced it. */
  requestId: string;
  /** Assets it was derived from, for an edit. */
  parentAssetIds?: string[];
  /** Application data about its origin. */
  metadata?: Record<string, unknown>;
}

/** A generated or edited image, with its dimensions and provenance. */
export interface AssetDescriptor extends AssetInput {
  /** Width in pixels, when known. */
  width?: number;
  /** Height in pixels, when known. */
  height?: number;
  /** Size of the encoded content in bytes, when known. */
  byteLength?: number;
  /** Where the asset came from. */
  provenance: AssetProvenance;
}

/** Width and height in pixels. */
export interface ImageDimensions {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

/** Encoding for generated images. */
export type ImageOutputFormat = 'png' | 'jpeg' | 'webp' | 'avif' | (string & {});
/** Quality tier. Providers map it to their own settings; `auto` lets them choose. */
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | (string & {});
/** Background of a generated image. `transparent` needs an output format with an alpha channel. */
export type ImageBackground = 'auto' | 'opaque' | 'transparent';

/** How generated images come back: as bytes, as a URL, or written straight into an asset store. */
export type ImageDelivery =
  | { kind: 'bytes'; format?: ImageOutputFormat }
  | { kind: 'url'; format?: ImageOutputFormat; expiresInSeconds?: number }
  | { kind: 'stored'; format?: ImageOutputFormat; store?: string };

/** A mask that marks which part of the input an edit may change. */
export interface ImageMaskInput extends AssetInput {
  /**
   * Which color marks the editable area. Stated explicitly, because providers disagree and an
   * inverted mask edits exactly the part that should have been kept.
   */
  polarity: 'white-is-editable' | 'black-is-editable';
  /**
   * What happens when the mask and the input differ in size: refuse, or resize by containing,
   * covering, or stretching.
   */
  resizeMode?: 'reject' | 'contain' | 'cover' | 'stretch';
}

/** Fields every image request shares. */
export interface ImageRequestBase {
  /** Provider to use. Defaults to the manager's routing. */
  provider?: string;
  /** Model to use, or `auto`. */
  model?: string;
  /** What to produce or change. */
  prompt: string;
  /** What to keep out of the image, for providers that support it. */
  negativePrompt?: string;
  /** Images to produce. */
  count?: number;
  /** Exact size in pixels. */
  dimensions?: ImageDimensions;
  /** Shape of the image, such as `16:9`, for providers that size by ratio. */
  aspectRatio?: string;
  /** Quality tier. */
  quality?: ImageQuality;
  /** Encoding of the result. */
  outputFormat?: ImageOutputFormat;
  /** How results come back. */
  delivery?: ImageDelivery;
  /** Opaque or transparent background. */
  background?: ImageBackground;
  /** Seed for reproducible output, for providers that support it. */
  seed?: number;
  /** Identifies the request in records and traces. Generated when omitted. */
  requestId?: string;
  /**
   * Replays an accepted request instead of generating twice, which is what makes a retried timeout
   * safe to pay for once.
   */
  idempotencyKey?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
  /** Application data carried through to the result and records. */
  metadata?: Record<string, unknown>;
}

/** Creates images from a prompt. */
export interface ImageGenerateRequest extends ImageRequestBase {}

/** Changes an existing image. */
export interface ImageEditRequest extends ImageRequestBase {
  /** The image to change. */
  input: AssetInput;
  /** Restricts the edit to part of the image. */
  mask?: ImageMaskInput;
  /** Images whose style or content the edit should follow. */
  references?: AssetInput[];
}

/** What an image operation consumed and produced, in the units media providers price by. */
export interface MediaUsage {
  /** Images sent to the provider. */
  inputImages?: number;
  /** Images the provider returned. */
  outputImages?: number;
  /** Bytes sent to the provider. */
  inputBytes?: number;
  /** Bytes the provider returned. */
  outputBytes?: number;
  /** Output size in megapixels, for providers that price by area. */
  megapixels?: number;
  /** Provider-specific units, such as tokens or compute seconds. */
  providerUnits?: Record<string, number>;
}

/** One finding from a safety policy, on a request or on a result. */
export interface MediaSafetyFinding {
  /** Identifies the finding. */
  id: string;
  /** What kind of concern it is, such as `violence` or `pii`. */
  category: string;
  /** How serious it is. */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** What the policy decided: let it through, send it for review, or block it. */
  action: 'allow' | 'review' | 'block';
  /** Whether the prompt and inputs or a generated image triggered it. */
  source: 'input' | 'output';
  /** The detector's confidence, from 0 to 1. */
  confidence?: number;
  /** Which generated image it concerns, for an output finding. */
  assetIndex?: number;
  /** A readable explanation. */
  message?: string;
  /**
   * Detector-specific details. `withheld: true` on a blocked output finding means the provider
   * returned no image for it.
   */
  metadata?: Record<string, unknown>;
}

/** A request option the provider could not honor exactly, reported instead of silently changed. */
export interface ImageWarning {
  /** Stable code for the warning. */
  code: string;
  /** A readable explanation. */
  message: string;
  /** The option concerned. */
  option?: string;
  /** The value that was requested. */
  requestedValue?: unknown;
}

/** How an operation ran: which provider, how long it took, and what it cost. */
export interface OperationMeta {
  /** The durable operation's id. */
  operationId: string;
  /** The request's id. */
  requestId: string;
  /** The provider that served it. */
  provider: string;
  /** The model that served it. */
  model?: string;
  /** Providers tried in order, when failover happened. */
  route?: string[];
  /** ISO-8601 start time. */
  startedAt?: string;
  /** ISO-8601 completion time. */
  completedAt?: string;
  /** Duration in milliseconds. */
  latencyMs?: number;
  /** Cost in `currency`, from the provider's pricing. Absent rather than guessed when unknown. */
  cost?: number;
  /** Currency of `cost`. */
  currency?: string;
  /** Application data from the request. */
  metadata?: Record<string, unknown>;
}

/** The outcome of an image operation. */
export interface ImageResult {
  /** Images produced, in order. */
  assets: AssetDescriptor[];
  /** What was consumed and produced. */
  usage?: MediaUsage;
  /** Safety policy findings on the request and the images. */
  safetyFindings?: MediaSafetyFinding[];
  /** Options the provider could not honor exactly. */
  warnings?: ImageWarning[];
  /** Provider, timing, and cost. */
  meta: OperationMeta;
  /** The provider's response, when the adapter was configured to include it. */
  raw?: unknown;
}

/**
 * The operation lifecycle now lives in `types/operations.ts`, shared by every long-running family.
 * It is re-exported here so existing image imports keep working unchanged.
 */
export type {
  OperationErrorDescriptor,
  OperationEvent,
  OperationEventBase,
  OperationHandle,
  OperationProgress,
  OperationStatus,
} from './operations.js';

/**
 * What an image provider supports, so routing and validation can refuse a request before it costs
 * anything.
 */
export interface ImageProviderCapabilities {
  /** Operations it implements. */
  operations: readonly ImageOperation[];
  /** Models it offers. */
  models?: readonly string[];
  /** Input location kinds it accepts directly. */
  inputLocationKinds?: readonly AssetLocationKind[];
  /** Delivery kinds it can return. */
  deliveryKinds?: readonly AssetLocationKind[];
  /** Input image MIME types it accepts. */
  inputMimeTypes?: readonly string[];
  /** Output formats it can produce. */
  outputFormats?: readonly ImageOutputFormat[];
  /** Exact sizes it supports, when it has a fixed list. */
  dimensions?: readonly ImageDimensions[];
  /** Aspect ratios it supports. */
  aspectRatios?: readonly string[];
  /** Quality tiers it supports. */
  qualities?: readonly ImageQuality[];
  /** Fewest images per request. */
  minCount?: number;
  /** Most images per request. */
  maxCount?: number;
  /** Whether edits can be restricted by a mask. */
  supportsMask?: boolean;
  /** Whether requests can carry reference images. */
  supportsReferences?: boolean;
  /** Most reference images per request. */
  maxReferences?: number;
  /** Whether it can produce a transparent background. */
  supportsTransparency?: boolean;
  /** Whether it honors `seed`. */
  supportsSeed?: boolean;
  /** Whether it honors `negativePrompt`. */
  supportsNegativePrompt?: boolean;
}

/** Identifies an image provider and what it supports. */
export interface ImageProviderInfo {
  /** The provider's registered name. */
  name: string;
  /** True for a provider that runs locally, such as ComfyUI or the mock. */
  isLocal?: boolean;
  /** The adapter's version. */
  version?: string;
  /** What it supports. */
  capabilities: ImageProviderCapabilities;
}

/** What an image provider receives with every call besides the request. */
export interface ImageProviderCallContext {
  /** The durable operation's id. */
  operationId: string;
  /** The request's id. */
  requestId: string;
  /** Aborted when the operation is cancelled or its deadline passes. */
  signal: AbortSignal;
  /** Epoch milliseconds by which the call must finish. */
  deadline?: number;
  /** Passed to providers that deduplicate requests themselves. */
  idempotencyKey?: string;
  /** Trace propagation headers, for providers that accept them. */
  traceContext?: Record<string, string>;
}

/**
 * An image generation backend. Each operation is optional; `info.capabilities` says which exist.
 */
export interface ImageProvider {
  /** What the provider is and what it supports. */
  readonly info: ImageProviderInfo;
  /** Creates images from a prompt. */
  generate?(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult>;
  /** Changes an existing image. */
  edit?(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult>;
}

/** What a safety policy sees besides the request or result. */
export interface ImageSafetyContext extends ImageProviderCallContext {
  /** The operation being inspected. */
  operation: ImageOperation;
  /** The provider serving it. */
  provider: string;
  /** The model serving it. */
  model?: string;
}

/**
 * Inspects requests before they reach a provider and results before they reach the caller. A
 * `block` finding on the input stops the request; on the output, it withholds the image.
 */
export interface ImageSafetyPolicy {
  /** Inspects the prompt and inputs before the provider sees them. */
  inspectInput?(
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageSafetyContext,
  ): readonly MediaSafetyFinding[] | Promise<readonly MediaSafetyFinding[]>;
  /** Inspects generated images before the caller sees them. */
  inspectOutput?(
    result: ImageResult,
    context: ImageSafetyContext,
  ): readonly MediaSafetyFinding[] | Promise<readonly MediaSafetyFinding[]>;
}

export interface ImageAssetResolverContext {
  /** Which asset is being resolved, such as `input`, `mask`, or `references[2]`, for error messages. */
  option: string;
  signal: AbortSignal;
  tenantId?: string;
}

/**
 * Turns an asset location a provider cannot read into one it can.
 *
 * Typed here as an interface so `ImageManager` depends only on the shape: the hardened
 * implementation, `ImageInputResolver`, lives on the `nexus-ai-pro/images/inputs` subpath with its
 * network code, and a caller that never resolves remote inputs never loads it.
 */
export interface ImageAssetResolver {
  resolve(asset: AssetInput, context: ImageAssetResolverContext): Promise<AssetInput> | AssetInput;
}

/** Configuration for `ImageManager`: providers, routing, safety, and storage. */
export interface ImageConfig {
  /** Provider used when a request names none. */
  defaultProvider?: string;
  /** Providers by name. */
  providers?: Record<string, ImageProvider>;
  /** Checks requests and results. */
  safety?: ImageSafetyPolicy;
  /**
   * Resolves `url` and `stored` inputs to bytes, and validates byte inputs, before capability
   * checks run. Off unless set, so a request whose inputs are already bytes pays nothing.
   */
  inputResolver?: ImageAssetResolver;
  /** Tenant passed to the resolver for `stored` inputs. */
  tenantId?: string;
  /** Creates operation ids. Defaults to random ids. */
  createOperationId?: () => string;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** @deprecated Prefer `ImageConfig`; retained as an explicit manager-local alias. */
export type ImageManagerConfig = ImageConfig;

/** An image operation as queued work: which operation, and its request. */
export type ImageOperationSubmission =
  | { operation: 'generate'; request: ImageGenerateRequest }
  | { operation: 'edit'; request: ImageEditRequest };
