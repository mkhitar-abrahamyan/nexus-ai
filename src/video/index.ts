/**
 * Video generation: a prompt, and optionally a first frame, a last frame, reference images, or a video
 * to extend or edit, become a video through a provider's asynchronous job. The job is recorded the moment it exists, so a worker
 * that dies while it waits is replaced by one that collects that job, never a second; the video is
 * streamed into an asset store and priced per second.
 */
import { pollUntilSettled } from '../batch/poll.js';
import type { AssetByteSource, AssetStore } from '../images/asset-support.js';
import { type ContinuedFields, continuing } from '../lifecycle/continue.js';
import type { AssetDescriptor, AssetInput, AssetLocation } from '../types/images.js';
import type { OperationLifecycleLike, ProviderCallContext } from '../types/lifecycle.js';
import type { DurableOperationHandle, OperationContext, OperationRunnerConfig } from '../types/operations.js';
import type { ResponseCost } from '../types/response.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { generateRequestId } from '../utils/ids.js';
import { readMediaDuration } from '../utils/media-duration.js';
import { VideoError, VideoJobFailedError } from './errors.js';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 60_000;
/** Past the slowest generation a provider documents, six minutes at peak, with room to queue. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** 512 MiB: the most a video returned as bytes, rather than streamed to a store, may hold. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

// ── Requests ───────────────────────────────────────────────────────

/**
 * What a video can be made from beside its prompt: a first frame, a last frame, reference images,
 * reference videos, or a video to continue (`extend`) or to change as the prompt says (`edit`).
 */
export type VideoInputKind = 'image' | 'last-frame' | 'references' | 'reference-videos' | 'extend' | 'edit';

/**
 * A video to work from: one to continue from its end, or one to change as the prompt says. Give the
 * video itself as `input`, or name a finished job of the same provider as `from`, which the provider
 * continues from what it already holds, with nothing uploaded.
 */
export interface VideoSource {
  /** `extend` continues the video; `edit` changes it as the prompt says. */
  mode: 'extend' | 'edit';
  /** The video: bytes, a URL the provider can read, or an asset in the manager's store. */
  input?: AssetInput;
  /** Or a video this provider made: its job, and which of the job's videos, from 0. */
  from?: { ref: VideoJobRef; index?: number };
}

/** Whether a model makes sound: always, when asked, or never. */
export type VideoAudioSupport = 'always' | 'optional' | 'none';

/** A video to make. */
export interface VideoGenerateRequest {
  /** What the video shows. May be empty only when `image` is given and the model animates it alone. */
  prompt: string;
  /** The model. Defaults to the provider's. */
  model?: string;
  /** The provider to use. Defaults to the manager's default. */
  provider?: string;
  /** The first frame: the video starts from this image. */
  image?: AssetInput;
  /** The last frame, on a model that moves toward one. */
  lastFrame?: AssetInput;
  /** Images whose subject, character, or style the video keeps. */
  references?: readonly AssetInput[];
  /** Videos whose motion, subject, or look the video takes after; their sound is ignored. */
  referenceVideos?: readonly AssetInput[];
  /** A video to extend or edit. */
  video?: VideoSource;
  /** Length in seconds; for `extend`, how much is added. Defaults to the model's. */
  durationSeconds?: number;
  /** Frame shape, such as `16:9` or `9:16`. */
  aspectRatio?: string;
  /** Frame size, such as `720p`, `1080p`, or `4k`. */
  resolution?: string;
  /** Whether the video has sound, on a model where that is a choice. */
  audio?: boolean;
  /** What the video must not show. */
  negativePrompt?: string;
  /** Makes a generation repeatable, on a model that takes one. */
  seed?: number;
  /** Videos to make from this request. Defaults to 1. */
  count?: number;
  /** Fields only this provider knows, sent as they are. */
  providerOptions?: Record<string, unknown>;
  /**
   * Where the video goes: streamed into the manager's store, or returned as bytes. Defaults to
   * `store` when there is one. `generate()` always stores, since an operation keeps no bytes; `bytes`
   * is for `start()` and `resume()`.
   */
  delivery?: 'store' | 'bytes';
  /** The tenant a stored video belongs to. Defaults to the manager's. */
  tenantId?: string;
  /** How long a stored video is kept, in seconds. Defaults to the manager's. */
  ttlSeconds?: number;
  /** Replays the operation accepted under this key instead of making a second video. */
  idempotencyKey?: string;
  /** Labels kept on the job and its stored videos. */
  metadata?: Record<string, string>;
  /** Overrides the manager's poll interval. */
  pollIntervalMs?: number;
  /** Gives up waiting after this long. The provider's job is left running. */
  timeoutMs?: number;
  /** Stops waiting. The provider's job keeps running unless it is cancelled. */
  signal?: AbortSignal;
}

/** A request as a provider receives it: its model chosen and its inputs resolved to bytes or URLs. */
export interface VideoProviderRequest {
  /** What the video shows. */
  prompt: string;
  /** The provider's model name. */
  model: string;
  /** The first frame. */
  image?: AssetInput;
  /** The last frame. */
  lastFrame?: AssetInput;
  /** Reference images. */
  references?: readonly AssetInput[];
  /** Reference videos, resolved to bytes or URLs. */
  referenceVideos?: readonly AssetInput[];
  /** A video to extend or edit, its input resolved to bytes or a URL. */
  video?: VideoSource;
  /** Length in seconds; for `extend`, how much is added. */
  durationSeconds?: number;
  /** Frame shape. */
  aspectRatio?: string;
  /** Frame size. */
  resolution?: string;
  /** Whether the video has sound. */
  audio?: boolean;
  /** What the video must not show. */
  negativePrompt?: string;
  /** Makes a generation repeatable. */
  seed?: number;
  /** Videos to make. */
  count?: number;
  /** Fields only this provider knows. */
  providerOptions?: Record<string, unknown>;
  /** Labels for the provider's side. */
  metadata?: Record<string, string>;
}

// ── Jobs ───────────────────────────────────────────────────────────

/**
 * A provider's video job, as JSON: everything after `submit` takes only this, so a worker can collect
 * a job it did not submit.
 */
export interface VideoJobRef {
  /** The adapter's name. */
  provider: string;
  /** The provider's id for the job. */
  id: string;
  /** The model making it. */
  model: string;
  /** ISO-8601 time it was submitted. */
  createdAt: string;
  /** What the adapter, and the manager, need to finish it. JSON only. */
  metadata?: Record<string, unknown>;
}

/** Where a job is. `completed`, `failed`, `cancelled`, and `expired` are final. */
export type VideoJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';

const FINAL_STATUSES: ReadonlySet<VideoJobStatus> = new Set(['completed', 'failed', 'cancelled', 'expired']);
const STATUSES: ReadonlySet<string> = new Set(['queued', 'running', ...FINAL_STATUSES]);

/** Why a job failed. */
export interface VideoJobError {
  /** What went wrong, in the provider's words. */
  message: string;
  /** The provider's code for it. */
  code?: string;
  /** Whether submitting again may succeed: an internal fault may, a refused prompt will not. */
  retryable?: boolean;
  /** Whether a safety filter refused the prompt, an input, or the video. */
  safety?: boolean;
}

/** A job's state, as a poll reads it. */
export interface VideoJobState {
  /** Where it is. */
  status: VideoJobStatus;
  /** How far along, from 0 to 1, where the provider says. */
  progress?: number;
  /** Videos ready to download, once it has completed. */
  outputs?: number;
  /** Videos the provider's safety filter withheld. */
  filtered?: number;
  /** Each video's length in seconds, where the provider says. */
  durationSeconds?: number;
  /** Why it failed. */
  error?: VideoJobError;
  /** What it cost, where the provider reports it. */
  cost?: ResponseCost;
  /** ISO-8601 time it finished. */
  completedAt?: string;
  /** The provider's payload. */
  raw?: unknown;
}

/** A finished video's bytes, as they arrive. */
export interface VideoContent {
  /** The bytes. Read once. */
  stream: AssetByteSource;
  /** Its type, such as `video/mp4`. */
  mimeType: string;
  /** Its size, when the provider says. */
  byteLength?: number;
}

// ── Providers ──────────────────────────────────────────────────────

/** What one model makes: the inputs, lengths, shapes, and sizes it takes. */
export interface VideoModelCapabilities {
  /** What it takes beside a prompt. */
  inputs: readonly VideoInputKind[];
  /** The lengths it makes, in seconds. Any when absent. */
  durations?: readonly number[];
  /** Its length when a request names none. */
  defaultDurationSeconds?: number;
  /** The frame shapes it makes. Any when absent. */
  aspectRatios?: readonly string[];
  /** The frame sizes it makes. Any when absent. */
  resolutions?: readonly string[];
  /** Whether it makes sound. Defaults to `none`. */
  audio?: VideoAudioSupport;
  /** Most reference images it takes. */
  maxReferences?: number;
  /** Most videos one request makes. Defaults to 1. */
  maxCount?: number;
  /** Whether it takes a seed. */
  supportsSeed?: boolean;
  /** Whether it takes a negative prompt. */
  supportsNegativePrompt?: boolean;
  /** The lengths `extend` adds, in seconds. Any when absent. */
  extendDurations?: readonly number[];
  /** What every request to it must give, such as `edit` for a model that only changes videos. */
  requires?: readonly VideoInputKind[];
  /** Whether `video.from` may name a job of its own, which it continues from what it holds. */
  continuesJobs?: boolean;
  /** The longest video it extends or edits, in seconds, read from the video's headers when it is bytes. */
  maxInputVideoSeconds?: number;
  /** Most reference videos it takes. */
  maxReferenceVideos?: number;
  /** How long reference videos may be, in seconds: each, and all together. Read from the bytes' headers. */
  referenceVideoSeconds?: { each?: number; total?: number };
}

/** What a video provider supports: its models, and what each makes. */
export interface VideoProviderCapabilities extends VideoModelCapabilities {
  /** The models it serves. A request naming another is refused. */
  models: readonly string[];
  /** The model a request naming none uses. Defaults to the first. */
  defaultModel?: string;
  /** Where one model differs from the rest. */
  byModel?: Readonly<Record<string, Partial<VideoModelCapabilities>>>;
  /** How it takes an input image: as bytes, by URL, or both. */
  inputLocationKinds: readonly ('bytes' | 'url')[];
  /** The image types it takes. Any image when absent. */
  inputMimeTypes?: readonly string[];
  /** The video types it takes to extend or edit. Any video when absent. */
  inputVideoMimeTypes?: readonly string[];
  /** Whether a running job can be cancelled. */
  supportsCancel?: boolean;
  /** Whether a finished job's video can be deleted from the provider. */
  supportsRemove?: boolean;
  /** How long it keeps a finished video, in hours. Collect before then. */
  retentionHours?: number;
}

/** Identifies a video provider and what it supports. */
export interface VideoProviderInfo {
  /** Its name, which its refs carry. */
  name: string;
  /** What it supports. */
  capabilities: VideoProviderCapabilities;
}

/** What every provider call receives. */
export interface VideoCallContext extends ProviderCallContext {
  /** The attempt, from 1. */
  attempt: number;
}

/**
 * A video backend: a hosted model's job API, or a stand-in. Every call after `submit` takes only the
 * `VideoJobRef`, which survives a restart.
 */
export interface VideoProvider {
  /** What it is and supports. */
  readonly info: VideoProviderInfo;
  /** Starts a job and returns its ref. */
  submit(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef>;
  /** Reads the job's state. */
  poll(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState>;
  /** Reads one finished video, by its position from 0, as a stream. */
  download(ref: VideoJobRef, index: number, context: VideoCallContext): Promise<VideoContent>;
  /** Cancels a running job. */
  cancel?(ref: VideoJobRef, context: VideoCallContext): Promise<void>;
  /** Deletes a finished job's videos from the provider. */
  remove?(ref: VideoJobRef, context: VideoCallContext): Promise<void>;
}

// ── Results ────────────────────────────────────────────────────────

/** A made video: stored, or as bytes, with its length and where it came from. */
export interface VideoAsset extends AssetDescriptor {
  /** Its length in seconds, when known. */
  durationSeconds?: number;
}

/** Something about a video job the caller should know, which did not fail it. */
export interface VideoWarning {
  /** A stable code, such as `provider.remove_failed`. */
  code: string;
  /** What happened. */
  message: string;
}

/** A finished video job. */
export interface VideoResult {
  /** The job. */
  ref: VideoJobRef;
  /** The videos, in the provider's order. */
  videos: VideoAsset[];
  /** Each video's length in seconds, when known. */
  durationSeconds?: number;
  /** Videos the provider's safety filter withheld. */
  filtered?: number;
  /** What it cost: reported by the provider, or priced per second from the registry. */
  cost?: ResponseCost;
  /** The request's id, on its lifecycle operation and its stored videos. */
  requestId: string;
  /** ISO-8601 time it finished. */
  completedAt: string;
  /** What the caller should know. */
  warnings?: VideoWarning[];
  /** The provider's final state payload. */
  raw?: unknown;
}

// ── Errors ─────────────────────────────────────────────────────────

export { VideoError, type VideoErrorCode, VideoJobFailedError } from './errors.js';

// ── Pricing ────────────────────────────────────────────────────────

/** A model's price per second of video: one rate, or one per frame size. */
export interface VideoPrice {
  /** Per second, in `currency`: one rate, or by resolution such as `{ '720p': 0.4, '4k': 0.6 }`. */
  perSecond: number | Readonly<Record<string, number>>;
  /** Per second without sound, on a model where that is cheaper. */
  perSecondSilent?: number | Readonly<Record<string, number>>;
  /** The frame size priced when a request names none. Defaults to `720p`, or the first listed. */
  defaultResolution?: string;
  /** Defaults to `USD`. */
  currency?: string;
}

/**
 * List prices on the Gemini API's paid tier, in dollars per second with sound, as published on
 * 2026-10-20. Gemini Omni Flash is billed by output token, 5,792 a second of 720p video at $17.50 a
 * million, which is the rate here; Google publishes no rate for its other sizes, which stay unpriced.
 * The Veo 3.1 previews shut down on 2026-10-22. An account priced otherwise passes its own as `prices`.
 */
export const VIDEO_PRICES: Readonly<Record<string, VideoPrice>> = {
  'gemini-omni-1.1-flash': { perSecond: { '720p': 0.10136 } },
  'veo-3.1-generate-preview': { perSecond: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 } },
  'veo-3.1-fast-generate-preview': { perSecond: { '720p': 0.1, '1080p': 0.12, '4k': 0.3 } },
  'veo-3.1-lite-generate-preview': { perSecond: { '720p': 0.05, '1080p': 0.08 } },
};

/**
 * Prices `seconds` of video from `model`, or `undefined` when no price is known for it, so an unpriced
 * model is never recorded as free.
 */
export function priceVideo(
  model: string,
  seconds: number,
  options: { resolution?: string; audio?: boolean; prices?: Readonly<Record<string, VideoPrice>> } = {},
): ResponseCost | undefined {
  const price = options.prices?.[model] ?? VIDEO_PRICES[model];
  if (!price || !(seconds >= 0)) return undefined;
  const table =
    options.audio === false && price.perSecondSilent !== undefined ? price.perSecondSilent : price.perSecond;
  let rate: number | undefined;
  if (typeof table === 'number') rate = table;
  else {
    const size = options.resolution ?? price.defaultResolution ?? ('720p' in table ? '720p' : Object.keys(table)[0]);
    rate = size === undefined ? undefined : table[size];
  }
  if (rate === undefined) return undefined;
  const amount = rate * seconds;
  return { amount, currency: price.currency ?? 'USD', basis: 'estimated', output: amount };
}

// ── Manager ────────────────────────────────────────────────────────

/** Configuration for `VideoManager`. */
export interface VideoConfig {
  /** Providers, by name. */
  providers?: Record<string, VideoProvider>;
  /** The provider a request naming none uses. Defaults to the first registered. */
  defaultProvider?: string;
  /** Where finished videos are streamed. Without one, a video comes back as bytes. */
  store?: AssetStore;
  /** The tenant stored videos belong to, when a request names none. Defaults to `default`. */
  tenantId?: string;
  /** How long a stored video is kept, in seconds, when a request names none. Kept until deleted otherwise. */
  ttlSeconds?: number;
  /** Deletes the provider's copy of a video once it is collected, on a provider that can. */
  removeFromProvider?: boolean;
  /** Most bytes a video returned as bytes may hold. Defaults to 512 MiB. */
  maxBytes?: number;
  /** How often to poll a running job. Defaults to 10 seconds. */
  pollIntervalMs?: number;
  /** The longest poll interval, once backoff has grown it. Defaults to 1 minute. */
  maxPollIntervalMs?: number;
  /** How long a generation waits before giving up. Defaults to 1 hour. */
  timeoutMs?: number;
  /** Prices by model, over the bundled ones. */
  prices?: Record<string, VideoPrice>;
}

/** What the manager runs on. */
export interface VideoRuntime {
  /** Persists each generation, so a submitted job survives a restart. Share its store between workers. */
  operations?: OperationRunnerConfig<VideoResult>;
  /**
   * Runs every generation as one operation of a client's lifecycle, family `video`: pass
   * `ai.lifecycle`. It is authorized and budgeted before the provider sees it, and its cost is
   * reconciled when the video is collected.
   */
  lifecycle?: OperationLifecycleLike;
}

/** How `resume()` waits and where it puts the video. */
export interface VideoCollectOptions {
  /** Stops waiting. */
  signal?: AbortSignal;
  /** Overrides the manager's poll interval. */
  pollIntervalMs?: number;
  /** Streamed into the store, or returned as bytes. Defaults to the manager's. */
  delivery?: 'store' | 'bytes';
  /** The tenant a stored video belongs to. */
  tenantId?: string;
  /** How long a stored video is kept, in seconds. */
  ttlSeconds?: number;
}

/** What a generation records with its operation, so another worker can finish it. */
interface VideoJob {
  provider: string;
  request: SerializedRequest;
  requestId: string;
  delivery: 'store' | 'bytes';
  tenantId: string;
  /** The tenant the operation runs for, when the request or the manager names one. */
  tenant?: string;
  ttlSeconds?: number;
  pollIntervalMs?: number;
  idempotencyKey?: string;
}

/** What a generation's heartbeat carries: its job once it exists, and each video once it is stored. */
interface VideoCheckpoint {
  ref?: VideoJobRef;
  stored?: Array<{ index: number; asset: VideoAsset }>;
}

/** What the manager keeps on a ref, so whoever collects the job can price and store it. */
interface RefNotes {
  durationSeconds?: number;
  resolution?: string;
  audio?: boolean;
  count?: number;
  requestId?: string;
  labels?: Record<string, string>;
  /** The tenant the job runs for, whose credentials every later call to its provider uses. */
  tenant?: string;
}

type SerializedInput = Omit<AssetInput, 'location'> & {
  location: AssetLocation | { kind: 'base64'; data: string };
};
type SerializedRequest = Omit<
  VideoProviderRequest,
  'image' | 'lastFrame' | 'references' | 'referenceVideos' | 'video'
> & {
  image?: SerializedInput;
  lastFrame?: SerializedInput;
  references?: SerializedInput[];
  referenceVideos?: SerializedInput[];
  video?: Omit<VideoSource, 'input'> & { input?: SerializedInput };
};

/**
 * Video providers behind one handle. `generate()` submits a job as a durable operation that records
 * the job the moment it exists and each video as it is stored, so a worker that dies is replaced by
 * one that collects that job and stores nothing twice.
 *
 * ```ts
 * const video = new VideoManager(
 *   { providers: { google: new GoogleVideoProvider({ apiKey }) }, store: new S3AssetStore({ ... }) },
 *   { operations: { store: new RedisOperationStore({ client }) }, lifecycle: ai.lifecycle },
 * );
 * const handle = await video.generate({ prompt: 'a lighthouse at dusk', durationSeconds: 8 });
 * const { videos, cost } = await handle.result();
 * ```
 */
export class VideoManager {
  private readonly providers = new Map<string, VideoProvider>();
  /** Loaded on the first `generate()`: `start()` and `resume()` need neither the runner nor the lifecycle. */
  private durable?: Promise<{
    runner: import('../operations/runner.js').OperationRunner<VideoResult>;
    withLifecycle: typeof import('../lifecycle/run.js').withLifecycle;
  }>;

  constructor(
    private readonly config: VideoConfig = {},
    private readonly runtime: VideoRuntime = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers ?? {})) this.registerVideoProvider(name, provider);
  }

  /** Registers a provider under a name. Returns the manager, for chaining. */
  registerVideoProvider(name: string, provider: VideoProvider): this {
    const normalized = name.trim();
    if (!normalized) throw new VideoError('A video provider needs a name', 'VIDEO_INVALID');
    for (const method of ['submit', 'poll', 'download'] as const) {
      if (typeof provider?.[method] !== 'function') {
        throw new VideoError(`Video provider "${normalized}" must implement ${method}()`, 'VIDEO_INVALID');
      }
    }
    if (!Array.isArray(provider.info?.capabilities?.models)) {
      throw new VideoError(`Video provider "${normalized}" must declare its models`, 'VIDEO_INVALID');
    }
    this.providers.set(normalized, provider);
    return this;
  }

  /** Whether a provider is registered. */
  hasVideoProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered provider's name. */
  listVideoProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Makes a video as a durable operation: submits the job, waits, and streams the video into the store.
   * Returns at once with a handle that settles when the video is collected, minutes away: persist
   * `handle.id` rather than block a request on `handle.result()`.
   */
  async generate(request: VideoGenerateRequest): Promise<DurableOperationHandle<VideoResult>> {
    if (!this.config.store) {
      throw new VideoError(
        'A durable generation streams its video into a store, since an operation keeps no bytes: give the manager a store, or start() and resume() a job to have its bytes',
        'VIDEO_INVALID',
      );
    }
    if (request.delivery === 'bytes') {
      throw new VideoError(
        'A durable generation stores its video; start() and resume() a job to have its bytes',
        'VIDEO_INVALID',
      );
    }
    const [providerName, provider] = this.resolveProvider(request.provider);
    const prepared = await this.prepare(request, providerName, provider);
    const job: VideoJob = {
      provider: providerName,
      request: serializeRequest(prepared),
      requestId: generateRequestId(),
      delivery: this.deliveryFor(request.delivery),
      tenantId: request.tenantId ?? this.config.tenantId ?? 'default',
      ...ifDefined('tenant', request.tenantId ?? this.config.tenantId),
      ...ifDefined('ttlSeconds', request.ttlSeconds ?? this.config.ttlSeconds),
      ...ifDefined('pollIntervalMs', request.pollIntervalMs),
      ...ifDefined('idempotencyKey', request.idempotencyKey),
    };
    const { runner } = await this.loadDurable();
    return runner.submit((operation) => this.execute(operation), {
      kind: `video.generate.${providerName}`,
      idempotencyKey: request.idempotencyKey,
      tenantId: job.tenantId,
      signal: request.signal,
      timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      metadata: { video: job },
    });
  }

  /**
   * Takes over generations whose worker stopped heartbeating, typically because its process died, and
   * finishes them here: each job is collected, never submitted again. Run it on a schedule in every
   * worker that shares the operation store.
   */
  async recover(limit = 10): Promise<Array<DurableOperationHandle<VideoResult>>> {
    const { runner } = await this.loadDurable();
    return runner.recover((operation) => this.execute(operation), limit);
  }

  /**
   * Submits a job and returns its ref at once, without waiting or recording an operation: for a caller
   * that keeps the ref itself and collects it later with `resume()`.
   */
  async start(request: VideoGenerateRequest): Promise<VideoJobRef> {
    const [providerName, provider] = this.resolveProvider(request.provider);
    const prepared = await this.prepare(request, providerName, provider);
    const requestId = generateRequestId();
    const tenant = request.tenantId ?? this.config.tenantId;
    return this.continuing('video.submit', providerName, prepared.model, tenant, async (context) => {
      const ref = await provider.submit(prepared, {
        ...context,
        requestId,
        signal: request.signal ?? new AbortController().signal,
        idempotencyKey: request.idempotencyKey,
        attempt: 1,
      });
      return withNotes(ref, notesFor(prepared, provider, requestId, tenant));
    });
  }

  /** Waits for a job, submitted here or by another process, and collects its videos. */
  async resume(ref: VideoJobRef, options: VideoCollectOptions = {}): Promise<VideoResult> {
    const provider = this.providerFor(ref);
    const notes = notesOf(ref);
    const tenant = notes.tenant ?? options.tenantId ?? this.config.tenantId;
    return this.continuing('video.collect', this.nameOf(ref), ref.model, tenant, (context) =>
      this.collect(provider, ref, {
        context: {
          ...context,
          requestId: notes.requestId ?? generateRequestId(),
          signal: options.signal ?? new AbortController().signal,
          attempt: 1,
        },
        delivery: this.deliveryFor(options.delivery),
        tenantId: options.tenantId ?? this.config.tenantId ?? 'default',
        ttlSeconds: options.ttlSeconds ?? this.config.ttlSeconds,
        pollIntervalMs: options.pollIntervalMs,
        stored: [],
      }),
    );
  }

  /** The job's state now, without waiting. */
  status(ref: VideoJobRef): Promise<VideoJobState> {
    return this.continuing('video.status', this.nameOf(ref), ref.model, this.tenantOf(ref), (context) =>
      this.providerFor(ref).poll(ref, { ...freshContext(), ...context }),
    );
  }

  /** One finished video as a stream, to send on without storing it. */
  download(ref: VideoJobRef, index = 0): Promise<VideoContent> {
    return this.continuing('video.download', this.nameOf(ref), ref.model, this.tenantOf(ref), (context) =>
      this.providerFor(ref).download(ref, index, { ...freshContext(), ...context }),
    );
  }

  /** Cancels a running job. Throws when the provider cannot. */
  async cancel(ref: VideoJobRef): Promise<void> {
    const provider = this.providerFor(ref);
    const cancel = provider.cancel;
    if (!cancel) throw new VideoError(`Video provider "${ref.provider}" cannot cancel a job`, 'VIDEO_UNSUPPORTED');
    await this.continuing('video.cancel', this.nameOf(ref), ref.model, this.tenantOf(ref), (context) =>
      cancel.call(provider, ref, { ...freshContext(), ...context }),
    );
  }

  // ── Internals ────────────────────────────────────────────────────

  private loadDurable(): NonNullable<VideoManager['durable']> {
    this.durable ??= Promise.all([import('../operations/runner.js'), import('../lifecycle/run.js')]).then(
      ([{ OperationRunner }, { withLifecycle }]) => {
        const operations = this.runtime.operations ?? {};
        return {
          // Three attempts, so a worker that takes over after a crash has one to run; a job that failed
          // for good is not submitted again, and so not billed again, by a retry.
          runner: new OperationRunner<VideoResult>({
            ...operations,
            retry: { maxAttempts: 3, isRetryable: worthRetrying, ...operations.retry },
          }),
          withLifecycle,
        };
      },
    );
    return this.durable;
  }

  /** One attempt of a generation: the first, or a worker's that took over after another died. */
  private async execute(operation: OperationContext): Promise<VideoResult> {
    const job = operation.metadata?.video as VideoJob | undefined;
    if (!job) throw new VideoError(`Operation ${operation.operationId} is not a video generation`, 'VIDEO_INVALID');
    const provider = this.providers.get(job.provider);
    if (!provider) throw new VideoError(`No video provider is registered as "${job.provider}"`, 'VIDEO_NO_PROVIDER');
    const { withLifecycle } = await this.loadDurable();
    const request = deserializeRequest(job.request);
    return withLifecycle(
      this.runtime.lifecycle,
      {
        family: 'video',
        operation: 'video.generate',
        requestId: job.requestId,
        provider: job.provider,
        model: request.model,
        ...ifDefined('tenantId', job.tenant),
        metadata: { ...ifDefined('durationSeconds', request.durationSeconds), count: request.count ?? 1 },
      },
      { signal: operation.signal, ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}) },
      async (ticket) => {
        const context: VideoCallContext = {
          ...ticket?.context,
          requestId: job.requestId,
          signal: operation.signal,
          idempotencyKey: job.idempotencyKey,
          attempt: operation.attempt,
        };
        const checkpoint = (operation.previousHeartbeat ?? {}) as VideoCheckpoint;
        // A job an earlier attempt submitted is collected, never submitted again: the provider would
        // make, and bill, both. Its ref is recorded the moment it exists.
        let ref = checkpoint.ref;
        if (!ref) {
          ref = withNotes(
            await provider.submit(request, context),
            notesFor(request, provider, job.requestId, job.tenant),
          );
          await operation.heartbeat({ ref, stored: [] } satisfies VideoCheckpoint);
        }
        operation.report({ message: `submitted as ${ref.id}` });
        const submitted = ref;
        try {
          return await this.collect(provider, submitted, {
            context,
            delivery: job.delivery,
            tenantId: job.tenantId,
            ttlSeconds: job.ttlSeconds,
            pollIntervalMs: job.pollIntervalMs,
            stored: checkpoint.stored ?? [],
            onStored: (stored) => operation.heartbeat({ ref: submitted, stored } satisfies VideoCheckpoint),
            report: (state) =>
              operation.report({
                ...(state.progress !== undefined ? { completed: Math.round(state.progress * 100), total: 100 } : {}),
                message: state.status,
              }),
          });
        } catch (error) {
          // A job that failed in a way worth retrying is forgotten, so the next attempt submits anew
          // rather than polling the same failure.
          if (error instanceof VideoJobFailedError && error.retryable) await operation.heartbeat({});
          throw error;
        }
      },
      (result) => (result.cost && result.cost.currency === 'USD' ? { cost: result.cost.amount } : {}),
    );
  }

  private async collect(
    provider: VideoProvider,
    ref: VideoJobRef,
    options: {
      context: VideoCallContext;
      delivery: 'store' | 'bytes';
      tenantId: string;
      ttlSeconds?: number;
      pollIntervalMs?: number;
      stored: Array<{ index: number; asset: VideoAsset }>;
      onStored?: (stored: Array<{ index: number; asset: VideoAsset }>) => Promise<void>;
      report?: (state: VideoJobState) => void;
    },
  ): Promise<VideoResult> {
    const { context } = options;
    const state = await pollUntilSettled(() => provider.poll(ref, context), {
      intervalMs: options.pollIntervalMs ?? this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxIntervalMs: this.config.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      signal: context.signal,
      settled: (current) => FINAL_STATUSES.has(current.status),
      onState: options.report,
    });
    if (state.status !== 'completed') throw new VideoJobFailedError(ref, state);
    const notes = notesOf(ref);
    const outputs = state.outputs ?? notes.count ?? 1;
    if (outputs < 1) {
      throw new VideoJobFailedError(ref, {
        ...state,
        status: 'failed',
        error: { message: 'every video was withheld by the provider', safety: true, retryable: false },
      });
    }

    const durationSeconds = state.durationSeconds ?? notes.durationSeconds;
    const stored = [...options.stored];
    const videos: VideoAsset[] = [];
    for (let index = 0; index < outputs; index += 1) {
      const done = stored.find((entry) => entry.index === index);
      if (done) {
        videos.push(done.asset);
        continue;
      }
      const content = await provider.download(ref, index, context);
      const asset = await this.deliver(content, ref, index, durationSeconds, options);
      videos.push(asset);
      if (asset.location.kind === 'stored') {
        stored.push({ index, asset });
        await options.onStored?.(stored);
      }
    }

    const warnings: VideoWarning[] = [];
    if (this.config.removeFromProvider && provider.remove) {
      try {
        await provider.remove(ref, context);
      } catch (error) {
        warnings.push({
          code: 'provider.remove_failed',
          message: `The provider's copy of job ${ref.id} was not deleted: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const cost =
      state.cost ??
      (durationSeconds === undefined
        ? undefined
        : priceVideo(ref.model, durationSeconds * videos.length, {
            ...ifDefined('resolution', notes.resolution),
            ...ifDefined('audio', notes.audio),
            ...ifDefined('prices', this.config.prices),
          }));
    return {
      ref,
      videos,
      ...ifDefined('durationSeconds', durationSeconds),
      ...(state.filtered ? { filtered: state.filtered } : {}),
      ...ifDefined('cost', cost),
      requestId: context.requestId,
      completedAt: state.completedAt ?? new Date().toISOString(),
      ...(warnings.length ? { warnings } : {}),
      ...ifDefined('raw', state.raw),
    };
  }

  private async deliver(
    content: VideoContent,
    ref: VideoJobRef,
    index: number,
    durationSeconds: number | undefined,
    options: { delivery: 'store' | 'bytes'; tenantId: string; ttlSeconds?: number; context: VideoCallContext },
  ): Promise<VideoAsset> {
    const notes = notesOf(ref);
    const provenance = {
      provider: ref.provider,
      model: ref.model,
      operation: 'generate' as const,
      requestId: options.context.requestId,
      metadata: { kind: 'video', job: ref.id, index, ...notes.labels },
    };
    const mimeType = content.mimeType || 'video/mp4';
    const support = await import('../images/asset-support.js');
    if (options.delivery === 'store') {
      const store = this.config.store as AssetStore;
      const stat = await support.putAssetStream(
        store,
        { stream: content.stream, mimeType, filename: `${fileStem(ref.id)}-${index}.${extensionOf(mimeType)}` },
        {
          tenantId: options.tenantId,
          provenance,
          ...ifDefined('ttlSeconds', options.ttlSeconds),
          maxBufferedBytes: this.config.maxBytes ?? DEFAULT_MAX_BYTES,
        },
      );
      return { ...stat.descriptor, ...ifDefined('durationSeconds', durationSeconds) };
    }
    const limit = this.config.maxBytes ?? DEFAULT_MAX_BYTES;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of support.chunksOf(content.stream)) {
      total += chunk.byteLength;
      if (total > limit) {
        throw new VideoError(
          `Video ${index} of job ${ref.id} is larger than maxBytes (${limit}); give the manager a store to stream it into`,
          'VIDEO_TOO_LARGE',
        );
      }
      chunks.push(chunk);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      location: { kind: 'bytes', data },
      mimeType,
      byteLength: total,
      provenance,
      ...ifDefined('durationSeconds', durationSeconds),
    };
  }

  private deliveryFor(requested: 'store' | 'bytes' | undefined): 'store' | 'bytes' {
    const delivery = requested ?? (this.config.store ? 'store' : 'bytes');
    if (delivery === 'store' && !this.config.store) {
      throw new VideoError('Video delivery "store" needs a store on the manager', 'VIDEO_INVALID');
    }
    return delivery;
  }

  /** Checks a request against the provider's model and resolves stored inputs to bytes. */
  private async prepare(
    request: VideoGenerateRequest,
    providerName: string,
    provider: VideoProvider,
  ): Promise<VideoProviderRequest> {
    if (!request || typeof request !== 'object') throw new VideoError('A video request is required', 'VIDEO_INVALID');
    if (typeof request.prompt !== 'string' || (!request.prompt.trim() && !request.image && !request.video)) {
      throw new VideoError('A video request needs a prompt, an image to animate, or a video', 'VIDEO_INVALID');
    }
    const capabilities = provider.info.capabilities;
    const model = request.model?.trim() || capabilities.defaultModel || capabilities.models[0];
    if (!model) throw new VideoError(`Video provider "${providerName}" names no model`, 'VIDEO_INVALID');
    if (capabilities.models.length && !capabilities.models.includes(model)) {
      throw unsupported(providerName, `the model "${model}"`);
    }
    const caps = capabilitiesOf(capabilities, model);
    const video = request.video;
    if (video !== undefined) this.checkVideo(video, caps, model, providerName, provider);
    const durationSeconds = request.durationSeconds;
    if (durationSeconds !== undefined) {
      if (!(Number.isFinite(durationSeconds) && durationSeconds > 0)) {
        throw new VideoError('durationSeconds must be a positive number', 'VIDEO_INVALID');
      }
      // Extending, the length is what is added, and a model adds what it adds.
      const lengths = video?.mode === 'extend' ? caps.extendDurations : caps.durations;
      if (lengths && !lengths.includes(durationSeconds)) {
        const what =
          video?.mode === 'extend'
            ? `${durationSeconds} seconds added by "${model}"`
            : `${durationSeconds}-second videos from "${model}"`;
        throw unsupported(providerName, what, lengths.join(', '));
      }
    }
    if (request.aspectRatio !== undefined && caps.aspectRatios && !caps.aspectRatios.includes(request.aspectRatio)) {
      throw unsupported(providerName, `the aspect ratio "${request.aspectRatio}"`, caps.aspectRatios.join(', '));
    }
    if (request.resolution !== undefined && caps.resolutions && !caps.resolutions.includes(request.resolution)) {
      throw unsupported(providerName, `the resolution "${request.resolution}"`, caps.resolutions.join(', '));
    }
    const audio = caps.audio ?? 'none';
    if (request.audio === true && audio === 'none') throw unsupported(providerName, `sound from "${model}"`);
    if (request.audio === false && audio === 'always') throw unsupported(providerName, `silent video from "${model}"`);
    if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || !caps.supportsSeed)) {
      throw unsupported(providerName, `a seed for "${model}"`);
    }
    if (request.negativePrompt !== undefined && !caps.supportsNegativePrompt) {
      throw unsupported(providerName, `a negative prompt for "${model}"`);
    }
    const count = request.count ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > (caps.maxCount ?? 1)) {
      throw unsupported(providerName, `${count} videos from one "${model}" request`, `at most ${caps.maxCount ?? 1}`);
    }
    if (request.image && !caps.inputs.includes('image'))
      throw unsupported(providerName, `a first frame for "${model}"`);
    if (request.lastFrame && !caps.inputs.includes('last-frame')) {
      throw unsupported(providerName, `a last frame for "${model}"`);
    }
    const references = request.references ?? [];
    if (references.length && !caps.inputs.includes('references')) {
      throw unsupported(providerName, `reference images for "${model}"`);
    }
    if (caps.maxReferences !== undefined && references.length > caps.maxReferences) {
      throw unsupported(providerName, `${references.length} reference images`, `at most ${caps.maxReferences}`);
    }
    const referenceVideos = request.referenceVideos ?? [];
    if (referenceVideos.length && !caps.inputs.includes('reference-videos')) {
      throw unsupported(providerName, `reference videos for "${model}"`);
    }
    if (caps.maxReferenceVideos !== undefined && referenceVideos.length > caps.maxReferenceVideos) {
      throw unsupported(
        providerName,
        `${referenceVideos.length} reference videos`,
        `at most ${caps.maxReferenceVideos}`,
      );
    }
    const given: Record<VideoInputKind, boolean> = {
      image: request.image !== undefined,
      'last-frame': request.lastFrame !== undefined,
      references: references.length > 0,
      'reference-videos': referenceVideos.length > 0,
      extend: video?.mode === 'extend',
      edit: video?.mode === 'edit',
    };
    const missing = (caps.requires ?? []).filter((kind) => !given[kind]);
    if (missing.length) {
      throw new VideoError(`"${model}" needs ${missing.join(' and ')} in every request`, 'VIDEO_UNSUPPORTED');
    }

    const tenantId = request.tenantId ?? this.config.tenantId ?? 'default';
    const resolve = (input: AssetInput, option: string, kind: 'image' | 'video' = 'image') =>
      this.resolveInput(input, option, providerName, capabilities, tenantId, kind);
    const [image, lastFrame, resolvedReferences, videoInput, resolvedVideos] = await Promise.all([
      request.image ? resolve(request.image, 'image') : undefined,
      request.lastFrame ? resolve(request.lastFrame, 'lastFrame') : undefined,
      Promise.all(references.map((input, index) => resolve(input, `references[${index}]`))),
      video?.input ? resolve(video.input, 'video.input', 'video') : undefined,
      Promise.all(referenceVideos.map((input, index) => resolve(input, `referenceVideos[${index}]`, 'video'))),
    ]);
    // Reference videos given as bytes say their lengths, each and together.
    const limits = caps.referenceVideoSeconds;
    if (limits && resolvedVideos.length) {
      let total = 0;
      for (const [index, input] of resolvedVideos.entries()) {
        const length = input.location.kind === 'bytes' ? readMediaDuration(input.location.data)?.durationMs : undefined;
        if (length === undefined) continue;
        if (limits.each !== undefined && length > limits.each * 1000) {
          throw unsupported(
            providerName,
            `referenceVideos[${index}], ${(length / 1000).toFixed(1)} seconds long, for "${model}"`,
            `at most ${limits.each} seconds each`,
          );
        }
        total += length;
      }
      if (limits.total !== undefined && total > limits.total * 1000) {
        throw unsupported(
          providerName,
          `${(total / 1000).toFixed(1)} seconds of reference videos for "${model}"`,
          `at most ${limits.total} seconds together`,
        );
      }
    }
    // A video given as bytes says its own length; one longer than the model takes goes nowhere.
    if (videoInput?.location.kind === 'bytes' && caps.maxInputVideoSeconds !== undefined) {
      const length = readMediaDuration(videoInput.location.data)?.durationMs;
      if (length !== undefined && length > caps.maxInputVideoSeconds * 1000) {
        throw unsupported(
          providerName,
          `a ${(length / 1000).toFixed(1)}-second video for "${model}"`,
          `at most ${caps.maxInputVideoSeconds} seconds`,
        );
      }
    }
    return {
      prompt: request.prompt,
      model,
      ...ifDefined('image', image),
      ...ifDefined('lastFrame', lastFrame),
      ...(resolvedReferences.length ? { references: resolvedReferences } : {}),
      ...(resolvedVideos.length ? { referenceVideos: resolvedVideos } : {}),
      ...(video
        ? {
            video: videoInput
              ? { mode: video.mode, input: videoInput }
              : { mode: video.mode, from: { ref: video.from?.ref as VideoJobRef, index: video.from?.index ?? 0 } },
          }
        : {}),
      ...ifDefined('durationSeconds', durationSeconds),
      ...ifDefined('aspectRatio', request.aspectRatio),
      ...ifDefined('resolution', request.resolution),
      ...ifDefined('audio', request.audio),
      ...ifDefined('negativePrompt', request.negativePrompt),
      ...ifDefined('seed', request.seed),
      ...(request.count !== undefined ? { count } : {}),
      ...ifDefined('providerOptions', request.providerOptions),
      ...ifDefined('metadata', request.metadata),
    };
  }

  /** Checks a video to work from: a mode the model takes, and one source, an input or a job of this provider's. */
  private checkVideo(
    video: VideoSource,
    caps: VideoModelCapabilities,
    model: string,
    providerName: string,
    provider: VideoProvider,
  ): void {
    if (!video || (video.mode !== 'extend' && video.mode !== 'edit')) {
      throw new VideoError('video.mode must be "extend" or "edit"', 'VIDEO_INVALID');
    }
    if (!caps.inputs.includes(video.mode)) {
      throw unsupported(providerName, `${video.mode === 'extend' ? 'extending' : 'editing'} a video with "${model}"`);
    }
    if ((video.input === undefined) === (video.from === undefined)) {
      throw new VideoError('video needs an input or a job to continue from, and not both', 'VIDEO_INVALID');
    }
    if (video.from) {
      const { ref, index = 0 } = video.from;
      if (!ref || typeof ref.id !== 'string' || !ref.id)
        throw new VideoError('video.from needs a ref', 'VIDEO_INVALID');
      if (!caps.continuesJobs) throw unsupported(providerName, `continuing a job with "${model}"`);
      if (ref.provider !== provider.info.name) {
        throw new VideoError(
          `video.from names a job of "${ref.provider}", and only "${provider.info.name}" can continue its own`,
          'VIDEO_INVALID',
        );
      }
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new VideoError('video.from.index must be a whole number from 0', 'VIDEO_INVALID');
      }
    }
  }

  /** An input as the provider takes it: a stored asset read from the manager's store into bytes. */
  private async resolveInput(
    input: AssetInput,
    option: string,
    providerName: string,
    capabilities: VideoProviderCapabilities,
    tenantId: string,
    kind: 'image' | 'video' = 'image',
  ): Promise<AssetInput> {
    if (!input?.location || typeof input.mimeType !== 'string' || !input.mimeType.trim()) {
      throw new VideoError(`${option} needs a location and a mimeType`, 'VIDEO_INVALID');
    }
    const accepted = kind === 'video' ? capabilities.inputVideoMimeTypes : capabilities.inputMimeTypes;
    const mimeType = input.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (accepted ? !accepted.includes(mimeType) : !mimeType.startsWith(`${kind}/`)) {
      throw unsupported(providerName, `${option} of type ${input.mimeType}`, accepted?.join(', '));
    }
    let resolved = input;
    if (input.location.kind === 'stored') {
      const store = this.config.store;
      const held = store ? await store.get(input.location.assetId, tenantId) : undefined;
      if (!held) throw new VideoError(`${option} names an asset the manager's store does not hold`, 'VIDEO_INVALID');
      resolved = { ...input, location: held.location };
    }
    const location = resolved.location.kind as 'bytes' | 'url';
    if (!capabilities.inputLocationKinds.includes(location)) {
      throw unsupported(providerName, `${option} as ${location}`, capabilities.inputLocationKinds.join(', '));
    }
    if (location === 'bytes' && !(resolved.location.kind === 'bytes' && resolved.location.data.byteLength > 0)) {
      throw new VideoError(`${option} holds no bytes`, 'VIDEO_INVALID');
    }
    return resolved;
  }

  private resolveProvider(preferred?: string): [string, VideoProvider] {
    const selected = preferred?.trim() || this.config.defaultProvider;
    if (selected) {
      const provider = this.providers.get(selected);
      if (!provider) throw new VideoError(`No video provider is registered as "${selected}"`, 'VIDEO_NO_PROVIDER');
      return [selected, provider];
    }
    const first = [...this.providers.entries()][0];
    if (!first) throw new VideoError('No video provider is registered', 'VIDEO_NO_PROVIDER');
    return first;
  }

  /** The provider a ref belongs to: by its registered name, or the adapter's own name the ref carries. */
  /**
   * Runs a call that continues a job outside its operation, `start()` and the calls on a ref, with its
   * tenant's credentials and inside its regions, when the lifecycle gives them, its errors cleaned of
   * every credential.
   */
  private async continuing<T>(
    operation: string,
    provider: string,
    model: string | undefined,
    tenant: string | undefined,
    call: (context: ContinuedFields) => Promise<T>,
  ): Promise<T> {
    return continuing(
      this.runtime.lifecycle,
      { family: 'video', operation, provider, ...ifDefined('model', model), ...ifDefined('tenantId', tenant) },
      call,
    );
  }

  /** The name a ref's provider is registered under: a ref records the adapter's own name. */
  private nameOf(ref: VideoJobRef): string {
    if (this.providers.has(ref.provider)) return ref.provider;
    for (const [name, provider] of this.providers) if (provider.info.name === ref.provider) return name;
    return ref.provider;
  }

  /** The tenant a job runs for: the one its ref records, or the manager's. */
  private tenantOf(ref: VideoJobRef): string | undefined {
    return notesOf(ref).tenant ?? this.config.tenantId;
  }

  private providerFor(ref: VideoJobRef): VideoProvider {
    const provider =
      this.providers.get(ref.provider) ?? [...this.providers.values()].find((item) => item.info.name === ref.provider);
    if (!provider) throw new VideoError(`No video provider is registered as "${ref.provider}"`, 'VIDEO_NO_PROVIDER');
    return provider;
  }
}

/** A model's capabilities: the provider's, with that model's differences laid over them. */
export function capabilitiesOf(capabilities: VideoProviderCapabilities, model: string): VideoModelCapabilities {
  return { ...capabilities, ...capabilities.byModel?.[model] };
}

function unsupported(provider: string, what: string, accepted?: string): VideoError {
  return new VideoError(
    `Video provider "${provider}" does not take ${what}${accepted ? `; it takes ${accepted}` : ''}`,
    'VIDEO_UNSUPPORTED',
  );
}

/** Retries anything but a cancellation, and a failure the provider says will happen again. */
function worthRetrying(error: unknown): boolean {
  if (error instanceof VideoError) return error.retryable;
  return !(error instanceof Error && /Cancel/.test(error.name));
}

function freshContext(): VideoCallContext {
  return { requestId: generateRequestId(), signal: new AbortController().signal, attempt: 1 };
}

function notesFor(
  request: VideoProviderRequest,
  provider: VideoProvider,
  requestId: string,
  tenant: string | undefined,
): RefNotes {
  const caps = capabilitiesOf(provider.info.capabilities, request.model);
  return {
    ...ifDefined('durationSeconds', request.durationSeconds ?? caps.defaultDurationSeconds),
    ...ifDefined('resolution', request.resolution),
    ...ifDefined('audio', request.audio ?? (caps.audio === 'always' ? true : undefined)),
    count: request.count ?? 1,
    requestId,
    ...ifDefined('labels', request.metadata),
    ...ifDefined('tenant', tenant),
  };
}

function withNotes(ref: VideoJobRef, notes: RefNotes): VideoJobRef {
  return { ...ref, metadata: { ...ref.metadata, video: notes } };
}

function notesOf(ref: VideoJobRef): RefNotes {
  return (ref.metadata?.video ?? {}) as RefNotes;
}

function serializeInput(input: AssetInput): SerializedInput {
  return input.location.kind === 'bytes'
    ? { ...input, location: { kind: 'base64', data: encodeBase64(input.location.data) } }
    : (input as SerializedInput);
}

function deserializeInput(input: SerializedInput): AssetInput {
  return input.location.kind === 'base64'
    ? { ...input, location: { kind: 'bytes', data: decodeBase64(input.location.data) } }
    : (input as AssetInput);
}

/** A request as JSON, its image bytes as base64, so it can wait in an operation store for any worker. */
function serializeRequest(request: VideoProviderRequest): SerializedRequest {
  const { image, lastFrame, references, referenceVideos, video, ...rest } = request;
  return {
    ...rest,
    ...(image ? { image: serializeInput(image) } : {}),
    ...(lastFrame ? { lastFrame: serializeInput(lastFrame) } : {}),
    ...(references ? { references: references.map(serializeInput) } : {}),
    ...(referenceVideos ? { referenceVideos: referenceVideos.map(serializeInput) } : {}),
    ...(video ? { video: { ...video, ...(video.input ? { input: serializeInput(video.input) } : {}) } } : {}),
  };
}

function deserializeRequest(request: SerializedRequest): VideoProviderRequest {
  const { image, lastFrame, references, referenceVideos, video, ...rest } = request;
  return {
    ...rest,
    ...(image ? { image: deserializeInput(image) } : {}),
    ...(lastFrame ? { lastFrame: deserializeInput(lastFrame) } : {}),
    ...(references ? { references: references.map(deserializeInput) } : {}),
    ...(referenceVideos ? { referenceVideos: referenceVideos.map(deserializeInput) } : {}),
    ...(video
      ? { video: { ...video, ...(video.input ? { input: deserializeInput(video.input) } : {}) } as VideoSource }
      : {}),
  };
}

function fileStem(id: string): string {
  return (
    id
      .split('/')
      .pop()
      ?.replace(/[^\w.-]+/g, '_') || 'video'
  );
}

function extensionOf(mimeType: string): string {
  const subtype = mimeType.split(';', 1)[0]?.split('/')[1]?.trim().toLowerCase();
  return subtype === 'quicktime' ? 'mov' : subtype || 'mp4';
}

function ifDefined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

// ── Conformance ────────────────────────────────────────────────────

/** What `runVideoConformance()` asks a provider for. */
export interface VideoConformanceOptions {
  /** Overrides the request it submits. Defaults to a short prompt at the model's shortest length. */
  request?: Partial<VideoProviderRequest>;
  /** An image, to check image-to-video on a provider that takes one. */
  image?: AssetInput;
  /**
   * A video of the provider's limits, to check extending or editing it on a model that takes that. A
   * model that continues its own jobs is also asked to extend the first job it made.
   */
  video?: { mode: 'extend' | 'edit'; input: AssetInput };
  /** A short video of the provider's limits, to check making a video from reference videos where a model takes them. */
  referenceVideo?: AssetInput;
  /** Submits and cancels a second job, on a provider that can cancel. Off by default: it costs a job. */
  checkCancel?: boolean;
  /** How often to poll. Defaults to 5 seconds. */
  pollIntervalMs?: number;
  /** Gives up after this long. Defaults to 10 minutes. */
  timeoutMs?: number;
}

/** How a provider did against the video contract. */
export interface VideoConformanceReport {
  /** The provider. */
  provider: string;
  /** Checks that passed. */
  passed: string[];
  /** Checks that failed, each with why. */
  failures: string[];
}

/**
 * Checks a provider against the video contract: its capabilities are coherent, its ref survives JSON
 * as it would a restart, a job settles and is read back through a ref parsed afresh, and the video
 * streams as non-empty bytes of a video type. Never throws; failures are listed.
 */
export async function runVideoConformance(
  provider: VideoProvider,
  options: VideoConformanceOptions = {},
): Promise<VideoConformanceReport> {
  const report: VideoConformanceReport = { provider: provider.info?.name ?? '(unnamed)', passed: [], failures: [] };
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  const context = (): VideoCallContext => ({
    requestId: generateRequestId(),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    attempt: 1,
  });
  const check = async (name: string, body: () => Promise<void>): Promise<boolean> => {
    try {
      await body();
      report.passed.push(name);
      return true;
    } catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  const settle = (ref: VideoJobRef) =>
    pollUntilSettled(() => provider.poll(ref, context()), {
      intervalMs: options.pollIntervalMs ?? 5_000,
      maxIntervalMs: Math.max(options.pollIntervalMs ?? 5_000, 30_000),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      settled: (state) => {
        if (!STATUSES.has(state.status)) throw new Error(`unknown status "${state.status}"`);
        if (state.progress !== undefined && !(state.progress >= 0 && state.progress <= 1)) {
          throw new Error(`progress ${state.progress} is outside 0 to 1`);
        }
        return FINAL_STATUSES.has(state.status);
      },
    });

  const capabilities = provider.info?.capabilities;
  const coherent = await check('capabilities', async () => {
    if (!provider.info?.name?.trim()) throw new Error('the provider has no name');
    if (!capabilities?.models?.length) throw new Error('no models are declared');
    if (capabilities.defaultModel && !capabilities.models.includes(capabilities.defaultModel)) {
      throw new Error(`the default model "${capabilities.defaultModel}" is not among its models`);
    }
    if (!capabilities.inputLocationKinds?.length) throw new Error('no input location kinds are declared');
    for (const model of capabilities.models) {
      const caps = capabilitiesOf(capabilities, model);
      if (caps.durations?.some((value) => !(value > 0)))
        throw new Error(`"${model}" declares a duration that is not positive`);
      if (
        caps.defaultDurationSeconds !== undefined &&
        caps.durations &&
        !caps.durations.includes(caps.defaultDurationSeconds)
      ) {
        throw new Error(`"${model}" defaults to a duration it does not make`);
      }
      const unknown = (caps.requires ?? []).filter((kind) => !caps.inputs.includes(kind));
      if (unknown.length) throw new Error(`"${model}" requires ${unknown.join(', ')}, which it does not take`);
      if (caps.continuesJobs && !caps.inputs.some((kind) => kind === 'extend' || kind === 'edit')) {
        throw new Error(`"${model}" continues jobs, but takes no video to extend or edit`);
      }
    }
    if (capabilities.supportsCancel && typeof provider.cancel !== 'function')
      throw new Error('cancel is declared, but not implemented');
    if (capabilities.supportsRemove && typeof provider.remove !== 'function')
      throw new Error('remove is declared, but not implemented');
  });
  if (!coherent) return report;

  const model = options.request?.model ?? capabilities.defaultModel ?? (capabilities.models[0] as string);
  const caps = capabilitiesOf(capabilities, model);
  const request: VideoProviderRequest = {
    prompt: 'A paper boat drifting slowly across a still pond, seen from above.',
    model,
    ...(caps.durations?.length ? { durationSeconds: Math.min(...caps.durations) } : {}),
    ...options.request,
  };

  let ref: VideoJobRef | undefined;
  const submitted = await check('submit', async () => {
    ref = await provider.submit(request, context());
    if (!ref?.id || typeof ref.id !== 'string') throw new Error('the ref has no id');
    if (ref.provider !== provider.info.name)
      throw new Error(`the ref names "${ref.provider}", not "${provider.info.name}"`);
    if (ref.model !== model) throw new Error(`the ref names the model "${ref.model}", not "${model}"`);
    if (Number.isNaN(Date.parse(ref.createdAt))) throw new Error('the ref has no ISO-8601 createdAt');
    const copy = JSON.parse(JSON.stringify(ref)) as VideoJobRef;
    if (JSON.stringify(copy) !== JSON.stringify(ref)) throw new Error('the ref does not survive JSON');
  });
  if (!submitted || !ref) return report;

  // Read back through a ref parsed afresh, as a worker in another process would hold it.
  const parsed = JSON.parse(JSON.stringify(ref)) as VideoJobRef;
  let finished: VideoJobState | undefined;
  const settled = await check('settles', async () => {
    finished = await settle(parsed);
    if (finished.status !== 'completed') {
      throw new Error(`the job ended ${finished.status}${finished.error ? `: ${finished.error.message}` : ''}`);
    }
    if (finished.outputs !== undefined && finished.outputs < 1) throw new Error('it completed with no video');
  });
  if (settled) {
    await check('download', async () => {
      const content = await provider.download(parsed, 0, context());
      if (!content?.mimeType?.startsWith('video/'))
        throw new Error(`the type "${content?.mimeType}" is not a video type`);
      const { chunksOf } = await import('../images/asset-support.js');
      let total = 0;
      let head = new Uint8Array(0);
      for await (const chunk of chunksOf(content.stream)) {
        if (head.byteLength < 12) {
          const merged = new Uint8Array(head.byteLength + chunk.byteLength);
          merged.set(head);
          merged.set(chunk, head.byteLength);
          head = merged.subarray(0, 12);
        }
        total += chunk.byteLength;
      }
      if (total === 0) throw new Error('the video is empty');
      if (content.byteLength !== undefined && content.byteLength !== total) {
        throw new Error(`it declared ${content.byteLength} bytes and streamed ${total}`);
      }
      const box = String.fromCharCode(...head.subarray(4, 8));
      if (content.mimeType.startsWith('video/mp4') && box !== 'ftyp')
        throw new Error('the MP4 does not begin with an ftyp box');
    });
  }

  if (options.image && caps.inputs.includes('image')) {
    const image = options.image;
    await check('image to video', async () => {
      const state = await settle(await provider.submit({ ...request, image }, context()));
      if (state.status !== 'completed') throw new Error(`the job ended ${state.status}`);
    });
  }
  const source = options.video;
  if (source && caps.inputs.includes(source.mode)) {
    await check(`${source.mode} a video`, async () => {
      const state = await settle(
        await provider.submit({ ...request, video: { mode: source.mode, input: source.input } }, context()),
      );
      if (state.status !== 'completed') throw new Error(`the job ended ${state.status}`);
    });
    if (settled && caps.continuesJobs && caps.inputs.includes('extend')) {
      await check('extend its own job', async () => {
        const state = await settle(
          await provider.submit({ ...request, video: { mode: 'extend', from: { ref: parsed, index: 0 } } }, context()),
        );
        if (state.status !== 'completed') throw new Error(`the job ended ${state.status}`);
      });
    }
  }
  if (options.referenceVideo && caps.inputs.includes('reference-videos')) {
    const referenceVideos = [options.referenceVideo];
    await check('reference videos', async () => {
      const state = await settle(await provider.submit({ ...request, referenceVideos }, context()));
      if (state.status !== 'completed') throw new Error(`the job ended ${state.status}`);
    });
  }
  if (options.checkCancel && capabilities.supportsCancel && provider.cancel) {
    const cancel = provider.cancel.bind(provider);
    await check('cancel', async () => {
      const second = await provider.submit(request, context());
      await cancel(second, context());
      const state = await settle(second);
      if (state.status === 'completed') throw new Error('a cancelled job completed');
    });
  }
  return report;
}
