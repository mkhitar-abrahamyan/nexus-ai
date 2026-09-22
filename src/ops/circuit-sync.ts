import type { CircuitBreakerConfig, CircuitEntry, CircuitState, SharedCircuitState } from './circuit-breaker.js';

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
      if (entry.state === 'open' && entry.changedAt === Number.NEGATIVE_INFINITY) {
        this.published(name, entry, 'open', entry.reason ?? 'opened while shared state was loading');
      }
    }
    this.tick();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
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
