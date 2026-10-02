/**
 * One lifecycle for every operation.
 *
 * A completion, a stream, an embedding, a transcription, a call, an image, a realtime session, a
 * graph run, and an agent run pass through the same stages in the same order, so authorization,
 * budgets, hooks, audit, metrics, and finalization behave the same whichever family runs.
 */

/** The families an operation can belong to. */
export type OperationFamily =
  | 'completion'
  | 'embedding'
  | 'voice'
  | 'realtime'
  | 'telephony'
  | 'image'
  | 'batch'
  | 'job'
  | 'graph'
  | 'agent';

/**
 * The stages every operation passes through, in this order. A family skips a stage it has nothing
 * for: a transcription resolves no assets, and a graph run calls no provider directly.
 */
export type LifecycleStage =
  | 'validate'
  | 'authorize'
  | 'inputPolicy'
  | 'resolveAssets'
  | 'route'
  | 'reserveBudget'
  | 'execute'
  | 'outputPolicy'
  | 'persist'
  | 'reconcileCost'
  | 'audit';

/**
 * What every provider call receives besides its request, in every family: how to stop, when to
 * finish by, and what to carry to the provider.
 */
export interface ProviderCallContext {
  /** The operation's request id, also on the audit log and the response. */
  requestId: string;
  /** Aborted when the caller cancels or the deadline passes. */
  signal: AbortSignal;
  /** Epoch milliseconds by which the call must finish, when there is a timeout. */
  deadline?: number;
  /** Trace propagation headers, such as `traceparent`, for providers that accept them. */
  traceContext?: Record<string, string>;
  /** Passed to providers that deduplicate requests themselves. */
  idempotencyKey?: string;
}

/** One operation, as authorization, budgets, hooks, audit, and metrics see it. */
export interface OperationDescriptor {
  /** The family it belongs to. */
  family: OperationFamily;
  /** What it does, such as `complete`, `stream`, `embed`, `transcribe`, or `images.generate`. */
  operation: string;
  /** The request id. */
  requestId: string;
  /** The provider serving it, once routing has chosen one. */
  provider?: string;
  /** The model serving it, once routing has chosen one. */
  model?: string;
  /** The user it runs for, for per-user rate limits and authorization. */
  userId?: string;
  /** The tenant it runs for, for per-tenant budgets. */
  tenantId?: string;
  /** Application data. Never include raw media or credentials: the audit log records it. */
  metadata?: Record<string, unknown>;
}

/** How an operation ended, as `onFinish` receives it. */
export interface OperationOutcome {
  /** `denied` when authorization, a rate limit, a budget, or a guardrail refused it. */
  status: 'succeeded' | 'failed' | 'denied' | 'cancelled';
  /** True when a cache answered and no provider was called. */
  cacheHit: boolean;
  /** Milliseconds from admission to finish. */
  latencyMs: number;
  /** What the operation cost in US dollars, when it was priced. */
  cost?: number;
  /** Why it failed, when it did. */
  error?: { name: string; message: string };
}

/** Code that runs around every operation of every family. */
export interface LifecycleHooks {
  /** After authorization admits the operation, before anything else happens. */
  onStart?(operation: OperationDescriptor): void | Promise<void>;
  /**
   * After the operation ends, however it ends: success, cache hit, failure, denial, or cancellation.
   * A throwing hook is ignored, so observability can never fail a call.
   */
  onFinish?(operation: OperationDescriptor, outcome: OperationOutcome): void | Promise<void>;
}

/** A calendar period in UTC, or a fixed window in milliseconds. */
export type BudgetPeriod = 'hour' | 'day' | 'week' | 'month' | { windowMs: number };

/** Spend held for an operation between `reserveBudget` and `reconcileCost`. */
export interface BudgetReservation {
  /** The budget it counts against, such as a tenant. */
  key: string;
  /** The amount held, in US dollars. */
  amount: number;
}

/**
 * Spend shared by every family. The lifecycle reserves an operation's estimated cost before it runs
 * and reconciles the actual cost after, so concurrent calls cannot overshoot a budget together.
 */
export interface BudgetLedger {
  /**
   * Holds `estimate` for the operation, or throws `BudgetExceededError` when it does not fit.
   * Returns nothing for an operation the ledger does not track.
   */
  reserve(
    operation: OperationDescriptor,
    estimate: number,
  ): BudgetReservation | undefined | Promise<BudgetReservation | undefined>;
  /** Replaces the held amount with what the operation actually cost. */
  reconcile(reservation: BudgetReservation, actual: number): void | Promise<void>;
  /** Gives the held amount back, for an operation that failed or was cancelled. */
  release(reservation: BudgetReservation): void | Promise<void>;
}

/** What every operation of a client shares. Set it as `lifecycle` in the client's config. */
export interface LifecycleConfig {
  /**
   * Decides whether an operation may run. Return `false` or throw to refuse it, which raises
   * `OperationDeniedError` before any provider is called.
   */
  authorize?: (operation: OperationDescriptor) => boolean | undefined | Promise<boolean | undefined>;
  /** Spend shared by every family. `budgetLedger()` from `nexus-ai-pro/lifecycle` builds one. */
  budget?: BudgetLedger;
  /** Code that runs around every operation. */
  hooks?: LifecycleHooks;
}

/** Options for admitting one operation. */
export interface OperationStartOptions {
  /** Cancels the operation. */
  signal?: AbortSignal;
  /** Milliseconds the operation may run before its signal aborts. */
  timeoutMs?: number;
  /** Carried to providers that deduplicate requests themselves. */
  idempotencyKey?: string;
  /** Trace propagation headers carried to providers. */
  traceContext?: Record<string, string>;
}

/** What a finished operation reports, for budgets, metrics, audit, and hooks. */
export interface OperationResultInfo {
  /** What it cost in US dollars, when it was priced. */
  cost?: number;
  /** True when a cache answered and no provider was called. */
  cacheHit?: boolean;
  /** The provider that served it, when routing chose it late. */
  provider?: string;
  /** The model that served it, when routing chose it late. */
  model?: string;
  /** Extra fields for the response's audit event. */
  metadata?: Record<string, unknown>;
}

/**
 * An admitted operation that has not finished yet. A long-lived operation, such as a stream, a
 * realtime session, or a graph run, holds one between starting and finishing.
 */
export interface OperationTicket {
  /** The operation, with the provider and model filled in once routing chose them. */
  readonly descriptor: OperationDescriptor;
  /** What to hand every provider call the operation makes. */
  readonly context: ProviderCallContext;
  /** Holds the estimated cost against the budget. Throws `BudgetExceededError` when it does not fit. */
  reserve(estimate: number | undefined): Promise<void>;
  /** Finishes successfully: reconciles cost, audits the response, records metrics, runs `onFinish`. */
  succeed(info?: OperationResultInfo): Promise<void>;
  /** Finishes with an error: releases the budget, records the failure, runs `onFinish`. */
  fail(error: unknown): Promise<void>;
}

/**
 * The part of a client's lifecycle a module outside the core needs: a graph, an agent, or a realtime
 * session given one runs as an operation of that client.
 */
export interface OperationLifecycleLike {
  /** Admits an operation and returns its ticket. Throws when authorization or a rate limit refuses it. */
  start(
    operation: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
    options?: OperationStartOptions,
  ): Promise<OperationTicket>;
}
