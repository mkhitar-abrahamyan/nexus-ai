import type { RateLimitConfig } from '../types/config.js';
import type { AuditLogger } from './audit-logger.js';
import type { MetricsCollector } from './metrics.js';
import type { RateLimiter } from './rate-limiter.js';

/**
 * Shared observability wiring handed to an operation family.
 *
 * Passed down from `NexusAI` so every family reports into the same collector, audit log, and rate
 * limiter. Each field is optional, so a family constructed standalone still works and simply
 * records nothing.
 */
export interface FamilyRuntime {
  metrics?: MetricsCollector;
  auditLogger?: AuditLogger;
  rateLimiter?: RateLimiter;
  rateLimit?: RateLimitConfig;
}

export interface FamilyCallDescriptor {
  /** Operation name recorded as a metric label, such as `transcribe` or `images.generate`. */
  operation: string;
  provider?: string;
  model?: string;
  userId?: string;
  requestId?: string;
  /** Extra fields for the audit event. Never include raw media or credentials. */
  metadata?: Record<string, unknown>;
}

/**
 * Wraps one family call in the platform's rate limit, audit log, and metrics.
 *
 * Extracted rather than repeated in each manager: images, voice, and telephony need the same five
 * steps in the same order, and three hand-written copies would drift. Keeping it in one place also
 * means a family added later inherits the behavior by using this instead of remembering the order.
 *
 * Cost is deliberately not recorded here. Media and telephony providers price per second, per
 * image, or per minute, and inventing a number for a metric named after tokens would be worse than
 * reporting none.
 */
export class FamilyTelemetry {
  private readonly metrics?: MetricsCollector;
  private readonly auditLogger?: AuditLogger;
  private readonly rateLimiter?: RateLimiter;
  private readonly rateLimit?: RateLimitConfig;

  constructor(
    private readonly family: string,
    runtime: FamilyRuntime = {},
  ) {
    this.metrics = runtime.metrics;
    this.auditLogger = runtime.auditLogger;
    this.rateLimiter = runtime.rateLimiter;
    this.rateLimit = runtime.rateLimit;
  }

  /** True when nothing is wired, so a caller can skip the wrapper entirely. */
  get inert(): boolean {
    return !this.metrics && !this.auditLogger && !this.rateLimiter;
  }

  async run<T>(call: FamilyCallDescriptor, fn: () => Promise<T>): Promise<T> {
    const labels = this.labels(call);
    const startedAt = Date.now();

    try {
      await this.metrics?.recordRequest(labels);
      await this.checkRateLimit(call);
      await this.audit('request', call);

      const result = await fn();

      await this.audit('response', call);
      await this.metrics?.recordResponse(labels, Date.now() - startedAt);
      return result;
    } catch (error) {
      await this.metrics?.recordError(labels);
      throw error;
    }
  }

  private async checkRateLimit(call: FamilyCallDescriptor): Promise<void> {
    if (!this.rateLimiter || !this.rateLimit?.enabled) return;
    const request = { model: call.model ?? `${this.family}:${call.operation}`, userId: call.userId };
    if (this.rateLimit.store) await this.rateLimiter.checkAsync(request, this.rateLimit);
    else this.rateLimiter.check(request, this.rateLimit);
  }

  private async audit(type: 'request' | 'response', call: FamilyCallDescriptor): Promise<void> {
    await this.auditLogger?.log({
      type,
      requestId: call.requestId,
      userId: call.userId,
      model: call.model,
      provider: call.provider,
      timestamp: new Date().toISOString(),
      metadata: { family: this.family, operation: call.operation, ...call.metadata },
    });
  }

  private labels(call: FamilyCallDescriptor): Record<string, string> {
    const labels: Record<string, string> = { family: this.family, operation: call.operation };
    if (call.provider) labels.provider = call.provider;
    if (call.model) labels.model = call.model;
    return labels;
  }
}
