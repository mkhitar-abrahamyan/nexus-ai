export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  enabled?: boolean;
  /** Consecutive failures that open the circuit. Defaults to 5. */
  failureThreshold?: number;
  /**
   * Failure fraction within the window that opens the circuit, between 0 and 1.
   *
   * Catches a provider that fails most calls without ever failing several in a row, which a
   * consecutive-failure count alone cannot see. Only applied once `minimumThroughput` calls have
   * been observed, because one failure out of two is not evidence of anything.
   */
  failureRateThreshold?: number;
  /** Calls needed before `failureRateThreshold` is considered. Defaults to 10. */
  minimumThroughput?: number;
  /** Rolling window for the failure rate. Defaults to 60 seconds. */
  windowMs?: number;
  /** How long the circuit stays open before allowing a probe. Defaults to 30 seconds. */
  resetTimeoutMs?: number;
  /** Concurrent probes allowed while half-open. Defaults to 1. */
  halfOpenMaxCalls?: number;
  /** Probe successes needed to close the circuit again. Defaults to 1. */
  successThreshold?: number;
  /** Decides whether a failure counts against the circuit. Defaults to counting every failure. */
  isFailure?: (error: unknown) => boolean;
  onStateChange?: (event: CircuitStateChange) => void;
  now?: () => number;
}

export interface CircuitStateChange {
  providerName: string;
  from: CircuitState;
  to: CircuitState;
  at: string;
  reason: string;
}

export interface CircuitSnapshot {
  providerName: string;
  state: CircuitState;
  consecutiveFailures: number;
  /** Calls counted inside the rolling window. */
  windowCalls: number;
  windowFailures: number;
  failureRate: number;
  openedAt?: string;
  /** When a probe will be allowed, while the circuit is open. */
  retryAt?: string;
  lastError?: string;
}

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  /** Timestamps of calls in the rolling window, paired with whether each failed. */
  window: Array<{ at: number; failed: boolean }>;
  openedAt?: number;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
  lastError?: string;
}

/**
 * Trips routing away from a provider that is failing.
 *
 * `ProviderHealthMonitor` already scores providers, and the auto-router already penalizes an
 * unhealthy one. A breaker is the stronger step: while a circuit is open the provider is removed
 * from routing entirely rather than merely ranked lower, so a hard-down provider stops absorbing
 * one attempt per request. After a cooldown a limited number of probes decide whether it recovered.
 *
 * State is per process. Sharing it across workers would need a distributed store, and a breaker
 * that disagrees between workers is worse than one that each worker learns for itself.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly now: () => number;

  constructor(private readonly config: CircuitBreakerConfig = {}) {
    this.now = config.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Whether a call may proceed.
   *
   * Consumes a half-open probe slot when it returns true in that state, so concurrent callers do
   * not all rush a provider that has only just come back.
   */
  allowRequest(providerName: string): boolean {
    if (!this.enabled) return true;
    const entry = this.entry(providerName);
    this.refreshState(providerName, entry);

    if (entry.state === 'closed') return true;
    if (entry.state === 'open') return false;

    const maxCalls = this.config.halfOpenMaxCalls ?? 1;
    if (entry.halfOpenInFlight >= maxCalls) return false;
    entry.halfOpenInFlight += 1;
    return true;
  }

  /** Current state, after applying any elapsed cooldown. */
  state(providerName: string): CircuitState {
    if (!this.enabled) return 'closed';
    const entry = this.entry(providerName);
    this.refreshState(providerName, entry);
    return entry.state;
  }

  isOpen(providerName: string): boolean {
    return this.state(providerName) === 'open';
  }

  /** Providers whose circuit currently refuses traffic. */
  openProviders(): string[] {
    if (!this.enabled) return [];
    const open: string[] = [];
    for (const name of this.entries.keys()) {
      if (this.state(name) === 'open') open.push(name);
    }
    return open;
  }

  recordSuccess(providerName: string): void {
    if (!this.enabled) return;
    const entry = this.entry(providerName);
    this.refreshState(providerName, entry);
    this.pushWindow(entry, false);
    entry.consecutiveFailures = 0;

    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      entry.halfOpenSuccesses += 1;
      if (entry.halfOpenSuccesses >= (this.config.successThreshold ?? 1)) {
        this.transition(providerName, entry, 'closed', 'probe succeeded');
      }
    }
  }

  recordFailure(providerName: string, error?: unknown): void {
    if (!this.enabled) return;
    if (this.config.isFailure && !this.config.isFailure(error)) return;

    const entry = this.entry(providerName);
    this.refreshState(providerName, entry);
    this.pushWindow(entry, true);
    entry.consecutiveFailures += 1;
    entry.lastError = error instanceof Error ? error.message : error === undefined ? undefined : String(error);

    if (entry.state === 'half-open') {
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      // A failed probe means the provider is still down, so the cooldown restarts from now.
      this.transition(providerName, entry, 'open', 'probe failed');
      return;
    }

    if (entry.consecutiveFailures >= (this.config.failureThreshold ?? 5)) {
      this.transition(providerName, entry, 'open', 'consecutive failure threshold reached');
      return;
    }

    const rateThreshold = this.config.failureRateThreshold;
    if (rateThreshold !== undefined) {
      const minimum = this.config.minimumThroughput ?? 10;
      if (entry.window.length >= minimum && this.failureRate(entry) >= rateThreshold) {
        this.transition(providerName, entry, 'open', 'failure rate threshold reached');
      }
    }
  }

  snapshot(providerName?: string): CircuitSnapshot[] {
    const names = providerName ? [providerName] : [...this.entries.keys()];
    return names.map((name) => {
      const entry = this.entry(name);
      this.refreshState(name, entry);
      const resetTimeoutMs = this.config.resetTimeoutMs ?? 30_000;
      return {
        providerName: name,
        state: entry.state,
        consecutiveFailures: entry.consecutiveFailures,
        windowCalls: entry.window.length,
        windowFailures: entry.window.filter((call) => call.failed).length,
        failureRate: this.failureRate(entry),
        openedAt: entry.openedAt === undefined ? undefined : new Date(entry.openedAt).toISOString(),
        retryAt:
          entry.state === 'open' && entry.openedAt !== undefined
            ? new Date(entry.openedAt + resetTimeoutMs).toISOString()
            : undefined,
        lastError: entry.lastError,
      };
    });
  }

  /** Forces a circuit closed, for an operator override or a test. */
  reset(providerName?: string): void {
    if (providerName) {
      this.entries.delete(providerName);
      return;
    }
    this.entries.clear();
  }

  private refreshState(providerName: string, entry: CircuitEntry): void {
    this.trimWindow(entry);
    if (entry.state !== 'open' || entry.openedAt === undefined) return;

    const resetTimeoutMs = this.config.resetTimeoutMs ?? 30_000;
    if (this.now() - entry.openedAt >= resetTimeoutMs) {
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
      this.transition(providerName, entry, 'half-open', 'cooldown elapsed');
    }
  }

  private transition(providerName: string, entry: CircuitEntry, to: CircuitState, reason: string): void {
    const from = entry.state;
    if (from === to && to !== 'open') return;

    entry.state = to;
    if (to === 'open') {
      entry.openedAt = this.now();
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
    }
    if (to === 'closed') {
      entry.openedAt = undefined;
      entry.consecutiveFailures = 0;
      entry.window = [];
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
    }

    if (from !== to) {
      this.config.onStateChange?.({
        providerName,
        from,
        to,
        at: new Date(this.now()).toISOString(),
        reason,
      });
    }
  }

  private pushWindow(entry: CircuitEntry, failed: boolean): void {
    entry.window.push({ at: this.now(), failed });
    this.trimWindow(entry);
  }

  private trimWindow(entry: CircuitEntry): void {
    const windowMs = this.config.windowMs ?? 60_000;
    const cutoff = this.now() - windowMs;
    while (entry.window.length > 0 && (entry.window[0] as { at: number }).at < cutoff) {
      entry.window.shift();
    }
  }

  private failureRate(entry: CircuitEntry): number {
    if (entry.window.length === 0) return 0;
    const failures = entry.window.reduce((total, call) => total + (call.failed ? 1 : 0), 0);
    return failures / entry.window.length;
  }

  private entry(providerName: string): CircuitEntry {
    let entry = this.entries.get(providerName);
    if (!entry) {
      entry = {
        state: 'closed',
        consecutiveFailures: 0,
        window: [],
        halfOpenInFlight: 0,
        halfOpenSuccesses: 0,
      };
      this.entries.set(providerName, entry);
    }
    return entry;
  }
}
