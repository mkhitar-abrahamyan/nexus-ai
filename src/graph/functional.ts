/**
 * Durable workflows written as ordinary TypeScript.
 *
 * A graph makes the shape of a program explicit: nodes, edges, and channels. Some programs are better
 * written as plain control flow — loops, early returns, `Promise.all` — and still need what a graph
 * gives: a checkpoint after every piece of work, a question a person answers hours later, and a run
 * that picks up on another worker after a crash. `workflow()` gives that to a function. Each `step()`
 * records its result; when the workflow runs again — resumed, continued, or recovered — completed
 * steps return their recorded result instantly and the function carries on from the first step that
 * did not finish.
 *
 * The checkpoints are ordinary graph checkpoints, so every checkpointer — memory, Redis, Postgres,
 * SQLite — stores a workflow, and `state()`, `history()`, and the studio read it.
 */
import { MemoryGraphCheckpointer } from './checkpointer.js';
import { withLifecycle } from '../lifecycle/run.js';
import type { OperationLifecycleLike } from '../types/lifecycle.js';
import { type CheckpointDraft, migrateCheckpoint, toCheckpoint } from './checkpoint-migration.js';
import { GraphError, GraphNotInterruptedError, GraphThreadNotFoundError } from './errors.js';
import type {
  GraphCheckpoint,
  GraphCheckpointer,
  GraphDescription,
  GraphEvent,
  GraphStatus,
  InterruptRequest,
  PendingInterrupt,
  RetryPolicy,
} from '../types/graph.js';
import type { Store } from '../types/store.js';

/** What a workflow checkpoint holds: the input, every completed step's result, and the output. */
export interface WorkflowState<I = unknown, O = unknown> {
  /** The input the workflow was started with. */
  input: I;
  /** Each completed step's result, keyed by step name — `name#2` for the second call with a name. */
  steps: Record<string, { value?: unknown }>;
  /** The workflow's return value, once it has completed. */
  output?: O;
}

/** What a step's function receives. */
export interface StepContext {
  /** The step's name. */
  readonly name: string;
  /** The key its result is recorded under: the name, or `name#n` for a repeated name. */
  readonly key: string;
  /** Attempt number, starting at 1. Above 1 only under a retry policy. */
  readonly attempt: number;
  /** Aborted when the run is cancelled or the step exceeds its timeout. */
  readonly signal: AbortSignal;
}

/** How one step runs. */
export interface StepOptions {
  /** Retries a failing attempt, overriding the workflow's default policy. */
  retry?: RetryPolicy;
  /** Aborts the step's signal and fails the attempt when it runs longer than this, in milliseconds. */
  timeoutMs?: number;
}

/** What a workflow function receives besides its input. */
export interface WorkflowContext {
  /** The thread this run belongs to. */
  readonly threadId: string;
  /** Aborted when the run is cancelled. */
  readonly signal: AbortSignal;
  /** Long-term memory, when the workflow was created with a store. */
  readonly store?: Store;
  /**
   * Runs a piece of work once per thread and records its result.
   *
   * When the workflow runs again, a step that already finished returns its recorded result without
   * running. Name steps so the same call has the same name every time; a name used more than once
   * is numbered in call order. The result must survive JSON serialization.
   */
  step<T>(name: string, run: (context: StepContext) => Promise<T> | T, options?: StepOptions): Promise<T>;
  /**
   * Suspends the workflow until a person answers.
   *
   * The first time, the run stops with status `awaiting_input` and this question pending. After
   * `resume()` supplies a value, the workflow runs again from the top — completed steps return their
   * recorded results — and this call returns the value instead of stopping.
   */
  interrupt<T = unknown>(request: InterruptRequest): T;
  /** Sends anything to the run's `onEvent` listener as a `custom` event. Nothing is recorded. */
  emit(data: unknown): void;
}

/** A workflow function: its input and context in, its output out. */
export type WorkflowFn<I, O> = (input: I, context: WorkflowContext) => Promise<O> | O;

/** Options for `workflow()`. */
export interface WorkflowOptions {
  /** Names the workflow in checkpoints, events, and diagrams. Defaults to `workflow`. */
  name?: string;
  /**
   * Where checkpoints go. Defaults to an in-process `MemoryGraphCheckpointer`; pass a persistent one
   * to survive restarts, or `false` to record nothing, which also disables interrupts and resume.
   */
  checkpointer?: GraphCheckpointer | false;
  /** Long-term memory handed to the function as `context.store`. */
  store?: Store;
  /** Default retry policy for every step. A step's own policy wins. Defaults to one attempt. */
  retry?: RetryPolicy;
  /** Steps that may run at once, for a workflow that starts many with `Promise.all`. Defaults to 16. */
  maxConcurrency?: number;
  /**
   * Runs every invocation as one operation of a client's lifecycle: pass `ai.lifecycle`. Model calls
   * inside its steps are operations of their own.
   */
  lifecycle?: OperationLifecycleLike;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Options for one run of a workflow. */
export interface WorkflowRunOptions {
  /** Identifies the run. Reusing one continues that thread. Defaults to a generated id. */
  threadId?: string;
  /** Stops the run. Steps in flight see the signal. */
  signal?: AbortSignal;
  /** Application data recorded on every checkpoint of the run. */
  metadata?: Record<string, unknown>;
  /** Receives each step starting, retrying, and finishing, each checkpoint, and custom events. */
  onEvent?: (event: GraphEvent) => void;
}

/** One event of a streamed workflow run. */
export type WorkflowEvent<O = unknown> =
  | {
      /** A step finished, or returned its recorded result. */
      type: 'step';
      /** Checkpoints written so far in the thread. */
      step: number;
      /** The step's name. */
      name: string;
      /** The key its result is recorded under. */
      key: string;
      /** True when the result came from a checkpoint and the step did not run. */
      cached: boolean;
      /** The workflow state after the step. */
      state: WorkflowState<unknown, O>;
      /** Always `running`. */
      status: 'running';
    }
  | {
      /** The workflow returned. */
      type: 'done';
      /** Checkpoints written in the thread. */
      step: number;
      /** The final state. */
      state: WorkflowState<unknown, O>;
      /** Always `completed`. */
      status: 'completed';
      /** What the workflow returned. */
      output: O;
    }
  | {
      /** The workflow is waiting for a person, or was stopped by its signal. */
      type: 'interrupt';
      /** Checkpoints written in the thread. */
      step: number;
      /** The state when it stopped. */
      state: WorkflowState<unknown, O>;
      /** `awaiting_input` for a question, `interrupted` for a cancelled run. */
      status: 'awaiting_input' | 'interrupted';
      /** The first pending question. */
      interrupt?: PendingInterrupt;
      /** Every pending question. */
      interrupts?: PendingInterrupt[];
    };

/** The outcome of a workflow run. */
export interface WorkflowResult<O = unknown> {
  /** The thread the run belongs to. */
  threadId: string;
  /** `completed`, `awaiting_input`, or `interrupted`. A failed run throws instead. */
  status: GraphStatus;
  /** What the workflow returned, when it completed. */
  output?: O;
  /** The workflow state: input, step results, and output. */
  state: WorkflowState<unknown, O>;
  /** Steps whose results are recorded. */
  steps: number;
  /** The first pending question, when it is waiting. */
  interrupt?: PendingInterrupt;
  /** Every pending question. */
  interrupts?: PendingInterrupt[];
}

/** Raised when a step outlives its `timeoutMs`. */
export class WorkflowStepTimeoutError extends GraphError {
  constructor(
    /** The step. */
    readonly stepName: string,
    /** The limit it exceeded, in milliseconds. */
    readonly timeoutMs: number,
  ) {
    super(`Step "${stepName}" exceeded its ${timeoutMs} ms timeout`, 'WORKFLOW_STEP_TIMEOUT');
    this.name = 'WorkflowStepTimeoutError';
  }
}

/** Thrown inside the function to stop it at an interrupt. Never escapes a run. */
class WorkflowSuspended extends Error {
  constructor(readonly pending: PendingInterrupt) {
    super(`Workflow waiting for input: ${pending.reason}`);
  }
}

const DEFAULT_RETRY = { maxAttempts: 1, initialIntervalMs: 250, backoffFactor: 2, maxIntervalMs: 30_000, jitter: true };

/**
 * A durable workflow: a function whose steps are checkpointed, so it survives interrupts, restarts,
 * and a move to another worker. Create one with `workflow()`.
 */
export class Workflow<I = unknown, O = unknown> {
  /** The workflow's name. */
  readonly name: string;
  private readonly defaultCheckpointer: GraphCheckpointer | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly fn: WorkflowFn<I, O>,
    private readonly options: WorkflowOptions = {},
  ) {
    this.name = options.name ?? 'workflow';
    this.defaultCheckpointer =
      options.checkpointer === false ? undefined : (options.checkpointer ?? new MemoryGraphCheckpointer());
    this.now = options.now ?? (() => new Date());
  }

  /** Runs to the end, or to the first question, and returns the result. */
  async invoke(input: I, runOptions: WorkflowRunOptions = {}): Promise<WorkflowResult<O>> {
    const threadId = runOptions.threadId ?? generatedId();
    return this.collect(threadId, this.stream(input, { ...runOptions, threadId }));
  }

  /** Runs, yielding an event as each step finishes. */
  stream(input: I, runOptions: WorkflowRunOptions = {}): AsyncIterable<WorkflowEvent<O>> {
    const threadId = runOptions.threadId ?? generatedId();
    // A new run on an existing thread starts from a fresh state, numbered after the thread's history.
    return this.execute(threadId, runOptions, async () => ({
      ...this.fresh(threadId, input),
      step: (await this.latest(threadId))?.step ?? 0,
    }));
  }

  /** Answers the first pending question and runs on. */
  resume(threadId: string, value: unknown, runOptions: WorkflowRunOptions = {}): AsyncIterable<WorkflowEvent<O>> {
    return this.execute(threadId, runOptions, async () => {
      const checkpoint = await this.waiting(threadId);
      const first = checkpoint.interrupts[0];
      return this.answered(checkpoint, first ? { [first.id]: value } : {});
    });
  }

  /** Answers the first pending question, runs on, and returns the result. */
  async resumeWith(threadId: string, value: unknown, runOptions: WorkflowRunOptions = {}): Promise<WorkflowResult<O>> {
    return this.collect(threadId, this.resume(threadId, value, runOptions));
  }

  /** Answers pending questions by id and runs on. */
  resumeInterrupts(
    threadId: string,
    answers: Record<string, unknown>,
    runOptions: WorkflowRunOptions = {},
  ): AsyncIterable<WorkflowEvent<O>> {
    return this.execute(threadId, runOptions, async () => this.answered(await this.waiting(threadId), answers));
  }

  /**
   * Runs a thread on from its latest checkpoint: after a crash, a failure, or a cancelled run.
   * Completed steps return their recorded results, so only unfinished work runs again.
   */
  continue(threadId: string, runOptions: WorkflowRunOptions = {}): AsyncIterable<WorkflowEvent<O>> {
    return this.execute(threadId, runOptions, async () => {
      const checkpoint = await this.latest(threadId);
      if (!checkpoint) throw new GraphThreadNotFoundError(threadId);
      return checkpoint;
    });
  }

  /** The latest checkpoint, or the one at `step`. */
  async state(threadId: string, step?: number): Promise<GraphCheckpoint | undefined> {
    const stored = await this.checkpointer()?.get(threadId, step);
    return stored ? migrateCheckpoint(stored) : undefined;
  }

  /** Every checkpoint of a thread, newest first. */
  async history(threadId: string, limit?: number): Promise<GraphCheckpoint[]> {
    const stored = (await this.checkpointer()?.history(threadId, limit)) ?? [];
    return stored.map((item) => migrateCheckpoint(item));
  }

  /** The workflow as a one-node graph, so diagrams and the studio can show it. */
  describe(): GraphDescription {
    return {
      name: this.name,
      nodes: [{ id: this.name }],
      edges: [
        { from: '__start__', to: this.name },
        { from: this.name, to: '__end__' },
      ],
      dynamic: [],
    };
  }

  private checkpointer(): GraphCheckpointer | undefined {
    return this.defaultCheckpointer;
  }

  private async latest(threadId: string): Promise<GraphCheckpoint | undefined> {
    const stored = await this.checkpointer()?.get(threadId);
    return stored ? migrateCheckpoint(stored) : undefined;
  }

  private fresh(threadId: string, input: I): CheckpointDraft {
    const state: WorkflowState<I, O> = { input, steps: {} };
    return {
      threadId,
      step: 0,
      state: state as never,
      next: [this.name],
      status: 'running',
      createdAt: this.now().toISOString(),
    };
  }

  private async waiting(threadId: string): Promise<GraphCheckpoint> {
    const checkpoint = await this.latest(threadId);
    if (!checkpoint) throw new GraphThreadNotFoundError(threadId);
    if (checkpoint.status !== 'awaiting_input') throw new GraphNotInterruptedError(threadId, checkpoint.status);
    return checkpoint;
  }

  private answered(checkpoint: GraphCheckpoint, answers: Record<string, unknown>): GraphCheckpoint {
    return { ...checkpoint, resolved: { ...checkpoint.resolved, ...answers } };
  }

  private async collect(threadId: string, events: AsyncIterable<WorkflowEvent<O>>): Promise<WorkflowResult<O>> {
    let last: WorkflowEvent<O> | undefined;
    for await (const event of events) last = event;
    const state = (last?.state ?? { input: undefined, steps: {} }) as WorkflowState<unknown, O>;
    return {
      threadId,
      status: last?.status ?? 'running',
      ...(last?.type === 'done' ? { output: last.output } : {}),
      state,
      steps: Object.keys(state.steps).length,
      ...(last?.type === 'interrupt' && last.interrupt
        ? { interrupt: last.interrupt, interrupts: last.interrupts }
        : {}),
    };
  }

  /** Runs the function against a starting checkpoint, streaming events through a queue. */
  private execute(
    threadId: string,
    runOptions: WorkflowRunOptions,
    start: () => Promise<CheckpointDraft>,
  ): AsyncIterable<WorkflowEvent<O>> {
    const queue = new EventQueue<WorkflowEvent<O>>();
    void withLifecycle(
      this.options.lifecycle,
      { family: 'graph', operation: `workflow.${this.name}`, metadata: { threadId, graph: this.name } },
      runOptions.signal ? { signal: runOptions.signal } : {},
      () => this.run(threadId, runOptions, start, queue),
    ).then(
      () => queue.close(),
      (error: unknown) => queue.fail(error),
    );
    return queue;
  }

  private async run(
    threadId: string,
    runOptions: WorkflowRunOptions,
    start: () => Promise<CheckpointDraft>,
    queue: EventQueue<WorkflowEvent<O>>,
  ): Promise<void> {
    const initial = await start();
    const checkpointer = this.checkpointer();
    const state = structuredClone(initial.state) as unknown as WorkflowState<I, O>;
    state.steps ??= {};
    const resolved: Record<string, unknown> = { ...initial.resolved };
    const metadata = { ...initial.metadata, graph: this.name, ...runOptions.metadata };
    let stepNumber = initial.step;
    let writes = Promise.resolve();

    // Checkpoints are written one at a time, in completion order, so parallel steps cannot interleave.
    const persist = (checkpoint: Omit<CheckpointDraft, 'threadId' | 'step' | 'createdAt'>): Promise<void> => {
      writes = writes.then(async () => {
        stepNumber += 1;
        const written = toCheckpoint({
          ...checkpoint,
          threadId,
          step: stepNumber,
          createdAt: this.now().toISOString(),
          metadata,
        });
        if (checkpointer) await checkpointer.put(written);
        notify(runOptions, { type: 'checkpoint', step: stepNumber, status: written.status, next: written.next });
      });
      return writes;
    };
    // Events carry a shallow copy: later steps cannot change an event already delivered.
    const snapshot = (): WorkflowState<unknown, O> =>
      ({ ...state, steps: { ...state.steps } }) as WorkflowState<unknown, O>;

    const controller = new AbortController();
    const abort = () => controller.abort(runOptions.signal?.reason);
    if (runOptions.signal?.aborted) abort();
    else runOptions.signal?.addEventListener('abort', abort, { once: true });

    const counts = new Map<string, number>();
    const inFlight = new Set<Promise<unknown>>();
    const suspended: PendingInterrupt[] = [];
    let interruptIndex = 0;
    const limiter = new Limiter(this.options.maxConcurrency ?? 16);

    const context: WorkflowContext = {
      threadId,
      signal: controller.signal,
      ...(this.options.store ? { store: this.options.store } : {}),
      step: <T>(name: string, run: (stepContext: StepContext) => Promise<T> | T, options: StepOptions = {}) => {
        const count = (counts.get(name) ?? 0) + 1;
        counts.set(name, count);
        const key = count === 1 ? name : `${name}#${count}`;
        const recorded = state.steps[key];
        if (recorded) {
          queue.push({ type: 'step', step: stepNumber, name, key, cached: true, state: snapshot(), status: 'running' });
          return Promise.resolve(recorded.value as T);
        }
        const work = limiter
          .run(() =>
            this.runStep(
              name,
              key,
              run,
              { ...this.options.retry, ...options.retry },
              options,
              controller.signal,
              runOptions,
              stepNumber,
            ),
          )
          .then(async (value) => {
            // A step's result is recorded once it resolves, whatever the workflow does next.
            state.steps[key] = value === undefined ? {} : { value: structuredClone(value) };
            await persist({ state: state as never, next: [this.name], status: 'running' });
            queue.push({
              type: 'step',
              step: stepNumber,
              name,
              key,
              cached: false,
              state: snapshot(),
              status: 'running',
            });
            return value;
          });
        inFlight.add(work);
        void work.then(
          () => inFlight.delete(work),
          () => inFlight.delete(work),
        );
        return work as Promise<T>;
      },
      interrupt: <T>(request: InterruptRequest): T => {
        if (!checkpointer) {
          throw new GraphError(
            'A workflow created with checkpointer: false cannot interrupt',
            'WORKFLOW_NO_CHECKPOINTER',
          );
        }
        const index = interruptIndex++;
        const id = `${this.name}:interrupt:${index}`;
        if (id in resolved) return resolved[id] as T;
        const pending: PendingInterrupt = {
          ...request,
          id,
          node: this.name,
          step: stepNumber,
          index,
          requestedAt: this.now().toISOString(),
        };
        suspended.push(pending);
        throw new WorkflowSuspended(pending);
      },
      emit: (data: unknown) =>
        notify(runOptions, { type: 'custom', step: stepNumber, taskId: this.name, node: this.name, data }),
    };

    let outcome: { kind: 'done'; output: O } | { kind: 'failed'; error: unknown };
    try {
      outcome = { kind: 'done', output: await this.fn(state.input, context) };
    } catch (error) {
      outcome = { kind: 'failed', error };
    }
    // Steps started alongside the one that stopped the workflow still finish and are recorded, so a
    // resume does not repeat them.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    runOptions.signal?.removeEventListener('abort', abort);

    const questions =
      suspended.length > 0 && (outcome.kind === 'failed' ? outcome.error instanceof WorkflowSuspended : true);
    if (questions) {
      await persist({
        state: state as never,
        next: [this.name],
        status: 'awaiting_input',
        interrupts: suspended,
        resolved,
      });
      await writes;
      queue.push({
        type: 'interrupt',
        step: stepNumber,
        state: snapshot(),
        status: 'awaiting_input',
        interrupt: suspended[0],
        interrupts: [...suspended],
      });
      return;
    }
    if (controller.signal.aborted) {
      await persist({ state: state as never, next: [this.name], status: 'interrupted', resolved });
      await writes;
      queue.push({ type: 'interrupt', step: stepNumber, state: snapshot(), status: 'interrupted' });
      return;
    }
    if (outcome.kind === 'failed') {
      const error = outcome.error;
      await persist({
        state: state as never,
        next: [this.name],
        status: 'failed',
        resolved,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      await writes;
      throw error;
    }
    state.output = outcome.output;
    await persist({ state: state as never, next: [], status: 'completed', resolved });
    await writes;
    queue.push({ type: 'done', step: stepNumber, state: snapshot(), status: 'completed', output: outcome.output });
  }

  private async runStep<T>(
    name: string,
    key: string,
    run: (context: StepContext) => Promise<T> | T,
    retry: RetryPolicy,
    options: StepOptions,
    signal: AbortSignal,
    runOptions: WorkflowRunOptions,
    step: number,
  ): Promise<T> {
    const policy = { ...DEFAULT_RETRY, ...retry };
    for (let attempt = 1; ; attempt += 1) {
      notify(runOptions, { type: 'task_start', step, taskId: key, node: name, attempt });
      const stepController = new AbortController();
      const forward = () => stepController.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const work = Promise.resolve(run({ name, key, attempt, signal: stepController.signal }));
        const value =
          options.timeoutMs === undefined
            ? await work
            : await Promise.race([
                work,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => {
                    // Reject before aborting: a step that settles on abort must not win the race.
                    timedOut = true;
                    reject(new WorkflowStepTimeoutError(name, options.timeoutMs as number));
                    stepController.abort();
                  }, options.timeoutMs);
                }),
              ]);
        if (timedOut) throw new WorkflowStepTimeoutError(name, options.timeoutMs as number);
        notify(runOptions, { type: 'task_end', step, taskId: key, node: name, update: value });
        return value;
      } catch (error) {
        if (signal.aborted || error instanceof WorkflowSuspended) throw error;
        const failure = timedOut ? new WorkflowStepTimeoutError(name, options.timeoutMs as number) : error;
        const retryable = policy.retryOn
          ? policy.retryOn(failure, attempt)
          : !(failure instanceof GraphError) || timedOut;
        if (attempt >= Math.max(1, policy.maxAttempts) || !retryable) throw failure;
        notify(runOptions, {
          type: 'task_retry',
          step,
          taskId: key,
          node: name,
          attempt,
          error: failure instanceof Error ? failure.message : String(failure),
        });
        await sleep(backoff(policy, attempt), signal);
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', forward);
      }
    }
  }
}

/**
 * Creates a durable workflow from a function.
 *
 * ```ts
 * const refund = workflow(async (input: { orderId: string }, { step, interrupt }) => {
 *   const order = await step('load', () => orders.get(input.orderId));
 *   if (!interrupt<boolean>({ reason: `Refund ${order.total}?` })) return { refunded: false };
 *   await step('refund', () => payments.refund(order.id));
 *   return { refunded: true };
 * }, { checkpointer });
 * ```
 */
export function workflow<I, O>(fn: WorkflowFn<I, O>, options: WorkflowOptions = {}): Workflow<I, O> {
  return new Workflow(fn, options);
}

/** A push queue read as an async iterable: the run pushes events, the caller pulls them. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private rejecting: ((error: unknown) => void) | undefined;
  private done = false;
  private error: { value: unknown } | undefined;

  push(item: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.rejecting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.done = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  fail(error: unknown): void {
    this.error = { value: error };
    this.rejecting?.(error);
    this.waiting = undefined;
    this.rejecting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.error) return Promise.reject(this.error.value);
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = resolve;
          this.rejecting = reject;
        });
      },
    };
  }
}

/** Bounds how many steps run at once. */
class Limiter {
  private active = 0;
  private readonly queued: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= Math.max(1, this.limit)) await new Promise<void>((resolve) => this.queued.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queued.shift()?.();
    }
  }
}

function notify(runOptions: WorkflowRunOptions, event: GraphEvent): void {
  if (!runOptions.onEvent) return;
  try {
    runOptions.onEvent(event);
  } catch {
    // A listener that throws must never fail the run it observes.
  }
}

function backoff(policy: typeof DEFAULT_RETRY, attempt: number): number {
  const capped = Math.min(policy.initialIntervalMs * policy.backoffFactor ** (attempt - 1), policy.maxIntervalMs);
  return policy.jitter ? Math.round(capped * (0.5 + Math.random() / 2)) : Math.round(capped);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function generatedId(): string {
  return `thread-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
