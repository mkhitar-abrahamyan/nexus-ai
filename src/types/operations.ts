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

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

export interface OperationEventBase {
  operationId: string;
  sequence: number;
  timestamp: string;
}

export interface OperationErrorDescriptor {
  name: string;
  message: string;
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
  completed?: number;
  total?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

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

export type OperationEventType = OperationEvent<unknown>['type'];

export interface OperationHandle<TResult> {
  readonly id: string;
  status(): OperationStatus;
  result(): Promise<TResult>;
  cancel(reason?: string): boolean;
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
  id: string;
  status: OperationStatus;
  /** Attempt currently running or last run, starting at 1. */
  attempt: number;
  maxAttempts: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** After this time the operation is expired by recovery rather than run again. */
  expiresAt?: string;
  lease?: OperationLease;
  progress?: OperationProgress;
  result?: TResult;
  error?: OperationErrorDescriptor;
  /** True when every attempt failed and the record was parked for inspection. */
  deadLettered?: boolean;
  /** Replays an accepted operation instead of starting a second one. */
  idempotencyKey?: string;
  /** Family and operation, such as `image.generate`, for filtering and metrics. */
  kind?: string;
  traceContext?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Durable storage for operation records.
 *
 * `update` is a compare-and-set on `sequence` and returns `false` when another worker already
 * moved the record, which is how lease stealing is prevented without a distributed lock.
 */
export interface OperationStore<TResult = unknown> {
  create(record: OperationRecord<TResult>): Promise<void> | void;
  read(id: string): Promise<OperationRecord<TResult> | undefined> | OperationRecord<TResult> | undefined;
  update(record: OperationRecord<TResult>, expectedSequence: number): Promise<boolean> | boolean;
  delete?(id: string): Promise<boolean> | boolean;
  /** Non-terminal records whose lease has lapsed, for a recovery sweep. */
  claimExpired?(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> | Array<OperationRecord<TResult>>;
  findByIdempotencyKey?(
    key: string,
  ): Promise<OperationRecord<TResult> | undefined> | OperationRecord<TResult> | undefined;
  list?(): Promise<Array<OperationRecord<TResult>>> | Array<OperationRecord<TResult>>;
}

/**
 * Hands an accepted operation to a worker process.
 *
 * Separate from `OperationStore` because state and dispatch are different concerns: a deployment
 * can persist to Redis and dispatch through BullMQ, or persist and dispatch in one place.
 */
export interface OperationDispatcher {
  dispatch(record: OperationRecord<unknown>): Promise<void> | void;
}

export interface OperationWebhookConfig {
  url: string;
  /** Shared secret used for the HMAC-SHA256 signature. */
  secret: string;
  /** Defaults to terminal events only, which is what most receivers want. */
  events?: readonly OperationEventType[];
  headers?: Record<string, string>;
  /** Replaces the global `fetch`, for proxying or tests. */
  fetch?: typeof fetch;
  /** Delivery timeout. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export interface OperationRetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoff?: 'fixed' | 'exponential';
  /** Adds up to this fraction of the delay as random jitter, so retries do not synchronize. */
  jitter?: number;
  /** Decides whether a failure is worth another attempt. Defaults to retrying anything but a cancellation. */
  isRetryable?: (error: unknown) => boolean;
}

export interface OperationRunnerConfig<TResult = unknown> {
  store?: OperationStore<TResult>;
  dispatcher?: OperationDispatcher;
  /** Identifies this worker in leases. Defaults to a generated id. */
  owner?: string;
  /** How long a lease stays valid without a heartbeat. Defaults to 30 seconds. */
  leaseMs?: number;
  /** Heartbeat interval. Defaults to a third of `leaseMs`. */
  heartbeatMs?: number;
  /** Wall-clock budget for the whole operation, retries included. */
  timeoutMs?: number;
  retry?: OperationRetryConfig;
  webhook?: OperationWebhookConfig;
  /** Reports a webhook delivery failure. Delivery never fails the operation itself. */
  onWebhookError?: (error: unknown, event: OperationEvent<TResult>) => void;
  createOperationId?: () => string;
  now?: () => Date;
}

export interface OperationSubmitOptions {
  id?: string;
  kind?: string;
  idempotencyKey?: string;
  /** Overrides the runner's attempt budget for this operation. */
  maxAttempts?: number;
  timeoutMs?: number;
  expiresAt?: string;
  traceContext?: Record<string, string>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** What an executor receives. */
export interface OperationContext {
  operationId: string;
  attempt: number;
  signal: AbortSignal;
  /** Publishes a progress event and persists it. */
  report(progress: OperationProgress): void;
  /** Extends the lease immediately, for a step known to exceed the heartbeat interval. */
  heartbeat(): Promise<void>;
  traceContext?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type OperationExecutor<TResult> = (context: OperationContext) => Promise<TResult>;
