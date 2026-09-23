import { OperationRunner } from '../operations/runner.js';
import type { OperationContext, OperationRunnerConfig } from '../types/operations.js';
import type {
  AssistantRunContext,
  Principal,
  RunEvent,
  RunEventLog,
  RunRecord,
  RunStatus,
  ServerAssistant,
  ServerStateStore,
  ThreadBusyPolicy,
  ThreadRecord,
} from '../types/server.js';
import { AssistantCapabilityError, BadRequestError, NotFoundError, ThreadBusyError } from './errors.js';
import { MemoryRunEventLog } from './events.js';
import { MemoryServerStore } from './state.js';

/** What a run needs to start. */
export interface StartRunOptions {
  /** The assistant to run. */
  assistant: string;
  /** What it runs on. */
  input?: unknown;
  /** The thread it belongs to. Without one the run is stateless. */
  threadId?: string;
  /** Answers an interrupt instead of starting a new input. */
  resume?: unknown;
  /** Who asked. */
  principal?: Principal;
  /** Replays the existing run when a run with this key was already accepted. */
  idempotencyKey?: string;
  /** Application data recorded on the run. */
  metadata?: Record<string, unknown>;
  /** What to do when the thread is already running something. Defaults to the server's policy. */
  onBusy?: ThreadBusyPolicy;
}

/** Options for the run manager. */
export interface RunManagerOptions {
  /** The assistants that can be run, by id. */
  assistants: Record<string, ServerAssistant>;
  /** Where threads, runs, and cron jobs are recorded. Defaults to memory. */
  state?: ServerStateStore;
  /** Where run events are kept for resumable streaming. Defaults to memory. */
  events?: RunEventLog;
  /** Configures the operation runner underneath: store, dispatcher, retries, leases, webhooks. */
  operations?: OperationRunnerConfig<unknown>;
  /** What to do when a thread is already running something. Defaults to `reject`. */
  onBusy?: ThreadBusyPolicy;
  /** How long a run may take before it expires, in milliseconds. */
  runTimeoutMs?: number;
  /** How long `enqueue` waits for the run in flight, in milliseconds. Defaults to 30 seconds. */
  queueTimeoutMs?: number;
  /** Receives errors that must not fail a request, such as a failed event append. */
  onError?: (error: unknown, context: { runId?: string; threadId?: string }) => void;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

const THREADS = ['nexus', 'server', 'threads'];
const RUNS = ['nexus', 'server', 'runs'];

/**
 * Runs assistants, records threads and runs, and keeps the event log a client streams from.
 *
 * Every run is a durable operation, so a run that outlives the request that started it, a worker
 * that dies mid-run, a duplicate submission, and a cancellation from another replica are all handled
 * by the operation runner rather than by anything here. What this adds is the thread: which run owns
 * it, what happens when a second arrives, and where the events go.
 */
export class RunManager {
  private readonly runner: OperationRunner<unknown>;
  /** Handles of runs this worker is executing, so a cancellation aborts them at once. */
  private readonly local = new Map<string, { cancel(reason?: string): boolean }>();
  private readonly state: ServerStateStore;
  private readonly events: RunEventLog;
  private readonly now: () => Date;

  constructor(private readonly options: RunManagerOptions) {
    this.runner = new OperationRunner<unknown>(options.operations ?? {});
    this.state = options.state ?? new MemoryServerStore();
    this.events = options.events ?? new MemoryRunEventLog();
    this.now = options.now ?? (() => new Date());
  }

  /** The event log, which the event-stream route reads. */
  get eventLog(): RunEventLog {
    return this.events;
  }

  /** The id this worker writes into operation leases. */
  get workerId(): string {
    return this.runner.workerId;
  }

  /** The assistants that can be run. */
  get assistants(): Record<string, ServerAssistant> {
    return this.options.assistants;
  }

  /** Looks an assistant up, or refuses the request. */
  assistant(id: string): ServerAssistant {
    const found = this.options.assistants[id];
    if (!found) throw new BadRequestError(`Unknown assistant "${id}"`, 'UNKNOWN_ASSISTANT');
    return found;
  }

  // ── Threads ──────────────────────────────────────────────────────

  /** Creates a thread for an assistant. */
  async createThread(options: {
    assistant: string;
    threadId?: string;
    principal?: Principal;
    metadata?: Record<string, unknown>;
  }): Promise<ThreadRecord> {
    this.assistant(options.assistant);
    const at = this.now().toISOString();
    const thread: ThreadRecord = {
      id: options.threadId?.trim() || `thread-${randomId()}`,
      assistant: options.assistant,
      tenantId: options.principal?.tenantId,
      createdBy: options.principal?.userId,
      createdAt: at,
      updatedAt: at,
      metadata: options.metadata,
    };
    await this.state.put(THREADS, thread.id, thread);
    return thread;
  }

  /** Reads a thread, refusing one that belongs to another tenant. */
  async thread(threadId: string, principal?: Principal): Promise<ThreadRecord> {
    const thread = await this.state.get<ThreadRecord>(THREADS, threadId);
    if (!thread || !sameTenant(thread.tenantId, principal)) throw new NotFoundError('Thread', threadId);
    return thread;
  }

  /** Threads of a tenant, newest written first. */
  async threads(principal?: Principal, limit?: number): Promise<ThreadRecord[]> {
    const all = await this.state.list<ThreadRecord>(THREADS, { limit: limit ?? 50 });
    return all.filter((thread) => sameTenant(thread.tenantId, principal));
  }

  /** Deletes a thread's record. The assistant's own checkpoints are left alone. */
  async deleteThread(threadId: string, principal?: Principal): Promise<void> {
    await this.thread(threadId, principal);
    await this.state.delete(THREADS, threadId);
  }

  /** The assistant's state for a thread, when the assistant reports one. */
  async threadState(threadId: string, principal?: Principal): Promise<unknown> {
    const thread = await this.thread(threadId, principal);
    const assistant = this.assistant(thread.assistant);
    if (!assistant.state) throw new AssistantCapabilityError(thread.assistant, 'thread state');
    return assistant.state(threadId);
  }

  // ── Runs ─────────────────────────────────────────────────────────

  /** Reads a run, refusing one that belongs to another tenant. */
  async run(runId: string, principal?: Principal): Promise<RunRecord> {
    const run = await this.state.get<RunRecord>(RUNS, runId);
    if (!run || !sameTenant(run.tenantId, principal)) throw new NotFoundError('Run', runId);
    return run;
  }

  /** Runs of a tenant, newest written first, optionally for one thread. */
  async runs(principal?: Principal, options: { threadId?: string; limit?: number } = {}): Promise<RunRecord[]> {
    const all = await this.state.list<RunRecord>(RUNS, { limit: options.limit ?? 50 });
    return all.filter(
      (run) => sameTenant(run.tenantId, principal) && (!options.threadId || run.threadId === options.threadId),
    );
  }

  /**
   * Accepts a run and starts it in the background.
   *
   * Returns as soon as the run is recorded, so the caller can stream its events or hand back its id.
   * A thread already running something is handled by the busy policy before anything is submitted.
   */
  async start(options: StartRunOptions): Promise<RunRecord> {
    const assistant = this.assistant(options.assistant);
    let thread: ThreadRecord | undefined;

    if (options.threadId) {
      thread = await this.thread(options.threadId, options.principal);
      thread = await this.settleBusyThread(thread, options);
    }
    if (options.resume !== undefined && !assistant.resume) {
      throw new AssistantCapabilityError(options.assistant, 'resuming an interrupt');
    }

    const at = this.now().toISOString();
    // Recorded before the run starts, so the rollback policy has a step to put the thread back to.
    const startedAtStep = thread && assistant.step ? await assistant.step(thread.id) : undefined;

    // The record is written before the work is submitted: the executor starts immediately, and its
    // first status update must find the run rather than create a stub without an assistant — which is
    // also what a recovering worker reads to know what to run.
    const runId = `run-${randomId()}`;
    const run: RunRecord = {
      id: runId,
      assistant: options.assistant,
      threadId: options.threadId,
      tenantId: options.principal?.tenantId,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      metadata: startedAtStep === undefined ? options.metadata : { ...options.metadata, startedAtStep },
    };
    await this.state.put(RUNS, runId, run);

    const handle = await this.runner.submit((context) => this.execute(assistant, options, context), {
      id: runId,
      kind: `assistant:${options.assistant}`,
      idempotencyKey: options.idempotencyKey,
      // The submission carries what a recovering worker needs to run it again.
      metadata: {
        assistant: options.assistant,
        threadId: options.threadId,
        tenantId: options.principal?.tenantId,
        input: options.input,
        resume: options.resume,
      },
      ...(this.options.runTimeoutMs === undefined
        ? {}
        : { expiresAt: new Date(this.now().getTime() + this.options.runTimeoutMs).toISOString() }),
    });

    if (handle.id !== runId) {
      // An idempotency key matched a run that already exists, so this one was never started.
      await this.state.delete(RUNS, runId);
      return (await this.state.get<RunRecord>(RUNS, handle.id)) ?? run;
    }

    this.local.set(handle.id, handle);
    if (thread) await this.state.put(THREADS, thread.id, { ...thread, activeRunId: runId, updatedAt: at });
    return (await this.state.get<RunRecord>(RUNS, runId)) ?? run;
  }

  /** Cancels a run, including one another replica is executing. */
  async cancel(runId: string, principal?: Principal, reason?: string): Promise<RunRecord> {
    const run = await this.run(runId, principal);
    // Aborting the local handle stops the work now; cancelling the record stops it on other workers,
    // which observe it through their heartbeat.
    this.local.get(runId)?.cancel(reason);
    await this.runner.cancel(runId, reason).catch((error: unknown) => this.report(error, { runId }));
    return this.settle(run.id, 'cancelled', { error: { message: reason ?? 'Cancelled', code: 'CANCELLED' } });
  }

  /**
   * Re-runs whatever this worker can claim from the store, after a restart or another worker's
   * crash. The operation runner decides what is claimable; this only supplies the executor.
   */
  async recover(limit = 10): Promise<string[]> {
    const handles = await this.runner.recover(async (context) => {
      const record = await this.state.get<RunRecord>(RUNS, context.operationId);
      if (!record) throw new NotFoundError('Run', context.operationId);
      const assistant = this.assistant(record.assistant);
      const submitted = (await this.runner.read(context.operationId))?.metadata as
        | { input?: unknown; resume?: unknown }
        | undefined;
      return this.execute(
        assistant,
        {
          assistant: record.assistant,
          threadId: record.threadId,
          input: submitted?.input,
          resume: submitted?.resume,
          metadata: record.metadata,
        },
        context,
      );
    }, limit);
    return handles.map((handle) => handle.id);
  }

  // ── Execution ────────────────────────────────────────────────────

  private async execute(
    assistant: ServerAssistant,
    options: StartRunOptions,
    context: OperationContext,
  ): Promise<unknown> {
    const runId = context.operationId;
    const runContext: AssistantRunContext = {
      runId,
      threadId: options.threadId,
      signal: context.signal,
      principal: options.principal,
      metadata: options.metadata,
    };

    await this.record(runId, 'status', { status: 'running' });
    await this.settle(runId, 'running');

    const stream =
      options.resume !== undefined && assistant.resume
        ? assistant.resume(options.threadId as string, options.resume, runContext)
        : assistant.stream(options.input, runContext);

    let last: unknown;
    try {
      for await (const event of stream) {
        last = event;
        await this.record(runId, typeOf(event), event);
        context.report({ message: typeOf(event) });
      }
    } catch (error) {
      await this.record(runId, 'error', { message: error instanceof Error ? error.message : String(error) });
      this.local.delete(runId);
      await this.settle(runId, 'failed', {
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
        },
      });
      await this.releaseThread(options.threadId, runId);
      throw error;
    }

    this.local.delete(runId);
    const interrupt = interruptOf(last);
    const status: RunStatus = interrupt ? 'awaiting_input' : 'succeeded';
    const output = outputOf(last);
    await this.record(runId, 'status', { status, output, interrupt });
    await this.settle(runId, status, { output, interrupt });
    await this.releaseThread(options.threadId, runId);
    return output;
  }

  /** Applies the busy policy, returning the thread once it is free to run something new. */
  private async settleBusyThread(thread: ThreadRecord, options: StartRunOptions): Promise<ThreadRecord> {
    const policy = options.onBusy ?? this.options.onBusy ?? 'reject';
    let current = thread;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const activeId = current.activeRunId;
      if (!activeId) return current;
      const active = await this.state.get<RunRecord>(RUNS, activeId);
      if (!active || isFinished(active.status)) {
        current = { ...current, activeRunId: undefined };
        await this.state.put(THREADS, current.id, current);
        return current;
      }

      if (policy === 'reject') throw new ThreadBusyError(current.id, activeId);
      if (policy === 'enqueue') {
        await this.waitForRun(activeId);
        current = await this.thread(current.id, options.principal);
        continue;
      }

      // `interrupt` and `rollback` both stop the run in flight; `rollback` also puts the thread back.
      await this.cancel(activeId, options.principal, `superseded by a new run (${policy})`);
      if (policy === 'rollback') {
        const assistant = this.assistant(current.assistant);
        if (!assistant.restore) throw new AssistantCapabilityError(current.assistant, 'rolling a thread back');
        const step = (active.metadata as { startedAtStep?: number } | undefined)?.startedAtStep;
        if (step !== undefined) await assistant.restore(current.id, step);
      }
      current = { ...current, activeRunId: undefined };
      await this.state.put(THREADS, current.id, current);
      return current;
    }
    return current;
  }

  /** Waits for a run to finish, for the `enqueue` policy. */
  private async waitForRun(runId: string): Promise<void> {
    const deadline = this.now().getTime() + (this.options.queueTimeoutMs ?? 30_000);
    while (this.now().getTime() < deadline) {
      const run = await this.state.get<RunRecord>(RUNS, runId);
      if (!run || isFinished(run.status)) return;
      const seen = (await this.events.read(runId, { after: 0 })).length;
      await this.events.wait?.(runId, seen, { timeoutMs: 250 });
      if (!this.events.wait) await delay(50);
    }
  }

  private async releaseThread(threadId: string | undefined, runId: string): Promise<void> {
    if (!threadId) return;
    const thread = await this.state.get<ThreadRecord>(THREADS, threadId);
    if (!thread || thread.activeRunId !== runId) return;
    await this.state.put(THREADS, threadId, { ...thread, activeRunId: undefined, updatedAt: this.now().toISOString() });
  }

  private async record(runId: string, type: string, data: unknown): Promise<RunEvent | undefined> {
    try {
      return await this.events.append(runId, { type, at: this.now().toISOString(), data });
    } catch (error) {
      // A log that refuses an append must not fail the run; the client falls back to polling status.
      this.report(error, { runId });
      return undefined;
    }
  }

  private async settle(
    runId: string,
    status: RunStatus,
    fields: Partial<Pick<RunRecord, 'output' | 'error' | 'interrupt'>> = {},
  ): Promise<RunRecord> {
    const current = await this.state.get<RunRecord>(RUNS, runId);
    // A cancelled run stays cancelled: its executor may still be unwinding, and the outcome a client
    // already saw must not change underneath it. A failed one may still be recovered and re-run.
    if (current?.status === 'cancelled' && status !== 'cancelled') return current;
    const next: RunRecord = {
      ...(current ?? { id: runId, assistant: 'unknown', status, createdAt: this.now().toISOString() }),
      ...fields,
      status,
      updatedAt: this.now().toISOString(),
    } as RunRecord;
    await this.state.put(RUNS, runId, next);
    return next;
  }

  private report(error: unknown, context: { runId?: string; threadId?: string }): void {
    this.options.onError?.(error, context);
  }
}

function sameTenant(owner: string | undefined, principal?: Principal): boolean {
  return (owner ?? undefined) === (principal?.tenantId ?? undefined);
}

function isFinished(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

function typeOf(event: unknown): string {
  const type = (event as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : 'event';
}

/** A graph yields its state on every event, so the last event carries the run's output. */
function outputOf(event: unknown): unknown {
  if (event === null || typeof event !== 'object') return event;
  const record = event as { state?: unknown; output?: unknown };
  return record.state ?? record.output ?? event;
}

/** A graph reports an interrupt on the event that paused the run. */
function interruptOf(event: unknown): unknown {
  if (event === null || typeof event !== 'object') return undefined;
  const record = event as { status?: unknown; interrupt?: unknown; interrupts?: unknown };
  if (record.status !== 'awaiting_input' && record.interrupt === undefined) return undefined;
  return record.interrupts ?? record.interrupt;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object') timer.unref?.();
  });
}
