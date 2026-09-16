import type { GraphCheckpoint, GraphCheckpointer } from '../types/graph.js';
import type { OperationRecord, OperationStore } from '../types/operations.js';

export interface MemoryGraphCheckpointerOptions {
  /** Checkpoints kept per thread, newest first. Defaults to 50. */
  maxPerThread?: number;
  /**
   * Threads kept before the least recently written one is dropped. Defaults to 1,000.
   *
   * The cap is what makes this safe as a default: a service that runs graphs without ever resuming
   * them would otherwise grow without bound. Pass `Infinity` to keep every thread.
   */
  maxThreads?: number;
}

/**
 * In-process checkpoint history.
 *
 * The default when `compile()` is given no checkpointer, and enough for a single process that wants
 * interrupts, resume, and time travel without a store. It does not survive a restart;
 * `OperationStoreCheckpointer` does.
 */
export class MemoryGraphCheckpointer implements GraphCheckpointer {
  private readonly threads = new Map<string, GraphCheckpoint[]>();
  private readonly maxPerThread: number;
  private readonly maxThreads: number;

  constructor(options: MemoryGraphCheckpointerOptions = {}) {
    this.maxPerThread = options.maxPerThread ?? 50;
    this.maxThreads = options.maxThreads ?? 1_000;
    if (!(this.maxThreads >= 1)) throw new RangeError('maxThreads must be at least 1');
  }

  put(checkpoint: GraphCheckpoint): void {
    // Writing step N means the thread continues from N. Anything already stored at N or later belongs
    // to a timeline that was rewound or restarted, and would otherwise surface as the "latest" state.
    const list = (this.threads.get(checkpoint.threadId) ?? []).filter((item) => item.step < checkpoint.step);
    list.push(clone(checkpoint));
    list.sort((a, b) => a.step - b.step);
    while (list.length > this.maxPerThread) list.shift();
    // Re-inserting moves the thread to the end, so Map order is least recently written first.
    this.threads.delete(checkpoint.threadId);
    this.threads.set(checkpoint.threadId, list);
    while (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value as string;
      this.threads.delete(oldest);
    }
  }

  get(threadId: string, step?: number): GraphCheckpoint | undefined {
    const list = this.threads.get(threadId);
    if (!list?.length) return undefined;
    const found = step === undefined ? list[list.length - 1] : list.find((item) => item.step === step);
    return found ? clone(found) : undefined;
  }

  history(threadId: string, limit = 20): GraphCheckpoint[] {
    const list = this.threads.get(threadId) ?? [];
    return [...list].reverse().slice(0, limit).map(clone);
  }

  delete(threadId: string): void {
    this.threads.delete(threadId);
  }

  /** Thread ids this checkpointer knows about. */
  threadIds(): string[] {
    return [...this.threads.keys()];
  }
}

export interface OperationStoreCheckpointerOptions {
  /** Checkpoints kept per thread. Defaults to 50. */
  maxPerThread?: number;
}

/**
 * Persists checkpoints through the `OperationStore` that already backs durable operations.
 *
 * This is what makes a graph durable without the graph module depending on the operations runtime:
 * the store is imported as a type only, so `nexus-ai-pro/graph` stays small, and handing it a
 * `RedisOperationStore` is all it takes to make a thread survive a restart.
 *
 * Each checkpoint is one record at `<threadId>#<step>`, with a head record at `<threadId>` naming
 * the latest step. Two records per superstep, in exchange for time travel and a resume point that
 * another process can read.
 */
export class OperationStoreCheckpointer implements GraphCheckpointer {
  private readonly maxPerThread: number;

  constructor(
    private readonly store: OperationStore<GraphCheckpoint | ThreadHead>,
    options: OperationStoreCheckpointerOptions = {},
  ) {
    this.maxPerThread = options.maxPerThread ?? 50;
  }

  async put(checkpoint: GraphCheckpoint): Promise<void> {
    await this.write(stepId(checkpoint.threadId, checkpoint.step), checkpoint);

    const head = await this.readHead(checkpoint.threadId);
    // As in the memory checkpointer, steps after this one belong to an abandoned timeline.
    for (const stale of head?.steps.filter((step) => step > checkpoint.step) ?? []) {
      await this.store.delete?.(stepId(checkpoint.threadId, stale));
    }
    const kept = (head?.steps ?? []).filter((step) => step < checkpoint.step);
    const steps = [...kept, checkpoint.step];
    while (steps.length > this.maxPerThread) {
      const dropped = steps.shift() as number;
      await this.store.delete?.(stepId(checkpoint.threadId, dropped));
    }
    await this.write(checkpoint.threadId, { kind: 'graph-thread', latest: checkpoint.step, steps });
  }

  async get(threadId: string, step?: number): Promise<GraphCheckpoint | undefined> {
    const target = step ?? (await this.readHead(threadId))?.latest;
    if (target === undefined) return undefined;
    const record = await this.store.read(stepId(threadId, target));
    return record?.result && !isHead(record.result) ? (record.result as GraphCheckpoint) : undefined;
  }

  async history(threadId: string, limit = 20): Promise<GraphCheckpoint[]> {
    const head = await this.readHead(threadId);
    if (!head) return [];
    const wanted = [...head.steps].reverse().slice(0, limit);
    const found: GraphCheckpoint[] = [];
    for (const step of wanted) {
      const checkpoint = await this.get(threadId, step);
      if (checkpoint) found.push(checkpoint);
    }
    return found;
  }

  async delete(threadId: string): Promise<void> {
    const head = await this.readHead(threadId);
    for (const step of head?.steps ?? []) await this.store.delete?.(stepId(threadId, step));
    await this.store.delete?.(threadId);
  }

  private async readHead(threadId: string): Promise<ThreadHead | undefined> {
    const record = await this.store.read(threadId);
    return record?.result && isHead(record.result) ? record.result : undefined;
  }

  /**
   * Writes one record, creating it when absent and otherwise updating in place.
   *
   * `update` is a compare-and-set on the record's sequence, so two workers advancing the same
   * thread cannot both win; the loser simply re-reads on its next step.
   */
  private async write(id: string, value: GraphCheckpoint | ThreadHead): Promise<void> {
    const existing = await this.store.read(id);
    const now = new Date().toISOString();

    if (!existing) {
      await this.store.create({
        id,
        status: 'succeeded',
        attempt: 1,
        maxAttempts: 1,
        sequence: 0,
        createdAt: now,
        updatedAt: now,
        kind: 'graph.checkpoint',
        result: value,
      });
      return;
    }

    await this.store.update(
      { ...existing, result: value, sequence: existing.sequence + 1, updatedAt: now },
      existing.sequence,
    );
  }
}

interface ThreadHead {
  kind: 'graph-thread';
  latest: number;
  steps: number[];
}

function isHead(value: unknown): value is ThreadHead {
  return typeof value === 'object' && value !== null && (value as ThreadHead).kind === 'graph-thread';
}

function stepId(threadId: string, step: number): string {
  return `${threadId}#${step}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Re-exported for the adapter's signature, so a caller need not import the operations types. */
export type { OperationRecord, OperationStore };
