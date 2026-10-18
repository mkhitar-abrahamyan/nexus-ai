/**
 * Traces that are never lost to a collector that is down: a batch the collector does not accept is
 * spooled to an operation store, retried with backoff, and dead-lettered only once it is too old or
 * has failed too often, under a bound on how much is kept. Every replica on the same store drains the
 * same spool, each batch once, and a process that stops leaves its spool for the next.
 */
import type { OperationRecord, OperationStore } from '../types/operations.js';
import type { Run, TraceExporter } from '../types/tracing.js';

/** Sends finished runs to a receiver, and rejects when the receiver did not take them. */
export interface TraceBatchSender {
  /** Sends one batch. `OtlpTraceExporter.send()` is one. */
  send(runs: Run[], signal?: AbortSignal): Promise<void>;
}

/** Options for `spoolingExporter()`. */
export interface SpoolingExporterOptions {
  /** Where batches go: an OTLP exporter, or any `TraceBatchSender`. */
  sender: TraceBatchSender;
  /** Where refused batches are kept: any operation store, shared by every replica that drains them. */
  store: OperationStore;
  /** Runs per batch. Defaults to 100. */
  maxBatch?: number;
  /** How long a run waits for others to batch with, in milliseconds. Defaults to 2,000. */
  flushIntervalMs?: number;
  /**
   * Writes each batch to the spool before sending it, and removes it once sent, so a process that
   * stops between the two loses nothing either. Off by default: a store write per batch.
   */
  writeAhead?: boolean;
  /**
   * The most batches the spool keeps. Spooling one more drops the oldest waiting, counted as dropped.
   * Defaults to 10,000.
   */
  maxPendingBatches?: number;
  /** A batch older than this, in milliseconds, is dead-lettered instead of tried again. Defaults to 24 hours. */
  maxAgeMs?: number;
  /** Attempts a batch gets before it is dead-lettered. Defaults to 1,000. */
  maxAttempts?: number;
  /** The wait before a spooled batch's second attempt, in milliseconds, doubling to `maxDelayMs`. Defaults to 1,000. */
  baseDelayMs?: number;
  /** The longest wait between attempts, in milliseconds. Defaults to 5 minutes. */
  maxDelayMs?: number;
  /** Drains the spool this often, in milliseconds. Defaults to 15 seconds; 0 drains only when asked. */
  drainEveryMs?: number;
  /** How long a replica holds a batch it is sending, in milliseconds. Defaults to 60 seconds. */
  leaseMs?: number;
  /** This replica's name in the leases it takes. Defaults to a random one. */
  owner?: string;
  /** The operation kind spooled batches are kept under. Defaults to `nexus.trace.spool`. */
  kind?: string;
  /** Receives failures of the spool itself, such as a store that cannot be written. */
  onError?: (error: unknown) => void;
  /** Replaces the system clock, in milliseconds, for tests. */
  now?: () => number;
}

/** What a spooling exporter has done, counted in runs. */
export interface SpoolStats {
  /** Runs the receiver took, at once or from the spool. */
  exported: number;
  /** Of those, the runs taken from the spool, after the receiver had refused them. */
  retried: number;
  /** Runs written to the spool because the receiver refused them, or ahead of sending. */
  spooled: number;
  /** Runs dropped because the spool was full: the oldest waiting go first. */
  dropped: number;
  /** Runs dead-lettered: too old, or tried too often. They stay in the store, marked, and are never sent. */
  deadLettered: number;
  /** Batches waiting in the spool now, across every replica on the store. */
  pendingBatches: number;
  /** How long the oldest waiting batch has waited, in milliseconds, when one does. */
  oldestPendingAgeMs?: number;
}

/** What one `drain()` did. */
export interface SpoolDrainReport {
  /** Batches the receiver took. */
  sent: number;
  /** Batches it refused again, waiting for their next attempt. */
  failed: number;
  /** Batches dead-lettered. */
  deadLettered: number;
}

/** A trace exporter that spools what its receiver refuses, from `spoolingExporter()`. */
export interface SpoolingExporter extends TraceExporter {
  /** Sends the batch waiting now, spooling it if the receiver refuses it. */
  flush(): Promise<void>;
  /** Tries the spooled batches whose next attempt is due, up to `limit` (100). */
  drain(options?: { limit?: number }): Promise<SpoolDrainReport>;
  /** What it has done, and what waits in the spool. */
  stats(): Promise<SpoolStats>;
  /** Flushes, and stops its timers. The spool stays in the store for any replica to drain. */
  close(): Promise<void>;
}

/** A batch in the spool, as its record's metadata keeps it. */
interface Spooled {
  runs: Run[];
  nextAttemptAt: number;
}

/**
 * Wraps a receiver of traces, such as `OtlpTraceExporter`, so that nothing it refuses is lost.
 *
 * Runs are batched and sent as they finish. A batch the receiver refuses is kept in the operation
 * store and tried again, with backoff, every `drainEveryMs`, by every replica sharing the store: each
 * batch is claimed before it is tried, so it is sent once. One that waits past `maxAgeMs`, or fails
 * `maxAttempts` times, is dead-lettered, and at most `maxPendingBatches` wait; `stats()` reports what
 * was exported, retried, spooled, dropped, and dead-lettered, and the age of the oldest batch waiting.
 *
 * ```ts
 * const exporter = spoolingExporter({
 *   sender: new OtlpTraceExporter({ endpoint: 'https://collector.internal:4318' }),
 *   store: new PostgresOperationStore(client),
 * });
 * const tracer = new Tracer({ store: traces, exporters: [exporter] });
 * ```
 */
export function spoolingExporter(options: SpoolingExporterOptions): SpoolingExporter {
  const { sender, store } = options;
  const kind = options.kind ?? 'nexus.trace.spool';
  const maxBatch = options.maxBatch ?? 100;
  const maxPending = options.maxPendingBatches ?? 10_000;
  const maxAgeMs = options.maxAgeMs ?? 24 * 3_600_000;
  const maxAttempts = options.maxAttempts ?? 1_000;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
  const leaseMs = options.leaseMs ?? 60_000;
  const owner = options.owner ?? `spool-${Math.random().toString(36).slice(2, 10)}`;
  const now = options.now ?? Date.now;
  const iso = (ms: number) => new Date(ms).toISOString();
  const counts = { exported: 0, retried: 0, spooled: 0, dropped: 0, deadLettered: 0 };
  const report = (error: unknown) => options.onError?.(error);

  let queue: Run[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> = Promise.resolve();
  let draining: Promise<SpoolDrainReport> | undefined;
  let spooledCount = 0;

  const delayFor = (attempt: number) => Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const spooledOf = (record: OperationRecord) => record.metadata as unknown as Spooled;

  /** The batches waiting, oldest first, as the store lists them. */
  const waiting = async (limit: number): Promise<OperationRecord[]> => {
    const filter = { kinds: [kind] };
    if (store.listQueued) return store.listQueued(limit, filter);
    const all = (await store.list?.()) ?? [];
    return all
      .filter((record) => record.kind === kind && record.status === 'queued')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit);
  };

  /** Keeps the spool within its bound, dropping the oldest batches waiting. */
  const bound = async () => {
    const stats = store.stats ? await store.stats(iso(now()), { kinds: [kind] }) : undefined;
    const pending = stats
      ? (stats.byStatus.queued ?? 0) + (stats.byStatus.running ?? 0)
      : (await waiting(maxPending + 1)).length;
    if (pending < maxPending) return;
    for (const record of await waiting(pending - maxPending + 1)) {
      const removed = store.delete ? await store.delete(record.id) : await settle(record, 'cancelled');
      if (removed) counts.dropped += spooledOf(record).runs.length;
    }
  };

  const spool = async (runs: Run[]): Promise<string> => {
    await bound();
    const at = now();
    spooledCount += 1;
    const id = `${kind}-${at.toString(36)}-${owner}-${spooledCount}`;
    const metadata: Spooled = { runs, nextAttemptAt: at };
    await store.create({
      id,
      kind,
      status: 'queued',
      attempt: 0,
      maxAttempts,
      sequence: 0,
      createdAt: iso(at),
      updatedAt: iso(at),
      metadata: metadata as unknown as Record<string, unknown>,
    });
    counts.spooled += runs.length;
    return id;
  };

  /** Ends a batch's record: sent, dropped, or dead-lettered. */
  const settle = async (record: OperationRecord, status: 'succeeded' | 'failed' | 'cancelled', error?: unknown) => {
    if (status === 'succeeded' && store.delete) return store.delete(record.id);
    return store.update(
      {
        ...record,
        status,
        lease: undefined,
        sequence: record.sequence + 1,
        updatedAt: iso(now()),
        completedAt: iso(now()),
        ...(status === 'failed'
          ? {
              deadLettered: true,
              error: { name: 'SpoolDeadLettered', message: error instanceof Error ? error.message : String(error) },
            }
          : {}),
      },
      record.sequence,
    );
  };

  /** Sends a batch now; a refused one is spooled. With write-ahead, it is spooled first. */
  const deliver = async (runs: Run[]) => {
    if (!runs.length) return;
    if (options.writeAhead) {
      try {
        await spool(runs);
      } catch (error) {
        report(error);
      }
      await drain();
      return;
    }
    try {
      await sender.send(runs);
      counts.exported += runs.length;
    } catch {
      try {
        await spool(runs);
      } catch (error) {
        // The receiver and the spool both refused: the batch is lost, and this is the one report of it.
        counts.dropped += runs.length;
        report(error);
      }
    }
  };

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    while (queue.length) {
      const batch = queue.slice(0, maxBatch);
      queue = queue.slice(maxBatch);
      sending = sending.then(() => deliver(batch));
    }
    await sending;
  };

  /** Claims a batch, so no other replica tries it at the same time. */
  const claim = async (record: OperationRecord): Promise<OperationRecord | undefined> => {
    const claimed = {
      ...record,
      status: 'running' as const,
      attempt: record.attempt + 1,
      lease: { owner, expiresAt: iso(now() + leaseMs) },
      sequence: record.sequence + 1,
      updatedAt: iso(now()),
    };
    return (await store.update(claimed, record.sequence)) ? claimed : undefined;
  };

  const attempt = async (record: OperationRecord, result: SpoolDrainReport) => {
    const claimed = await claim(record);
    if (!claimed) return;
    const batch = spooledOf(claimed);
    try {
      await sender.send(batch.runs);
      await settle(claimed, 'succeeded');
      counts.exported += batch.runs.length;
      if (claimed.attempt > 1 || !options.writeAhead) counts.retried += batch.runs.length;
      result.sent += 1;
    } catch (error) {
      const age = now() - Date.parse(claimed.createdAt);
      if (age >= maxAgeMs || claimed.attempt >= maxAttempts) {
        await settle(claimed, 'failed', error);
        counts.deadLettered += batch.runs.length;
        result.deadLettered += 1;
        return;
      }
      // Back to the queue, to be tried again once its backoff has passed.
      const next: Spooled = { runs: batch.runs, nextAttemptAt: now() + delayFor(claimed.attempt) };
      await store.update(
        {
          ...claimed,
          status: 'queued',
          lease: undefined,
          sequence: claimed.sequence + 1,
          updatedAt: iso(now()),
          error: { name: 'SpoolRefused', message: error instanceof Error ? error.message : String(error) },
          metadata: next as unknown as Record<string, unknown>,
        },
        claimed.sequence,
      );
      result.failed += 1;
    }
  };

  const drain = (drainOptions: { limit?: number } = {}): Promise<SpoolDrainReport> => {
    if (draining) return draining;
    const limit = drainOptions.limit ?? 100;
    draining = (async () => {
      const result: SpoolDrainReport = { sent: 0, failed: 0, deadLettered: 0 };
      try {
        // A batch a stopped replica was sending, its lease lapsed, is waiting again.
        for (const record of (await store.claimExpired?.(iso(now()), limit)) ?? []) {
          if (record.kind !== kind || record.status !== 'running') continue;
          await store.update(
            { ...record, status: 'queued', lease: undefined, sequence: record.sequence + 1, updatedAt: iso(now()) },
            record.sequence,
          );
        }
        // Batches whose backoff has not passed are listed too, so the window is wider than the limit.
        const due = (await waiting(limit * 4))
          .filter((record) => spooledOf(record).nextAttemptAt <= now())
          .slice(0, limit);
        for (const record of due) await attempt(record, result);
      } catch (error) {
        report(error);
      } finally {
        draining = undefined;
      }
      return result;
    })();
    return draining;
  };

  const every = options.drainEveryMs ?? 15_000;
  const ticker =
    every > 0
      ? setInterval(() => {
          void drain();
        }, every)
      : undefined;
  (ticker as { unref?: () => void } | undefined)?.unref?.();

  return {
    export(run) {
      if (run.status === 'running') return;
      queue.push(run);
      if (queue.length >= maxBatch) {
        void flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => void flush(), options.flushIntervalMs ?? 2_000);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    flush,
    drain,
    async stats() {
      const at = now();
      let pendingBatches = 0;
      let oldest: string | undefined;
      if (store.stats) {
        const stats = await store.stats(iso(at), { kinds: [kind] });
        pendingBatches = (stats.byStatus.queued ?? 0) + (stats.byStatus.running ?? 0);
        oldest = stats.oldestQueuedAt;
      } else {
        const listed = await waiting(maxPending);
        pendingBatches = listed.length;
        oldest = listed[0]?.createdAt;
      }
      return {
        ...counts,
        pendingBatches,
        ...(oldest && pendingBatches ? { oldestPendingAgeMs: Math.max(0, at - Date.parse(oldest)) } : {}),
      };
    },
    async close() {
      if (ticker) clearInterval(ticker);
      await flush();
      await draining;
    },
  };
}
