import type { CompletionRequest } from '../types/messages.js';
import type { NexusAIConfig } from '../types/config.js';
import type { BaseProvider } from '../providers/base.js';
import type { ProviderHealthSnapshot } from '../ops/health.js';

/** One provider and model to try, with limits that apply to this attempt only. */
export interface RouteAttempt {
  /** The provider to call. */
  providerName: string;
  /** The model to request from it. */
  model: string;
  /** Replaces the request's timeout for this attempt, in milliseconds. */
  timeoutMs?: number;
  /** Retries a rate-limited attempt on the same provider before moving on to the next one. */
  rateLimit?: { retryAfterMs: number; maxRetries: number };
}

/** Where a request goes: the provider and model to try first, and what to try if they fail. */
export interface RouteDecision {
  /** The provider tried first. */
  providerName: string;
  /** The model tried first. */
  model: string;
  /** Why the router chose it, for logs and response metadata. */
  reason: string;
  /** Tried in order when the first attempt fails. */
  fallbacks: RouteAttempt[];
  /** Limits for the first attempt, from `routing.fallback`. */
  primary?: Pick<RouteAttempt, 'timeoutMs' | 'rateLimit'>;
}

/** What a routing strategy sees when it picks a provider. */
export interface RouterContext {
  /** The request being routed. */
  request: CompletionRequest;
  /** The client configuration. */
  config: NexusAIConfig;
  /** Configured providers, by name. */
  providers: Map<string, BaseProvider>;
  /** Provider health, when health tracking is on. */
  health?: ProviderHealthSnapshot[];
  /**
   * Providers whose circuit is open, excluded from routing entirely.
   *
   * Distinct from an unhealthy provider, which is only ranked lower: an open circuit means the
   * provider is not tried at all until its cooldown elapses.
   */
  openCircuits?: readonly string[];
}
