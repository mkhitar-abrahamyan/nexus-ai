/**
 * Video failures, on their own so a provider can raise them without loading the manager.
 */
import type { VideoJobRef, VideoJobState } from './index.js';

/** Stable codes for video failures. */
export type VideoErrorCode =
  | 'VIDEO_INVALID'
  | 'VIDEO_UNSUPPORTED'
  | 'VIDEO_NO_PROVIDER'
  | 'VIDEO_PROVIDER'
  | 'VIDEO_JOB_FAILED'
  | 'VIDEO_TOO_LARGE';

/** Raised for a request no provider can serve, a provider that fails, or a job that does not finish. */
export class VideoError extends Error {
  constructor(
    message: string,
    /** What kind of failure. */
    readonly code: VideoErrorCode,
    options: {
      /** Whether trying again may succeed. */
      retryable?: boolean;
      /** The HTTP status, for a provider failure. */
      status?: number;
      /** What caused it. */
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VideoError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }

  /** Whether trying again may succeed. */
  readonly retryable: boolean;
  /** The HTTP status, for a provider failure. */
  readonly status?: number;
}

/** Raised when a job ends without a video: failed, cancelled, expired, or every video withheld. */
export class VideoJobFailedError extends VideoError {
  constructor(
    /** The job. */
    readonly ref: VideoJobRef,
    /** Its final state. */
    readonly state: VideoJobState,
  ) {
    super(
      `Video job ${ref.id} ended ${state.status}${state.error ? `: ${state.error.message}` : ''}`,
      'VIDEO_JOB_FAILED',
      { retryable: state.status === 'failed' && state.error?.retryable === true },
    );
    this.name = 'VideoJobFailedError';
  }
}
