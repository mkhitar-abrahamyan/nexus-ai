import { OperationLifecycle } from '../core/lifecycle.js';
import type { RateLimitConfig } from '../types/config.js';
import type { OperationFamily, ProviderCallContext } from '../types/lifecycle.js';
import type { AuditLogger } from './audit-logger.js';
import type { MetricsCollector } from './metrics.js';
import type { RateLimiter } from './rate-limiter.js';

/**
 * Shared observability wiring handed to an operation family.
 *
 * Passed down from `NexusAI` so every family runs through the client's lifecycle: the same
 * authorization, budget, hooks, collector, audit log, and rate limiter. Each field is optional, so a
 * family constructed standalone still works and simply records nothing.
 */
export interface FamilyRuntime {
  /** Where metrics go. */
  metrics?: MetricsCollector;
  /** Where audit events go. */
  auditLogger?: AuditLogger;
  /** The rate limiter shared with text completions. */
  rateLimiter?: RateLimiter;
  /** The rate-limit policy. */
  rateLimit?: RateLimitConfig;
  /**
   * The client's lifecycle. When it is set, every call runs through it and the fields above are
   * ignored; otherwise a lifecycle is built from them.
   */
  lifecycle?: OperationLifecycle;
}

/** What one family call is, for authorization, metrics labels, the audit log, and the rate limit. */
export interface FamilyCallDescriptor {
  /** Operation name recorded as a metric label, such as `transcribe` or `images.generate`. */
  operation: string;
  /** The provider called. */
  provider?: string;
  /** The model called. */
  model?: string;
  /** The user it is for, for per-user rate limits. */
  userId?: string;
  /** The tenant it is for, for per-tenant budgets. */
  tenantId?: string;
  /** The request id, for the audit log and the provider. */
  requestId?: string;
  /** Extra fields for the audit event. Never include raw media or credentials. */
  metadata?: Record<string, unknown>;
  /** Cancels the call. */
  signal?: AbortSignal;
  /** Carried to providers that deduplicate requests themselves. */
  idempotencyKey?: string;
  /** What the call is expected to cost in US dollars, held against the lifecycle's budget. */
  estimate?: number;
}

/**
 * Runs one family call through the client's lifecycle: authorization, the rate limit, the budget,
 * the audit log, metrics, and hooks.
 *
 * Extracted rather than repeated in each manager: images, voice, and telephony need the same steps in
 * the same order, and hand-written copies would drift. A family added later inherits the behavior by
 * using this instead of remembering the order.
 *
 * Cost is reported only when the family can price the call. Media and telephony providers price per
 * second, per image, or per minute, and inventing a number would be worse than reporting none.
 */
export class FamilyTelemetry {
  private readonly lifecycle: OperationLifecycle;

  constructor(
    private readonly family: string,
    runtime: FamilyRuntime = {},
  ) {
    this.lifecycle = runtime.lifecycle ?? new OperationLifecycle(runtime);
  }

  /** True when nothing is wired, so a caller can skip the wrapper entirely. */
  get inert(): boolean {
    return this.lifecycle.inert;
  }

  /** Runs a call inside the lifecycle. `fn` receives the context to hand the provider. */
  run<T>(
    call: FamilyCallDescriptor,
    fn: (context: ProviderCallContext) => Promise<T>,
    settle?: (result: T) => { cost?: number },
  ): Promise<T> {
    return this.lifecycle.run(
      {
        family: familyOf(this.family),
        operation: call.operation,
        ...(call.requestId ? { requestId: call.requestId } : {}),
        ...(call.provider ? { provider: call.provider } : {}),
        ...(call.model ? { model: call.model } : {}),
        ...(call.userId ? { userId: call.userId } : {}),
        ...(call.tenantId ? { tenantId: call.tenantId } : {}),
        ...(call.metadata ? { metadata: call.metadata } : {}),
      },
      {
        estimate: () => call.estimate,
        execute: fn,
        ...(settle ? { settle } : {}),
      },
      {
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
      },
    );
  }
}

/** The family a manager names, as the lifecycle spells it. */
function familyOf(name: string): OperationFamily {
  return (name === 'images' ? 'image' : name === 'embeddings' ? 'embedding' : name) as OperationFamily;
}
