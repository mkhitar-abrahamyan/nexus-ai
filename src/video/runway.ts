/**
 * Runway's video task API: one protocol for its own models and the hosted ones it serves, Veo,
 * Gemini Omni Flash, and Seedance among them, from a prompt, an image, or a video to extend or edit.
 */
import type { AssetInput } from '../types/images.js';
import { encodeBase64 } from '../utils/base64.js';
import type {
  VideoCallContext,
  VideoContent,
  VideoJobError,
  VideoJobRef,
  VideoJobState,
  VideoModelCapabilities,
  VideoProvider,
  VideoProviderInfo,
  VideoProviderRequest,
} from './index.js';
import { VideoError } from './errors.js';

const BASE_URL = 'https://api.dev.runwayml.com';
const API_VERSION = '2024-11-06';
const DEFAULT_MODEL = 'gen4.5';
/**
 * The models Runway's API names, as its SDK listed them on 2026-10-20: every text-to-video model, and
 * Aleph, which only changes a video it is given.
 */
const RUNWAY_MODELS = [
  'gen4.5',
  'veo3.1',
  'veo3.1_fast',
  'gemini_omni_flash_1.1',
  'gemini_omni_flash',
  'seedance2_5',
  'seedance2',
  'seedance2_fast',
  'seedance2_mini',
  'hailuo3',
  'happyhorse_1_0',
  'grok_imagine_1_5',
  'grok_imagine_1_5_lite',
  'wan3',
  'wan3_prime',
  'h3_max',
  'aleph2',
] as const;
/** What Omni adds when it extends a video, in seconds. */
const OMNI_LENGTHS = [3, 4, 5, 6, 7, 8, 9, 10];
/** Models that take reference images and reference videos, up to 15 seconds of video together. */
const REFERENCED: Partial<VideoModelCapabilities> = {
  inputs: ['image', 'references', 'reference-videos'],
  maxReferences: 9,
  referenceVideoSeconds: { total: 15 },
};
/** Reference videos Runway names by their type; Omni's are bare. */
const BARE_REFERENCE_VIDEOS = new Set(['gemini_omni_flash_1.1']);
/** The image-to-video models that take reference videos too. */
const IMAGE_REFERENCE_VIDEOS = new Set(['wan3', 'wan3_prime']);
const VEO: Partial<VideoModelCapabilities> = {
  durations: [4, 6, 8],
  defaultDurationSeconds: 8,
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p'],
  audio: 'optional',
};
const BY_MODEL: Record<string, Partial<VideoModelCapabilities>> = {
  'gen4.5': {
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    defaultDurationSeconds: 5,
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    audio: 'none',
  },
  'veo3.1': VEO,
  'veo3.1_fast': VEO,
  seedance2: REFERENCED,
  seedance2_fast: REFERENCED,
  seedance2_mini: REFERENCED,
  seedance2_5: REFERENCED,
  hailuo3: REFERENCED,
  wan3: { ...REFERENCED, maxReferences: 10 },
  wan3_prime: { ...REFERENCED, maxReferences: 10 },
  grok_imagine_1_5: { inputs: ['image', 'references'] },
  'gemini_omni_flash_1.1': {
    inputs: ['image', 'references', 'reference-videos', 'extend', 'edit'],
    maxReferenceVideos: 3,
    referenceVideoSeconds: { each: 3 },
    durations: OMNI_LENGTHS,
    extendDurations: OMNI_LENGTHS,
    audio: 'none',
    supportsSeed: false,
    continuesJobs: true,
  },
  gemini_omni_flash: {
    inputs: ['image', 'edit'],
    durations: OMNI_LENGTHS,
    audio: 'none',
    supportsSeed: false,
    continuesJobs: true,
  },
  // Aleph changes the video it is given, as its prompt says; it makes none from nothing.
  aleph2: { inputs: ['edit'], requires: ['edit'], audio: 'none', supportsSeed: true, continuesJobs: true },
};
/** The most a video inline in a request may hold: Runway takes a larger one by URL. */
const MAX_INLINE_VIDEO_BYTES = 5 * 1024 * 1024;
/** Pixel sizes Runway's `ratio` names, by shape and frame size. */
const RATIOS: Record<string, Record<string, string>> = {
  '16:9': { '720p': '1280:720', '1080p': '1920:1080' },
  '9:16': { '720p': '720:1280', '1080p': '1080:1920' },
};
/** Failure codes Runway says are worth submitting again; any other is not. */
const RETRYABLE = /^(INTERNAL(\.BAD_OUTPUT.*)?|INPUT_PREPROCESSING\.INTERNAL|THIRD_PARTY\.UNAVAILABLE)$/;

/** Options for the Runway video provider. */
export interface RunwayVideoProviderConfig {
  /** The API secret, sent as a bearer token. */
  apiKey: string;
  /** API base URL. Defaults to `https://api.dev.runwayml.com`. */
  baseUrl?: string;
  /** The `X-Runway-Version` header. Defaults to `2024-11-06`. */
  version?: string;
  /** The model a request naming none uses. Defaults to `gen4.5`. */
  defaultModel?: string;
  /** The models served. Defaults to every text-to-video model Runway names. */
  models?: readonly string[];
  /** Where a model differs from what the adapter knows of it. */
  byModel?: Record<string, Partial<VideoModelCapabilities>>;
  /** Headers added to every API request, not to a download. */
  defaultHeaders?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface RunwayTask {
  id?: string;
  status?: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  createdAt?: string;
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string | null;
}

/**
 * Runway behind the video contract. A job is a task: its id is the ref, any worker polls it, and each
 * video is read from the signed URL the finished task lists, which takes no credentials. A request's
 * shape and size become Runway's `ratio`, such as `1280:720`; a ratio of Runway's own passes through
 * as `aspectRatio`. Fields a model takes that the contract does not, such as Seedance's, go in
 * `providerOptions`.
 */
export class RunwayVideoProvider implements VideoProvider {
  /** Provider name, capabilities, and models. */
  readonly info: VideoProviderInfo;

  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly config: RunwayVideoProviderConfig) {
    if (!config.apiKey?.trim()) throw new VideoError('Runway video provider needs an apiKey', 'VIDEO_INVALID');
    const fetchImplementation = config.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== 'function') {
      throw new VideoError('Runway video provider requires a fetch implementation', 'VIDEO_INVALID');
    }
    this.fetchImplementation = fetchImplementation;
    this.baseUrl = (config.baseUrl || BASE_URL).replace(/\/+$/, '');
    const models = config.models ?? RUNWAY_MODELS;
    this.info = {
      name: 'runway',
      capabilities: {
        inputs: ['image'],
        audio: 'optional',
        supportsSeed: true,
        maxCount: 1,
        models,
        defaultModel: config.defaultModel ?? (models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]),
        byModel: { ...BY_MODEL, ...config.byModel },
        inputLocationKinds: ['bytes', 'url'],
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        inputVideoMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
        supportsCancel: true,
        supportsRemove: true,
      },
    };
  }

  /**
   * Starts a text-to-video task, an image-to-video one when the request has a first frame, or a
   * video-to-video one when it has a video to extend or edit.
   */
  async submit(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    if (request.video) return this.fromVideo(request, context);
    const caps = { ...this.info.capabilities, ...this.info.capabilities.byModel?.[request.model] };
    const body: Record<string, unknown> = { model: request.model };
    if (request.prompt.trim()) body.promptText = request.prompt;
    const duration = request.durationSeconds ?? caps.defaultDurationSeconds;
    if (duration !== undefined) body.duration = duration;
    // A model that needs a ratio gets a landscape one at the size asked when the request names none.
    const ratio = ratioOf(
      request.aspectRatio ?? (caps.aspectRatios?.includes('16:9') ? '16:9' : undefined),
      request.resolution,
    );
    if (ratio) body.ratio = ratio;
    if (request.audio !== undefined) body.audio = request.audio;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.image) body.promptImage = imageUri(request.image);
    // Image to video takes no reference images, and reference videos on Wan alone.
    if (request.image && request.references?.length) {
      throw new VideoError(
        "Runway's image to video takes no reference images; send them without a first frame",
        'VIDEO_UNSUPPORTED',
      );
    }
    if (request.image && request.referenceVideos?.length && !IMAGE_REFERENCE_VIDEOS.has(request.model)) {
      throw new VideoError(
        `Runway's image to video takes reference videos only on Wan, not "${request.model}"`,
        'VIDEO_UNSUPPORTED',
      );
    }
    this.references(request, body);
    Object.assign(body, request.providerOptions);
    const path = request.image ? '/v1/image_to_video' : '/v1/text_to_video';
    const task = await this.call<RunwayTask>(path, { method: 'POST', body: JSON.stringify(body) }, context);
    if (!task.id) throw new VideoError('Runway returned no task id', 'VIDEO_PROVIDER');
    return {
      provider: this.info.name,
      id: task.id,
      model: request.model,
      createdAt:
        task.createdAt && !Number.isNaN(Date.parse(task.createdAt)) ? task.createdAt : new Date().toISOString(),
      ...(duration !== undefined ? { metadata: { runway: { duration } } } : {}),
    };
  }

  /** A video-to-video task: the video given, or the one a task of this account made, changed or continued. */
  private async fromVideo(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    const video = request.video as NonNullable<VideoProviderRequest['video']>;
    const body: Record<string, unknown> = { model: request.model, videoUri: await this.videoUri(video, context) };
    if (request.prompt.trim()) body.promptText = request.prompt;
    if (request.model === 'gemini_omni_flash_1.1') {
      body.mode = video.mode;
      // Extending, the duration is what is added; editing, the video keeps its own.
      if (video.mode === 'extend' && request.durationSeconds !== undefined) body.duration = request.durationSeconds;
      const ratio = ratioOf(request.aspectRatio, request.resolution);
      if (ratio) body.ratio = ratio;
    }
    if (request.seed !== undefined) body.seed = request.seed;
    this.references(request, body);
    Object.assign(body, request.providerOptions);
    const task = await this.call<RunwayTask>(
      '/v1/video_to_video',
      { method: 'POST', body: JSON.stringify(body) },
      context,
    );
    if (!task.id) throw new VideoError('Runway returned no task id', 'VIDEO_PROVIDER');
    return {
      provider: this.info.name,
      id: task.id,
      model: request.model,
      createdAt:
        task.createdAt && !Number.isNaN(Date.parse(task.createdAt)) ? task.createdAt : new Date().toISOString(),
    };
  }

  /** A video as Runway takes it: by URL, inline up to 5 MB, or the signed URL of a task's own video. */
  private async videoUri(
    video: NonNullable<VideoProviderRequest['video']>,
    context: VideoCallContext,
  ): Promise<string> {
    if (video.from) {
      const index = video.from.index ?? 0;
      const url = (await this.task(video.from.ref, context)).output?.[index];
      if (!url)
        throw new VideoError(`Runway task ${video.from.ref.id} has no video ${index} to continue`, 'VIDEO_INVALID');
      return url;
    }
    return videoInputUri(video.input as AssetInput);
  }

  /** A request's reference images and reference videos, as the model names them. */
  private references(request: VideoProviderRequest, body: Record<string, unknown>): void {
    if (request.references?.length) {
      body.references = request.references.map((reference) => ({ uri: imageUri(reference) }));
    }
    if (request.referenceVideos?.length) {
      const bare = BARE_REFERENCE_VIDEOS.has(request.model);
      body.referenceVideos = request.referenceVideos.map((reference) =>
        bare ? { uri: videoInputUri(reference) } : { type: 'video', uri: videoInputUri(reference) },
      );
    }
  }

  /** Reads the task. */
  async poll(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState> {
    const task = await this.task(ref, context);
    const duration = (ref.metadata?.runway as { duration?: number } | undefined)?.duration;
    switch (task.status) {
      case 'SUCCEEDED':
        return {
          status: 'completed',
          outputs: task.output?.length ?? 0,
          ...(duration !== undefined ? { durationSeconds: duration } : {}),
          raw: task,
        };
      case 'FAILED':
        return { status: 'failed', error: failureOf(task), raw: task };
      case 'CANCELLED':
        return { status: 'cancelled', raw: task };
      case 'RUNNING':
        return {
          status: 'running',
          ...(typeof task.progress === 'number' ? { progress: Math.min(1, Math.max(0, task.progress)) } : {}),
          raw: task,
        };
      default:
        return { status: 'queued', raw: task };
    }
  }

  /** Streams one video from the signed URL the finished task lists. */
  async download(ref: VideoJobRef, index: number, context: VideoCallContext): Promise<VideoContent> {
    const url = (await this.task(ref, context)).output?.[index];
    if (!url) throw new VideoError(`Runway task ${ref.id} has no video ${index}`, 'VIDEO_INVALID');
    let response: Response;
    try {
      // A signed URL: it carries its own access, and the API secret is never sent to it.
      response = await this.fetchImplementation(url, { signal: context.signal });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new VideoError('Runway video download failed before a response', 'VIDEO_PROVIDER', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok || !response.body)
      throw await failure(response, `Runway video download for task ${ref.id} failed`);
    const length = Number(response.headers.get('content-length'));
    return {
      stream: response.body,
      mimeType: response.headers.get('content-type')?.split(';', 1)[0] || 'video/mp4',
      ...(Number.isSafeInteger(length) && length > 0 ? { byteLength: length } : {}),
    };
  }

  /** Cancels a running task. */
  async cancel(ref: VideoJobRef, context: VideoCallContext): Promise<void> {
    await this.call(`/v1/tasks/${encodeURIComponent(ref.id)}`, { method: 'DELETE' }, context);
  }

  /** Deletes a finished task and its videos. */
  async remove(ref: VideoJobRef, context: VideoCallContext): Promise<void> {
    await this.call(`/v1/tasks/${encodeURIComponent(ref.id)}`, { method: 'DELETE' }, context);
  }

  private task(ref: VideoJobRef, context: VideoCallContext): Promise<RunwayTask> {
    return this.call<RunwayTask>(`/v1/tasks/${encodeURIComponent(ref.id)}`, { method: 'GET' }, context);
  }

  private async call<T>(path: string, init: RequestInit, context: VideoCallContext): Promise<T> {
    const headers = new Headers(this.config.defaultHeaders);
    // A credential resolved for the call's tenant replaces the configured key.
    const credential = await context.credential?.(this.info.name);
    headers.set('authorization', `Bearer ${credential?.apiKey ?? this.config.apiKey}`);
    for (const [name, value] of Object.entries(credential?.headers ?? {})) headers.set(name, value);
    headers.set('x-runway-version', this.config.version ?? API_VERSION);
    if (init.body) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, { ...init, headers, signal: context.signal });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new VideoError('Runway video request failed before a response', 'VIDEO_PROVIDER', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) throw await failure(response, 'Runway video request failed');
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      throw new VideoError('Runway returned a body that is not JSON', 'VIDEO_PROVIDER', { cause: error });
    }
  }
}

/** A shape and size as Runway's `ratio`; a ratio of Runway's own, such as `1584:672`, as it is. */
function ratioOf(aspectRatio: string | undefined, resolution: string | undefined): string | undefined {
  if (!aspectRatio) return undefined;
  if (/^\d{3,4}:\d{3,4}$/.test(aspectRatio)) return aspectRatio;
  const ratio = RATIOS[aspectRatio]?.[resolution ?? '720p'];
  if (!ratio) {
    throw new VideoError(
      `Runway has no ratio for ${aspectRatio} at ${resolution ?? '720p'}; pass one of its own, such as 1280:720`,
      'VIDEO_UNSUPPORTED',
    );
  }
  return ratio;
}

/** A video given to Runway: by URL, or inline as a data URI up to 5 MB. */
function videoInputUri(input: AssetInput): string {
  if (input.location.kind === 'bytes' && input.location.data.byteLength > MAX_INLINE_VIDEO_BYTES) {
    throw new VideoError('Runway takes a video inline up to 5 MB; give a larger one by URL', 'VIDEO_UNSUPPORTED');
  }
  if (input.location.kind === 'url') return input.location.url;
  if (input.location.kind === 'bytes') return `data:${input.mimeType};base64,${encodeBase64(input.location.data)}`;
  throw new VideoError('Runway takes a video as bytes or by URL', 'VIDEO_UNSUPPORTED');
}

function imageUri(input: AssetInput): string {
  if (input.location.kind === 'url') return input.location.url;
  if (input.location.kind === 'bytes') return `data:${input.mimeType};base64,${encodeBase64(input.location.data)}`;
  throw new VideoError('Runway takes an input image as bytes or by URL', 'VIDEO_UNSUPPORTED');
}

function failureOf(task: RunwayTask): VideoJobError {
  const code = task.failureCode ?? undefined;
  return {
    message: task.failure || 'the task failed',
    ...(code ? { code } : {}),
    // A task with no code failed inside Runway, which it says to try again; a refused input never is.
    retryable: code ? RETRYABLE.test(code) : true,
    safety: code?.startsWith('SAFETY') === true || code === 'INPUT_PREPROCESSING.SAFETY.TEXT',
  };
}

async function failure(response: Response, message: string): Promise<VideoError> {
  let detail = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string | { message?: string } };
    const text = typeof body?.error === 'string' ? body.error : body?.error?.message;
    if (text) detail = text;
  } catch {
    // The status says enough.
  }
  return new VideoError(`${message}: ${detail}`, 'VIDEO_PROVIDER', {
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}
