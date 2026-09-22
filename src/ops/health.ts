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
}

/** Health tracking for providers, used to route around unhealthy ones. */
export interface HealthConfig {
  /** Turns tracking on. Off by default, and then nothing is recorded. */
  enabled?: boolean;
  /** Consecutive failures that mark a provider unhealthy. Defaults to 3. */
  failureThreshold?: number;
  /**
   * Ignored: latency is always averaged with a fixed weight of 0.3 for the newest call.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  latencyHalfLife?: number;
  /** Score below which a provider is unhealthy. Defaults to 20. */
  minScore?: number;
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

  /** Records a successful call and its latency. */
  recordSuccess(providerName: string, latencyMs: number): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.avgLatencyMs = state.avgLatencyMs ? state.avgLatencyMs * 0.7 + latencyMs * 0.3 : latencyMs;
    state.lastCheckedAt = new Date().toISOString();
  }

  /** Records a failed call. */
  recordFailure(providerName: string, error: unknown): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
    state.lastCheckedAt = new Date().toISOString();
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

  private snapshotOne(providerName: string): ProviderHealthSnapshot {
    const state = this.state(providerName);
    const failureThreshold = this.config.failureThreshold || 3;
    const failurePenalty = Math.min(60, state.consecutiveFailures * 20);
    const latencyPenalty = Math.min(30, state.avgLatencyMs / 1000);
    const score = Math.max(0, 100 - failurePenalty - latencyPenalty);
    const minScore = this.config.minScore ?? 20;

    return {
      providerName,
      healthy: state.consecutiveFailures < failureThreshold && score >= minScore,
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
      state = {
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        avgLatencyMs: 0,
      };
      this.states.set(providerName, state);
    }
    return state;
  }
}
