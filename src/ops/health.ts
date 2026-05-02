export interface ProviderHealthSnapshot {
  providerName: string;
  healthy: boolean;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastError?: string;
  lastCheckedAt?: string;
  score: number;
}

export interface HealthConfig {
  enabled?: boolean;
  failureThreshold?: number;
  latencyHalfLife?: number;
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

export class ProviderHealthMonitor {
  private states = new Map<string, ProviderHealthState>();

  constructor(private config: HealthConfig = {}) {}

  recordSuccess(providerName: string, latencyMs: number): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.avgLatencyMs = state.avgLatencyMs
      ? state.avgLatencyMs * 0.7 + latencyMs * 0.3
      : latencyMs;
    state.lastCheckedAt = new Date().toISOString();
  }

  recordFailure(providerName: string, error: unknown): void {
    if (!this.config.enabled) return;
    const state = this.state(providerName);
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message : String(error);
    state.lastCheckedAt = new Date().toISOString();
  }

  snapshot(providerName?: string): ProviderHealthSnapshot[] {
    const names = providerName ? [providerName] : [...this.states.keys()];
    return names.map((name) => this.snapshotOne(name));
  }

  score(providerName: string): number {
    return this.snapshotOne(providerName).score;
  }

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
