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

export const TERMINAL_BATCH_STATUSES: readonly BatchJobStatus[] = ['completed', 'failed', 'expired', 'cancelled'];

export function isTerminalBatchStatus(status: BatchJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired' || status === 'cancelled';
}

export interface BatchInputItem {
  /**
   * Caller-chosen identifier echoed back on the result.
   *
   * Required because a batch provider does not guarantee output order, and matching by position is
   * exactly the bug that silently mislabels every row.
   */
  customId: string;
  request: CompletionRequest;
}

export interface BatchOutputItem {
  customId: string;
  response?: NexusResponse;
  error?: {
    message: string;
    code?: string;
    status?: number;
  };
}

export interface BatchSubmitRequest {
  items: BatchInputItem[];
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
  metadata?: Record<string, string>;
  /** Overrides the manager's poll interval for this batch. */
  pollIntervalMs?: number;
  /** Gives up waiting after this long. The provider-side batch is left running. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BatchCounts {
  total: number;
  completed: number;
  failed: number;
}

/** A provider-side batch that outlives this process. */
export interface BatchJobRef {
  /** Provider's own batch identifier, the only thing needed to resume after a restart. */
  id: string;
  provider: string;
  /** Anything the adapter needs on later calls. Must stay JSON-serializable. */
  metadata?: Record<string, unknown>;
}

export interface BatchJobState {
  ref: BatchJobRef;
  status: BatchJobStatus;
  counts?: BatchCounts;
  createdAt?: string;
  completedAt?: string;
  expiresAt?: string;
  error?: { message: string; code?: string };
  raw?: unknown;
}

export interface BatchJobResult {
  ref: BatchJobRef;
  status: BatchJobStatus;
  items: BatchOutputItem[];
  counts: BatchCounts;
  /** Summed across every item the provider reported usage for. */
  usage: TokenUsage;
  /** Priced from the model registry, with the provider's batch discount applied. */
  cost: ResponseCost;
  createdAt?: string;
  completedAt?: string;
  raw?: unknown;
}

export interface BatchProviderCallContext {
  requestId: string;
  signal: AbortSignal;
  idempotencyKey?: string;
  attempt: number;
}

export interface BatchProviderCapabilities {
  /** Largest number of items accepted in one batch. */
  maxItems?: number;
  /** Largest request payload in bytes. */
  maxBytes?: number;
  completionWindows?: readonly string[];
  supportsCancel?: boolean;
  /** Fraction of the standard price a batched token costs. Both major providers charge half. */
  discount?: number;
}

export interface BatchProviderInfo {
  name: string;
  version?: string;
  capabilities: BatchProviderCapabilities;
}

/**
 * A provider's asynchronous batch tier.
 *
 * Four calls, deliberately split so a worker can resume a batch it did not submit: everything after
 * `submit` takes only a `BatchJobRef`, which is JSON-serializable and survives a restart.
 */
export interface BatchProvider {
  readonly info: BatchProviderInfo;
  submit(request: BatchSubmitRequest, context: BatchProviderCallContext): Promise<BatchJobRef>;
  poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
  results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchOutputItem[]>;
  cancel?(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
}

export interface BatchConfig {
  providers?: Record<string, BatchProvider>;
  defaultProvider?: string;
  /** How often to poll while a batch is running. Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** Upper bound on the poll interval once backoff has grown it. Defaults to 5 minutes. */
  maxPollIntervalMs?: number;
  /** Gives up waiting after this long. Defaults to 26 hours, just past the 24h tier. */
  timeoutMs?: number;
}
