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
  MediaUsage,
} from '../types/images.js';
import {
  ImageCapabilityError,
  ImageProviderError,
  ImageProviderResponseError,
  ImageValidationError,
} from './errors.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const OPENAI_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;
const OPENAI_INPUT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface OpenAIImageProviderConfig {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  defaultHeaders?: Record<string, string>;
  defaultModel?: string;
  maxInputBytes?: number;
  fetch?: typeof globalThis.fetch;
  includeRawResponse?: boolean;
}

export interface OpenAIModerationDetails {
  moderationStage?: 'input' | 'output' | 'unknown';
  categories?: string[];
}

export class OpenAIImageProviderError extends ImageProviderError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly apiCode?: string,
    public readonly moderation?: OpenAIModerationDetails,
    public readonly safetyFindings?: MediaSafetyFinding[],
    cause?: unknown,
  ) {
    super(message, 'openai', cause);
    this.name = 'OpenAIImageProviderError';
  }
}

interface OpenAIImageData {
  b64_json?: string;
  revised_prompt?: string;
  url?: string;
}

interface OpenAIImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    image_tokens?: number;
    text_tokens?: number;
  };
}

interface OpenAIImagesResponse {
  created?: number;
  data?: OpenAIImageData[];
  usage?: OpenAIImageUsage;
}

/**
 * Hosted OpenAI Image API adapter for one-shot generation and reference-based editing.
 *
 * Masked editing stays disabled until an asset transformer can verify dimensions and convert the
 * provider-neutral mask polarity into the alpha-channel semantics required by OpenAI.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly info: ImageProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly defaultModel: string;
  private readonly maxInputBytes: number;

  constructor(private readonly config: OpenAIImageProviderConfig) {
    if (!config.apiKey?.trim()) throw new ImageValidationError('OpenAI image apiKey must not be empty');
    if (
      config.maxInputBytes !== undefined &&
      (!Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1)
    ) {
      throw new ImageValidationError('OpenAI image maxInputBytes must be a positive safe integer');
    }

    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new ImageValidationError('OpenAI image provider requires a fetch implementation');
    }

    this.fetchImplementation = fetchImplementation;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = config.defaultModel?.trim() || DEFAULT_MODEL;
    this.maxInputBytes = config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.info = {
      name: 'openai',
      version: 'image-api-v1',
      capabilities: {
        operations: ['generate', 'edit'],
        models: [this.defaultModel],
        inputLocationKinds: ['bytes'],
        deliveryKinds: ['bytes'],
        inputMimeTypes: OPENAI_INPUT_MIME_TYPES,
        outputFormats: OPENAI_IMAGE_FORMATS,
        dimensions: [
          { width: 1024, height: 1024 },
          { width: 1536, height: 1024 },
          { width: 1024, height: 1536 },
          { width: 2048, height: 2048 },
          { width: 2048, height: 1152 },
          { width: 3840, height: 2160 },
          { width: 2160, height: 3840 },
        ],
        qualities: ['auto', 'low', 'medium', 'high'],
        minCount: 1,
        maxCount: 10,
        supportsMask: false,
        supportsReferences: true,
        maxReferences: 15,
        supportsTransparency: false,
        supportsSeed: false,
        supportsNegativePrompt: false,
      },
    };
  }

  async generate(request: ImageGenerateRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    this.assertDirectRequest(request, 'generate');
    const startedAt = Date.now();
    const outputFormat = resolveOutputFormat(request);
    const model = resolveModel(request.model, this.defaultModel);
    const payload = compactRecord({
      model,
      prompt: request.prompt,
      n: request.count,
      size: request.dimensions ? `${request.dimensions.width}x${request.dimensions.height}` : undefined,
      quality: request.quality,
      output_format: outputFormat,
      background: request.background,
    });
    const response = await this.request('/images/generations', payload, context, true);
    return this.normalizeResult(
      response.body,
      response.requestId,
      request,
      context,
      model,
      outputFormat,
      startedAt,
      'generate',
    );
  }

  async edit(request: ImageEditRequest, context: ImageProviderCallContext): Promise<ImageResult> {
    this.assertDirectRequest(request, 'edit');
    if (request.mask) throw new ImageCapabilityError('openai', 'mask');

    const startedAt = Date.now();
    const outputFormat = resolveOutputFormat(request);
    const model = resolveModel(request.model, this.defaultModel);
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', request.prompt);
    appendOptionalField(form, 'n', request.count);
    appendOptionalField(
      form,
      'size',
      request.dimensions ? `${request.dimensions.width}x${request.dimensions.height}` : undefined,
    );
    appendOptionalField(form, 'quality', request.quality);
    appendOptionalField(form, 'output_format', outputFormat);
    appendOptionalField(form, 'background', request.background);

    const inputs = [request.input, ...(request.references ?? [])];
    for (const [index, asset] of inputs.entries()) {
      this.appendAsset(form, 'image[]', asset, `image-${index + 1}`);
    }

    const response = await this.request('/images/edits', form, context, false);
    return this.normalizeResult(
      response.body,
      response.requestId,
      request,
      context,
      model,
      outputFormat,
      startedAt,
      'edit',
    );
  }

  private assertDirectRequest(request: ImageGenerateRequest | ImageEditRequest, operation: ImageOperation): void {
    if (request.delivery && request.delivery.kind !== 'bytes') {
      throw new ImageCapabilityError('openai', 'delivery', request.delivery.kind);
    }
    if (request.aspectRatio) throw new ImageCapabilityError('openai', 'aspectRatio', request.aspectRatio);
    if (request.negativePrompt) throw new ImageCapabilityError('openai', 'negativePrompt');
    if (request.seed !== undefined) throw new ImageCapabilityError('openai', 'seed', request.seed);
    if (request.background === 'transparent') {
      throw new ImageCapabilityError('openai', 'background', request.background);
    }
    if (operation === 'edit' && 'references' in request && (request.references?.length ?? 0) > 15) {
      throw new ImageCapabilityError('openai', 'references', request.references?.length);
    }
  }

  private appendAsset(form: FormData, field: string, asset: AssetInput, fallbackName: string): void {
    if (asset.location.kind !== 'bytes') {
      throw new ImageCapabilityError('openai', `${fallbackName}.location`, asset.location.kind);
    }
    const mimeType = normalizeMimeType(asset.mimeType);
    if (!OPENAI_INPUT_MIME_TYPES.includes(mimeType as (typeof OPENAI_INPUT_MIME_TYPES)[number])) {
      throw new ImageCapabilityError('openai', `${fallbackName}.mimeType`, asset.mimeType);
    }
    if (asset.location.data.byteLength > this.maxInputBytes) {
      throw new ImageValidationError(
        `${fallbackName} exceeds the configured OpenAI image input limit of ${this.maxInputBytes} bytes`,
      );
    }

    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
    const filename = asset.filename || `${fallbackName}.${extension}`;
    form.append(field, new Blob([Buffer.from(asset.location.data)], { type: mimeType }), filename);
  }

  private async request(
    path: string,
    body: Record<string, unknown> | FormData,
    context: ImageProviderCallContext,
    json: boolean,
  ): Promise<{ body: OpenAIImagesResponse; requestId?: string }> {
    if (context.deadline !== undefined && Date.now() >= context.deadline) {
      throw new ImageProviderError('OpenAI image request deadline has already elapsed', 'openai');
    }

    const headers = new Headers(this.config.defaultHeaders);
    headers.set('authorization', `Bearer ${this.config.apiKey}`);
    if (this.config.organization) headers.set('openai-organization', this.config.organization);
    if (this.config.project) headers.set('openai-project', this.config.project);
    if (context.idempotencyKey) headers.set('idempotency-key', context.idempotencyKey);
    if (json) headers.set('content-type', 'application/json');
    else headers.delete('content-type');

    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: json ? JSON.stringify(body) : (body as FormData),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new ImageProviderError('OpenAI image request failed before receiving a response', 'openai', error);
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const parsed = await parseJson(response);
    if (!response.ok) throw createOpenAIError(response.status, requestId, parsed);
    if (!isRecord(parsed)) throw new ImageProviderResponseError('openai', 'response body must be a JSON object');
    return { body: parsed as unknown as OpenAIImagesResponse, requestId };
  }

  private normalizeResult(
    response: OpenAIImagesResponse,
    providerRequestId: string | undefined,
    request: ImageGenerateRequest | ImageEditRequest,
    context: ImageProviderCallContext,
    model: string,
    outputFormat: ImageOutputFormat,
    startedAt: number,
    operation: ImageOperation,
  ): ImageResult {
    if (!Array.isArray(response.data) || response.data.length === 0) {
      throw new ImageProviderResponseError('openai', 'response data must contain at least one image');
    }

    const assets = response.data.map((item, index) =>
      normalizeOpenAIAsset(item, index, outputFormat, request, context, model, operation),
    );
    const warnings = response.data
      .map((item) => item.revised_prompt)
      .filter((value): value is string => Boolean(value))
      .map<ImageWarning>((revisedPrompt) => ({
        code: 'provider.revised_prompt',
        message: 'OpenAI revised the image prompt',
        option: 'prompt',
        ...(this.config.includeRawResponse ? { requestedValue: revisedPrompt } : {}),
      }));
    const usage = normalizeUsage(response.usage, assets);

    return {
      assets,
      usage,
      warnings: warnings.length > 0 ? warnings : undefined,
      meta: {
        operationId: context.operationId,
        requestId: context.requestId,
        provider: 'openai',
        model,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        metadata: {
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(response.created ? { providerCreatedAt: new Date(response.created * 1000).toISOString() } : {}),
        },
      },
      raw: this.config.includeRawResponse ? response : undefined,
    };
  }
}

function normalizeOpenAIAsset(
  item: OpenAIImageData,
  index: number,
  outputFormat: ImageOutputFormat,
  request: ImageGenerateRequest | ImageEditRequest,
  context: ImageProviderCallContext,
  model: string,
  operation: ImageOperation,
): AssetDescriptor {
  if (!item || typeof item.b64_json !== 'string' || !item.b64_json) {
    const detail = item?.url
      ? 'returned a temporary URL when byte delivery was requested'
      : `image ${index} is missing b64_json`;
    throw new ImageProviderResponseError('openai', detail);
  }

  const data = decodeBase64(item.b64_json, index);
  return {
    location: { kind: 'bytes', data },
    mimeType: formatToMimeType(outputFormat),
    width: request.dimensions?.width,
    height: request.dimensions?.height,
    byteLength: data.byteLength,
    provenance: {
      provider: 'openai',
      model,
      operation,
      requestId: context.requestId,
      parentAssetIds: operation === 'edit' ? collectParentAssetIds(request as ImageEditRequest) : undefined,
    },
  };
}

function normalizeUsage(usage: OpenAIImageUsage | undefined, assets: AssetDescriptor[]): MediaUsage {
  const providerUnits = compactNumberRecord({
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    inputImageTokens: usage?.input_tokens_details?.image_tokens,
    inputTextTokens: usage?.input_tokens_details?.text_tokens,
  });
  return {
    outputImages: assets.length,
    outputBytes: assets.reduce((total, asset) => total + (asset.byteLength ?? 0), 0),
    providerUnits: Object.keys(providerUnits).length > 0 ? providerUnits : undefined,
  };
}

function collectParentAssetIds(request: ImageEditRequest): string[] | undefined {
  const ids = [request.input, ...(request.references ?? [])]
    .map((asset) => (asset.location.kind === 'stored' ? asset.location.assetId : undefined))
    .filter((value): value is string => Boolean(value));
  return ids.length > 0 ? ids : undefined;
}

function resolveOutputFormat(request: ImageGenerateRequest | ImageEditRequest): ImageOutputFormat {
  const format = request.outputFormat ?? request.delivery?.format ?? 'png';
  if (!OPENAI_IMAGE_FORMATS.includes(format as (typeof OPENAI_IMAGE_FORMATS)[number])) {
    throw new ImageCapabilityError('openai', 'outputFormat', format);
  }
  return format;
}

function resolveModel(requested: string | undefined, defaultModel: string): string {
  return !requested || requested === 'auto' ? defaultModel : requested;
}

function formatToMimeType(format: ImageOutputFormat): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function appendOptionalField(form: FormData, name: string, value: string | number | undefined): void {
  if (value !== undefined) form.set(name, String(value));
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function compactNumberRecord(values: Record<string, number | undefined>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}

function decodeBase64(value: string, index: number): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ImageProviderResponseError('openai', `image ${index} contains invalid base64 data`);
  }
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (response.ok) throw new ImageProviderResponseError('openai', 'response body is not valid JSON', error);
    return undefined;
  }
}

function createOpenAIError(status: number, requestId: string | undefined, value: unknown): OpenAIImageProviderError {
  const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
  const apiCode = typeof error?.code === 'string' ? error.code : undefined;
  const moderation = normalizeModeration(error?.moderation_details);
  const safetyFindings = moderation ? moderationToFindings(moderation) : undefined;
  const message =
    apiCode === 'moderation_blocked'
      ? 'OpenAI image request was blocked by moderation'
      : `OpenAI image request failed with HTTP ${status}`;
  return new OpenAIImageProviderError(message, status, requestId, apiCode, moderation, safetyFindings, value);
}

function normalizeModeration(value: unknown): OpenAIModerationDetails | undefined {
  if (!isRecord(value)) return undefined;
  const stage = value.moderation_stage;
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((category): category is string => typeof category === 'string')
    : undefined;
  return {
    moderationStage: stage === 'input' || stage === 'output' || stage === 'unknown' ? stage : undefined,
    categories,
  };
}

function moderationToFindings(details: OpenAIModerationDetails): MediaSafetyFinding[] {
  const categories = details.categories?.length ? details.categories : ['provider-moderation'];
  return categories.map((category, index) => ({
    id: `openai-moderation-${index + 1}`,
    category,
    severity: 'high',
    action: 'block',
    source: details.moderationStage === 'output' ? 'output' : 'input',
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
