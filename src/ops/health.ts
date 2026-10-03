/** One provider's health, as tracked from real calls. */
export interface ProviderHealthSnapshot {
  /** The provider. */
  providerName: string;
  /** True when it is under the failure threshold and at or above the minimum score. */
  healthy: boolean;
  /** Successful calls recorded. */
  successes: number;
  /** Failed calls recorded. */
  failures: number;
  /** Failures in a row. */
  consecutiveFailures: number;
  /** Moving average of latency, in milliseconds. */
  avgLatencyMs: number;
  /** The most recent error, as text. */
  lastError?: string;
  /** ISO-8601 time of the last recorded call. */
  lastCheckedAt?: string;
  /**
   * From 0 to 100: 100, less 20 per consecutive failure up to 60, less 1 per second of average
   * latency up to 30.
   */
  score: number;
  /**
   * `unknown` with no recent calls to judge by, `unhealthy` past the failure threshold or under the
   * minimum score, `degraded` when calls are failing or slow but not enough to stop routing to it,
   * and `healthy` otherwise. Always set by `ProviderHealthMonitor`; optional so a hand-built snapshot
   * still type-checks.
   */
  status?: ProviderHealthStatus;
  /** True when the last call is older than `observationTtlMs`, so the figures above are old news. */
  stale?: boolean;
}

/** Where a provider stands, by what its recent calls say. */
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Health tracking for providers, used to route around unhealthy ones. */
export interface HealthConfig {
  /** Turns tracking on. Off by default, and then nothing is recorded. */
  enabled?: boolean;
  /** Consecutive failures that mark a provider unhealthy. Defaults to 3. */
  failureThreshold?: number;
  /** Score below which a provider is unhealthy. Defaults to 20. */
  minScore?: number;
  /**
   * How long a call's outcome counts, in milliseconds. A provider whose last call is older is
   * `unknown`, and is routed to as a provider never seen is, rather than kept down for a failure
   * hours ago or kept up for a success days ago. `checkProviders({ staleOnly: true })` refreshes it.
   * Defaults to never expiring, as before.
   */
  observationTtlMs?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

interface ProviderHealthState {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastError?: string;
  lastCheckedAt?: string;
}

/** Tracks provider health from call outcomes and scores each provider for routing. */
export class ProviderHealthMonitor {
  private states = new Map<string, ProviderHealthState>();

  constructor(private config: HealthConfig = {}) {}

  private nowDate(): Date {
    return this.config.now?.() ?? new Date();
  }

  /** Records a successful call and its latency. */
  recordSuccess(providerName: string, latencyMs: number): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    state.successes += 1;
    state.consecutiveFailures = 0;
    if (this.isStale(state)) Object.assign(state, freshState());
    state.avgLatencyMs = state.avgLatencyMs ? state.avgLatencyMs * 0.7 + latencyMs * 0.3 : latencyMs;
    state.lastCheckedAt = this.nowDate().toISOString();
  }

  /** Records a failed call. */
  recordFailure(providerName: string, error: unknown): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    // An old streak is not this one: a failure after a quiet spell starts counting again.
    if (this.isStale(state)) state.consecutiveFailures = 0;
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
    state.lastCheckedAt = this.nowDate().toISOString();
  }

  /** Every provider's health, or one provider's. */
  snapshot(providerName?: string): ProviderHealthSnapshot[] {
    const names = providerName ? [providerName] : [...this.states.keys()];
    return names.map((name) => this.snapshotOne(name));
  }

  /** A provider's score, from 0 to 100. */
  score(providerName: string): number {
    return this.snapshotOne(providerName).score;
  }

  /** Whether a provider is healthy. */
  isHealthy(providerName: string): boolean {
    return this.snapshotOne(providerName).healthy;
  }

  /** Whether a provider's figures are too old to judge by, or there are none. */
  isUnknown(providerName: string): boolean {
    return this.snapshotOne(providerName).status === 'unknown';
  }

  private isStale(state: ProviderHealthState): boolean {
    const ttl = this.config.observationTtlMs;
    if (ttl === undefined || !state.lastCheckedAt) return false;
    return this.nowDate().getTime() - Date.parse(state.lastCheckedAt) > ttl;
  }

  private snapshotOne(providerName: string): ProviderHealthSnapshot {
    const recorded = this.state(providerName);
    const stale = this.isStale(recorded);
    // Old figures are judged as no figures: the provider is routed to as one never seen.
    const state = stale
      ? { ...freshState(), lastError: recorded.lastError, lastCheckedAt: recorded.lastCheckedAt }
      : recorded;
    const failureThreshold = this.config.failureThreshold || 3;
    const failurePenalty = Math.min(60, state.consecutiveFailures * 20);
    const latencyPenalty = Math.min(30, state.avgLatencyMs / 1000);
    const score = Math.max(0, 100 - failurePenalty - latencyPenalty);
    const minScore = this.config.minScore ?? 20;

    const healthy = state.consecutiveFailures < failureThreshold && score >= minScore;
    const seen = recorded.successes + recorded.failures > 0;
    return {
      providerName,
      healthy,
      status:
        stale || !seen
          ? 'unknown'
          : !healthy
            ? 'unhealthy'
            : state.consecutiveFailures > 0 || score < 70
              ? 'degraded'
              : 'healthy',
      stale,
      successes: state.successes,
      failures: state.failures,
      consecutiveFailures: state.consecutiveFailures,
      avgLatencyMs: Math.round(state.avgLatencyMs),
      lastError: state.lastError,
      lastCheckedAt: state.lastCheckedAt,
      score,
    };
  }

  private state(providerName: string): ProviderHealthState {
    let state = this.states.get(providerName);
    if (!state) {
      state = freshState();
      this.states.set(providerName, state);
    }
    return state;
  }
}

function freshState(): ProviderHealthState {
  return { successes: 0, failures: 0, consecutiveFailures: 0, avgLatencyMs: 0 };
}
