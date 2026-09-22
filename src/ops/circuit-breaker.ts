import type { CircuitCoordinator } from './circuit-sync.js';

/**
 * Where a circuit stands: `closed` lets traffic through, `open` refuses it, `half-open` admits
 * probes.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /** Turns the breaker on. Off by default. */
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
  /**
   * Decides whether a failure counts against the circuit. Defaults to counting every failure except
   * a cancellation by the caller, which says nothing about the provider's health.
   */
  isFailure?: (error: unknown) => boolean;
  /** Called on every state change. */
  onStateChange?: (event: CircuitStateChange) => void;
  /**
   * Shares circuit decisions across processes. Without it each worker learns on its own, which is
   * the right default for one process; with it, a provider that fails in one worker is taken out of
   * routing in all of them, and only one worker probes it when the cooldown ends. Adapters live in
   * `nexus-ai-pro/ops/circuit-store` and `nexus-ai-pro/postgres/circuits`.
   */
  store?: CircuitStateStore;
  /** Names this worker in shared state. Defaults to a random id. */
  workerId?: string;
  /** Shared state is refreshed at most this often, on the next check that needs it. Defaults to 1 second. */
  syncIntervalMs?: number;
  /** How long one worker holds the right to probe. Defaults to 30 seconds. */
  probeLeaseMs?: number;
  /** Called when the shared store cannot be read or written. The breaker keeps working locally. */
  onStoreError?: (error: unknown) => void;
  /** Replaces the system clock, for tests. */
  now?: () => number;
}

/** A circuit changing state. */
export interface CircuitStateChange {
  /** The provider whose circuit changed. */
  providerName: string;
  /** The state it left. */
  from: CircuitState;
  /** The state it entered. */
  to: CircuitState;
  /** ISO-8601 time of the change. */
  at: string;
  /** Why it changed, such as `consecutive failure threshold reached`. */
  reason: string;
}

/** One circuit's state, for a health endpoint or dashboard. */
export interface CircuitSnapshot {
  /** The provider. */
  providerName: string;
  /** Its state. */
  state: CircuitState;
  /** Failures in a row. */
  consecutiveFailures: number;
  /** Calls counted inside the rolling window. */
  windowCalls: number;
  /** Failures inside the rolling window. */
  windowFailures: number;
  /** Share of calls in the window that failed. */
  failureRate: number;
  /** ISO-8601 time the circuit opened. */
  openedAt?: string;
  /** When a probe will be allowed, while the circuit is open. */
  retryAt?: string;
  /** The most recent error, as text. */
  lastError?: string;
}

/** A circuit decision as every worker sees it. */
export interface SharedCircuitState {
  /** The provider. */
  providerName: string;
  /** Open or closed. Half-open is never shared; it belongs to the worker holding the probe. */
  state: 'open' | 'closed';
  /** Epoch milliseconds when the circuit opened. Present while open. */
  openedAt?: number;
  /** Epoch milliseconds of the transition that wrote this state. The newest transition wins. */
  updatedAt: number;
  /** The worker that wrote it. */
  updatedBy: string;
  /** Why it changed. */
  reason?: string;
  /** The error that opened it. */
  lastError?: string;
}

/**
 * Where shared circuit decisions live.
 *
 * Only decisions are shared — open, closed, and who may probe. Each worker still counts its own
 * failures, because a shared counter would put a network round trip on every call's hot path.
 */
export interface CircuitStateStore {
  /** Every circuit the store knows about. One entry per provider, so this stays small. */
  read(): Promise<SharedCircuitState[]> | SharedCircuitState[];
  /** Records a transition. A write older than the stored state must not replace it. */
  write(state: SharedCircuitState): Promise<void> | void;
  /**
   * Claims the right to send the half-open probe. One worker holds it until `ttlMs` passes, so a
   * recovering provider is probed once rather than by every replica at the same moment.
   */
  claimProbe(providerName: string, owner: string, ttlMs: number): Promise<boolean> | boolean;
}

/** @internal A circuit's local state. Shared with the coordinator module, never exported publicly. */
export interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  /** Timestamps of calls in the rolling window, paired with whether each failed. */
  window: Array<{ at: number; failed: boolean }>;
  openedAt?: number;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
  lastError?: string;
  /** When this worker last changed or adopted the state, for ordering against shared writes. */
  changedAt: number;
  /** True once this worker holds the shared right to probe the current cooldown. */
  probeClaimed: boolean;
  /** Why the circuit last changed state. */
  reason?: string;
}

/**
 * Trips routing away from a provider that is failing.
 *
 * `ProviderHealthMonitor` already scores providers, and the auto-router already penalizes an
 * unhealthy one. A breaker is the stronger step: while a circuit is open the provider is removed
 * from routing entirely rather than merely ranked lower, so a hard-down provider stops absorbing
 * one attempt per request. After a cooldown a limited number of probes decide whether it recovered.
 *
 * State is per process unless a `store` is configured. Every check stays synchronous either way:
 * shared state is refreshed in the background, on the first check after `syncIntervalMs`, so the
 * breaker never puts a network call in front of a request.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly now: () => number;
  /** Shared-state logic, loaded only when a store is configured. */
  private coordinator: CircuitCoordinator | undefined;
  private readonly coordinatorReady: Promise<void> | undefined;

  constructor(private readonly config: CircuitBreakerConfig = {}) {
    this.now = config.now ?? (() => Date.now());
    if (config.store && config.enabled === true) {
      const workerId = config.workerId ?? `worker-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      this.coordinatorReady = import('./circuit-sync.js').then(({ CircuitCoordinator }) => {
        this.coordinator = new CircuitCoordinator({
          config,
          workerId,
          now: this.now,
          entry: (name) => this.entry(name),
          names: () => this.entries.keys(),
          transition: (name, entry, to, reason, options) => this.transition(name, entry, to, reason, options),
          refresh: (name, entry) => this.refreshState(name, entry),
        });
        this.coordinator.reconcile();
      });
    }
  }

  /** Whether the breaker is on. */
  get enabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Whether a call may proceed.
   *
   * Consumes a half-open probe slot when it returns true in that state, so concurrent callers do
   * not all rush a provider that has only just come back. The slot is released by
   * `recordSuccess()` or `recordFailure()`.
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

  /** Whether the circuit currently refuses traffic. */
  isOpen(providerName: string): boolean {
    return this.state(providerName) === 'open';
  }

  /** Providers whose circuit currently refuses traffic. */
  openProviders(): string[] {
    if (!this.enabled) return [];
    this.coordinator?.tick();
    const open: string[] = [];
    for (const name of this.entries.keys()) {
      if (this.state(name) === 'open') open.push(name);
    }
    return open;
  }

  /** Records a successful call. A successful probe closes the circuit. */
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

  /** Records a failed call. Enough failures, or a failed probe, open the circuit. */
  recordFailure(providerName: string, error?: unknown): void {
    if (!this.enabled) return;
    const entry = this.entry(providerName);
    this.refreshState(providerName, entry);

    const counts = this.config.isFailure ? this.config.isFailure(error) : !isCancellation(error);
    if (!counts) {
      // The attempt ended without saying anything about the provider, but it still held a probe
      // slot; keeping the slot would leave the circuit half-open and refusing traffic forever.
      if (entry.state === 'half-open') entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      return;
    }

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

  /** Every circuit's state, or one provider's. */
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

  /**
   * Forces a circuit closed, for an operator override or a test. With a shared store the override
   * is published, so every worker closes the circuit rather than only this one.
   */
  reset(providerName?: string): void {
    this.coordinator?.reset(providerName ? [providerName] : [...this.entries.keys()]);
    if (providerName) {
      this.entries.delete(providerName);
      return;
    }
    this.entries.clear();
  }

  /**
   * Reads shared state now, adopting decisions other workers made and claiming a probe when this
   * worker's cooldown has elapsed. Checks call it in the background on their own; await it at
   * startup so the first request already knows which providers are open elsewhere.
   */
  async sync(): Promise<void> {
    await this.coordinatorReady;
    await this.coordinator?.sync();
  }

  /** Waits for transitions this worker has published. For tests and graceful shutdown. */
  async flush(): Promise<void> {
    await this.coordinatorReady;
    await this.coordinator?.flush();
  }

  private refreshState(providerName: string, entry: CircuitEntry): void {
    this.trimWindow(entry);
    if (entry.state !== 'open' || entry.openedAt === undefined) return;

    const resetTimeoutMs = this.config.resetTimeoutMs ?? 30_000;
    if (this.now() - entry.openedAt >= resetTimeoutMs) {
      // With a reachable store, only the worker that holds the probe goes half-open; the rest stay
      // open until that probe settles the question for everyone.
      if (this.config.store && !this.coordinator?.mayProbe(entry)) {
        this.coordinator?.tick();
        return;
      }
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
      this.transition(providerName, entry, 'half-open', 'cooldown elapsed');
    }
  }

  private transition(
    providerName: string,
    entry: CircuitEntry,
    to: CircuitState,
    reason: string,
    options: { openedAt?: number; publish?: boolean } = {},
  ): void {
    const from = entry.state;
    if (from === to && to !== 'open') return;

    entry.state = to;
    entry.reason = reason;
    if (to === 'open') {
      entry.openedAt = options.openedAt ?? this.now();
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
      entry.probeClaimed = false;
    }
    if (to === 'closed') {
      entry.openedAt = undefined;
      entry.consecutiveFailures = 0;
      entry.window = [];
      entry.halfOpenInFlight = 0;
      entry.halfOpenSuccesses = 0;
      entry.probeClaimed = false;
    }

    if (to !== 'half-open' && options.publish !== false) this.coordinator?.published(providerName, entry, to, reason);

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
        changedAt: Number.NEGATIVE_INFINITY,
        probeClaimed: false,
      };
      this.entries.set(providerName, entry);
    }
    return entry;
  }
}

/** A caller cancelling a request, which is not the provider's fault. */
function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { category?: unknown; name?: unknown };
  return candidate.category === 'abort' || candidate.name === 'AbortError';
}
