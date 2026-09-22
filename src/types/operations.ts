/**
 * The operation lifecycle shared by every long-running family.
 *
 * These types were introduced for images and are now family-neutral, so images, embeddings, batch
 * jobs, and anything added later report progress and failure the same way. `types/images.ts`
 * re-exports them, so existing image imports keep working unchanged.
 */

export type OperationStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'expired';

/** Statuses from which an operation can never move again. */
export const TERMINAL_OPERATION_STATUSES: readonly OperationStatus[] = ['succeeded', 'failed', 'cancelled', 'expired'];

/** Whether an operation has reached a status it can never leave. */
export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

/** Fields every operation event carries. */
export interface OperationEventBase {
  /** The operation the event belongs to. */
  operationId: string;
  /**
   * The record's sequence when the event was emitted, so events can be ordered and deduplicated.
   */
  sequence: number;
  /** ISO-8601 time of the event. */
  timestamp: string;
}

/** A failure, in a form that survives serialization into a store or a webhook. */
export interface OperationErrorDescriptor {
  /** The error's class name. */
  name: string;
  /** What went wrong. */
  message: string;
  /** A stable code, when the error carried one. */
  code?: string;
  /** True when the runner considered this failure worth another attempt. */
  retryable?: boolean;
}

/**
 * How far along a running operation is.
 *
 * Every field is optional because most providers report nothing useful. A consumer should render
 * whatever is present rather than assume a percentage exists.
 */
export interface OperationProgress {
  /** Fraction between 0 and 1, when the executor can compute one. */
  ratio?: number;
  /** Units done, when the executor counts them. */
  completed?: number;
  /** Units in total, when known. */
  total?: number;
  /** What the operation is doing now, for display. */
  message?: string;
  /** Executor-specific details. */
  metadata?: Record<string, unknown>;
}

/** Everything an operation reports, as a discriminated union on `type`. */
export type OperationEvent<TResult> =
  | (OperationEventBase & { type: 'queued'; status: 'queued' })
  | (OperationEventBase & { type: 'running'; status: 'running'; attempt: number })
  | (OperationEventBase & { type: 'progress'; status: 'running'; progress: OperationProgress })
  | (OperationEventBase & {
      type: 'retrying';
      status: 'retrying';
      attempt: number;
      delayMs: number;
      error: OperationErrorDescriptor;
    })
  | (OperationEventBase & { type: 'cancelling'; status: 'cancelling'; reason?: string })
  | (OperationEventBase & { type: 'succeeded'; status: 'succeeded'; result: TResult })
  | (OperationEventBase & {
      type: 'failed';
      status: 'failed';
      error: OperationErrorDescriptor;
      /** True when every attempt was used and the record was moved to the dead-letter state. */
      deadLettered?: boolean;
    })
  | (OperationEventBase & { type: 'cancelled'; status: 'cancelled'; reason?: string })
  | (OperationEventBase & { type: 'expired'; status: 'expired'; error?: OperationErrorDescriptor });

/** The name of an operation event, such as `succeeded`. */
export type OperationEventType = OperationEvent<unknown>['type'];

/** A running or finished operation. */
export interface OperationHandle<TResult> {
  /** The operation's id. */
  readonly id: string;
  /** Its current status. */
  status(): OperationStatus;
  /** Resolves with the result, or rejects with the failure, cancellation, or expiry. */
  result(): Promise<TResult>;
  /** Asks the operation to stop. Returns false when it had already finished. */
  cancel(reason?: string): boolean;
  /** Every event from now on, ending when the operation settles. */
  events(): AsyncIterable<OperationEvent<TResult>>;
}

/**
 * A durable handle, which can also report what a store knows about the operation.
 *
 * Returned by the durable runner. `OperationHandle` stays the narrower contract so existing
 * process-local callers are unaffected.
 */
export interface DurableOperationHandle<TResult> extends OperationHandle<TResult> {
  /** Latest persisted snapshot, or `undefined` when the record has been evicted. */
  record(): Promise<OperationRecord<TResult> | undefined>;
  /** The latest progress reported, if any. */
  progress(): OperationProgress | undefined;
}

/** Exclusive claim a worker holds while it executes an operation. */
export interface OperationLease {
  /** Identifier of the worker holding the claim. */
  owner: string;
  /** ISO timestamp after which another worker may take over. */
  expiresAt: string;
  /** ISO timestamp of the most recent heartbeat. */
  heartbeatAt?: string;
}

/**
 * The persistable state of one operation.
 *
 * `sequence` doubles as an optimistic-concurrency token: a store update must state the sequence it
 * expected, so two workers racing on the same record cannot both win.
 */
export interface OperationRecord<TResult = unknown> {
  /** The operation's id. */
  id: string;
  /** Its current status. */
  status: OperationStatus;
  /** Attempt currently running or last run, starting at 1. */
  attempt: number;
  /** Attempts allowed before the operation fails for good. */
  maxAttempts: number;
  /** Bumped on every write. A store update must name the sequence it expected. */
  sequence: number;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 time of the last write. */
  updatedAt: string;
  /** ISO-8601 time the first attempt started. */
  startedAt?: string;
  /** ISO-8601 time the operation settled. */
  completedAt?: string;
  /** After this time the operation is expired by recovery rather than run again. */
  expiresAt?: string;
  /** The worker currently holding the operation, and until when. */
  lease?: OperationLease;
  /** The latest progress reported. */
  progress?: OperationProgress;
  /** The result, once it succeeded. Must be serializable; bytes belong in an asset store. */
  result?: TResult;
  /** The failure, once it failed. */
  error?: OperationErrorDescriptor;
  /** True when every attempt failed and the record was parked for inspection. */
  deadLettered?: boolean;
  /** Replays an accepted operation instead of starting a second one. */
  idempotencyKey?: string;
  /** Family and operation, such as `image.generate`, for filtering and metrics. */
  kind?: string;
  /** Trace propagation headers, carried to the worker that runs it. */
  traceContext?: Record<string, string>;
  /** Application data. Must be serializable. */
  metadata?: Record<string, unknown>;
}

/**
 * Durable storage for operation records.
 *
 * `update` is a compare-and-set on `sequence` and returns `false` when another worker already
 * moved the record, which is how lease stealing is prevented without a distributed lock.
 */
export interface OperationStore<TResult = unknown> {
  /** Stores a new record. */
  create(record: OperationRecord<TResult>): Promise<void> | void;
  /** Reads a record, or `undefined` when there is none. */
  read(id: string): Promise<OperationRecord<TResult> | undefined> | OperationRecord<TResult> | undefined;
  /**
   * Writes a record only if its stored sequence is still `expectedSequence`. Returns false when
   * another worker moved it first.
   */
  update(record: OperationRecord<TResult>, expectedSequence: number): Promise<boolean> | boolean;
  /** Deletes a record. Returns false when there was none. */
  delete?(id: string): Promise<boolean> | boolean;
  /** Non-terminal records whose lease has lapsed, for a recovery sweep. */
  claimExpired?(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> | Array<OperationRecord<TResult>>;
  /** Finds the operation accepted under an idempotency key. */
  findByIdempotencyKey?(
    key: string,
  ): Promise<OperationRecord<TResult> | undefined> | OperationRecord<TResult> | undefined;
  /** Every record, for inspection and tests. */
  list?(): Promise<Array<OperationRecord<TResult>>> | Array<OperationRecord<TResult>>;
}

/**
 * Hands an accepted operation to a worker process.
 *
 * Separate from `OperationStore` because state and dispatch are different concerns: a deployment
 * can persist to Redis and dispatch through BullMQ, or persist and dispatch in one place.
 */
export interface OperationDispatcher {
  /** Hands the record to a worker. */
  dispatch(record: OperationRecord<unknown>): Promise<void> | void;
}

/** Sends signed operation events to a URL. */
export interface OperationWebhookConfig {
  /** Where events are posted. */
  url: string;
  /** Shared secret used for the HMAC-SHA256 signature. */
  secret: string;
  /** Defaults to terminal events only, which is what most receivers want. */
  events?: readonly OperationEventType[];
  /** Headers added to every delivery. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`, for proxying or tests. */
  fetch?: typeof fetch;
  /** Delivery timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
}

/** How an operation's failed attempts are retried. */
export interface OperationRetryConfig {
  /** Attempts in total, the first included. */
  maxAttempts?: number;
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs?: number;
  /** Longest delay between attempts, in milliseconds. */
  maxDelayMs?: number;
  /** Whether the delay doubles after each attempt or stays fixed. */
  backoff?: 'fixed' | 'exponential';
  /** Adds up to this fraction of the delay as random jitter, so retries do not synchronize. */
  jitter?: number;
  /** Decides whether a failure is worth another attempt. Defaults to retrying anything but a cancellation. */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Configuration for `OperationRunner`: where records live, how work is dispatched, and how failures
 * are retried.
 */
export interface OperationRunnerConfig<TResult = unknown> {
  /** Where records are persisted. Defaults to an in-process store. */
  store?: OperationStore<TResult>;
  /** Hands accepted operations to workers, such as a BullMQ queue. */
  dispatcher?: OperationDispatcher;
  /** Identifies this worker in leases. Defaults to a generated id. */
  owner?: string;
  /** How long a lease stays valid without a heartbeat. Defaults to 30 seconds. */
  leaseMs?: number;
  /** Heartbeat interval. Defaults to a third of `leaseMs`. */
  heartbeatMs?: number;
  /** Wall-clock budget for the whole operation, retries included. */
  timeoutMs?: number;
  /** Retry policy for failed attempts. */
  retry?: OperationRetryConfig;
  /** Sends signed events to a URL. */
  webhook?: OperationWebhookConfig;
  /** Reports a webhook delivery failure. Delivery never fails the operation itself. */
  onWebhookError?: (error: unknown, event: OperationEvent<TResult>) => void;
  /** Creates operation ids. Defaults to random ids. */
  createOperationId?: () => string;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Options for one submitted operation. */
export interface OperationSubmitOptions {
  /** The operation's id. Generated when omitted. */
  id?: string;
  /** Family and operation, such as `image.generate`. */
  kind?: string;
  /** Replays the operation already accepted under this key instead of starting another. */
  idempotencyKey?: string;
  /** Overrides the runner's attempt budget for this operation. */
  maxAttempts?: number;
  /** Wall-clock budget for this operation, overriding the runner's. */
  timeoutMs?: number;
  /** ISO-8601 time after which recovery expires the operation instead of running it again. */
  expiresAt?: string;
  /** Trace propagation headers carried to the worker. */
  traceContext?: Record<string, string>;
  /** Application data. Must be serializable. */
  metadata?: Record<string, unknown>;
  /** Cancels the operation when aborted. */
  signal?: AbortSignal;
}

/** What an executor receives. */
export interface OperationContext {
  /** The operation's id. */
  operationId: string;
  /** This attempt's number, starting at 1. */
  attempt: number;
  /** Aborted when the operation is cancelled, times out, or loses its lease. */
  signal: AbortSignal;
  /** Publishes a progress event and persists it. */
  report(progress: OperationProgress): void;
  /** Extends the lease immediately, for a step known to exceed the heartbeat interval. */
  heartbeat(): Promise<void>;
  /** Trace propagation headers from submission. */
  traceContext?: Record<string, string>;
  /** Application data from submission. */
  metadata?: Record<string, unknown>;
}

/**
 * The work an operation performs. Receives a context for progress, heartbeats, and cancellation,
 * and returns the result.
 */
export type OperationExecutor<TResult> = (context: OperationContext) => Promise<TResult>;
