import type { RunControlLike } from '../types/graph.js';

/**
 * Stops graph runs cleanly: each finishes its current superstep, writes its checkpoint, and ends with
 * `GraphDrainedError`, so another worker can `continue()` it.
 *
 * An abort signal stops a run in the middle of a superstep, cancelling the nodes in flight. A drain
 * waits for them, which is what a rolling deploy, a spot eviction, or a scale-down wants: nothing
 * half done, nothing lost. One control can drain any number of runs at once.
 *
 * @example
 * ```ts
 * const control = new RunControl();
 * process.on('SIGTERM', () => control.drain('sigterm'));
 * await graph.invoke(input, { threadId, control });
 * ```
 */
export class RunControl implements RunControlLike {
  private requested: { reason?: string } | undefined;
  private readonly listeners = new Set<(reason?: string) => void>();

  /** True once `drain()` was called. */
  get draining(): boolean {
    return this.requested !== undefined;
  }

  /** Why the drain was requested. */
  get reason(): string | undefined {
    return this.requested?.reason;
  }

  /** Asks every run using this control to stop after its current superstep. A second call is ignored. */
  drain(reason?: string): void {
    if (this.requested) return;
    this.requested = { reason };
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        // A listener is told; it cannot stop the drain.
      }
    }
  }

  /** Calls `listener` when a drain is requested. Returns a function that removes it. */
  onDrain(listener: (reason?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
