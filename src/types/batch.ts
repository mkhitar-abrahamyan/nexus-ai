import type { CompletionRequest } from './messages.js';
import type { NexusResponse, ResponseCost, TokenUsage } from './response.js';

/**
 * Where a provider batch is in its lifecycle.
 *
 * Deliberately the provider vocabulary rather than `OperationStatus`: a batch spends real time in
 * `validating` and `finalizing`, and collapsing those into `running` would hide the distinction
 * between "not started yet" and "results are being written". The surrounding operation handle still
 * reports the neutral lifecycle, so a caller can use either.
 */
export type BatchJobStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelling'
  | 'cancelled';

/** Batch statuses from which a batch can never move again. */
export const TERMINAL_BATCH_STATUSES: readonly BatchJobStatus[] = ['completed', 'failed', 'expired', 'cancelled'];

/** Whether a batch has reached a status it can never leave. */
export function isTerminalBatchStatus(status: BatchJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired' || status === 'cancelled';
}

/** One request in a batch. */
export interface BatchInputItem {
  /**
   * Caller-chosen identifier echoed back on the result.
   *
   * Required because a batch provider does not guarantee output order, and matching by position is
   * exactly the bug that silently mislabels every row.
   */
  customId: string;
  /** The completion to run. Streaming does not apply to a batch. */
  request: CompletionRequest;
}

/** The outcome of one batched request. */
export interface BatchOutputItem {
  /** The `customId` of the request this answers. */
  customId: string;
  /** The response, when the request succeeded. */
  response?: NexusResponse;
  /** Why the request failed, when it did. */
  error?: {
    message: string;
    code?: string;
    status?: number;
  };
}

/** A batch to submit to a provider's asynchronous tier. */
export interface BatchSubmitRequest {
  /** The requests to run. Every `customId` must be unique. */
  items: BatchInputItem[];
  /** Provider to use. Defaults to the manager's default. */
  provider?: string;
  /** Model applied to any item that does not name its own. */
  model?: string;
  /**
   * How long the provider may take, in its own vocabulary. `24h` is the discounted tier on both
   * OpenAI and Anthropic and is the default.
   */
  completionWindow?: string;
  /** Replays an accepted batch instead of submitting a second one. */
  idempotencyKey?: string;
  /** Labels attached to the batch on the provider's side, for its console and billing exports. */
  metadata?: Record<string, string>;
  /** Overrides the manager's poll interval for this batch. */
  pollIntervalMs?: number;
  /** Gives up waiting after this long. The provider-side batch is left running. */
  timeoutMs?: number;
  /** Stops waiting. The provider-side batch keeps running unless it is cancelled. */
  signal?: AbortSignal;
}

/** How many requests a batch holds and how many have finished. */
export interface BatchCounts {
  /** Requests in the batch. */
  total: number;
  /** Requests that succeeded. */
  completed: number;
  /** Requests that failed. */
  failed: number;
}

/** A provider-side batch that outlives this process. */
export interface BatchJobRef {
  /** Provider's own batch identifier, the only thing needed to resume after a restart. */
  id: string;
  /** The provider that runs the batch. */
  provider: string;
  /** Anything the adapter needs on later calls. Must stay JSON-serializable. */
  metadata?: Record<string, unknown>;
}

/** A batch's status as last polled. */
export interface BatchJobState {
  /** The batch. */
  ref: BatchJobRef;
  /** Where it is in its lifecycle. */
  status: BatchJobStatus;
  /** Progress, when the provider reports it. */
  counts?: BatchCounts;
  /** ISO-8601 time it was submitted. */
  createdAt?: string;
  /** ISO-8601 time it finished. */
  completedAt?: string;
  /** ISO-8601 time the provider will give up on it. */
  expiresAt?: string;
  /** Why the batch failed as a whole, when it did. Per-request failures are on the items. */
  error?: { message: string; code?: string };
  /** The provider's status payload, unmodified. */
  raw?: unknown;
}

/** A finished batch with every item's outcome, its usage, and its discounted cost. */
export interface BatchJobResult {
  /** The batch. */
  ref: BatchJobRef;
  /** Its final status. */
  status: BatchJobStatus;
  /** Every item's outcome, matched by `customId`, never by position. */
  items: BatchOutputItem[];
  /** How many succeeded and failed. */
  counts: BatchCounts;
  /** Summed across every item the provider reported usage for. */
  usage: TokenUsage;
  /** Priced from the model registry, with the provider's batch discount applied. */
  cost: ResponseCost;
  /** ISO-8601 time it was submitted. */
  createdAt?: string;
  /** ISO-8601 time it finished. */
  completedAt?: string;
  /** The provider's final payload, unmodified. */
  raw?: unknown;
}

/** What a batch adapter receives with every call. */
export interface BatchProviderCallContext {
  /** The request's id. */
  requestId: string;
  /** Aborts the call. It does not cancel the provider-side batch; `cancel` does. */
  signal: AbortSignal;
  /** Replays a submission instead of creating a second batch. */
  idempotencyKey?: string;
  /** This attempt's number, starting at 1. */
  attempt: number;
}

/** What a batch tier supports. */
export interface BatchProviderCapabilities {
  /** Largest number of items accepted in one batch. */
  maxItems?: number;
  /** Largest request payload in bytes. */
  maxBytes?: number;
  /** Completion windows it accepts, such as `24h`. */
  completionWindows?: readonly string[];
  /** Whether a running batch can be cancelled. */
  supportsCancel?: boolean;
  /** Fraction of the standard price a batched token costs. Both major providers charge half. */
  discount?: number;
}

/** Identifies a batch adapter and what it supports. */
export interface BatchProviderInfo {
  /** The adapter's registered name. */
  name: string;
  /** The adapter's version. */
  version?: string;
  /** What it supports. */
  capabilities: BatchProviderCapabilities;
}

/**
 * A provider's asynchronous batch tier.
 *
 * Four calls, deliberately split so a worker can resume a batch it did not submit: everything after
 * `submit` takes only a `BatchJobRef`, which is JSON-serializable and survives a restart.
 */
export interface BatchProvider {
  /** What the adapter is and what it supports. */
  readonly info: BatchProviderInfo;
  /** Submits the batch and returns a reference that survives a restart. */
  submit(request: BatchSubmitRequest, context: BatchProviderCallContext): Promise<BatchJobRef>;
  /** Reads the batch's current status. */
  poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
  /** Downloads every item's outcome once the batch has finished. */
  results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchOutputItem[]>;
  /** Cancels a running batch. */
  cancel?(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
}

/** Configuration for `BatchManager`. */
export interface BatchConfig {
  /** Batch adapters, by name. */
  providers?: Record<string, BatchProvider>;
  /** Adapter used when a submission names none. */
  defaultProvider?: string;
  /** How often to poll while a batch is running. Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Upper bound on the poll interval once backoff has grown it. Defaults to 5 minutes. */
  maxPollIntervalMs?: number;
  /** Gives up waiting after this long. Defaults to 26 hours, just past the 24h tier. */
  timeoutMs?: number;
}
