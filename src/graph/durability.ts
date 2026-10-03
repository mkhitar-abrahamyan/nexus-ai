import type { DurabilityMode } from '../types/graph.js';

const DEFAULT_MAX_PENDING = 8;

/**
 * Writes one run's checkpoints under a durability mode.
 *
 * `sync` writes each one before returning. `async` chains writes behind each other, so they land in
 * order, and makes the run wait only when `maxPending` are already in flight. `exit` keeps only the
 * latest and writes it when the run stops. A write that fails is kept and thrown from the next call,
 * so a background failure still fails the run.
 */
export class CheckpointWriter<T> {
  private chain: Promise<void> = Promise.resolve();
  private readonly inFlight: Array<Promise<void>> = [];
  private failure: { error: unknown } | undefined;
  private unwritten: T | undefined;

  constructor(
    private readonly write: (checkpoint: T) => Promise<void>,
    private readonly mode: DurabilityMode,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {}

  /**
   * Hands over a checkpoint. A `durable` one is persisted, with everything before it, before this
   * resolves, whatever the mode: a pause, a failure, the end of a run, or a recovery decision.
   */
  async persist(checkpoint: T, durable = false): Promise<void> {
    this.throwFailure();
    if (this.mode === 'sync') {
      await this.write(checkpoint);
      return;
    }
    if (this.mode === 'exit' && !durable) {
      this.unwritten = checkpoint;
      return;
    }
    if (this.mode === 'exit') {
      this.unwritten = undefined;
      await this.write(checkpoint);
      return;
    }

    // The chain continues past a failure, so later writes still run in order; the failure is kept.
    const link: Promise<void> = this.chain
      .then(() => this.write(checkpoint))
      .catch((error: unknown) => {
        this.failure ??= { error };
      })
      .finally(() => {
        const index = this.inFlight.indexOf(link);
        if (index >= 0) this.inFlight.splice(index, 1);
      });
    this.chain = link;
    this.inFlight.push(link);
    if (durable) {
      await this.flush();
      return;
    }
    // Backpressure: a store that falls behind slows the graph down instead of growing memory.
    while (this.inFlight.length > Math.max(1, this.maxPending)) await this.inFlight[0];
    this.throwFailure();
  }

  /** Waits for every write handed over so far, and writes what `exit` mode was holding. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.unwritten !== undefined) {
      const latest = this.unwritten;
      this.unwritten = undefined;
      await this.write(latest);
    }
    this.throwFailure();
  }

  private throwFailure(): void {
    if (!this.failure) return;
    const { error } = this.failure;
    this.failure = undefined;
    throw error;
  }
}
