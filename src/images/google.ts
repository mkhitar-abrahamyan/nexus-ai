import type {
  AssetDescriptor,
  AssetInput,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageOperation,
  ImageOutputFormat,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderInfo,
  ImageResult,
  ImageWarning,
  MediaSafetyFinding,
} from '../types/images.js';
import {
  ImageCapabilityError,
  ImageProviderError,
  ImageProviderResponseError,
  ImageValidationError,
} from './errors.js';
import type { AssetTransformer } from './transform.js';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GENERATE_MODEL = 'imagen-4.0-generate-001';
const DEFAULT_EDIT_MODEL = 'imagen-3.0-capability-001';
const GOOGLE_FORMATS = ['png', 'jpeg'] as const;
const GOOGLE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
const GOOGLE_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Options for the Google image provider, for the Gemini API or Vertex AI. */
export interface GoogleImageProviderConfig {
  /** Gemini API key, sent as `x-goog-api-key`. */
  apiKey?: string;
  /**
   * OAuth bearer token for Vertex AI. Takes precedence over `apiKey`, and requires `baseUrl` to point
   * at a Vertex endpoint such as `https://us-central1-aiplatform.googleapis.com/v1/projects/P/locations/us-central1/publishers/google`.
   */
  accessToken?: string;
  /**
   * API base URL. Defaults to the Gemini API, `https://generativelanguage.googleapis.com/v1beta`.
   */
  baseUrl?: string;
  /** Model for generation. Defaults to `imagen-4.0-generate-001`. */
  generateModel?: string;
  /** Model for edits. Defaults to `imagen-3.0-capability-001`. */
  editModel?: string;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Converts a neutral mask to Imagen's white-is-editable greyscale. Loaded on first masked request. */
  maskTransformer?: AssetTransformer;
  /** `dont_allow`, `allow_adult`, or `allow_all`, passed through as `personGeneration`. */
  personGeneration?: string;
  /** Keeps Google's response on each result as `raw`. Off by default. */
  includeRawResponse?: boolean;
}

interface ImagenPrediction {
  bytesBase64Encoded?: string;
  mimeType?: string;
  raiFilteredReason?: string;
}

interface ImagenResponse {
  predictions?: ImagenPrediction[];
}

/**
 * Google Imagen through the `:predict` protocol, on either the Gemini API or Vertex AI.
 *
 * The second hosted wire protocol behind the neutral image contract, and deliberately a different
 * shape from OpenAI's: aspect ratio instead of pixel dimensions, seeds and negative prompts that
 * OpenAI refuses, masks as a white-is-editable greyscale reference image rather than an alpha
 * channel, and safety filtering reported per image rather than as a request failure.
 */
export class GoogleImageProvider implements ImageProvider {
  /** Provider name, capabilities, and models. */
  readonly info: ImageProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly generateModel: string;
  private readonly editModel: string;

  constructor(private readonly config: GoogleImageProviderConfig) {
    if (!config.apiKey?.trim() && !config.accessToken?.trim()) {
      throw new ImageValidationError('Google image provider needs an apiKey or an accessToken');
    }
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new ImageValidationError('Google image provider requires a fetch implementation');
    }

    this.fetchImplementation = fetchImplementation;
    this.baseUrl = (config.baseUrl || GEMINI_API_BASE_URL).replace(/\/+$/, '');
    this.generateModel = config.generateModel?.trim() || DEFAULT_GENERATE_MODEL;
    this.editModel = config.editModel?.trim() || DEFAULT_EDIT_MODEL;
    this.info = {
      name: 'google',
      version: 'imagen-predict-v1',
      capabilities: {
        operations: ['generate', 'edit'],
        models: [this.generateModel, this.editModel],
        inputLocationKinds: ['bytes'],
        deliveryKinds: ['bytes'],
        inputMimeTypes: GOOGLE_INPUT_MIME_TYPES,
        outputFormats: GOOGLE_FORMATS,
        aspectRatios: GOOGLE_ASPECT_RATIOS,
        minCount: 1,
        maxCount: 4,
        supportsMask: true,
        supportsReferences: false,
        supportsTransparency: false,
        supportsSeed: true,
        supportsNegativePrompt: true,
      },
    };
  }

  /** Generates images from a prompt. */
  async generate(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    const startedAt = Date.now();
    const model = resolveModel(request.model, this.generateModel);
    const format = resolveFormat(request);
    const warnings: ImageWarning[] = [];

    const response = await this.predict(
      model,
      {
        instances: [{ prompt: request.prompt }],
        parameters: this.parameters(request, format, warnings),
      },
      context,
    );
    return this.normalize(response, request, context, model, format, startedAt, 'generate', warnings);
  }

  /** Edits an image, optionally within a mask. */
  async edit(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    const startedAt = Date.now();
    const model = resolveModel(request.model, this.editModel);
    const format = resolveFormat(request);
    const warnings: ImageWarning[] = [];

    const referenceImages: Array<Record<string, unknown>> = [
      { referenceType: 'REFERENCE_TYPE_RAW', referenceId: 1, referenceImage: encodeAsset(request.input, 'input') },
    ];

    if (request.mask) {
      const transform = await import('./transform.js');
      const transformer = this.config.maskTransformer ?? transform.defaultMaskTransformer();
      const target = transform.requireImageDimensions(request.input, 'google');
      const prepared = await transformer.prepareMask(request.mask, {
        ...target,
        semantics: 'white-is-editable',
        provider: 'google',
      });
      referenceImages.push({
        referenceType: 'REFERENCE_TYPE_MASK',
        referenceId: 2,
        referenceImage: encodeAsset(prepared, 'mask'),
        maskImageConfig: { maskMode: 'MASK_MODE_USER_PROVIDED' },
      });
    }

    const parameters = this.parameters(request, format, warnings);
    // With a mask Imagen inpaints inside it; without one the whole image is open to the prompt.
    if (request.mask) parameters.editMode = 'EDIT_MODE_INPAINT_INSERTION';

    const response = await this.predict(
      model,
      { instances: [{ prompt: request.prompt, referenceImages }], parameters },
      context,
    );
    return this.normalize(response, request, context, model, format, startedAt, 'edit', warnings);
  }

  private parameters(
    request: ImageGenerateRequest | ImageEditRequest,
    format: ImageOutputFormat,
    warnings: ImageWarning[],
  ): Record<string, unknown> {
    if (request.delivery && request.delivery.kind !== 'bytes') {
      throw new ImageCapabilityError('google', 'delivery', request.delivery.kind);
    }
    if (request.dimensions) {
      throw new ImageCapabilityError(
        'google',
        'dimensions',
        request.dimensions,
        'Imagen sizes output by aspect ratio; pass aspectRatio instead of dimensions',
      );
    }

    const parameters: Record<string, unknown> = {
      sampleCount: request.count ?? 1,
      outputOptions: { mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' },
    };
    if (request.aspectRatio) parameters.aspectRatio = request.aspectRatio;
    if (request.negativePrompt) parameters.negativePrompt = request.negativePrompt;
    if (this.config.personGeneration) parameters.personGeneration = this.config.personGeneration;
    if (request.seed !== undefined) {
      parameters.seed = request.seed;
      // Imagen only honours a seed with watermarking off, so reproducibility has a visible cost that
      // the caller should hear about rather than discover.
      parameters.addWatermark = false;
      warnings.push({
        code: 'provider.watermark_disabled',
        message: 'Imagen requires the SynthID watermark to be disabled for a seed to take effect',
        option: 'seed',
        requestedValue: request.seed,
      });
    }
    return parameters;
  }

  private async predict(
    model: string,
    body: Record<string, unknown>,
    context: ImageProviderCallContext,
  ): Promise<ImagenResponse> {
    if (context.deadline !== undefined && Date.now() >= context.deadline) {
      throw new ImageProviderError('Google image request deadline has already elapsed', 'google');
    }

    const headers = new Headers(this.config.defaultHeaders);
    headers.set('content-type', 'application/json');
    if (this.config.accessToken) headers.set('authorization', `Bearer ${this.config.accessToken}`);
    else if (this.config.apiKey) headers.set('x-goog-api-key', this.config.apiKey);

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}/models/${encodeURIComponent(model)}:predict`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new ImageProviderError('Google image request failed before receiving a response', 'google', error);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (response.ok) throw new ImageProviderResponseError('google', 'response body is not valid JSON', error);
    }

    if (!response.ok) {
      const message =
        isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
          ? parsed.error.message
          : `HTTP ${response.status}`;
      throw new ImageProviderError(`Google image request failed: ${message}`, 'google', parsed);
    }
    if (!isRecord(parsed)) throw new ImageProviderResponseError('google', 'response body must be a JSON object');
    return parsed as ImagenResponse;
  }

  private normalize(
    response: ImagenResponse,
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageProviderCallContext,
    model: string,
    format: ImageOutputFormat,
    startedAt: number,
    operation: ImageOperation,
    warnings: ImageWarning[],
  ): ImageResult {
    const predictions = response.predictions ?? [];
    const safetyFindings: MediaSafetyFinding[] = [];
    const assets: AssetDescriptor[] = [];

    predictions.forEach((prediction, index) => {
      if (prediction.raiFilteredReason && !prediction.bytesBase64Encoded) {
        // No assetIndex: the image does not exist in the result. `withheld` tells the manager this
        // finding explains a missing image rather than condemning one that is present.
        safetyFindings.push({
          id: `google-rai-${index + 1}`,
          category: 'provider-safety-filter',
          severity: 'high',
          action: 'block',
          source: 'output',
          message: prediction.raiFilteredReason,
          metadata: { withheld: true, predictionIndex: index },
        });
        return;
      }
      if (!prediction.bytesBase64Encoded) {
        throw new ImageProviderResponseError('google', `prediction ${index} carries no image bytes`);
      }
      const data = new Uint8Array(Buffer.from(prediction.bytesBase64Encoded, 'base64'));
      assets.push({
        location: { kind: 'bytes', data },
        mimeType: prediction.mimeType || (format === 'jpeg' ? 'image/jpeg' : 'image/png'),
        byteLength: data.byteLength,
        provenance: {
          provider: 'google',
          model,
          operation,
          requestId: context.requestId,
        },
      });
    });

    if (assets.length === 0) {
      // Imagen answers a fully filtered request with 200 and no images; surfacing it as a safety
      // block rather than an empty success is what stops a caller treating nothing as a result.
      if (safetyFindings.length > 0) {
        throw new ImageProviderError('Google filtered every generated image', 'google', safetyFindings);
      }
      throw new ImageProviderResponseError('google', 'response contained no images');
    }

    const requested = request.count ?? 1;
    if (assets.length < requested) {
      warnings.push({
        code: 'provider.partial_result',
        message: `Google returned ${assets.length} of ${requested} requested images`,
        option: 'count',
        requestedValue: requested,
      });
    }

    return {
      assets,
      usage: {
        outputImages: assets.length,
        outputBytes: assets.reduce((total, asset) => total + (asset.byteLength ?? 0), 0),
      },
      safetyFindings: safetyFindings.length > 0 ? safetyFindings : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      meta: {
        operationId: context.operationId,
        requestId: context.requestId,
        provider: 'google',
        model,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
      },
      raw: this.config.includeRawResponse ? response : undefined,
    };
  }
}

function encodeAsset(asset: AssetInput, option: string): { bytesBase64Encoded: string } {
  if (asset.location.kind !== 'bytes') {
    throw new ImageCapabilityError('google', `${option}.location`, asset.location.kind);
  }
  return { bytesBase64Encoded: Buffer.from(asset.location.data).toString('base64') };
}

function resolveFormat(request: ImageGenerateRequest | ImageEditRequest): ImageOutputFormat {
  const format = request.outputFormat ?? request.delivery?.format ?? 'png';
  if (!GOOGLE_FORMATS.includes(format as (typeof GOOGLE_FORMATS)[number])) {
    throw new ImageCapabilityError('google', 'outputFormat', format);
  }
  return format;
}

function resolveModel(requested: string | undefined, fallback: string): string {
  return !requested || requested === 'auto' ? fallback : requested;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
