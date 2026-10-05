import { OperationDuplicateError, OperationReleasedError } from '../operations/errors.js';
import { OperationRunner } from '../operations/runner.js';
import { operationStats } from '../operations/stats.js';
import { MemoryOperationStore } from '../operations/store.js';
import type {
  DurableOperationHandle,
  OperationContext,
  OperationRunnerConfig,
  OperationStore,
} from '../types/operations.js';
import type {
  AssistantRunContext,
  Principal,
  ReplicaReport,
  RunEvent,
  RunEventLog,
  RunRecord,
  RunRevision,
  RunStatus,
  ScalingSnapshot,
  ServerAssistant,
  ServerStateStore,
  TenantGate,
  ThreadBusyPolicy,
  ThreadRecord,
} from '../types/server.js';
import {
  AssistantCapabilityError,
  BadRequestError,
  NotFoundError,
  TenantLimitError,
  ThreadBusyError,
} from './errors.js';
import { MemoryRunEventLog } from './events.js';
import { gauge, ServerMetrics } from './metrics.js';
import { MemoryServerStore, RUNS_NAMESPACE } from './state.js';

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
  /** Runs this revision of the assistant, instead of letting the traffic split choose. */
  revision?: string;
}

/**
 * Runs in a queue that any replica's workers claim, instead of on the replica that accepted them.
 *
 * With a queue, a replica runs at most `concurrency` runs at once. It starts a new run itself while
 * it has room, and leaves the rest queued in the operation store for whichever worker frees up
 * first. That queue is what an autoscaler watches: `GET /scaling` and `GET /metrics` report it.
 */
export interface RunQueueOptions {
  /** Runs this replica executes at once. Defaults to 10. */
  concurrency?: number;
  /**
   * Whether this replica claims queued runs. `false` makes it an API replica that only accepts them,
   * in front of a separate pool of workers. Defaults to true.
   */
  claim?: boolean;
  /** How often an idle worker looks for queued runs, in milliseconds. Defaults to 1 second. */
  pollMs?: number;
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
  /** Runs in a shared queue with a per-replica cap. Without it, a run executes where it was accepted. */
  queue?: RunQueueOptions;
  /**
   * How often this replica takes over runs whose worker stopped, in milliseconds. Defaults to 30
   * seconds with a queue. Without a queue it is off unless set, and only `start()` recovers.
   */
  recoverEveryMs?: number;
  /** Per-tenant limits, enforced when a run is accepted. See `tenantLimits()` in `nexus-ai-pro/server/tenancy`. */
  tenants?: TenantGate;
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

/** What `drain()` did with the runs this replica was executing. */
export interface DrainResult {
  /** Runs that finished before the timeout. */
  finished: string[];
  /** Runs handed back to the queue for another worker, because the timeout passed first. */
  released: string[];
}

/** Everything one execution needs, whether it starts here, is claimed from the queue, or is recovered. */
interface RunPlan {
  assistantId: string;
  assistant: ServerAssistant;
  threadId?: string;
  input?: unknown;
  resume?: unknown;
  principal?: Principal;
  metadata?: Record<string, unknown>;
  revision?: RunRevision;
}

/** What a run's submission carries, so any worker can run it. */
interface Submission {
  assistant: string;
  threadId?: string;
  tenantId?: string;
  principal?: Principal;
  input?: unknown;
  resume?: unknown;
  revision?: string;
}

const THREADS = ['nexus', 'server', 'threads'];
const RUNS = RUNS_NAMESPACE as string[];
const KIND_PREFIX = 'assistant:';
/** The idempotency-key prefix of the record that says which run holds a thread. */
const THREAD_CLAIM = 'nexus-thread:';
/** A claim whose run never got recorded is abandoned after this long: its starter died mid-start. */
const UNRECORDED_CLAIM_MS = 60_000;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_RECOVER_MS = 30_000;

const METRIC_HELP: Record<string, string> = {
  nexus_server_runs_started_total: 'Runs this replica started executing, per assistant and revision.',
  nexus_server_runs_finished_total: 'Runs that finished on this replica, per assistant, revision, and status.',
  nexus_server_run_duration_seconds: 'Time from a run first starting to finishing, per assistant and revision.',
  nexus_server_queue_wait_seconds: 'Time a run waited between being accepted and first starting.',
  nexus_server_runs_handed_off_total: 'Runs this replica handed back to the queue while draining.',
  nexus_server_tenant_refusals_total: 'Runs refused by a per-tenant limit, per limit.',
};

/**
 * Runs assistants, records threads and runs, and keeps the event log a client streams from.
 *
 * Every run is a durable operation, so a run that outlives the request that started it, a worker
 * that dies mid-run, a duplicate submission, and a cancellation from another replica are all handled
 * by the operation runner rather than by anything here. What this adds is the thread: which run owns
 * it, what happens when a second arrives, and where the events go. With a `queue`, it also decides
 * where a run executes: here while there is room, otherwise on the next free worker.
 */
export class RunManager {
  private readonly runner: OperationRunner<unknown>;
  private readonly store: OperationStore<unknown>;
  /** Handles of runs this worker is executing, so a cancellation aborts them at once. */
  private readonly local = new Map<string, { cancel(reason?: string): boolean }>();
  /** Runs holding one of this replica's execution slots. */
  private readonly slots = new Set<string>();
  /** The drain switch of each run this replica is executing, so `drain()` can reach graph runs. */
  private readonly controls = new Map<string, { draining: boolean; reason?: string }>();
  /** Runs handed back to the queue during a drain, as each graph run stopped at a boundary. */
  private readonly drainedRuns = new Set<string>();
  private readonly state: ServerStateStore;
  private readonly events: RunEventLog;
  private readonly now: () => Date;
  private readonly startedAt: string;
  /** This replica's run counters and latency histograms, rendered by `GET /metrics`. */
  readonly metrics = new ServerMetrics();
  private claiming = 0;
  private draining = false;
  private working = false;
  private ticking = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastRecovery = 0;

  constructor(private readonly options: RunManagerOptions) {
    this.store = options.operations?.store ?? new MemoryOperationStore<unknown>();
    this.runner = new OperationRunner<unknown>({ ...options.operations, store: this.store });
    this.state = options.state ?? new MemoryServerStore();
    this.events = options.events ?? new MemoryRunEventLog();
    this.now = options.now ?? (() => new Date());
    this.startedAt = this.now().toISOString();
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

  /** Runs this replica is executing now. */
  get inFlight(): number {
    return this.slots.size;
  }

  /** Runs this replica executes at once, when it runs a queue. */
  get capacity(): number | undefined {
    return this.options.queue ? (this.options.queue.concurrency ?? DEFAULT_CONCURRENCY) : undefined;
  }

  /** Whether this replica is draining, which `GET /health` reports so a load balancer stops sending. */
  get isDraining(): boolean {
    return this.draining;
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

  /** The assistant's state for a thread, from the revision the thread last ran on. */
  async threadState(threadId: string, principal?: Principal): Promise<unknown> {
    const thread = await this.thread(threadId, principal);
    const assistant = this.revisionOf(thread.assistant, thread.revision);
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
   * A thread already running something is handled by the busy policy before anything is submitted,
   * the assistant's traffic split picks the revision, and the tenant's limits admit the run or refuse
   * it with a `TenantLimitError`.
   */
  async start(options: StartRunOptions): Promise<RunRecord> {
    const base = this.assistant(options.assistant);
    const runId = `run-${randomId()}`;
    let thread: ThreadRecord | undefined;

    if (options.threadId) {
      thread = await this.thread(options.threadId, options.principal);
      thread = await this.settleBusyThread(thread, options, runId);
    }
    try {
      return await this.startClaimed(runId, base, thread, options);
    } catch (error) {
      // Whatever refused the run after it claimed the thread, the thread is free again.
      if (thread) await this.releaseClaim(thread.id, runId).catch((cause: unknown) => this.report(cause, { runId }));
      throw error;
    }
  }

  /** The rest of `start()`, once the thread, if any, is this run's. */
  private async startClaimed(
    runId: string,
    base: ServerAssistant,
    thread: ThreadRecord | undefined,
    options: StartRunOptions,
  ): Promise<RunRecord> {
    let assistant = base;
    let revision: RunRevision | undefined;
    if (base.route) {
      const choice = await base.route({
        runId,
        threadId: thread?.id,
        threadRevision: thread?.revision,
        requested: options.revision,
        principal: options.principal,
      });
      if (choice) {
        const { assistant: chosen, ...chosenRevision } = choice;
        assistant = chosen;
        revision = chosenRevision;
      }
    } else if (options.revision !== undefined) {
      throw new BadRequestError(`Assistant "${options.assistant}" has no revisions`, 'UNKNOWN_REVISION');
    }
    if (options.resume !== undefined && !assistant.resume) {
      throw new AssistantCapabilityError(options.assistant, 'resuming an interrupt');
    }

    try {
      await this.options.tenants?.admit({ runId, assistant: options.assistant, principal: options.principal });
    } catch (error) {
      if (error instanceof TenantLimitError) {
        this.metrics.count('nexus_server_tenant_refusals_total', { limit: error.limit });
      }
      throw error;
    }

    try {
      return await this.accept(runId, options, assistant, thread, revision);
    } catch (error) {
      await this.releaseTenant(runId, options.principal?.tenantId);
      throw error;
    }
  }

  /** Cancels a run, including one another replica is executing. */
  async cancel(runId: string, principal?: Principal, reason?: string): Promise<RunRecord> {
    const run = await this.run(runId, principal);
    // Aborting the local handle stops the work now; cancelling the record stops it on other workers,
    // which observe it through their heartbeat.
    this.local.get(runId)?.cancel(reason);
    await this.runner.cancel(runId, reason).catch((error: unknown) => this.report(error, { runId }));
    const wasFinished = isFinished(run.status);
    const settled = await this.settle(run.id, 'cancelled', {
      error: { message: reason ?? 'Cancelled', code: 'CANCELLED' },
      finishedAt: this.now().toISOString(),
    });
    if (!wasFinished) this.countFinished(settled);
    await this.releaseTenant(runId, run.tenantId);
    return settled;
  }

  /**
   * Re-runs whatever this worker can claim from the store, after a restart or another worker's
   * crash. The operation runner decides what is claimable; this only supplies the executor.
   */
  async recover(limit = 10): Promise<string[]> {
    const handles = await this.runner.recover((context) => this.executeStored(context), limit);
    for (const handle of handles) this.track(handle);
    return handles.map((handle) => handle.id);
  }

  /**
   * Claims queued runs up to this replica's free capacity and starts them. The worker loop calls it;
   * a test or a custom scheduler can call it directly. Resolves to the ids it claimed.
   */
  async claim(): Promise<string[]> {
    const room = this.freeSlots();
    const free = Number.isFinite(room) ? room : 10;
    if (free <= 0 || this.draining) return [];
    this.claiming += free;
    try {
      const handles = await this.runner.claimQueued((context) => this.executeStored(context), free, {
        kindPrefix: KIND_PREFIX,
      });
      for (const handle of handles) this.track(handle);
      return handles.map((handle) => handle.id);
    } finally {
      this.claiming -= free;
    }
  }

  /**
   * Starts the worker loop: claiming queued runs while there is room, and taking over runs whose
   * worker stopped. Does nothing without a queue or `recoverEveryMs`. `stopWorking()` ends it.
   */
  startWorking(): void {
    if (this.working || (!this.options.queue && this.options.recoverEveryMs === undefined)) return;
    this.working = true;
    this.lastRecovery = Date.now();
    this.schedule(0);
  }

  /** Stops the worker loop. Runs in flight carry on. */
  stopWorking(): void {
    this.working = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Stops taking new work and waits for the runs in flight, before this replica shuts down.
   *
   * New runs accepted here go to the queue instead of starting, and the worker loop stops claiming.
   * Runs still going when `timeoutMs` passes are handed back to the queue for another worker to
   * continue, so a scale-down neither waits for a long run nor loses it. Without a queue nothing can
   * claim a hand-off, so they are left to their leases, which another replica's recovery takes over.
   */
  async drain(options: { timeoutMs?: number } = {}): Promise<DrainResult> {
    this.draining = true;
    this.stopWorking();
    // A graph run stops at its next superstep boundary with its checkpoint written, so with a queue to
    // hand it to, nothing waits for the timeout and nothing is cut off mid-step.
    if (this.options.queue) {
      for (const control of this.controls.values()) {
        control.draining = true;
        control.reason = 'replica draining';
      }
    }
    const running = [...this.slots];
    const deadline = Date.now() + (options.timeoutMs ?? 25_000);
    // These waits hold the process open on purpose: a drain must finish before the process may exit.
    while (this.slots.size > 0 && Date.now() < deadline) await pause(Math.min(50, deadline - Date.now()));

    // Graph runs that stopped at a boundary were handed off already, as they stopped.
    const released: string[] = [...this.drainedRuns];
    this.drainedRuns.clear();
    if (this.options.queue) {
      for (const id of [...this.slots]) {
        if (this.runner.release(id)) released.push(id);
      }
      const settle = Date.now() + 5_000;
      while (this.slots.size > 0 && Date.now() < settle) await pause(10);
    }
    if (released.length > 0) this.metrics.count('nexus_server_runs_handed_off_total', {}, released.length);
    return { finished: running.filter((id) => !released.includes(id) && !this.slots.has(id)), released };
  }

  /** This replica, as it reports itself to heartbeats and the scaling endpoint. */
  replica(metadata?: Record<string, unknown>): ReplicaReport {
    const assistants: Record<string, readonly string[]> = {};
    for (const [id, assistant] of Object.entries(this.options.assistants)) assistants[id] = assistant.revisions ?? [];
    return {
      id: this.workerId,
      startedAt: this.startedAt,
      heartbeatAt: this.now().toISOString(),
      inFlight: this.slots.size,
      ...(this.capacity === undefined ? {} : { capacity: this.capacity }),
      claims: this.options.queue ? this.options.queue.claim !== false : true,
      draining: this.draining,
      assistants,
      ...(metadata ? { metadata } : {}),
    };
  }

  /** The queue as the operation store counts it, across every replica, with this replica's report. */
  async scaling(metadata?: Record<string, unknown>): Promise<ScalingSnapshot> {
    const now = this.now();
    const stats = await operationStats(this.store, { kindPrefix: KIND_PREFIX, now });
    const queued = stats.byStatus.queued ?? 0;
    const running = (stats.byStatus.running ?? 0) + (stats.byStatus.retrying ?? 0) + (stats.byStatus.cancelling ?? 0);
    return {
      queued,
      running,
      load: queued + running,
      oldestQueuedSeconds: stats.oldestQueuedAt
        ? Math.max(0, (now.getTime() - Date.parse(stats.oldestQueuedAt)) / 1000)
        : 0,
      lapsedLeases: stats.lapsedLeases,
      replica: this.replica(metadata),
    };
  }

  /** Every metric in Prometheus text: the deployment-wide queue, this replica, and its run counters. */
  async prometheus(extra: (lines: string[]) => void | Promise<void> = () => undefined): Promise<string> {
    const snapshot = await this.scaling();
    const lines: string[] = [];
    // Deployment-wide gauges read the same on every replica: aggregate them with max(), not sum().
    gauge(lines, 'nexus_server_runs_queued', 'Runs waiting for a worker, across the deployment.', snapshot.queued);
    gauge(lines, 'nexus_server_runs_running', 'Runs executing or retrying, across the deployment.', snapshot.running);
    gauge(lines, 'nexus_server_queue_load', 'Queued plus running runs, across the deployment.', snapshot.load);
    gauge(
      lines,
      'nexus_server_queue_oldest_seconds',
      'Seconds the oldest queued run has waited.',
      snapshot.oldestQueuedSeconds,
    );
    gauge(lines, 'nexus_server_leases_lapsed', 'Running runs whose lease lapsed.', snapshot.lapsedLeases);
    gauge(lines, 'nexus_server_worker_in_flight', 'Runs this replica is executing.', snapshot.replica.inFlight);
    if (snapshot.replica.capacity !== undefined) {
      gauge(lines, 'nexus_server_worker_capacity', 'Runs this replica executes at once.', snapshot.replica.capacity);
    }
    gauge(lines, 'nexus_server_worker_draining', 'Whether this replica is draining.', this.draining ? 1 : 0);
    this.metrics.render(lines, METRIC_HELP);
    await extra(lines);
    return `${lines.join('\n')}\n`;
  }

  // ── Execution ────────────────────────────────────────────────────

  /** Records a run and submits it: to run here while there is room, or to the queue otherwise. */
  private async accept(
    runId: string,
    options: StartRunOptions,
    assistant: ServerAssistant,
    thread: ThreadRecord | undefined,
    revision: RunRevision | undefined,
  ): Promise<RunRecord> {
    const at = this.now().toISOString();
    // Recorded before the run starts, so the rollback policy has a step to put the thread back to.
    const startedAtStep = thread && assistant.step ? await assistant.step(thread.id) : undefined;

    // The record is written before the work is submitted: the executor starts immediately, and its
    // first status update must find the run rather than create a stub without an assistant — which is
    // also what a recovering worker reads to know what to run.
    const run: RunRecord = {
      id: runId,
      assistant: options.assistant,
      threadId: options.threadId,
      tenantId: options.principal?.tenantId,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      metadata: startedAtStep === undefined ? options.metadata : { ...options.metadata, startedAtStep },
      ...(revision ? { revision } : {}),
    };
    await this.state.put(RUNS, runId, run);

    const submission: Submission = {
      assistant: options.assistant,
      threadId: options.threadId,
      tenantId: options.principal?.tenantId,
      principal: options.principal,
      input: options.input,
      resume: options.resume,
      revision: revision?.id,
    };
    const submit = {
      id: runId,
      kind: `${KIND_PREFIX}${options.assistant}`,
      idempotencyKey: options.idempotencyKey,
      // The submission carries what any worker needs to run it.
      metadata: submission as unknown as Record<string, unknown>,
      ...(this.options.runTimeoutMs === undefined
        ? {}
        : { expiresAt: new Date(this.now().getTime() + this.options.runTimeoutMs).toISOString() }),
    };

    let acceptedId: string;
    if (this.runsHere()) {
      this.slots.add(runId);
      const plan: RunPlan = {
        assistantId: options.assistant,
        assistant,
        threadId: options.threadId,
        input: options.input,
        resume: options.resume,
        principal: options.principal,
        metadata: options.metadata,
        revision,
      };
      const handle = await this.runner.submit((context) => this.execute(plan, context), submit);
      if (handle.id === runId) this.track(handle);
      else this.freeSlot(runId);
      acceptedId = handle.id;
    } else {
      acceptedId = (await this.runner.enqueue(submit)).id;
    }

    if (acceptedId !== runId) {
      // An idempotency key matched a run that already exists, so this one was never started.
      if (thread) await this.releaseClaim(thread.id, runId);
      await this.state.delete(RUNS, runId);
      await this.releaseTenant(runId, options.principal?.tenantId);
      return (await this.state.get<RunRecord>(RUNS, acceptedId)) ?? run;
    }

    if (thread) {
      await this.state.put(THREADS, thread.id, {
        ...thread,
        activeRunId: runId,
        updatedAt: at,
        ...(revision ? { revision: revision.id } : {}),
      });
    }
    return (await this.state.get<RunRecord>(RUNS, runId)) ?? run;
  }

  /** Runs a run from what its record and submission say: a claimed queued run, or a recovered one. */
  private async executeStored(context: OperationContext): Promise<unknown> {
    const record = await this.state.get<RunRecord>(RUNS, context.operationId);
    if (!record) throw new NotFoundError('Run', context.operationId);
    const submitted = (context.metadata ?? (await this.runner.read(context.operationId))?.metadata) as
      | Submission
      | undefined;
    return this.execute(
      {
        assistantId: record.assistant,
        assistant: this.revisionOf(record.assistant, record.revision?.id ?? submitted?.revision),
        threadId: record.threadId,
        input: submitted?.input,
        resume: submitted?.resume,
        principal: submitted?.principal ?? (record.tenantId ? { tenantId: record.tenantId } : undefined),
        metadata: record.metadata,
        revision: record.revision,
      },
      context,
    );
  }

  private async execute(plan: RunPlan, context: OperationContext): Promise<unknown> {
    const runId = context.operationId;
    let cost = 0;
    const control: { draining: boolean; reason?: string } = { draining: false };
    const runContext: AssistantRunContext = {
      runId,
      threadId: plan.threadId,
      signal: context.signal,
      control,
      principal: plan.principal,
      metadata: plan.metadata,
      attempt: context.attempt,
      ...(plan.revision ? { revision: plan.revision.id } : {}),
      saveProgress: (details: unknown) => context.heartbeat(details),
      ...(context.previousHeartbeat === undefined ? {} : { progress: context.previousHeartbeat }),
      recordCost: async (usd: number) => {
        if (!Number.isFinite(usd) || usd <= 0) return;
        cost += usd;
        const within = await this.options.tenants?.spend({ runId, tenantId: plan.principal?.tenantId }, usd);
        if (within === false) {
          await this.cancel(runId, plan.principal, 'The tenant budget is spent').catch((error: unknown) =>
            this.report(error, { runId }),
          );
        }
      },
    };

    const labels = { assistant: plan.assistantId, revision: plan.revision?.id ?? '' };
    await this.record(runId, 'status', { status: 'running' });
    const started = await this.settle(runId, 'running', {
      startedAt: this.now().toISOString(),
      worker: this.workerId,
      attempt: context.attempt,
    });
    this.metrics.count('nexus_server_runs_started_total', labels);
    if (context.attempt === 1 && started.startedAt) {
      this.metrics.observe(
        'nexus_server_queue_wait_seconds',
        { assistant: plan.assistantId },
        Math.max(0, (Date.parse(started.startedAt) - Date.parse(started.createdAt)) / 1000),
      );
    }

    // A later attempt continues from the run's own last checkpoint when the assistant can, so only the
    // step in flight when the worker died runs again.
    const recovered =
      context.attempt > 1 && plan.threadId && plan.assistant.recover
        ? await plan.assistant.recover(plan.threadId, runContext)
        : undefined;
    const stream =
      recovered ??
      (plan.resume !== undefined && plan.assistant.resume
        ? plan.assistant.resume(plan.threadId as string, plan.resume, runContext)
        : plan.assistant.stream(plan.input, runContext));

    let last: unknown;
    this.controls.set(runId, control);
    try {
      for await (const event of stream) {
        last = event;
        await this.record(runId, typeOf(event), event);
        context.report({ message: typeOf(event) });
      }
    } catch (error) {
      // A graph that drained stopped cleanly at a superstep boundary; releasing it makes the stop a
      // hand-off, so the next worker continues from the checkpoint it just wrote.
      if (control.draining && isDrained(error) && this.runner.release(runId)) this.drainedRuns.add(runId);
      if (context.signal.aborted && context.signal.reason instanceof OperationReleasedError) {
        // A hand-off, not a failure: the thread stays with this run, and another worker continues it.
        await this.record(runId, 'status', { status: 'queued', reason: 'handed to another worker' });
        await this.settle(runId, 'queued', { addCost: cost });
        throw error;
      }
      await this.record(runId, 'error', { message: error instanceof Error ? error.message : String(error) });
      const failed = await this.settle(runId, 'failed', {
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
        },
        finishedAt: this.now().toISOString(),
        addCost: cost,
      });
      if (failed.status === 'failed') this.countFinished(failed);
      await this.releaseThread(plan.threadId, runId);
      await this.releaseTenant(runId, plan.principal?.tenantId);
      throw error;
    } finally {
      this.controls.delete(runId);
    }

    const interrupt = interruptOf(last);
    const status: RunStatus = interrupt ? 'awaiting_input' : 'succeeded';
    const output = outputOf(last);
    await this.record(runId, 'status', { status, output, interrupt });
    const settled = await this.settle(runId, status, {
      output,
      interrupt,
      finishedAt: this.now().toISOString(),
      addCost: cost,
    });
    if (settled.status === status) this.countFinished(settled);
    await this.releaseThread(plan.threadId, runId);
    await this.releaseTenant(runId, plan.principal?.tenantId);
    return output;
  }

  /** The assistant for one revision, or the assistant itself when it has none by that id. */
  private revisionOf(assistantId: string, revision: string | undefined): ServerAssistant {
    const base = this.assistant(assistantId);
    return (revision !== undefined && base.revision?.(revision)) || base;
  }

  /** Whether a new run starts on this replica rather than waiting in the queue. */
  private runsHere(): boolean {
    const queue = this.options.queue;
    if (!queue) return true;
    return queue.claim !== false && !this.draining && this.freeSlots() > 0;
  }

  private freeSlots(): number {
    const capacity = this.capacity;
    return capacity === undefined ? Number.POSITIVE_INFINITY : capacity - this.slots.size - this.claiming;
  }

  /** Keeps a run's handle while it executes here, and frees its slot when it settles. */
  private track(handle: DurableOperationHandle<unknown>): void {
    this.slots.add(handle.id);
    this.local.set(handle.id, handle);
    const done = (): void => {
      this.local.delete(handle.id);
      this.freeSlot(handle.id);
    };
    void handle.result().then(done, done);
  }

  private freeSlot(runId: string): void {
    if (!this.slots.delete(runId)) return;
    // A freed slot is room for the next queued run, so look now rather than at the next poll.
    if (this.working && this.options.queue && !this.draining) this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.working) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (!this.working || this.ticking) return;
    this.ticking = true;
    let claimed = 0;
    try {
      const recoverEvery = this.options.recoverEveryMs ?? (this.options.queue ? DEFAULT_RECOVER_MS : undefined);
      if (recoverEvery !== undefined && Date.now() - this.lastRecovery >= recoverEvery) {
        this.lastRecovery = Date.now();
        const room = this.freeSlots();
        if (room > 0) claimed += (await this.recover(Number.isFinite(room) ? room : 10)).length;
      }
      if (this.options.queue && this.options.queue.claim !== false) claimed += (await this.claim()).length;
    } catch (error) {
      this.report(error, {});
    } finally {
      this.ticking = false;
    }
    // Keep claiming while the queue gives work and there is room; otherwise wait for the next poll.
    const pollMs = this.options.queue?.pollMs ?? DEFAULT_POLL_MS;
    this.schedule(claimed > 0 && this.freeSlots() > 0 ? 0 : Math.min(pollMs, this.options.recoverEveryMs ?? pollMs));
  }

  /**
   * Applies the busy policy, returning the thread once this run holds it. The thread is claimed
   * atomically, so of several replicas starting runs on one thread at once, exactly one proceeds and
   * the rest meet the policy; a thread still busy after the policy has run its course is refused.
   */
  private async settleBusyThread(thread: ThreadRecord, options: StartRunOptions, runId: string): Promise<ThreadRecord> {
    const policy = options.onBusy ?? this.options.onBusy ?? 'reject';
    let current = thread;
    // `enqueue` waits its turn for as long as the queue timeout allows; the others need a few tries.
    const deadline = this.now().getTime() + (this.options.queueTimeoutMs ?? 30_000);

    for (let attempt = 0; attempt < 4 || (policy === 'enqueue' && this.now().getTime() < deadline); attempt += 1) {
      const activeId = await this.claimThread(current, runId);
      if (!activeId) return current;
      const active = await this.state.get<RunRecord>(RUNS, activeId);

      if (policy === 'reject') throw new ThreadBusyError(current.id, activeId);
      if (!active) {
        // Another replica claimed the thread and is still recording its run; it will be there shortly.
        await delay(50);
        continue;
      }
      if (policy === 'enqueue') {
        await this.waitForRun(activeId);
        current = await this.thread(current.id, options.principal);
        continue;
      }

      // `interrupt` and `rollback` both stop the run in flight; `rollback` also puts the thread back.
      await this.cancel(activeId, options.principal, `superseded by a new run (${policy})`);
      if (policy === 'rollback') {
        const assistant = this.revisionOf(current.assistant, active.revision?.id);
        if (!assistant.restore) throw new AssistantCapabilityError(current.assistant, 'rolling a thread back');
        const step = (active.metadata as { startedAtStep?: number } | undefined)?.startedAtStep;
        if (step !== undefined) await assistant.restore(current.id, step);
      }
      current = { ...current, activeRunId: undefined };
      await this.state.put(THREADS, current.id, current);
    }
    throw new ThreadBusyError(current.id, current.activeRunId ?? 'another run');
  }

  /**
   * Claims a thread for a run. The claim is a record in the operation store under a unique
   * idempotency key, moved from run to run by compare-and-set, so two replicas cannot both take a free
   * thread: creating it races on the key, and taking it over races on the sequence. Resolves
   * undefined once this run holds the thread, or the id of the unfinished run that does.
   *
   * A store without `findByIdempotencyKey` falls back to the thread record's `activeRunId`, which is
   * what every release before 2.2 used, and which two replicas racing can both see empty.
   */
  private async claimThread(thread: ThreadRecord, runId: string): Promise<string | undefined> {
    if (!this.store.findByIdempotencyKey) {
      const activeId = thread.activeRunId;
      return activeId && !(await this.runIsFree(activeId, undefined)) ? activeId : undefined;
    }
    const key = `${THREAD_CLAIM}${thread.id}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claim = await this.store.findByIdempotencyKey(key);
      const at = this.now().toISOString();
      if (!claim) {
        try {
          await this.store.create({
            id: `${key}:${runId}`,
            // Finished, so no worker ever claims or recovers it as work.
            status: 'succeeded',
            attempt: 1,
            maxAttempts: 1,
            sequence: 0,
            createdAt: at,
            updatedAt: at,
            kind: 'server.thread',
            idempotencyKey: key,
            result: { runId },
          });
          return undefined;
        } catch (error) {
          if (error instanceof OperationDuplicateError) continue;
          throw error;
        }
      }
      const holder = (claim.result as { runId?: string } | undefined)?.runId;
      if (holder === runId) return undefined;
      if (holder && !(await this.runIsFree(holder, claim.updatedAt))) return holder;
      const taken = await this.store.update(
        { ...claim, result: { runId }, sequence: claim.sequence + 1, updatedAt: at },
        claim.sequence,
      );
      if (taken) return undefined;
    }
    const holder = ((await this.store.findByIdempotencyKey(key))?.result as { runId?: string } | undefined)?.runId;
    return holder ?? 'another run';
  }

  /**
   * Whether a thread's holder no longer needs it: its run finished, or it was never recorded and its
   * claim is old enough that the replica starting it must have died.
   */
  private async runIsFree(runId: string, claimedAt: string | undefined): Promise<boolean> {
    const run = await this.state.get<RunRecord>(RUNS, runId);
    if (run) return isFinished(run.status);
    if (claimedAt === undefined) return true;
    return this.now().getTime() - Date.parse(claimedAt) > UNRECORDED_CLAIM_MS;
  }

  /** Frees a thread this run holds. Losing the compare-and-set means another run took it over, which is fine. */
  private async releaseClaim(threadId: string, runId: string): Promise<void> {
    if (!this.store.findByIdempotencyKey) return;
    const claim = await this.store.findByIdempotencyKey(`${THREAD_CLAIM}${threadId}`);
    if (!claim || (claim.result as { runId?: string } | undefined)?.runId !== runId) return;
    await this.store.update(
      { ...claim, result: {}, sequence: claim.sequence + 1, updatedAt: this.now().toISOString() },
      claim.sequence,
    );
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
    await this.releaseClaim(threadId, runId).catch((error: unknown) => this.report(error, { runId }));
    const thread = await this.state.get<ThreadRecord>(THREADS, threadId);
    if (!thread || thread.activeRunId !== runId) return;
    await this.state.put(THREADS, threadId, { ...thread, activeRunId: undefined, updatedAt: this.now().toISOString() });
  }

  private async releaseTenant(runId: string, tenantId: string | undefined): Promise<void> {
    if (!this.options.tenants) return;
    try {
      await this.options.tenants.release({ runId, tenantId });
    } catch (error) {
      this.report(error, { runId });
    }
  }

  private countFinished(run: RunRecord): void {
    const labels = { assistant: run.assistant, revision: run.revision?.id ?? '' };
    this.metrics.count('nexus_server_runs_finished_total', { ...labels, status: run.status });
    if (run.durationMs !== undefined) {
      this.metrics.observe('nexus_server_run_duration_seconds', labels, run.durationMs / 1000);
    }
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
    fields: Partial<
      Pick<RunRecord, 'output' | 'error' | 'interrupt' | 'startedAt' | 'finishedAt' | 'worker' | 'attempt'>
    > & { addCost?: number } = {},
  ): Promise<RunRecord> {
    const current = await this.state.get<RunRecord>(RUNS, runId);
    // A cancelled run stays cancelled: its executor may still be unwinding, and the outcome a client
    // already saw must not change underneath it. A failed one may still be recovered and re-run.
    if (current?.status === 'cancelled' && status !== 'cancelled') return current;
    const { addCost, ...rest } = fields;
    const next: RunRecord = {
      ...(current ?? { id: runId, assistant: 'unknown', status, createdAt: this.now().toISOString() }),
      ...rest,
      status,
      updatedAt: this.now().toISOString(),
    } as RunRecord;
    // The first start is the one that counts: a retry or a hand-off does not reset the clock.
    if (current?.startedAt) next.startedAt = current.startedAt;
    if (addCost) next.cost = (current?.cost ?? 0) + addCost;
    if (next.finishedAt && next.startedAt) {
      next.durationMs = Math.max(0, Date.parse(next.finishedAt) - Date.parse(next.startedAt));
    }
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
  // A workflow's final event carries its return value as `output`; a graph's carries its state.
  return record.output ?? record.state ?? event;
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer === 'object') timer.unref?.();
  });
}

/**
 * True for an error that hands a run off: a graph's `GraphDrainedError` or an assistant's
 * `RunHandOffError`, read by their codes.
 */
function isDrained(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'GRAPH_DRAINED' || code === 'RUN_HANDED_OFF';
}
