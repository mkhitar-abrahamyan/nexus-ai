import type { AssetInput, ImageAssetResolver, ImageAssetResolverContext } from '../types/images.js';
import { parseUrl, type SafeFetchPolicy, safeFetch, UrlPolicyError } from '../utils/safe-fetch.js';
import type { AssetStore } from './asset-support.js';
import { readImageDimensions, sniffImageType } from './image-header.js';
import { ImageValidationError } from './errors.js';

/** Why the input resolver refused an input. */
export type ImageInputRejection =
  | 'too-large'
  | 'too-many-pixels'
  | 'unmeasurable'
  | 'mime-mismatch'
  | 'unsupported-type'
  | 'fetch-failed'
  | 'blocked-url'
  | 'not-found';

/**
 * An input the resolver refused.
 *
 * Carries a machine-readable `reason` so an application can tell a user "that file is too large"
 * rather than surfacing a generic validation failure.
 */
export class ImageInputError extends ImageValidationError {
  /** Always `IMAGE_INPUT_REJECTED`. */
  override readonly code = 'IMAGE_INPUT_REJECTED';

  constructor(
    message: string,
    /** Why it was refused. */
    public readonly reason: ImageInputRejection,
    /** The request option that carried the input, such as `input` or `mask`. */
    public readonly option: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.name = 'ImageInputError';
  }
}

/** Limits on image inputs, and how remote and stored inputs are fetched. */
export interface ImageInputPolicy extends SafeFetchPolicy {
  /** Largest input accepted, in bytes. Defaults to 20 MB. */
  maxBytes?: number;
  /**
   * Largest input accepted, in pixels. Defaults to 40 megapixels.
   *
   * Checked from the header before anything is decoded, which is what defeats a decompression bomb:
   * a few kilobytes that claim a 100,000 × 100,000 canvas are refused without allocating a byte.
   */
  maxPixels?: number;
  /** Defaults to PNG, JPEG, WebP, and GIF. */
  allowedMimeTypes?: readonly string[];
  /**
   * Accept a format whose dimensions cannot be read from its header. Defaults to false, because an
   * unmeasurable image is exactly one whose pixel ceiling cannot be enforced.
   */
  allowUnmeasurableDimensions?: boolean;
  /** Defaults to 3. Each hop is validated against the SSRF policy again. */
  maxRedirects?: number;
  /** Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Resolves `stored` locations. */
  store?: AssetStore;
  /** Tenant stored assets are read for, when the call supplies none. */
  tenantId?: string;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/**
 * Turns any asset location into validated bytes.
 *
 * Every path ends in the same checks, so a byte upload, a remote URL, and a stored asset are held to
 * one standard: the content must be the type it claims, fit the byte ceiling, and fit the pixel
 * ceiling. A declared `image/png` that sniffs as something else is refused rather than trusted,
 * since a mismatched MIME type is how a hostile payload reaches a decoder that did not expect it.
 */
export class ImageInputResolver implements ImageAssetResolver {
  private readonly maxBytes: number;
  private readonly maxPixels: number;
  private readonly allowed: readonly string[];

  constructor(private readonly policy: ImageInputPolicy = {}) {
    this.maxBytes = positive(policy.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
    this.maxPixels = positive(policy.maxPixels, DEFAULT_MAX_PIXELS, 'maxPixels');
    this.allowed = (policy.allowedMimeTypes ?? DEFAULT_ALLOWED).map(normalizeMime);
  }

  /**
   * Resolves an input to bytes, enforcing every limit. Throws `ImageInputError` for a refused
   * input.
   */
  async resolve(asset: AssetInput, context: ImageAssetResolverContext): Promise<AssetInput> {
    const option = context.option;
    const location = asset.location;

    if (location.kind === 'bytes') return this.validate(asset, location.data, option);

    if (location.kind === 'url') {
      const bytes = await this.fetchRemote(location.url, option, context.signal);
      return this.validate(
        { ...asset, filename: asset.filename ?? filenameFromUrl(location.url) },
        bytes.bytes,
        option,
        bytes.contentType,
      );
    }

    const store = this.policy.store;
    if (!store) {
      throw new ImageInputError(
        `${option} is a stored asset, but the input resolver was configured without a store`,
        'not-found',
        option,
      );
    }
    const tenantId = context.tenantId ?? this.policy.tenantId;
    if (!tenantId) {
      throw new ImageInputError(`${option} is a stored asset, but no tenantId was supplied`, 'not-found', option);
    }
    const stored = await store.get(location.assetId, tenantId);
    if (!stored) {
      throw new ImageInputError(`${option} refers to an asset that does not exist`, 'not-found', option);
    }
    return this.validate({ ...asset, filename: asset.filename ?? stored.filename }, stored.location.data, option);
  }

  private async fetchRemote(
    url: string,
    option: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType?: string }> {
    const timeoutMs = positive(this.policy.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await safeFetch(parseUrl(url), {
        ...this.policy,
        // One byte past the ceiling is enough to know the file is too large without buffering it.
        maxBytes: this.maxBytes + 1,
        maxRedirects: this.policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
        signal: controller.signal,
        accept: 'image/*',
      });

      if (response.truncated) {
        throw new ImageInputError(`${option} exceeds the ${this.maxBytes}-byte input limit`, 'too-large', option);
      }
      if (!response.ok) {
        throw new ImageInputError(`${option} could not be fetched: HTTP ${response.status}`, 'fetch-failed', option);
      }
      return { bytes: new Uint8Array(response.bytes), contentType: response.contentType };
    } catch (error) {
      if (error instanceof ImageInputError) throw error;
      if (controller.signal.aborted && !signal.aborted) {
        throw new ImageInputError(`${option} fetch timed out after ${timeoutMs}ms`, 'fetch-failed', option, error);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ImageInputError(
        `${option} was refused: ${message}`,
        error instanceof UrlPolicyError ? 'blocked-url' : 'fetch-failed',
        option,
        error,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private validate(asset: AssetInput, bytes: Uint8Array, option: string, served?: string): AssetInput {
    if (bytes.byteLength === 0) throw new ImageInputError(`${option} is empty`, 'unsupported-type', option);
    if (bytes.byteLength > this.maxBytes) {
      throw new ImageInputError(`${option} exceeds the ${this.maxBytes}-byte input limit`, 'too-large', option);
    }

    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      throw new ImageInputError(`${option} is not a recognisable image`, 'unsupported-type', option);
    }
    if (!this.allowed.includes(sniffed.mimeType)) {
      throw new ImageInputError(`${option} is ${sniffed.mimeType}, which is not allowed`, 'unsupported-type', option);
    }

    // The bytes are the authority. Both the caller's claim and the server's header must agree with
    // them, and a disagreement is refused rather than corrected.
    const declared = normalizeMime(asset.mimeType);
    if (declared && declared !== 'application/octet-stream' && declared !== sniffed.mimeType) {
      throw new ImageInputError(
        `${option} declares ${declared} but its content is ${sniffed.mimeType}`,
        'mime-mismatch',
        option,
      );
    }
    const servedType = served ? normalizeMime(served) : undefined;
    if (servedType?.startsWith('image/') && servedType !== sniffed.mimeType) {
      throw new ImageInputError(
        `${option} was served as ${servedType} but its content is ${sniffed.mimeType}`,
        'mime-mismatch',
        option,
      );
    }

    const dimensions = readImageDimensions(bytes);
    if (!dimensions) {
      if (!this.policy.allowUnmeasurableDimensions) {
        throw new ImageInputError(
          `${option} dimensions could not be read, so the pixel limit cannot be enforced`,
          'unmeasurable',
          option,
        );
      }
    } else if (dimensions.width * dimensions.height > this.maxPixels) {
      throw new ImageInputError(
        `${option} is ${dimensions.width}x${dimensions.height}, above the ${this.maxPixels}-pixel limit`,
        'too-many-pixels',
        option,
      );
    }

    return {
      ...asset,
      location: { kind: 'bytes', data: bytes },
      mimeType: sniffed.mimeType,
    };
  }
}

/** Builds a resolver, for passing straight into `ImageConfig.inputResolver`. */
export function createImageInputResolver(policy: ImageInputPolicy = {}): ImageInputResolver {
  return new ImageInputResolver(policy);
}

function normalizeMime(value: string): string {
  const base = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ImageValidationError(`Image input ${name} must be a positive integer`);
  }
  return resolved;
}
