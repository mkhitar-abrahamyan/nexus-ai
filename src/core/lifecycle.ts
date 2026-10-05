import type { AuditLogEvent, RateLimitConfig } from '../types/config.js';
import type {
  BudgetReservation,
  LifecycleConfig,
  LifecycleStage,
  OperationDescriptor,
  OperationLifecycleLike,
  OperationOutcome,
  OperationResultInfo,
  OperationStartOptions,
  OperationTicket,
  ProviderCallContext,
} from '../types/lifecycle.js';
import type { AuditLogger } from '../ops/audit-logger.js';
import type { MetricsCollector } from '../ops/metrics.js';
import { NexusRateLimitError, type RateLimiter } from '../ops/rate-limiter.js';
import { generateRequestId } from '../utils/ids.js';
import { linkSignals } from '../utils/signals.js';

/** Every lifecycle stage, in the order an operation passes through them. */
export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'validate',
  'authorize',
  'inputPolicy',
  'resolveAssets',
  'route',
  'reserveBudget',
  'execute',
  'outputPolicy',
  'persist',
  'reconcileCost',
  'audit',
];

/** Raised when `lifecycle.authorize` refuses an operation, before any provider is called. */
export class OperationDeniedError extends Error {
  constructor(
    /** The operation that was refused. */
    public readonly operation: OperationDescriptor,
    reason?: string,
    options?: { cause?: unknown },
  ) {
    super(`${operation.operation} was not authorized${reason ? `: ${reason}` : ''}`, options);
    this.name = 'OperationDeniedError';
  }
}

/** Raised when an operation's estimated cost does not fit what is left of its budget. */
export class BudgetExceededError extends Error {
  constructor(
    /** The budget, such as a tenant. */
    public readonly key: string,
    /** What the operation was estimated to cost, in US dollars. */
    public readonly estimate: number,
    /** What was left of the budget, in US dollars. */
    public readonly remaining: number,
  ) {
    super(
      `Budget "${key}" has $${Math.max(0, remaining).toFixed(4)} left, not enough for an operation estimated at $${estimate.toFixed(4)}`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** What a lifecycle reports into. Every field is optional; a lifecycle with none records nothing. */
export interface LifecycleRuntime {
  /** Where metrics go. */
  metrics?: MetricsCollector;
  /** Where audit events go. */
  auditLogger?: AuditLogger;
  /** The rate limiter every family shares. */
  rateLimiter?: RateLimiter;
  /** The rate-limit policy. */
  rateLimit?: RateLimitConfig;
  /** Authorization, budget, and hooks. */
  config?: LifecycleConfig;
  /** Default milliseconds an operation may run before its signal aborts. */
  timeoutMs?: number;
}

/** The family's part of one operation: what each stage does for it. Every stage but `execute` is optional. */
export interface OperationPlan<T> {
  /** Checks the request before anything else happens. Runs before authorization, so it must not have side effects. */
  validate?(): void | Promise<void>;
  /** Applies input guardrails: security, safety policies, trimming. */
  inputPolicy?(context: ProviderCallContext): void | Promise<void>;
  /** Loads the assets the request refers to. */
  resolveAssets?(context: ProviderCallContext): void | Promise<void>;
  /** Chooses the provider and model, and reports them. */
  route?():
    | { provider?: string; model?: string }
    | undefined
    | Promise<{ provider?: string; model?: string } | undefined>;
  /** What the operation is expected to cost in US dollars, held against the budget. */
  estimate?(): number | undefined;
  /** Runs the operation: a provider call, a cache read, or both. */
  execute(context: ProviderCallContext): Promise<T>;
  /** Applies output guardrails, and may replace the result. */
  outputPolicy?(result: T): T | Promise<T>;
  /** Stores what should outlive the call, such as a cache entry. */
  persist?(result: T): void | Promise<void>;
  /** What the result cost and whether a cache answered, for the budget, metrics, and audit. */
  settle?(result: T): OperationResultInfo;
}

/**
 * Runs operations of every family through the same stages: validate, authorize, input policy,
 * resolve assets, route, reserve budget, execute, output policy, persist, reconcile cost, and audit.
 *
 * Authorization, the rate limit, the budget, hooks, audit, and metrics live here once, so a family
 * supplies only what is its own: its checks, its routing, and its provider call. With nothing
 * configured, an operation pays for one request id and one abort signal.
 */
export class OperationLifecycle implements OperationLifecycleLike {
  constructor(private readonly runtime: LifecycleRuntime = {}) {}

  /**
   * Admits an operation: authorizes it, applies the rate limit, audits the request, and runs
   * `onStart`. Throws `OperationDeniedError` or `NexusRateLimitError` when it may not run.
   */
  async start(
    input: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
    options: OperationStartOptions & { audit?: Record<string, unknown> } = {},
  ): Promise<OperationTicket> {
    const descriptor: OperationDescriptor = { ...input, requestId: input.requestId?.trim() || generateRequestId() };
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? this.runtime.timeoutMs;
    const deadline =
      timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : undefined;
    const call = callSignal(options.signal, deadline === undefined ? undefined : deadline - startedAt);
    const context: ProviderCallContext = {
      requestId: descriptor.requestId,
      signal: call.signal,
      ...(deadline !== undefined ? { deadline } : {}),
      ...(options.traceContext ? { traceContext: options.traceContext } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    };
    const ticket = new Ticket(this.runtime, descriptor, context, startedAt, call.dispose);

    try {
      await this.runtime.metrics?.recordRequest(labelsOf(descriptor));
      await this.checkRateLimit(descriptor);
      await this.authorize(descriptor);
    } catch (error) {
      await ticket.fail(error);
      throw error;
    }

    await ticket.audit('request', options.audit);
    await runHook(() => this.runtime.config?.hooks?.onStart?.(descriptor));
    return ticket;
  }

  /** Runs one operation through every stage and returns its result. */
  async run<T>(
    input: Omit<OperationDescriptor, 'requestId'> & { requestId?: string },
    plan: OperationPlan<T>,
    options: OperationStartOptions & { audit?: Record<string, unknown> } = {},
  ): Promise<T> {
    await plan.validate?.();
    const ticket = await this.start(input, options);
    try {
      await plan.inputPolicy?.(ticket.context);
      await plan.resolveAssets?.(ticket.context);
      const routed = await plan.route?.();
      if (routed?.provider) ticket.descriptor.provider = routed.provider;
      if (routed?.model) ticket.descriptor.model = routed.model;
      // Estimating can mean tokenizing every input, so it only happens when a budget will read it.
      if (this.runtime.config?.budget) await ticket.reserve(plan.estimate?.());
      let result = await plan.execute(ticket.context);
      if (plan.outputPolicy) result = await plan.outputPolicy(result);
      await plan.persist?.(result);
      await ticket.succeed(plan.settle?.(result));
      return result;
    } catch (error) {
      await ticket.fail(error);
      throw error;
    }
  }

  /** True when nothing is configured, so a caller may skip work that only feeds the lifecycle. */
  get inert(): boolean {
    const config = this.runtime.config;
    return (
      !this.runtime.metrics?.enabled &&
      !this.runtime.auditLogger?.enabled &&
      !this.runtime.rateLimit?.enabled &&
      !config?.authorize &&
      !config?.budget &&
      !config?.hooks
    );
  }

  private async checkRateLimit(descriptor: OperationDescriptor): Promise<void> {
    const { rateLimiter, rateLimit } = this.runtime;
    if (!rateLimiter || !rateLimit?.enabled) return;
    const bucket = {
      model: descriptor.model ?? `${descriptor.family}:${descriptor.operation}`,
      userId: descriptor.userId,
      tenantId: descriptor.tenantId,
    };
    if (rateLimit.store) await rateLimiter.checkAsync(bucket, rateLimit);
    else rateLimiter.check(bucket, rateLimit);
  }

  private async authorize(descriptor: OperationDescriptor): Promise<void> {
    const authorize = this.runtime.config?.authorize;
    if (!authorize) return;
    let verdict: boolean | undefined;
    try {
      verdict = await authorize(descriptor);
    } catch (error) {
      if (error instanceof OperationDeniedError) throw error;
      throw new OperationDeniedError(descriptor, error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    if (verdict === false) throw new OperationDeniedError(descriptor);
  }
}

class Ticket implements OperationTicket {
  private reservation?: BudgetReservation;
  private finished = false;

  constructor(
    private readonly runtime: LifecycleRuntime,
    readonly descriptor: OperationDescriptor,
    readonly context: ProviderCallContext,
    private readonly startedAt: number,
    /** Releases the call signal's hold on the caller's, once the operation has finished. */
    private readonly release: () => void = () => undefined,
  ) {}

  async reserve(estimate: number | undefined): Promise<void> {
    const budget = this.runtime.config?.budget;
    if (!budget || estimate === undefined || this.finished) return;
    if (this.reservation) {
      await budget.release(this.reservation);
      this.reservation = undefined;
    }
    this.reservation = await budget.reserve(this.descriptor, estimate);
  }

  async succeed(info: OperationResultInfo = {}): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (info.provider) this.descriptor.provider = info.provider;
    if (info.model) this.descriptor.model = info.model;
    const latencyMs = Date.now() - this.startedAt;
    const budget = this.runtime.config?.budget;
    if (budget && this.reservation) {
      await budget.reconcile(this.reservation, info.cost ?? this.reservation.amount);
    }
    await this.audit('response', { ...(info.cacheHit ? { cacheHit: true } : {}), ...info.metadata });
    const labels = labelsOf(this.descriptor);
    await this.runtime.metrics?.recordResponse(labels, latencyMs, info.cost);
    if (info.cacheHit) await this.runtime.metrics?.recordCacheHit(labels);
    await this.finish({
      status: 'succeeded',
      cacheHit: info.cacheHit === true,
      latencyMs,
      ...(info.cost !== undefined ? { cost: info.cost } : {}),
    });
  }

  async fail(error: unknown): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const budget = this.runtime.config?.budget;
    if (budget && this.reservation) await budget.release(this.reservation);
    const status = outcomeOf(error, this.context.signal);
    await this.runtime.metrics?.recordError(labelsOf(this.descriptor));
    // A guardrail's findings say why it blocked, and are already redacted.
    const findings = (error as { findings?: unknown } | undefined)?.findings;
    await this.audit(status === 'denied' ? 'blocked' : 'error', {
      error: describeError(error),
      ...(Array.isArray(findings) ? { findings } : {}),
    });
    await this.finish({ status, cacheHit: false, latencyMs: Date.now() - this.startedAt, error: describeError(error) });
  }

  /** Writes one audit event for this operation. */
  async audit(type: AuditLogEvent['type'], metadata?: Record<string, unknown>): Promise<void> {
    const logger = this.runtime.auditLogger;
    if (!logger?.enabled) return;
    await logger.log({
      type,
      family: this.descriptor.family,
      operation: this.descriptor.operation,
      requestId: this.descriptor.requestId,
      userId: this.descriptor.userId,
      model: this.descriptor.model,
      provider: this.descriptor.provider,
      timestamp: new Date().toISOString(),
      ...(this.descriptor.metadata || metadata ? { metadata: { ...this.descriptor.metadata, ...metadata } } : {}),
    });
  }

  private async finish(outcome: OperationOutcome): Promise<void> {
    this.release();
    await runHook(() => this.runtime.config?.hooks?.onFinish?.(this.descriptor, outcome));
  }
}

/**
 * The caller's signal, with the deadline added when there is one, and how to let go of the caller's
 * signal once the operation finishes: a caller's signal often outlives thousands of operations.
 */
function callSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; dispose(): void } {
  if (timeoutMs === undefined) return { signal: signal ?? new AbortController().signal, dispose: () => undefined };
  return linkSignals([signal, AbortSignal.timeout(timeoutMs)]);
}

function outcomeOf(error: unknown, signal: AbortSignal): OperationOutcome['status'] {
  if (
    error instanceof OperationDeniedError ||
    error instanceof BudgetExceededError ||
    error instanceof NexusRateLimitError ||
    (error instanceof Error &&
      (error.name === 'CostBudgetError' || error.name === 'TenantLimitError' || error.name === 'NexusSecurityError'))
  ) {
    return 'denied';
  }
  if (
    signal.aborted ||
    (error instanceof Error && error.name === 'AbortError') ||
    (error as { category?: unknown } | undefined)?.category === 'abort'
  ) {
    return 'cancelled';
  }
  return 'failed';
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

function labelsOf(descriptor: OperationDescriptor): Record<string, string> {
  const labels: Record<string, string> = { family: descriptor.family, operation: descriptor.operation };
  if (descriptor.provider) labels.provider = descriptor.provider;
  if (descriptor.model) labels.model = descriptor.model;
  return labels;
}

/** Runs a hook and ignores what it throws, so observability can never fail a call. */
async function runHook(hook: () => void | Promise<void>): Promise<void> {
  try {
    await hook();
  } catch {
    // Documented: a throwing hook is ignored.
  }
}
