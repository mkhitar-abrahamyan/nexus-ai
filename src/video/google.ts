/**
 * Google's video models: Gemini Omni Flash through the Interactions API, and Veo through its
 * long-running prediction protocol, on the Gemini API or on Vertex AI.
 */
import type { AssetInput } from '../types/images.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
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
/** The Gemini API's video model since the Veo 3.1 previews shut down on 2026-10-22. */
const OMNI_MODEL = 'gemini-omni-1.1-flash';
/** Veo on Vertex AI, as generally available: the standard, Fast, and Lite (in preview) models. */
const VERTEX_MODELS = ['veo-3.1-generate-001', 'veo-3.1-fast-generate-001', 'veo-3.1-lite-generate-001'] as const;
const VEO_31: VideoModelCapabilities = {
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
/** Omni makes 3 to 10 seconds, and adds as much when it extends. */
const OMNI_LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10];
const OMNI: VideoModelCapabilities = {
  inputs: ['image', 'references', 'extend', 'edit'],
  durations: OMNI_LENGTHS,
  defaultDurationSeconds: 8,
  extendDurations: OMNI_LENGTHS,
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['360p', '720p', '1080p', '4k'],
  audio: 'always',
  maxCount: 1,
  supportsSeed: false,
  supportsNegativePrompt: false,
  continuesJobs: true,
  // An uploaded video it extends or edits is 10 seconds at most.
  maxInputVideoSeconds: 10,
};

/** Whether a model is served on the Interactions API: Gemini Omni Flash and its versions. */
const isOmni = (model: string) => model.startsWith('gemini-omni');

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
  /**
   * Vertex AI only: where Veo writes each video, as `gs://bucket/prefix`. Without it Vertex returns the
   * bytes inline, and a job cannot be extended from what it made.
   */
  storageUri?: string;
  /**
   * The model a request naming none uses. Defaults to `gemini-omni-1.1-flash` on the Gemini API and
   * `veo-3.1-generate-001` on Vertex AI.
   */
  defaultModel?: string;
  /**
   * The models served. Defaults to Gemini Omni Flash on the Gemini API, where the Veo 3.1 previews shut
   * down on 2026-10-22, and to Veo 3.1 on Vertex AI. A model named `gemini-omni…` is reached through the
   * Interactions API, any other through Veo's protocol.
   */
  models?: readonly string[];
  /** Where a model differs from what the adapter knows of it. */
  byModel?: Record<string, Partial<VideoModelCapabilities>>;
  /** `dont_allow`, `allow_adult`, or `allow_all`, sent to Veo as `personGeneration`. Some regions allow only `allow_adult`. */
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

/** An interaction, as the Interactions API returns it: its state, and the steps that made its output. */
interface Interaction {
  id?: string;
  status?: string;
  error?: { code?: number; message?: string; status?: string };
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; uri?: string; mime_type?: string }>;
    error?: { code?: number; message?: string; status?: string };
  }>;
}

interface Sample {
  uri?: string;
  base64?: string;
  mimeType: string;
}

/**
 * Google's video models behind the video contract.
 *
 * Gemini Omni Flash runs as a background interaction: its id is the ref, any worker reads it, and its
 * video comes back with it, inline or by a Files API URI. It extends or edits a video given to it, or
 * continues an interaction of its own by its id, with nothing uploaded.
 *
 * Veo runs as a long-running operation: its name is the ref, any worker polls it, and the video is read
 * from the URI the Gemini API returns, from Cloud Storage, or from the bytes Vertex returns inline. On
 * Vertex it extends a video in Cloud Storage by seven seconds, or a job of its own that wrote there.
 */
export class GoogleVideoProvider implements VideoProvider {
  /** Provider name, capabilities, and models. */
  readonly info: VideoProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly vertex: boolean;
  /** Interactions read as finished, so the download right after reads no second copy of the video. */
  private readonly finished = new Map<string, Interaction>();

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
    const models = config.models ?? (this.vertex ? VERTEX_MODELS : [OMNI_MODEL]);
    const byModel: Record<string, Partial<VideoModelCapabilities>> = {};
    for (const model of models) byModel[model] = this.capabilitiesFor(model);
    const defaultModel = config.defaultModel ?? models[0];
    const omniOnly = models.every(isOmni);
    this.info = {
      name: 'google',
      capabilities: {
        ...(defaultModel ? byModel[defaultModel] : VEO_31),
        inputs: (defaultModel ? byModel[defaultModel]?.inputs : undefined) ?? VEO_31.inputs,
        models,
        ...(defaultModel ? { defaultModel } : {}),
        byModel: { ...byModel, ...mergeByModel(byModel, config.byModel) },
        // Veo on the Gemini API takes images as bytes; Omni and Vertex also take them by URI.
        inputLocationKinds: this.vertex || models.some(isOmni) ? ['bytes', 'url'] : ['bytes'],
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        inputVideoMimeTypes: ['video/mp4'],
        // An interaction can be cancelled and deleted; an operation cannot, here.
        supportsCancel: omniOnly,
        supportsRemove: omniOnly,
        // The Gemini API keeps a Veo video two days, and an interaction a day on the free tier.
        retentionHours: this.vertex ? undefined : omniOnly ? 24 : 48,
      },
    };
  }

  /** What one model takes: Omni's, Veo 3.1's, or Veo's on Vertex, which extends videos too. */
  private capabilitiesFor(model: string): VideoModelCapabilities {
    if (isOmni(model)) return OMNI;
    const veo: VideoModelCapabilities = { ...VEO_31 };
    // Lite makes no 4k video anywhere; on Vertex, Fast makes none either, and Lite takes no references.
    if (model.includes('lite')) veo.resolutions = ['720p', '1080p'];
    if (this.vertex) {
      if (model.includes('fast')) veo.resolutions = ['720p', '1080p'];
      if (model.includes('lite')) veo.inputs = ['image', 'last-frame'];
      veo.inputs = [...veo.inputs, 'extend'];
      veo.extendDurations = [7];
      veo.maxInputVideoSeconds = 30;
      veo.maxCount = 4;
      // A job's video can be extended only when it is in Cloud Storage.
      veo.continuesJobs = this.config.storageUri !== undefined;
    }
    return veo;
  }

  /** Starts an interaction for Omni, or a long-running prediction for Veo. */
  async submit(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    if (isOmni(request.model)) return this.startInteraction(request, context);
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
    if (request.video) instance.video = await this.veoVideo(request, context);
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

  /** Reads the interaction or the operation. */
  async poll(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState> {
    if (isInteraction(ref)) return this.pollInteraction(ref, context);
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

  /** Streams one video: from its URI, from Cloud Storage, or from the bytes returned with the job. */
  async download(ref: VideoJobRef, index: number, context: VideoCallContext): Promise<VideoContent> {
    const sample = isInteraction(ref)
      ? videosOf(this.finished.get(ref.id) ?? (await this.interaction(ref.id, context)))[index]
      : samplesOf(await this.operation(ref, context))[index];
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
    const url = uri.startsWith('gs://') ? storageUrl(uri) : /^https?:\/\//.test(uri) ? uri : `${this.baseUrl}/${uri}`;
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

  /** Cancels a running interaction. A Veo operation runs to its end. */
  async cancel(ref: VideoJobRef, context: VideoCallContext): Promise<void> {
    if (!isInteraction(ref)) throw new VideoError('A Veo operation cannot be cancelled here', 'VIDEO_UNSUPPORTED');
    await this.call(`${this.baseUrl}/interactions/${encodeURIComponent(ref.id)}/cancel`, { method: 'POST' }, context);
  }

  /** Deletes a finished interaction, and its video, from Google. */
  async remove(ref: VideoJobRef, context: VideoCallContext): Promise<void> {
    if (!isInteraction(ref)) throw new VideoError('A Veo video expires on its own', 'VIDEO_UNSUPPORTED');
    this.finished.delete(ref.id);
    await this.call(`${this.baseUrl}/interactions/${encodeURIComponent(ref.id)}`, { method: 'DELETE' }, context);
  }

  // ── Gemini Omni Flash, through the Interactions API ──

  private async startInteraction(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    if (this.vertex) {
      throw new VideoError('Gemini Omni Flash is reached through the Gemini API, not Vertex AI', 'VIDEO_UNSUPPORTED');
    }
    const parts: Array<Record<string, unknown>> = [];
    if (request.video?.input) parts.push(media('video', request.video.input));
    if (request.image) parts.push(media('image', request.image));
    for (const reference of request.references ?? []) parts.push(media('image', reference));
    if (request.prompt.trim()) parts.push({ type: 'text', text: request.prompt });
    const format: Record<string, unknown> = { type: 'video' };
    if (request.aspectRatio) format.aspect_ratio = request.aspectRatio;
    if (request.resolution) format.resolution = request.resolution;
    if (request.durationSeconds !== undefined) format.duration = `${request.durationSeconds}s`;
    const body: Record<string, unknown> = {
      model: request.model,
      input: parts.length === 1 && parts[0]?.type === 'text' ? request.prompt : parts,
      response_format: format,
      // In the background, so the call returns at once and any worker reads it; stored, which that needs.
      background: true,
      store: true,
    };
    const from = request.video?.from;
    if (from) {
      if (!isInteraction(from.ref)) {
        throw new VideoError(
          'Gemini Omni Flash continues only its own interactions; give a Veo video as input',
          'VIDEO_UNSUPPORTED',
        );
      }
      if ((from.index ?? 0) !== 0) throw new VideoError('An interaction makes one video, at index 0', 'VIDEO_INVALID');
      body.previous_interaction_id = from.ref.id;
    }
    const task = request.video
      ? request.video.mode
      : request.references?.length
        ? 'reference_to_video'
        : request.image
          ? 'image_to_video'
          : undefined;
    if (task) body.generation_config = { video_config: { task } };
    Object.assign(body, request.providerOptions);
    const interaction = await this.call<Interaction>(
      `${this.baseUrl}/interactions`,
      { method: 'POST', body: JSON.stringify(body) },
      context,
    );
    if (!interaction.id) throw new VideoError('Google returned no interaction id', 'VIDEO_PROVIDER');
    return {
      provider: this.info.name,
      id: interaction.id,
      model: request.model,
      createdAt: new Date().toISOString(),
      metadata: { google: { api: 'interactions' } },
    };
  }

  private async pollInteraction(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState> {
    const interaction = await this.interaction(ref.id, context);
    switch (interaction.status) {
      case 'queued':
        return { status: 'queued', raw: summary(interaction) };
      case 'in_progress':
      case 'requires_action':
        return { status: 'running', raw: summary(interaction) };
      case 'cancelled':
        return { status: 'cancelled', raw: summary(interaction) };
      case 'completed': {
        const videos = videosOf(interaction);
        if (videos.length === 0) {
          return {
            status: 'failed',
            error: { message: errorOf(interaction)?.message ?? 'the interaction made no video', retryable: false },
            raw: summary(interaction),
          };
        }
        this.remember(ref.id, interaction);
        return { status: 'completed', outputs: videos.length, raw: summary(interaction) };
      }
      default: {
        // failed, incomplete, budget_exceeded, or a state this adapter does not know.
        const error = errorOf(interaction);
        const code = error?.status ?? (error?.code === undefined ? interaction.status : String(error.code));
        return {
          status: 'failed',
          error: {
            message: error?.message ?? `the interaction ended ${interaction.status ?? 'without a status'}`,
            ...(code ? { code } : {}),
            retryable: [13, 14, 4].includes(error?.code ?? -1),
            ...(/SAFETY|PROHIBITED|BLOCK/i.test(`${error?.status ?? ''} ${error?.message ?? ''}`)
              ? { safety: true }
              : {}),
          },
          raw: summary(interaction),
        };
      }
    }
  }

  private interaction(id: string, context: VideoCallContext): Promise<Interaction> {
    return this.call<Interaction>(`${this.baseUrl}/interactions/${encodeURIComponent(id)}`, { method: 'GET' }, context);
  }

  /** Keeps the last few finished interactions, whose video the download reads. */
  private remember(id: string, interaction: Interaction): void {
    this.finished.delete(id);
    this.finished.set(id, interaction);
    while (this.finished.size > 4) this.finished.delete(this.finished.keys().next().value as string);
  }

  // ── Veo ──

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

  /** The video Veo extends: one in Cloud Storage, or one a job of its own wrote there. */
  private async veoVideo(request: VideoProviderRequest, context: VideoCallContext): Promise<Record<string, unknown>> {
    const video = request.video;
    if (!this.vertex || video?.mode !== 'extend') {
      throw new VideoError('Veo extends videos on Vertex AI, and edits none', 'VIDEO_UNSUPPORTED');
    }
    if (video.input) {
      if (video.input.location.kind !== 'url' || !video.input.location.url.startsWith('gs://')) {
        throw new VideoError('Veo extends a video in Cloud Storage: give it as a gs:// URL', 'VIDEO_UNSUPPORTED');
      }
      return { gcsUri: video.input.location.url, mimeType: video.input.mimeType };
    }
    const from = video.from as { ref: VideoJobRef; index?: number };
    if (isInteraction(from.ref)) {
      throw new VideoError('Veo extends only its own videos; give an Omni video as input', 'VIDEO_UNSUPPORTED');
    }
    const sample = samplesOf(await this.operation(from.ref, context))[from.index ?? 0];
    if (!sample?.uri?.startsWith('gs://')) {
      throw new VideoError(
        `Job ${from.ref.id} kept no video in Cloud Storage to extend; set storageUri so Veo writes there`,
        'VIDEO_UNSUPPORTED',
      );
    }
    return { gcsUri: sample.uri, mimeType: sample.mimeType };
  }

  private image(input: AssetInput): Record<string, unknown> {
    if (input.location.kind === 'url' && this.vertex && input.location.url.startsWith('gs://')) {
      return { gcsUri: input.location.url, mimeType: input.mimeType };
    }
    if (input.location.kind !== 'bytes') {
      throw new VideoError(
        'Veo takes an input image as bytes, or on Vertex AI from Cloud Storage',
        'VIDEO_UNSUPPORTED',
      );
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

/** A model's capabilities as configured: what the adapter knows of it, with the configuration's changes. */
function mergeByModel(
  known: Record<string, Partial<VideoModelCapabilities>>,
  given: Record<string, Partial<VideoModelCapabilities>> | undefined,
): Record<string, Partial<VideoModelCapabilities>> {
  const merged: Record<string, Partial<VideoModelCapabilities>> = {};
  for (const [model, changes] of Object.entries(given ?? {})) merged[model] = { ...known[model], ...changes };
  return merged;
}

/** Whether a ref is an interaction's: Omni's refs say so, and an older ref is told by its model. */
function isInteraction(ref: VideoJobRef): boolean {
  const google = ref.metadata?.google as { api?: string } | undefined;
  return google?.api === 'interactions' || isOmni(ref.model);
}

/** An image or a video as an interaction's input: inline, or by the URI the Files API gave it. */
function media(type: 'image' | 'video', input: AssetInput): Record<string, unknown> {
  if (input.location.kind === 'bytes') {
    return { type, data: encodeBase64(input.location.data), mime_type: input.mimeType };
  }
  if (input.location.kind === 'url') return { type, uri: input.location.url, mime_type: input.mimeType };
  throw new VideoError(
    `Gemini Omni Flash takes an input ${type} as bytes or by its Files API URI`,
    'VIDEO_UNSUPPORTED',
  );
}

/** The videos an interaction made, from its model output steps, in order. */
function videosOf(interaction: Interaction): Sample[] {
  return (interaction.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((item) => item.type === 'video' && (item.data || item.uri))
    .map((item) => ({
      ...(item.data ? { base64: item.data } : { uri: item.uri as string }),
      mimeType: item.mime_type || 'video/mp4',
    }));
}

/** Why an interaction ended without a video: its own error, or the error of a step. */
function errorOf(interaction: Interaction): Interaction['error'] {
  return interaction.error ?? interaction.steps?.find((step) => step.error)?.error;
}

/** An interaction without its video's bytes, as a job state's raw payload, which may be stored. */
function summary(interaction: Interaction): Interaction {
  return {
    ...interaction,
    ...(interaction.steps
      ? {
          steps: interaction.steps.map((step) => ({
            ...step,
            ...(step.content
              ? { content: step.content.map(({ data, ...item }) => (data ? { ...item, data: '(omitted)' } : item)) }
              : {}),
          })),
        }
      : {}),
  };
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
