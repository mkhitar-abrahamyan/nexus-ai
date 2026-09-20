import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Run, RunFeedback, RunKind, RedactionPolicy, SamplingPolicy, TraceStore } from '../types/tracing.js';

export interface TracerOptions {
  store: TraceStore;
  sampling?: SamplingPolicy;
  redaction?: RedactionPolicy;
  /** Tags added to every run, such as the deployment or the release. */
  tags?: string[];
  metadata?: Record<string, unknown>;
  now?: () => Date;
  /** Errors from the store are swallowed by default; a hook lets an application notice them. */
  onError?: (error: unknown) => void;
}

export interface StartRunOptions {
  name: string;
  kind?: RunKind;
  inputs?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
  model?: string;
  provider?: string;
  /** Overrides the parent taken from the surrounding context. */
  parentId?: string;
  traceId?: string;
}

export interface FinishRunOptions {
  outputs?: unknown;
  error?: unknown;
  usage?: Record<string, number>;
  cost?: number;
  metadata?: Record<string, unknown>;
}

/** A run in progress. Finishing it writes it to the store. */
export interface RunHandle {
  readonly id: string;
  readonly traceId: string;
  finish(options?: FinishRunOptions): Promise<void>;
  /** Starts a run beneath this one, without relying on the ambient context. */
  child(options: StartRunOptions): RunHandle;
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
  private readonly now: () => Date;

  constructor(private readonly options: TracerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The run currently in scope, if any. */
  current(): { traceId: string; runId: string } | undefined {
    const active = this.context.getStore();
    return active ? { traceId: active.traceId, runId: active.runId } : undefined;
  }

  startRun(options: StartRunOptions): RunHandle {
    const parent = this.context.getStore();
    const traceId = options.traceId ?? parent?.traceId ?? id('trace');
    const runId = id('run');
    const sampled = parent?.sampled ?? this.decideSampling();

    const run: Run = {
      id: runId,
      traceId,
      ...((options.parentId ?? parent?.runId) ? { parentId: options.parentId ?? (parent?.runId as string) } : {}),
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

    // Runs are held until the trace finishes, so tail sampling can still decide to keep or drop it.
    this.pending.set(traceId, [...(this.pending.get(traceId) ?? []), run]);
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
        metadata: { ...run.metadata, ...options.metadata },
      };
      await this.close(finished, sampled);
    };

    return {
      id: run.id,
      traceId: run.traceId,
      finish,
      child: (options) => this.startRun({ ...options, traceId: run.traceId, parentId: run.id }),
    };
  }

  private async close(run: Run, sampled: boolean): Promise<void> {
    const runs = this.pending.get(run.traceId) ?? [];
    const index = runs.findIndex((item) => item.id === run.id);
    if (index >= 0) runs[index] = run;
    else runs.push(run);

    // A trace is written once its root finishes: by then tail sampling knows whether it is worth it.
    const root = runs.find((item) => !item.parentId);
    if (root && root.status === 'running') return;
    this.pending.delete(run.traceId);

    if (!sampled && !this.keepByTail(runs)) return;
    for (const item of runs) {
      try {
        await this.options.store.save(this.prepare(item));
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
  return `${prefix}-${randomBytes(8).toString('hex')}`;
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
