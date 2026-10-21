/**
 * A video provider for tests: jobs that finish after a set number of polls, and videos made of
 * bytes on the fly, as large as asked, streamed a chunk at a time.
 */
import type {
  VideoCallContext,
  VideoContent,
  VideoJobError,
  VideoJobRef,
  VideoJobState,
  VideoProvider,
  VideoProviderCapabilities,
  VideoProviderInfo,
  VideoProviderRequest,
} from './index.js';
import { VideoError } from './errors.js';

/** One job the mock holds. */
export interface MockVideoJob {
  /** What was asked. */
  request: VideoProviderRequest;
  /** Polls it has answered. */
  polls: number;
  /** Set once it is cancelled. */
  cancelled?: boolean;
  /** Set once its videos are deleted. */
  removed?: boolean;
}

/** Options for `MockVideoProvider`. */
export interface MockVideoProviderOptions {
  /** Its name. Defaults to `mock`. */
  name?: string;
  /** Its models. Defaults to `mock-video`. */
  models?: readonly string[];
  /** Overrides what it declares it supports. */
  capabilities?: Partial<VideoProviderCapabilities>;
  /** Polls a job answers `running` before it completes. Defaults to 1. */
  pollsToComplete?: number;
  /** Fails each job with this error, or with what the function returns for its request. */
  fail?: VideoJobError | ((request: VideoProviderRequest) => VideoJobError | undefined);
  /** Each video's size in bytes. Defaults to 64 KiB. */
  bytes?: number;
  /** The size of each streamed chunk. Defaults to 64 KiB. */
  chunkBytes?: number;
  /** Jobs shared between instances, as two processes share one provider. Defaults to the instance's own. */
  jobs?: Map<string, MockVideoJob>;
}

/**
 * A stand-in video backend. Its videos begin with an MP4 `ftyp` box and then hold a repeating
 * pattern, so they pass the conformance suite's checks without being playable. Pass one `jobs` map
 * to two instances to stand for two processes in front of one provider.
 */
export class MockVideoProvider implements VideoProvider {
  /** Provider name, capabilities, and models. */
  readonly info: VideoProviderInfo;
  /** Every job, by id. */
  readonly jobs: Map<string, MockVideoJob>;
  /** Videos this instance has streamed. */
  downloads = 0;

  private nextId = 0;

  constructor(private readonly options: MockVideoProviderOptions = {}) {
    this.jobs = options.jobs ?? new Map();
    this.info = {
      name: options.name ?? 'mock',
      capabilities: {
        inputs: ['image', 'last-frame', 'references', 'extend', 'edit'],
        durations: [4, 8],
        extendDurations: [4],
        continuesJobs: true,
        defaultDurationSeconds: 4,
        aspectRatios: ['16:9', '9:16'],
        resolutions: ['720p', '1080p'],
        audio: 'optional',
        maxReferences: 3,
        maxCount: 2,
        supportsSeed: true,
        supportsNegativePrompt: true,
        models: options.models ?? ['mock-video'],
        inputLocationKinds: ['bytes', 'url'],
        supportsCancel: true,
        supportsRemove: true,
        ...options.capabilities,
      },
    };
  }

  /** Starts a job. */
  async submit(request: VideoProviderRequest, context: VideoCallContext): Promise<VideoJobRef> {
    context.signal.throwIfAborted();
    // A job continued from another is continued from what this provider made, as a real one would.
    const from = request.video?.from;
    if (from) {
      const earlier = this.job(from.ref);
      if (earlier.removed || (from.index ?? 0) >= (earlier.request.count ?? 1)) {
        throw new VideoError(`Mock job ${from.ref.id} has no video ${from.index ?? 0} to continue`, 'VIDEO_INVALID');
      }
    }
    const id = `mock-video-${this.jobs.size + 1}-${++this.nextId}`;
    this.jobs.set(id, { request: structuredClone(request), polls: 0 });
    return { provider: this.info.name, id, model: request.model, createdAt: new Date().toISOString() };
  }

  /** Reads a job: running for `pollsToComplete` polls, then completed, or failed as `fail` says. */
  async poll(ref: VideoJobRef, context: VideoCallContext): Promise<VideoJobState> {
    context.signal.throwIfAborted();
    const job = this.job(ref);
    job.polls += 1;
    if (job.cancelled) return { status: 'cancelled' };
    if (job.polls <= (this.options.pollsToComplete ?? 1)) {
      return { status: 'running', progress: job.polls / ((this.options.pollsToComplete ?? 1) + 1) };
    }
    const fail = typeof this.options.fail === 'function' ? this.options.fail(job.request) : this.options.fail;
    if (fail) return { status: 'failed', error: fail };
    return {
      status: 'completed',
      outputs: job.request.count ?? 1,
      ...(job.request.durationSeconds !== undefined ? { durationSeconds: job.request.durationSeconds } : {}),
      completedAt: new Date().toISOString(),
    };
  }

  /** Streams one video of `bytes` bytes, made a chunk at a time. */
  async download(ref: VideoJobRef, index: number, context: VideoCallContext): Promise<VideoContent> {
    context.signal.throwIfAborted();
    const job = this.job(ref);
    if (job.removed || index >= (job.request.count ?? 1)) {
      throw new VideoError(`Mock job ${ref.id} has no video ${index}`, 'VIDEO_INVALID');
    }
    this.downloads += 1;
    const size = this.options.bytes ?? 64 * 1024;
    const chunk = this.options.chunkBytes ?? 64 * 1024;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        const bytes = new Uint8Array(Math.min(chunk, size - sent));
        for (let offset = 0; offset < bytes.length; offset += 1) bytes[offset] = (sent + offset + index) % 251;
        if (sent === 0) bytes.set(MP4_HEADER.subarray(0, Math.min(MP4_HEADER.length, bytes.length)));
        sent += bytes.length;
        controller.enqueue(bytes);
      },
    });
    return { stream, mimeType: 'video/mp4', byteLength: size };
  }

  /** Cancels a job. */
  async cancel(ref: VideoJobRef): Promise<void> {
    this.job(ref).cancelled = true;
  }

  /** Deletes a job's videos. */
  async remove(ref: VideoJobRef): Promise<void> {
    this.job(ref).removed = true;
  }

  private job(ref: VideoJobRef): MockVideoJob {
    const job = this.jobs.get(ref.id);
    if (!job) throw new VideoError(`Mock video job ${ref.id} does not exist`, 'VIDEO_INVALID');
    return job;
  }
}

/** An `ftyp` box naming the `isom` brand: how an MP4 file begins. */
const MP4_HEADER = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
