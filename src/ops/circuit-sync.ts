import type {
  CircuitBreakerConfig,
  CircuitEntry,
  CircuitState,
  CircuitStateStore,
  CircuitWindow,
  SharedCircuitState,
} from './circuit-breaker.js';

/**
 * Shared circuit state for `CircuitBreaker`, loaded only when a `store` is configured.
 *
 * Kept out of the breaker's own module so that a per-process breaker — the default, and the right
 * choice for one process — does not carry the code that coordinates several.
 */

/** @internal What the coordinator needs from the breaker it serves. */
export interface CircuitHost {
  readonly config: CircuitBreakerConfig;
  readonly workerId: string;
  now(): number;
  entry(providerName: string): CircuitEntry;
  names(): Iterable<string>;
  transition(
    providerName: string,
    entry: CircuitEntry,
    to: CircuitState,
    reason: string,
    options?: { openedAt?: number; publish?: boolean },
  ): void;
  refresh(providerName: string, entry: CircuitEntry): void;
}

/** @internal */
export class CircuitCoordinator {
  private readonly pending = new Set<Promise<void>>();
  private syncing: Promise<void> | undefined;
  private lastSyncAt = Number.NEGATIVE_INFINITY;
  /** False after a store failure, until a sync succeeds; the breaker then decides locally. */
  private reachable = true;
  /** Calls not yet added to the shared window, per provider, with `shareObservations`. */
  private readonly unreported = new Map<
    string,
    { buckets: Map<number, { calls: number; failures: number }>; succeeded: boolean; trailing: number }
  >();

  constructor(private readonly host: CircuitHost) {}

  /**
   * Whether this worker may go half-open once a cooldown has elapsed. With a reachable store only
   * the worker holding the probe may; the rest stay open until that probe settles it for everyone.
   */
  mayProbe(entry: CircuitEntry): boolean {
    return !this.reachable || entry.probeClaimed;
  }

  /** Starts a background sync when the last one is older than the interval. Never waits. */
  tick(): void {
    if (this.syncing) return;
    if (this.host.now() - this.lastSyncAt < (this.host.config.syncIntervalMs ?? 1_000)) return;
    void this.sync();
  }

  async sync(): Promise<void> {
    const store = this.host.config.store;
    if (!store) return;
    if (this.syncing) return this.syncing;

    this.syncing = (async () => {
      try {
        this.lastSyncAt = this.host.now();
        // Only awaited with calls to report, so a breaker that shares none reads exactly as before.
        if (this.unreported.size > 0) await this.report(store);
        for (const shared of await store.read()) this.adopt(shared);

        const resetTimeoutMs = this.host.config.resetTimeoutMs ?? 30_000;
        for (const name of [...this.host.names()]) {
          const entry = this.host.entry(name);
          if (entry.state !== 'open' || entry.probeClaimed || entry.openedAt === undefined) continue;
          if (this.host.now() - entry.openedAt < resetTimeoutMs) continue;
          if (await store.claimProbe(name, this.host.workerId, this.host.config.probeLeaseMs ?? 30_000)) {
            entry.probeClaimed = true;
            this.host.refresh(name, entry);
          }
        }
        this.reachable = true;
      } catch (error) {
        this.failed(error);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  /**
   * Counts one call toward the shared window, to be added on the next sync. Cheap and synchronous:
   * a check never waits for the store.
   */
  observed(providerName: string, failed: boolean): void {
    if (!this.host.config.shareObservations || !this.host.config.store?.observe) return;
    const bucketMs = bucketWidth(this.host.config.windowMs ?? 60_000);
    const at = Math.floor(this.host.now() / bucketMs) * bucketMs;
    let pending = this.unreported.get(providerName);
    if (!pending) {
      pending = { buckets: new Map(), succeeded: false, trailing: 0 };
      this.unreported.set(providerName, pending);
    }
    const bucket = pending.buckets.get(at) ?? { calls: 0, failures: 0 };
    bucket.calls += 1;
    if (failed) bucket.failures += 1;
    pending.buckets.set(at, bucket);
    if (failed) pending.trailing += 1;
    else {
      pending.succeeded = true;
      pending.trailing = 0;
    }
    this.tick();
  }

  /** Publishes a transition this worker made. */
  published(providerName: string, entry: CircuitEntry, to: 'open' | 'closed', reason: string): void {
    entry.changedAt = this.stampAfter(entry.changedAt);
    this.publish({
      providerName,
      state: to,
      ...(to === 'open' ? { openedAt: entry.openedAt } : {}),
      updatedAt: entry.changedAt,
      updatedBy: this.host.workerId,
      reason,
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    });
  }

  /** Publishes an operator reset, so every worker closes the circuit rather than only this one. */
  reset(names: Iterable<string>): void {
    for (const name of names) {
      const updatedAt = this.stampAfter(this.host.entry(name).changedAt);
      this.publish({ providerName: name, state: 'closed', updatedAt, updatedBy: this.host.workerId, reason: 'reset' });
    }
  }

  /**
   * Publishes anything that opened before this module finished loading, then starts the first sync.
   * The load takes one turn of the event loop; a circuit opened inside it must not stay local.
   */
  reconcile(): void {
    for (const name of [...this.host.names()]) {
      const entry = this.host.entry(name);
      // Calls made before this module loaded are still in the local window; nothing has been
      // reported yet, so all of them count toward the shared one.
      if (this.host.config.shareObservations && this.host.config.store?.observe && entry.window.length > 0) {
        const bucketMs = bucketWidth(this.host.config.windowMs ?? 60_000);
        const buckets = new Map<number, { calls: number; failures: number }>();
        for (const call of entry.window) {
          const at = Math.floor(call.at / bucketMs) * bucketMs;
          const bucket = buckets.get(at) ?? { calls: 0, failures: 0 };
          bucket.calls += 1;
          if (call.failed) bucket.failures += 1;
          buckets.set(at, bucket);
        }
        this.unreported.set(name, {
          buckets,
          succeeded: entry.window.some((call) => !call.failed),
          trailing: entry.consecutiveFailures,
        });
      }
      if (entry.state === 'open' && entry.changedAt === Number.NEGATIVE_INFINITY) {
        this.published(name, entry, 'open', entry.reason ?? 'opened while shared state was loading');
      }
    }
    this.tick();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Adds this worker's unreported calls to each provider's shared window, then opens a closed circuit
   * whose shared count crossed a threshold. The batch is taken before the first await, so calls made
   * while it is in flight wait for the next sync rather than being lost or counted twice.
   */
  private async report(store: CircuitStateStore): Promise<void> {
    if (!store.observe || this.unreported.size === 0) return;
    const batches = [...this.unreported];
    this.unreported.clear();
    const windowMs = this.host.config.windowMs ?? 60_000;
    for (const [name, pending] of batches) {
      const entry = this.host.entry(name);
      const window = await store.observe(name, {
        buckets: [...pending.buckets].map(([at, bucket]) => ({ at, calls: bucket.calls, failures: bucket.failures })),
        succeeded: pending.succeeded,
        trailingFailures: pending.trailing,
        windowMs,
        bucketMs: bucketWidth(windowMs),
        now: this.host.now(),
        ...(entry.state === 'closed' && Number.isFinite(entry.changedAt) ? { since: entry.changedAt } : {}),
      });
      entry.shared = {
        calls: window.calls,
        failures: window.failures,
        consecutiveFailures: window.consecutiveFailures,
      };
      this.judge(name, entry, window);
    }
  }

  /** Opens a closed circuit whose shared window crossed the breaker's thresholds. */
  private judge(name: string, entry: CircuitEntry, window: CircuitWindow): void {
    if (entry.state !== 'closed') return;
    const config = this.host.config;
    if (window.consecutiveFailures >= (config.failureThreshold ?? 5)) {
      this.host.transition(name, entry, 'open', 'shared failure threshold reached');
      return;
    }
    const rate = config.failureRateThreshold;
    if (
      rate !== undefined &&
      window.calls >= (config.minimumThroughput ?? 10) &&
      window.failures / window.calls >= rate
    ) {
      this.host.transition(name, entry, 'open', 'shared failure rate threshold reached');
    }
  }

  /** Takes a decision another worker published, when it is newer than what this worker knows. */
  private adopt(shared: SharedCircuitState): void {
    const entry = this.host.entry(shared.providerName);
    if (shared.updatedAt <= entry.changedAt) return;
    if (shared.updatedBy !== this.host.workerId) {
      const reason = `${shared.state === 'open' ? 'opened' : 'closed'} by ${shared.updatedBy}${shared.reason ? `: ${shared.reason}` : ''}`;
      if (shared.state === 'open' && (entry.state !== 'open' || entry.openedAt !== shared.openedAt)) {
        this.host.transition(shared.providerName, entry, 'open', reason, { openedAt: shared.openedAt, publish: false });
      } else if (shared.state === 'closed' && entry.state !== 'closed') {
        this.host.transition(shared.providerName, entry, 'closed', reason, { publish: false });
      }
      if (shared.lastError) entry.lastError = shared.lastError;
    }
    entry.changedAt = shared.updatedAt;
  }

  /**
   * A timestamp strictly after the last transition this worker knew of. Two transitions inside one
   * millisecond would otherwise tie, and "newest wins" cannot order a tie.
   */
  private stampAfter(previous: number): number {
    return Math.max(this.host.now(), previous + 1);
  }

  private publish(state: SharedCircuitState): void {
    const store = this.host.config.store;
    if (!store) return;
    const write: Promise<void> = Promise.resolve()
      .then(() => store.write(state))
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.pending.delete(write));
    this.pending.add(write);
  }

  private failed(error: unknown): void {
    this.reachable = false;
    try {
      this.host.config.onStoreError?.(error);
    } catch {
      // A broken error listener must not break routing.
    }
  }
}

/** The width of one shared-window bucket: a twelfth of the window, so a bucket rolling out moves the count by little. */
export function bucketWidth(windowMs: number): number {
  return Math.max(1, Math.floor(windowMs / 12));
}
