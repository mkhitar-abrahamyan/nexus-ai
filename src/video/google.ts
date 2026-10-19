/**
 * Google Veo through its long-running prediction protocol, on the Gemini API or on Vertex AI.
 */
import type { AssetInput } from '../types/images.js';
import { encodeBase64, decodeBase64 } from '../utils/base64.js';
import type {
  VideoCallContext,
  VideoContent,
  VideoJobRef,
  VideoJobState,
  VideoModelCapabilities,
  VideoProvider,
  VideoProviderInfo,
  VideoProviderRequest,
} from './index.js';
import { VideoError } from './errors.js';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const STORAGE_BASE_URL = 'https://storage.googleapis.com/storage/v1';
const DEFAULT_MODEL = 'veo-3.1-generate-preview';
const VEO_MODELS = [
  'veo-3.1-generate-preview',
  'veo-3.1-fast-generate-preview',
  'veo-3.1-lite-generate-preview',
] as const;
const VEO_31: Partial<VideoModelCapabilities> = {
  inputs: ['image', 'last-frame', 'references'],
  durations: [4, 6, 8],
  defaultDurationSeconds: 8,
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p', '4k'],
  audio: 'always',
  maxReferences: 3,
  maxCount: 1,
  supportsSeed: true,
  supportsNegativePrompt: true,
};

/** Options for the Google video provider, for the Gemini API or Vertex AI. */
export interface GoogleVideoProviderConfig {
  /** Gemini API key, sent as `x-goog-api-key`. */
  apiKey?: string;
  /**
   * OAuth bearer token for Vertex AI, or a function that returns a fresh one: a job can outlive a
   * token. Takes precedence over `apiKey`, and requires `baseUrl` to point at a Vertex endpoint such as
   * `https://us-central1-aiplatform.googleapis.com/v1/projects/P/locations/us-central1/publishers/google`.
   */
  accessToken?: string | (() => string | Promise<string>);
  /** API base URL. Defaults to the Gemini API, `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string;
  /** Vertex AI only: where Veo writes each video, as `gs://bucket/prefix`. Without it Vertex returns the bytes inline. */
  storageUri?: string;
  /** The model a request naming none uses. Defaults to `veo-3.1-generate-preview`. */
  defaultModel?: string;
  /** The models served. Defaults to the Veo 3.1 family; each takes what Veo 3.1 takes unless `byModel` says otherwise. */
  models?: readonly string[];
  /** Where a model differs from Veo 3.1. */
  byModel?: Record<string, Partial<VideoModelCapabilities>>;
  /** `dont_allow`, `allow_adult`, or `allow_all`, sent as `personGeneration`. Some regions allow only `allow_adult`. */
  personGeneration?: string;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string; status?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; mimeType?: string } }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
    videos?: Array<{ gcsUri?: string; bytesBase64Encoded?: string; mimeType?: string }>;
    raiMediaFilteredCount?: number;
    raiMediaFilteredReasons?: string[];
  };
}

interface Sample {
  uri?: string;
  base64?: string;
  mimeType: string;
}

/**
 * Veo behind the video contract. A job is a long-running operation: its name is the ref, any worker
 * polls it, and the video is read from the URI the Gemini API returns, from Cloud Storage, or from the
 * bytes Vertex returns inline. The Gemini API keeps a video for two days.
 */
export class GoogleVideoProvider implements VideoProvider {
  /** Provider name, capabilities, and models. */
  readonly info: VideoProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly vertex: boolean;

  constructor(private readonly config: GoogleVideoProviderConfig) {
    if (!config.apiKey?.trim() && !config.accessToken) {
      throw new VideoError('Google video provider needs an apiKey or an accessToken', 'VIDEO_INVALID');
    }
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new VideoError('Google video provider requires a fetch implementation', 'VIDEO_INVALID');
    }
    this.fetchImplementation = fetchImplementation;
    this.vertex = config.accessToken !== undefined;
    this.baseUrl = (config.baseUrl || GEMINI_API_BASE_URL).replace(/\/+$/, '');
    const models = config.models ?? VEO_MODELS;
    const byModel: Record<string, Partial<VideoModelCapabilities>> = {};
    // The Lite model makes no 4k video.
    if (models.includes('veo-3.1-lite-generate-preview')) {
      byModel['veo-3.1-lite-generate-preview'] = { resolutions: ['720p', '1080p'] };
    }
    this.info = {
      name: 'google',
      capabilities: {
        inputs: VEO_31.inputs ?? [],
        ...VEO_31,
        models,
        defaultModel: config.defaultModel ?? (models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]),
        byModel: { ...byModel, ...config.byModel },
        inputLocationKinds: ['bytes'],
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        retentionHours: this.vertex ? undefined : 48,
      },
    };
  }

  /** Starts a long-running prediction. */
  async submit(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    const instance: Record<string, unknown> = { prompt: request.prompt };
    if (request.image) instance.image = this.image(request.image);
    if (request.lastFrame) instance.lastFrame = this.image(request.lastFrame);
    if (request.references?.length) {
      instance.referenceImages = request.references.map((reference) => ({
        image: this.image(reference),
        referenceType:
          typeof reference.metadata?.referenceType === 'string' ? reference.metadata.referenceType : 'asset',
      }));
    }
    const parameters: Record<string, unknown> = {};
    if (request.aspectRatio) parameters.aspectRatio = request.aspectRatio;
    if (request.resolution) parameters.resolution = request.resolution;
    if (request.durationSeconds !== undefined) parameters.durationSeconds = request.durationSeconds;
    if (request.negativePrompt) parameters.negativePrompt = request.negativePrompt;
    if (request.seed !== undefined) parameters.seed = request.seed;
    if (request.count !== undefined) parameters[this.vertex ? 'sampleCount' : 'numberOfVideos'] = request.count;
    if (this.config.personGeneration) parameters.personGeneration = this.config.personGeneration;
    if (this.vertex) {
      if (request.audio !== undefined) parameters.generateAudio = request.audio;
      if (this.config.storageUri) parameters.storageUri = this.config.storageUri;
    }
    Object.assign(parameters, request.providerOptions);

    const operation = await this.call<Operation>(
      `${this.baseUrl}/models/${encodeURIComponent(request.model)}:predictLongRunning`,
      { method: 'POST', body: JSON.stringify({ instances: [instance], parameters }) },
      context,
    );
    if (!operation.name) throw new VideoError('Google returned no operation name', 'VIDEO_PROVIDER');
    return { provider: this.info.name, id: operation.name, model: request.model, createdAt: new Date().toISOString() };
  }

  /** Reads the operation. */
  async poll(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState> {
    const operation = await this.operation(ref, context);
    if (!operation.done) return { status: 'running', raw: operation };
    if (operation.error) {
      const code =
        operation.error.status ?? (operation.error.code === undefined ? undefined : String(operation.error.code));
      return {
        status: 'failed',
        error: {
          message: operation.error.message ?? 'the operation failed',
          ...(code ? { code } : {}),
          // Google's codes for a fault on its side: internal, unavailable, and deadline exceeded.
          retryable: [13, 14, 4].includes(operation.error.code ?? -1),
        },
        raw: operation,
      };
    }
    const samples = samplesOf(operation);
    const filtered = filteredOf(operation);
    if (samples.length === 0 && filtered > 0) {
      return {
        status: 'failed',
        filtered,
        error: {
          message: reasonsOf(operation) || 'the video was withheld by a safety filter',
          safety: true,
          retryable: false,
        },
        raw: operation,
      };
    }
    return { status: 'completed', outputs: samples.length, ...(filtered ? { filtered } : {}), raw: operation };
  }

  /** Streams one video: from its URI, from Cloud Storage, or from the bytes Vertex returned. */
  async download(ref: VideoJobRef, index: number, context: VideoCallContext): Promise<VideoContent> {
    const sample = samplesOf(await this.operation(ref, context))[index];
    if (!sample) throw new VideoError(`Job ${ref.id} has no video ${index}`, 'VIDEO_INVALID');
    if (sample.base64 !== undefined) {
      const data = decodeBase64(sample.base64);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      return { stream, mimeType: sample.mimeType, byteLength: data.byteLength };
    }
    const uri = sample.uri as string;
    const url = uri.startsWith('gs://') ? storageUrl(uri) : uri;
    const response = await this.send(url, { method: 'GET', redirect: 'follow' }, context);
    if (!response.ok || !response.body) {
      throw await failure(response, `Google video download for job ${ref.id} failed`);
    }
    const length = Number(response.headers.get('content-length'));
    return {
      stream: response.body,
      mimeType: response.headers.get('content-type')?.split(';', 1)[0] || sample.mimeType,
      ...(Number.isSafeInteger(length) && length > 0 ? { byteLength: length } : {}),
    };
  }

  private operation(ref: VideoJobRef, context: VideoCallContext): Promise<Operation> {
    if (this.vertex) {
      return this.call<Operation>(
        `${this.baseUrl}/models/${encodeURIComponent(ref.model)}:fetchPredictOperation`,
        { method: 'POST', body: JSON.stringify({ operationName: ref.id }) },
        context,
      );
    }
    return this.call<Operation>(`${this.baseUrl}/${ref.id}`, { method: 'GET' }, context);
  }

  private image(input: AssetInput): Record<string, unknown> {
    if (input.location.kind !== 'bytes') {
      throw new VideoError('Veo takes an input image as bytes', 'VIDEO_UNSUPPORTED');
    }
    const data = encodeBase64(input.location.data);
    return this.vertex
      ? { bytesBase64Encoded: data, mimeType: input.mimeType }
      : { inlineData: { mimeType: input.mimeType, data } };
  }

  private async call<T>(url: string, init: RequestInit, context: VideoCallContext): Promise<T> {
    const response = await this.send(url, init, context);
    if (!response.ok) throw await failure(response, 'Google video request failed');
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      throw new VideoError('Google returned a body that is not JSON', 'VIDEO_PROVIDER', { cause: error });
    }
  }

  private async send(url: string, init: RequestInit, context: VideoCallContext): Promise<Response> {
    const headers = new Headers(this.config.defaultHeaders);
    if (init.body) headers.set('content-type', 'application/json');
    // A credential resolved for the call's tenant replaces the configured key or token.
    const credential = await context.credential?.(this.info.name);
    const token = credential
      ? undefined
      : typeof this.config.accessToken === 'function'
        ? await this.config.accessToken()
        : this.config.accessToken;
    if (credential?.apiKey) headers.set('x-goog-api-key', credential.apiKey);
    else if (token) headers.set('authorization', `Bearer ${token}`);
    else if (this.config.apiKey) headers.set('x-goog-api-key', this.config.apiKey);
    for (const [name, value] of Object.entries(credential?.headers ?? {})) headers.set(name, value);
    try {
      return await this.fetchImplementation(url, { ...init, headers, signal: context.signal });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new VideoError('Google video request failed before a response', 'VIDEO_PROVIDER', {
        retryable: true,
        cause: error,
      });
    }
  }
}

function samplesOf(operation: Operation): Sample[] {
  const gemini = operation.response?.generateVideoResponse?.generatedSamples;
  if (gemini) {
    return gemini
      .filter((sample) => sample.video?.uri)
      .map((sample) => ({ uri: sample.video?.uri as string, mimeType: sample.video?.mimeType || 'video/mp4' }));
  }
  return (operation.response?.videos ?? [])
    .filter((video) => video.gcsUri || video.bytesBase64Encoded)
    .map((video) =>
      video.gcsUri
        ? { uri: video.gcsUri, mimeType: video.mimeType || 'video/mp4' }
        : { base64: video.bytesBase64Encoded as string, mimeType: video.mimeType || 'video/mp4' },
    );
}

function filteredOf(operation: Operation): number {
  const response = operation.response;
  return response?.generateVideoResponse?.raiMediaFilteredCount ?? response?.raiMediaFilteredCount ?? 0;
}

function reasonsOf(operation: Operation): string {
  const response = operation.response;
  return (response?.generateVideoResponse?.raiMediaFilteredReasons ?? response?.raiMediaFilteredReasons ?? []).join(
    ' ',
  );
}

/** A `gs://bucket/object` URI as the Cloud Storage JSON API's media URL. */
function storageUrl(uri: string): string {
  const path = uri.slice('gs://'.length);
  const slash = path.indexOf('/');
  const bucket = path.slice(0, slash);
  const object = path.slice(slash + 1);
  return `${STORAGE_BASE_URL}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
}

async function failure(response: Response, message: string): Promise<VideoError> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body?.error?.message) detail = body.error.message;
  } catch {
    // The status says enough.
  }
  return new VideoError(`${message}: ${detail}`, 'VIDEO_PROVIDER', {
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}
