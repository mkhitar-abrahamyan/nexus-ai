import { randomHex } from '../utils/ids.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Run,
  RunFeedback,
  RunKind,
  RedactionPolicy,
  SamplingPolicy,
  TraceExporter,
  TraceStore,
} from '../types/tracing.js';

/** Configuration for a tracer. */
export interface TracerOptions {
  /** Where runs are written. */
  store: TraceStore;
  /** Which traces are kept. */
  sampling?: SamplingPolicy;
  /** What is removed from runs before they are stored or exported. */
  redaction?: RedactionPolicy;
  /** Tags added to every run, such as the deployment or the release. */
  tags?: string[];
  /** Metadata added to every run. */
  metadata?: Record<string, unknown>;
  /**
   * Writes each run when it starts and again when it ends, instead of a whole trace once its root
   * finishes.
   *
   * A trace written at the end is lost with the process that held it. Written as it runs, a crashed
   * run stays in the store with every run that finished, and a run in progress can be watched.
   * Sampling is then decided when the root starts. A trace not sampled is still held in memory and
   * written at the end when tail sampling keeps it, so `keepErrors` still shows every failure.
   * Defaults to false, which writes at the end, as before.
   */
  incremental?: boolean;
  /**
   * Also hands every finished run that is kept to these exporters, after redaction, such as an
   * `OtlpTraceExporter` sending OpenTelemetry spans to a collector.
   */
  exporters?: TraceExporter[];
  /** Replaces the system clock, for tests. */
  now?: () => Date;
  /** Errors from the store are swallowed by default; a hook lets an application notice them. */
  onError?: (error: unknown) => void;
}

/** Options for starting a run. */
export interface StartRunOptions {
  /** What the run is, such as a node or a tool name. */
  name: string;
  /** What kind of work it is. Defaults to `chain`. */
  kind?: RunKind;
  /** What it received. */
  inputs?: unknown;
  /** Labels for filtering. */
  tags?: string[];
  /** Application data, queryable by dot path. */
  metadata?: Record<string, unknown>;
  /** The model it calls, for a model run. */
  model?: string;
  /** The provider it calls, for a model run. */
  provider?: string;
  /** Overrides the parent taken from the surrounding context. */
  parentId?: string;
  /** Joins an existing trace instead of starting a new one. */
  traceId?: string;
  /**
   * Continues a trace another process started, from a W3C `traceparent` header such as the one
   * `RunHandle.traceparent()` returns or an OpenTelemetry service sends. The run joins that trace,
   * under the span the header names, and keeps its sampling decision.
   */
  traceparent?: string;
}

/** Options for finishing a run. */
export interface FinishRunOptions {
  /** What it produced. */
  outputs?: unknown;
  /** Why it failed. Its presence marks the run as an error. */
  error?: unknown;
  /** Token counts and other units reported. */
  usage?: Record<string, number>;
  /** What it cost. */
  cost?: number;
  /** Metadata merged into the run's. */
  metadata?: Record<string, unknown>;
  /** The model that actually ran, replacing the one the run started with, such as `auto` after routing. */
  model?: string;
  /** The provider that actually ran. */
  provider?: string;
}

/** A run in progress. Finishing it writes it to the store. */
export interface RunHandle {
  /** The run's id. */
  readonly id: string;
  /** The trace it belongs to. */
  readonly traceId: string;
  /**
   * Finishes the run. By default the trace is written once its root finishes; with `incremental`,
   * this run is written now.
   */
  finish(options?: FinishRunOptions): Promise<void>;
  /** Starts a run beneath this one, without relying on the ambient context. */
  child(options: StartRunOptions): RunHandle;
  /**
   * This run as a W3C `traceparent` header, for work it hands to another process: an operation's
   * `traceContext`, a request to a remote graph, a call to any OpenTelemetry service. Pass it back
   * as `StartRunOptions.traceparent` there.
   */
  traceparent(): string;
}

interface ActiveContext {
  traceId: string;
  runId: string;
  sampled: boolean;
}

/**
 * Records run trees.
 *
 * The context is carried through `AsyncLocalStorage`, which is created only when a tracer exists, so
 * an application that never traces pays nothing: no storage, no wrapper objects, no per-call work.
 */
export class Tracer {
  private readonly context = new AsyncLocalStorage<ActiveContext>();
  private readonly pending = new Map<string, Run[]>();
  /** Each trace's writes, in order, so a run's end can never land before its start. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(private readonly options: TracerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Where runs are written. */
  get store(): TraceStore {
    return this.options.store;
  }

  /** Whether runs are written as they start and finish, as `incremental` asks. */
  get incremental(): boolean {
    return this.options.incremental === true;
  }

  /** The run currently in scope, if any. */
  current(): { traceId: string; runId: string } | undefined {
    const active = this.context.getStore();
    return active ? { traceId: active.traceId, runId: active.runId } : undefined;
  }

  /**
   * Starts a run beneath the run in scope, or a new trace when there is none. Finish it with the
   * handle.
   */
  startRun(options: StartRunOptions): RunHandle {
    const parent = this.context.getStore();
    const remote = options.traceparent ? parseTraceparent(options.traceparent) : undefined;
    const traceId = options.traceId ?? remote?.traceId ?? parent?.traceId ?? id('trace');
    const runId = id('run');
    const parentId = options.parentId ?? (remote ? `run-${remote.spanId}` : parent?.runId);
    const sampled = parent?.sampled ?? remote?.sampled ?? this.decideSampling();

    const run: Run = {
      id: runId,
      traceId,
      ...(parentId ? { parentId } : {}),
      name: options.name,
      kind: options.kind ?? 'chain',
      status: 'running',
      startedAt: this.now().toISOString(),
      ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      tags: [...(this.options.tags ?? []), ...(options.tags ?? [])],
      metadata: { ...this.options.metadata, ...options.metadata },
    };

    if (this.options.incremental && sampled) {
      // Written as it starts, so a crash leaves it behind instead of taking it along.
      this.enqueue(run.traceId, () => this.options.store.save(this.prepare(run)));
    } else {
      // Held until the trace finishes, so tail sampling can still decide to keep or drop it.
      this.pending.set(traceId, [...(this.pending.get(traceId) ?? []), run]);
    }
    return this.handle(run, sampled);
  }

  /** Runs `fn` inside a new run, finishing it with the result or the error. */
  async trace<T>(options: StartRunOptions, fn: (handle: RunHandle) => Promise<T> | T): Promise<T> {
    const handle = this.startRun(options);
    const active: ActiveContext = { traceId: handle.traceId, runId: handle.id, sampled: true };
    try {
      const result = await this.context.run(active, () => fn(handle));
      await handle.finish({ outputs: result });
      return result;
    } catch (error) {
      await handle.finish({ error });
      throw error;
    }
  }

  /** Wraps any function so every call to it becomes a run. */
  traceable<A extends unknown[], R>(
    options: StartRunOptions | ((...args: A) => StartRunOptions),
    fn: (...args: A) => Promise<R> | R,
  ): (...args: A) => Promise<R> {
    return (...args: A) =>
      this.trace(
        typeof options === 'function' ? options(...args) : { ...options, inputs: options.inputs ?? args },
        () => fn(...args),
      );
  }

  /** Attaches feedback to a run, through the store's `addFeedback` when it has one. */
  async recordFeedback(
    runId: string,
    feedback: Omit<RunFeedback, 'createdAt'> & { createdAt?: string },
  ): Promise<void> {
    const entry: RunFeedback = { ...feedback, createdAt: feedback.createdAt ?? this.now().toISOString() };
    try {
      if (this.options.store.addFeedback) {
        await this.options.store.addFeedback(runId, entry);
        return;
      }
      const run = await this.options.store.get(runId);
      if (run) await this.options.store.save({ ...run, feedback: [...(run.feedback ?? []), entry] });
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  /** Waits for every write and export handed over so far. */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
    await Promise.all(
      (this.options.exporters ?? []).map((exporter) =>
        Promise.resolve(exporter.flush?.()).catch((error: unknown) => this.options.onError?.(error)),
      ),
    );
  }

  private handle(run: Run, sampled: boolean): RunHandle {
    const finish = async (options: FinishRunOptions = {}): Promise<void> => {
      const endedAt = this.now();
      const finished: Run = {
        ...run,
        status: options.error ? 'error' : 'ok',
        endedAt: endedAt.toISOString(),
        latencyMs: Math.max(0, endedAt.getTime() - Date.parse(run.startedAt)),
        ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
        ...(options.error ? { error: describeError(options.error) } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        ...(options.cost === undefined ? {} : { cost: options.cost }),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        metadata: { ...run.metadata, ...options.metadata },
      };
      if (this.options.incremental && sampled) {
        await this.enqueue(run.traceId, async () => {
          const prepared = this.prepare(finished);
          await this.options.store.save(prepared);
          this.export(prepared);
        });
        // The trace's write chain is dropped with its root; a child finishing late starts a new one.
        if (!run.parentId) this.settle(run.traceId);
        return;
      }
      await this.close(finished, sampled);
    };

    return {
      id: run.id,
      traceId: run.traceId,
      finish,
      child: (options) => this.startRun({ ...options, traceId: run.traceId, parentId: run.id }),
      traceparent: () => formatTraceparent(run.traceId, run.id, sampled),
    };
  }

  private async close(run: Run, sampled: boolean): Promise<void> {
    const runs = this.pending.get(run.traceId) ?? [];
    const index = runs.findIndex((item) => item.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);

    // A trace is written once its root finishes: by then tail sampling knows whether it is worth it.
    const root = runs.find((item) => !item.parentId || !runs.some((other) => other.id === item.parentId));
    if (root && root.status === 'running') return;
    this.pending.delete(run.traceId);

    if (!sampled && !this.keepByTail(runs)) return;
    for (const item of runs) {
      try {
        const prepared = this.prepare(item);
        await this.options.store.save(prepared);
        if (prepared.status !== 'running') this.export(prepared);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /** Chains a write behind the trace's earlier ones. A failed write is reported, never thrown. */
  private enqueue(traceId: string, write: () => Promise<void> | void): Promise<void> {
    const next = (this.writes.get(traceId) ?? Promise.resolve())
      .then(write)
      .catch((error: unknown) => this.options.onError?.(error));
    this.writes.set(traceId, next);
    return next;
  }

  private settle(traceId: string): void {
    const last = this.writes.get(traceId);
    void last?.then(() => {
      if (this.writes.get(traceId) === last) this.writes.delete(traceId);
    });
  }

  private export(run: Run): void {
    for (const exporter of this.options.exporters ?? []) {
      try {
        void Promise.resolve(exporter.export(run)).catch((error: unknown) => this.options.onError?.(error));
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private keepByTail(runs: Run[]): boolean {
    const policy = this.options.sampling;
    if (!policy) return false;
    return runs.some(
      (run) =>
        (policy.keepErrors && run.status === 'error') ||
        (policy.keepSlowerThanMs !== undefined && (run.latencyMs ?? 0) >= policy.keepSlowerThanMs) ||
        (policy.keepCostlierThan !== undefined && (run.cost ?? 0) >= policy.keepCostlierThan),
    );
  }

  private decideSampling(): boolean {
    const rate = this.options.sampling?.rate ?? 1;
    return rate >= 1 || Math.random() < rate;
  }

  /** Applies the redaction policy. What a trace must not hold, it never holds. */
  private prepare(run: Run): Run {
    const policy = this.options.redaction;
    if (!policy) return run;

    let prepared: Run = { ...run };
    if (policy.hideInputs) delete prepared.inputs;
    if (policy.hideOutputs) delete prepared.outputs;
    if (policy.hideFields?.length) {
      prepared.inputs = stripFields(prepared.inputs, policy.hideFields);
      prepared.outputs = stripFields(prepared.outputs, policy.hideFields);
    }
    if (policy.redact) prepared = policy.redact(prepared);
    return prepared;
  }
}

function id(prefix: string): string {
  return `${prefix}-${randomHex(8)}`;
}

/**
 * A trace id as the 32 hex digits W3C trace context and OpenTelemetry use. An id that already is one
 * is kept; a tracer's own `trace-…` id is padded, so every process derives the same one.
 */
export function w3cTraceId(traceId: string): string {
  if (/^[0-9a-f]{32}$/.test(traceId)) return traceId;
  const hex = traceId
    .replace(/^trace-/, '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  return hex.length >= 32 ? hex.slice(-32) : hex.padStart(32, '0');
}

/** A run id as the 16 hex digits of a W3C span id. */
export function w3cSpanId(runId: string): string {
  const hex = runId
    .replace(/^run-/, '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  return hex.length >= 16 ? hex.slice(-16) : hex.padStart(16, '0');
}

function formatTraceparent(traceId: string, runId: string, sampled: boolean): string {
  return `00-${w3cTraceId(traceId)}-${w3cSpanId(runId)}-${sampled ? '01' : '00'}`;
}

function parseTraceparent(header: string): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim().toLowerCase());
  if (!match || match[2] === '0'.repeat(32) || match[3] === '0'.repeat(16)) return undefined;
  return {
    traceId: match[2] as string,
    spanId: match[3] as string,
    sampled: (Number.parseInt(match[4] as string, 16) & 1) === 1,
  };
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** Removes fields by dot path, deeply, without mutating what the caller passed in. */
export function stripFields(value: unknown, fields: readonly string[]): unknown {
  if (value === null || typeof value !== 'object') return value;
  const clone: unknown = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };

  for (const field of fields) {
    const [head, ...rest] = field.split('.');
    if (!head) continue;
    const record = clone as Record<string, unknown>;
    if (rest.length === 0) delete record[head];
    else if (record[head] !== undefined) record[head] = stripFields(record[head], [rest.join('.')]);
  }

  if (Array.isArray(clone)) return clone.map((item) => stripFields(item, fields));
  return clone;
}
