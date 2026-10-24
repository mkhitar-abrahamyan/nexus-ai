import type { CallResidency, ResidencyPolicy } from './residency.js';

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
  | 'agent'
  | 'media'
  | 'video'
  | 'messaging'
  | 'decision';

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
  /** The tenant the call runs for, when the operation names one. */
  tenantId?: string;
  /**
   * The credential a provider sends for this call: the call's tenant's own, resolved by the
   * lifecycle's `credentials` when the call is made, in place of the key the provider was configured
   * with. Resolves to `undefined` when there is no resolver, or it has nothing for the provider.
   * Each provider is resolved once per operation.
   */
  credential?: (provider: string) => Promise<ProviderCredential | undefined>;
  /**
   * The regions the call may reach, under the lifecycle's `residency` policy: a family that chooses
   * among providers calls only those it `allows`, and sends a call to a provider's twin where it
   * `place`s it.
   */
  residency?: CallResidency;
}

/** What a provider sends to authenticate one call, in place of its configured key. */
export interface ProviderCredential {
  /** The API key, sent as the provider sends its configured one. */
  apiKey?: string;
  /** Headers added to the call, such as an organization or a project. */
  headers?: Record<string, string>;
}

/** What a credential is resolved for: one provider, for one tenant, in one operation. */
export interface CredentialRequest {
  /** The provider the call goes to, by the name it is registered under. */
  provider: string;
  /** The tenant the call runs for. */
  tenantId?: string;
  /** The operation's family. */
  family: OperationFamily;
  /** The operation, such as `complete`. */
  operation: string;
}

/**
 * Resolves a provider's credential per tenant, at call time: from a secret manager, through
 * `tenantCredentials()` from `nexus-ai-pro/credentials`, or from code of your own.
 */
export interface CredentialResolver {
  /**
   * The credential for one call, or `undefined` to send the provider's configured key. Throw to
   * refuse the call.
   */
  resolve(request: CredentialRequest): Promise<ProviderCredential | undefined> | ProviderCredential | undefined;
  /**
   * Forgets a credential, so the next call resolves it again: called when a provider refuses one,
   * before the call is made once more.
   */
  invalidate?(request: Pick<CredentialRequest, 'provider' | 'tenantId'>): Promise<void> | void;
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
  /** The policy it runs under, when the client has one, as its audit events record it. */
  policy?: PolicyReference;
}

/** A policy, as each operation it decides records it: its name, its version, and its content hash. */
export interface PolicyReference {
  /** The policy's name, such as `production`. */
  name: string;
  /** Its version, as its file numbers it. */
  version: string;
  /** The SHA-256 of its content, hex-encoded, so two files with one version are told apart. */
  hash: string;
}

/**
 * Which providers and models an operation may reach, beside residency: a policy's routing rules,
 * per tenant. Checked wherever residency is.
 */
export interface ProviderGate {
  /** `true` when the operation may reach the provider, and the model when one is named; else why not. */
  check(operation: OperationDescriptor, provider: string, model?: string): true | string;
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
  /**
   * Its id, when the ledger's store records reservations: any process can then settle it, and one a
   * dead process held is found when its lease lapses.
   */
  id?: string;
}

/**
 * Where a recorded reservation stands. `reserved` is held under a lease; `settled` is charged at what
 * its operation cost; `released` was given back by its operation; `expired` was given back after its
 * lease lapsed, its operation never having started; `uncertain` lapsed with its operation's outcome
 * unknown, and is charged or given back by the ledger's policy until its operation says.
 */
export type BudgetReservationStatus = 'reserved' | 'settled' | 'released' | 'expired' | 'uncertain';

/** A reservation as a ledger's store records it. Times are epoch milliseconds. */
export interface BudgetReservationRecord {
  /** Its id. */
  id: string;
  /** The budget it counts against. */
  key: string;
  /** The total of the period it counts in. */
  storeKey: string;
  /** When that period's total resets. */
  resetAt: number;
  /** What was reserved. */
  amount: number;
  /** What it adds to the total now: the amount while reserved, the cost once settled, 0 once given back. */
  charged: number;
  /** The request id of the operation it was reserved for. */
  operationId: string;
  /** That operation's family. */
  family?: OperationFamily;
  /** What that operation does, such as `online-evaluation.quality`. */
  operation?: string;
  /** Where it stands. */
  status: BudgetReservationStatus;
  /** When its lease lapses, unless renewed. */
  leasedUntil: number;
  /** When it was reserved. */
  createdAt: number;
  /** What its operation cost, once settled. */
  actual?: number;
  /** When it left `reserved`. */
  settledAt?: number;
}

/**
 * What became of a reservation's operation, as whoever settles it knows: it finished at a cost, it
 * never started, its outcome is unknown, or it is still running, which renews the lease.
 */
export type BudgetReservationOutcome =
  | { kind: 'finished'; cost: number }
  | { kind: 'never-started' }
  | { kind: 'unknown' }
  | { kind: 'running' };

/** What one recovery pass did with reservations whose lease had lapsed. */
export interface BudgetRecoveryReport {
  /** Charged at what their operation cost. */
  settled: number;
  /** Given back, their operation never having started. */
  expired: number;
  /** Marked uncertain, charged or given back by the ledger's policy. */
  uncertain: number;
  /** Still running, their leases renewed. */
  renewed: number;
  /** Left for another resolver, which knows their operation. */
  skipped: number;
}

/** How `recover()` reads lapsed reservations. */
export interface BudgetRecoverOptions {
  /** Only reservations for operations that do this, such as `online-evaluation.quality`. */
  operation?: string;
  /** Most reservations settled in one pass. Defaults to 100. */
  limit?: number;
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
  /** Extends a recorded reservation's lease, for an operation that runs longer than it. */
  renew?(reservation: BudgetReservation): Promise<void>;
  /**
   * Settles a recorded reservation by its id, from any process: charged at a finished operation's
   * cost, given back for one that never started, or by policy when its outcome is unknown. A late
   * report from the operation itself corrects what recovery decided. Resolves whether it changed.
   */
  settle?(id: string, outcome: BudgetReservationOutcome): Promise<boolean>;
  /**
   * Settles reservations whose lease lapsed, typically because the process holding them died, by
   * what `resolve` says became of each operation. `resolve` returns `undefined` for an operation it
   * does not know, which leaves the reservation for another resolver.
   */
  recover?(
    resolve: (
      reservation: BudgetReservationRecord,
    ) => BudgetReservationOutcome | undefined | Promise<BudgetReservationOutcome | undefined>,
    options?: BudgetRecoverOptions,
  ): Promise<BudgetRecoveryReport>;
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
  /**
   * Resolves each provider's credential per tenant, when a call is made, instead of the key the
   * provider was configured with: `tenantCredentials()` from `nexus-ai-pro/credentials`, over a
   * secret manager. A provider that refuses a credential gets the call once more with it resolved
   * again, and a resolved key is removed from every error the operation raises.
   */
  credentials?: CredentialResolver;
  /**
   * Which regions each tenant's operations may reach, and what runs where: `residency()` from
   * `nexus-ai-pro/residency`. An operation is refused with a `ResidencyError`, before any provider
   * is called, when the provider it would reach runs outside its tenant's regions; a completion is
   * first sent to the provider's twin inside them, when there is one.
   */
  residency?: ResidencyPolicy;
  /**
   * Which providers and models each operation may reach, beside residency, such as a policy's
   * per-tenant routing rules: a provider it refuses is refused with an `OperationDeniedError` naming
   * why, and dropped from a completion's fallbacks.
   */
  providers?: ProviderGate;
  /** The policy every operation runs under, recorded on its descriptor and its audit events. */
  policy?: PolicyReference;
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
  /**
   * Resolves a provider's credential again, as after the provider refused it. Resolves to true when
   * there is a credential resolver, so the call is worth making once more.
   */
  refreshCredential?(provider: string): Promise<boolean>;
  /** Removes every credential this operation resolved from an error's text, in place, and returns it. */
  scrub?<E>(error: E): E;
}

/** How a provider answered: in time, or with an error. */
export type ProviderHealthOutcome = { ok: true; latencyMs: number } | { ok: false; error: unknown };

/**
 * The part of a client's lifecycle a module outside the core needs: a graph, an agent, or a realtime
 * session given one runs as an operation of that client.
 */
export interface OperationLifecycleLike {
  /**
   * Reports how a provider answered a call the family made itself, such as a realtime connection, to
   * the client's provider health and circuit breaker, as a completion's attempts are. Optional.
   */
  reportHealth?(provider: string, outcome: ProviderHealthOutcome): void;
  /** Admits an operation and returns its ticket. Throws when authorization or a rate limit refuses it. */
  start(
    operation: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
    options?: OperationStartOptions,
  ): Promise<OperationTicket>;
  /**
   * What a provider call that continues an operation admitted earlier is given, such as a video job
   * polled after a restart: its tenant's credentials and its residency, without admitting another
   * operation. Optional; a family without it sends the configured key.
   */
  callContext?(
    operation: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
  ): Promise<ContinuedCallContext>;
}

/** What `callContext()` gives a provider call that continues an operation. */
export interface ContinuedCallContext extends Pick<ProviderCallContext, 'tenantId' | 'credential' | 'residency'> {
  /** Removes every credential it resolved from an error, in place, and returns it. */
  scrub<E>(error: E): E;
}
