import type { OperationLifecycleLike } from './lifecycle.js';
/**
 * Typed state graphs: nodes, edges, cycles, subgraphs, and durable checkpoints.
 *
 * The execution model is a superstep loop. Each step runs the pending nodes, reduces whatever they
 * returned into the state channels, writes a checkpoint, and computes the next set of nodes. That
 * shape is what makes a graph resumable: a checkpoint is a complete description of where the run
 * is, so a different process can pick it up.
 */

import type { CacheAdapter } from '../cache/adapters.js';
import type { Store } from './store.js';

/** Entry sentinel. An edge from `START` names the first node. */
export const START = '__start__';
/** Terminal sentinel. An edge to `END` finishes that branch. */
export const END = '__end__';

/**
 * Where a run stands: running, paused to ask a human, finished, failed, or stopped at a breakpoint
 * or by a signal.
 */
export type GraphStatus = 'running' | 'awaiting_input' | 'completed' | 'failed' | 'interrupted';

/**
 * Routes to one node with its own input, creating one task per value.
 *
 * Fan-out over edges can only name nodes that already exist in the graph. `Send` is how a run decides
 * at execution time how many copies of a node to run: fifty URLs become fifty tasks of the same node,
 * each reading its own `context.input`, all in one superstep.
 */
export class Send {
  constructor(
    /** The node to run. */
    readonly node: string,
    /** What the task receives as `context.input`. */
    readonly input?: unknown,
    /** Options for this task alone. `timeout` replaces the node's own for it. */
    readonly options?: SendOptions,
  ) {}
}

/** Options for one task a `Send` creates. */
export interface SendOptions {
  /** Replaces the node's timeout for this task, such as a longer limit for one large document. */
  timeout?: NodeTimeout;
}

/** Where a `Command` sends control. */
export type CommandTarget = string | Send | Array<string | Send>;

/**
 * Updates state and chooses what runs next, in one return value.
 *
 * A router decides where to go after a node from the state that node left behind. When the node
 * itself already knows — an agent that just picked a tool, a triage step that classified a ticket —
 * splitting that decision into a separate router means computing it twice. A node that returns a
 * `Command` writes its update and names its successors together.
 *
 * `goto` is added to the node's outgoing edges, so a node that routes by `Command` usually has none;
 * declare its possible targets with `ends` so compile-time checks and diagrams stay exact.
 * `graph: Command.PARENT` hands the command to the graph that contains this one as a subgraph, which
 * is how a nested agent hands control back.
 */
export class Command<U = Record<string, unknown>> {
  /** Addresses the graph that contains this one, from inside a subgraph. */
  static readonly PARENT = '__parent__';

  /** State to write, reduced through the channels like any update. */
  readonly update?: U;
  /** Where to go next, replacing the node's outgoing edges for this step. */
  readonly goto?: CommandTarget;
  /** `Command.PARENT` to apply the command to the containing graph instead of this one. */
  readonly graph?: typeof Command.PARENT;

  constructor(options: { update?: U; goto?: CommandTarget; graph?: typeof Command.PARENT }) {
    this.update = options.update;
    this.goto = options.goto;
    this.graph = options.graph;
  }
}

/**
 * One unit of work in a superstep.
 *
 * A plain node produces a task whose id is the node name. A `Send` produces a task with a generated
 * id and its own input, so several tasks of one node stay distinct across a checkpoint and a resume.
 */
export interface GraphTask {
  /** Unique within its step: the node name, or `node#step.n` for a task created by `Send`. */
  id: string;
  /** The node the task runs. */
  node: string;
  /** The task's `Send` input. */
  input?: unknown;
  /** The timeout its `Send` set, replacing the node's own. */
  timeout?: NodeTimeout;
}

/**
 * How long a node may run, in two senses.
 *
 * `runMs` caps the whole attempt: "this may never take longer than ten minutes". `idleMs` caps the
 * time between signs of progress: "this may take ten minutes, but must show progress every thirty
 * seconds". A node shows progress by calling `context.heartbeat()`, `context.emit()`, or
 * `context.report()`. Either limit fails the attempt with `GraphNodeTimeoutError`, which the retry
 * policy may retry.
 */
export interface NodeTimeout {
  /** The longest an attempt may run, in milliseconds. */
  runMs?: number;
  /** The longest an attempt may go without showing progress, in milliseconds. */
  idleMs?: number;
}

/**
 * When a graph writes its checkpoints.
 *
 * - `sync` (the default) writes each checkpoint before the next superstep starts. Use it when a
 *   node's side effects must line up with the state that records them, such as payments.
 * - `async` writes checkpoints in the background while the graph runs on. Every write still
 *   happens, in order, and the run waits for them before it returns, pauses, fails, or drains. A
 *   crash can lose the last few supersteps, which then run again.
 * - `exit` writes only when the run stops: at an interrupt, a breakpoint, completion, a failure, an
 *   abort, or a drain. A crash loses the whole run. For short, high-throughput graphs.
 */
export type DurabilityMode = 'sync' | 'async' | 'exit';

/**
 * Why a node's last attempt failed, handed to its `onError` once retries are exhausted.
 *
 * Everything here is what the runtime knows at the moment of failure. The decision `onError`
 * returns is checkpointed before the graph moves on, so a crash after it resumes into the same path.
 */
export interface NodeFailure {
  /** The node that failed. */
  node: string;
  /** The task that failed. Equal to `node` unless the task came from a `Send`. */
  taskId: string;
  /** The superstep it failed in. */
  step: number;
  /** Attempts made, including the last. */
  attempts: number;
  /** ISO-8601 time of the first attempt. */
  firstAttemptAt: string;
  /** ISO-8601 time the last attempt failed. */
  failedAt: string;
  /** What the last attempt threw. */
  error: unknown;
  /** True when the retry policy ran out; false when the error was not retryable. */
  retryExhausted: boolean;
  /** The limit that ended the last attempt, when a timeout did. */
  timeout?: { type: 'run' | 'idle'; limitMs: number };
  /** The task's `Send` input. */
  input?: unknown;
  /** The thread the run belongs to. */
  threadId: string;
}

/**
 * Decides what happens after a node's retries are exhausted: a state update, a `Command` that
 * routes to a compensation node, or nothing, to carry on along the node's own edges. Throwing fails
 * the graph with that error.
 *
 * It decides; it should not act. Compensation with side effects belongs in the node it routes to,
 * which runs only after the decision is checkpointed.
 */
export type NodeErrorHandler<S extends ChannelSchema = ChannelSchema> = (
  failure: NodeFailure,
  context: { state: Readonly<StateOf<S>> },
) => NodeResult<S> | Promise<NodeResult<S>>;

/** A failure a node's `onError` recovered from, as its checkpoint records it. */
export interface RecoveredFailure {
  /** The node that failed. */
  node: string;
  /** The task that failed. */
  taskId: string;
  /** The superstep it failed in. */
  step: number;
  /** Attempts made. */
  attempts: number;
  /** What the last attempt threw, as a name and a message. */
  error: { name: string; message: string };
  /** ISO-8601 time the last attempt failed. */
  failedAt: string;
  /** True when the retry policy ran out. */
  retryExhausted: boolean;
  /** The limit that ended the last attempt, when a timeout did. */
  timeout?: { type: 'run' | 'idle'; limitMs: number };
  /** Where `onError` sent the run, when it returned a `Command` with a target. */
  goto?: string[];
}

/**
 * Asks a running graph to stop at the end of its current superstep.
 *
 * `RunControl` from `nexus-ai-pro/graph` implements it. Any object with these members works, so a
 * server can pass its own.
 */
export interface RunControlLike {
  /** True once a drain was requested. */
  readonly draining: boolean;
  /** Why the drain was requested. */
  readonly reason?: string;
}

/**
 * How a node retries. Applied per node, or as the graph default through `compile({ retry })`.
 *
 * Defaults to a single attempt: retrying is only safe when the node is idempotent, which the graph
 * cannot know. Interrupts, aborts, and validation errors are never retried.
 */
export interface RetryPolicy {
  /** Total attempts, including the first. Defaults to 1. */
  maxAttempts?: number;
  /** Delay before the second attempt. Defaults to 250 ms. */
  initialIntervalMs?: number;
  /** Multiplier applied to each subsequent delay. Defaults to 2. */
  backoffFactor?: number;
  /** Ceiling for the delay. Defaults to 30 seconds. */
  maxIntervalMs?: number;
  /** Spreads retries of simultaneous tasks rather than aligning them. Defaults to true. */
  jitter?: boolean;
  /** Decides whether this error is worth retrying. Defaults to retrying anything else. */
  retryOn?(error: unknown, attempt: number): boolean;
}

/**
 * How a node runs: retries, timeouts, recovery, where it may route, deferral, caching, and whether
 * it is safe to run twice.
 */
export interface NodeOptions<S extends ChannelSchema = ChannelSchema> {
  /** Retries failed attempts, overriding the graph's default policy. */
  retry?: RetryPolicy;
  /** Aborts the node's signal and fails the attempt when it runs longer than this. Same as `timeout.runMs`. */
  timeoutMs?: number;
  /** A run limit, an idle limit, or both. `timeout.runMs` wins over `timeoutMs`. */
  timeout?: NodeTimeout;
  /**
   * Called once retries are exhausted, instead of failing the graph. See `NodeErrorHandler`. A
   * `Command` it returns may route anywhere; declare those targets in `ends`.
   */
  onError?: NodeErrorHandler<S>;
  /**
   * Declares that running this node twice is safe: it has no side effects, or they carry an
   * idempotency key. Nothing at run time depends on it; `lintGraph()` uses it to flag retried nodes
   * that are not.
   */
  idempotent?: boolean;
  /**
   * Nodes this one may reach through `Send` or a `Command`. Declaring them keeps compile-time
   * reachability checks and diagrams exact, so a node reached only that way is not reported as
   * unreachable.
   */
  ends?: string[];
  /**
   * Waits until every other pending task has finished before running.
   *
   * For an aggregator after branches of different lengths: without it, the aggregator would run as
   * soon as the shortest branch reached it, and again for each longer branch.
   */
  defer?: boolean;
  /**
   * Reuses this node's result when it would see exactly what it saw before.
   *
   * Worth it for a node that is expensive and deterministic in its state and input: a retrieval, a
   * classification, a model call at temperature zero. Only completed results are kept. A failure,
   * an interrupt, a node that consumed an interrupt's answer, and a command for a parent graph always
   * run again, because their results depend on something the key cannot see.
   */
  cache?: NodeCachePolicy;
}

/** How a node reuses its results: the key, how long a result lasts, and where results are kept. */
export interface NodeCachePolicy {
  /**
   * Builds the key. Defaults to a hash of the graph name, the node, the whole state it reads, and
   * its `Send` input, which is always correct and sometimes too specific: a node that reads one
   * channel of a growing state should key on that channel. Return `undefined` to skip the cache for
   * one call.
   */
  key?: (context: { node: string; state: unknown; input?: unknown }) => string | undefined;
  /** How long a result is reused. Defaults to 5 minutes. A store taking seconds gets it rounded up. */
  ttlMs?: number;
  /**
   * Where results are kept: any cache adapter, such as Redis to share results across workers. The
   * cached update must survive that store's serialization. Defaults to the graph's `cache`, then to
   * a bounded in-process map created only when a node first uses it.
   */
  store?: CacheAdapter<NodeCacheEntry>;
}

/** A cached node result: the writes it made and where it routed. */
export interface NodeCacheEntry {
  /** The updates the node returned, in order. */
  updates: unknown[];
  /** Routes the node chose, including `Send` targets and their inputs. */
  goto?: Array<string | { node: string; input?: unknown }>;
}

/**
 * One slot of graph state, plus the rule for combining writes into it.
 *
 * A reducer rather than assignment is what makes parallel branches safe: two nodes running in the
 * same superstep can both write, and the channel decides whether that means overwrite, append, or
 * merge. Without it, concurrent fan-out would silently drop one branch's work.
 */
export interface Channel<T> {
  /** Combines the value already in the channel with what a node returned. */
  reduce(current: T | undefined, update: T): T;
  /** Value the channel holds before any node writes to it. */
  initial?(): T;
}

/** A graph's state channels, by name. */
export type ChannelSchema = Record<string, Channel<unknown>>;

/** The state object a schema describes. */
export type StateOf<S extends ChannelSchema> = {
  [K in keyof S]: S[K] extends Channel<infer T> ? T : never;
};

/** What a node may write back. Omitted channels are left untouched. */
export type StateUpdate<S extends ChannelSchema> = Partial<StateOf<S>>;

/**
 * What a caller may pass to `invoke()`: the graph's input channels, or every channel by default.
 *
 * A graph declared with no input at all takes `Record<string, never>` rather than `{}`, because `{}`
 * would accept any object and let a forbidden write through the types.
 */
export type GraphInput<S extends ChannelSchema, I extends keyof S = keyof S> = [I] extends [never]
  ? Record<string, never>
  : Partial<Pick<StateOf<S>, I>>;

/** Progress a node reported through `context.report()`. */
export interface GraphProgress {
  /** The step the node ran in. */
  step: number;
  /** The node that reported it. */
  node: string;
  /** What the node said it is doing. */
  message?: string;
}

/**
 * A request for human input, surfaced when a node interrupts.
 *
 * Carried on the checkpoint, so the question survives a restart alongside the state that produced
 * it. An operator answering it hours later on a different machine is the normal case.
 */
export interface InterruptRequest {
  /** What the caller is being asked, in terms the answering human understands. */
  reason: string;
  /** Anything the answerer needs in order to decide. Must stay JSON-serializable. */
  payload?: unknown;
}

/** A question a node asked through `interrupt()`, waiting for an answer. */
export interface PendingInterrupt extends InterruptRequest {
  /** Stable identity of this question, used to answer it through `resumeInterrupts()`. */
  id: string;
  /** The node that asked. */
  node: string;
  /** Task that asked, which differs from `node` only for `Send` tasks. */
  taskId?: string;
  /** The step it was asked in. */
  step: number;
  /** Position of this interrupt within the node, so a node may ask more than one question. */
  index: number;
  /** ISO-8601 time it was asked. */
  requestedAt: string;
}

/** What a node receives when it runs. */
export interface NodeContext<S extends ChannelSchema> {
  /** Current state. Frozen: a node writes by returning an update, never by mutation. */
  readonly state: Readonly<StateOf<S>>;
  /** The node's name. */
  readonly node: string;
  /** The current superstep, starting at 0. */
  readonly step: number;
  /** The thread this run belongs to. */
  readonly threadId: string;
  /** Identifies this task. Equal to `node` unless the task came from a `Send`. */
  readonly taskId: string;
  /** Input carried by a `Send`. Undefined for a node reached through an ordinary edge. */
  readonly input?: unknown;
  /** Attempt number, starting at 1. Above 1 only when a retry policy is in force. */
  readonly attempt: number;
  /**
   * Aborted when the run is cancelled, when this node exceeds its `timeoutMs`, or when a sibling
   * task fails under the default `fail-fast` policy.
   */
  readonly signal: AbortSignal;
  /**
   * Suspends the graph until a human answers.
   *
   * Throws a `GraphInterrupt` the first time. After `resume()` supplies a value, replaying this node
   * returns that value here instead of throwing, so the node body reads as ordinary straight-line
   * code either way.
   */
  interrupt<T = unknown>(request: InterruptRequest): T;
  /**
   * Long-term memory, present when the graph was compiled with a store.
   *
   * State is this thread's; the store is everything else the application remembers — across threads,
   * users, and runs.
   */
  readonly store?: Store;
  /** Reports progress without writing to state. Refreshes an idle timeout. */
  report(progress: Omit<GraphProgress, 'step' | 'node'>): void;
  /**
   * Shows the node is still making progress, which refreshes its idle timeout. For long work that
   * neither emits nor reports, such as a large upload or a slow tool call.
   */
  heartbeat(): void;
  /**
   * Sends anything to the run's `onEvent` listener as a `custom` event: intermediate results, a
   * status line. Nothing is written to state or checkpointed. Refreshes an idle timeout.
   */
  emit(data: unknown): void;
  /**
   * Streams a piece of model output as a `message` event, which `events()` delivers on its
   * `messages` projection. `createAgent()` sends its model's output this way. Refreshes an idle
   * timeout.
   */
  message(chunk: GraphMessageChunk): void;
  /**
   * Reports a tool call as a `tool` event, which `events()` delivers on its `tools` projection.
   * `createAgent()` reports every tool it runs this way. Refreshes an idle timeout.
   */
  tool(event: GraphToolEvent): void;
}

/** A node: reads state from its context and returns an update, a `Command`, or nothing. */
export type NodeFn<S extends ChannelSchema> = (context: NodeContext<S>) => Promise<NodeResult<S>> | NodeResult<S>;

/** What a node may return: an update, a `Command`, or nothing. */
// biome-ignore lint/suspicious/noConfusingVoidType: see NodeFn; `void` lets a side-effect node omit its return.
export type NodeResult<S extends ChannelSchema> = StateUpdate<S> | Command<StateUpdate<S>> | void;

/**
 * Chooses where to go after a node.
 *
 * Returning an array fans out: every named node runs in the next superstep, and their writes are
 * combined by the channel reducers.
 */
export type EdgeRouter<S extends ChannelSchema> = (
  state: Readonly<StateOf<S>>,
) => GraphRouteTarget | Promise<GraphRouteTarget>;

/** What a router may return: node names, `Send`s, or a mix of both. */
export type GraphRouteTarget = string | Send | Array<string | Send>;

/**
 * A graph's full state after a superstep, which is everything needed to resume the run elsewhere.
 *
 * This is schema version 2, the one 2.x writes. Every checkpoint carries its id and its pending
 * tasks, and its questions are only in `interrupts`. A checkpoint that 1.x stored is a
 * `GraphCheckpointV1`; the bundled checkpointers read it into this shape, and `migrateCheckpoint()`
 * does the same for a custom one.
 */
export interface GraphCheckpoint<S extends ChannelSchema = ChannelSchema> {
  /** The schema version. */
  version: 2;
  /** The checkpoint's id: the thread and the step, as `<threadId>:<step>`. */
  id: string;
  /** The thread it belongs to. */
  threadId: string;
  /** Supersteps completed. The checkpoint after step N describes the state entering step N+1. */
  step: number;
  /** Every channel's value. */
  state: StateOf<S>;
  /** Nodes to run next. Empty means the run is finished. */
  next: string[];
  /**
   * Tasks of the pending superstep, one per node or `Send`. Empty when the run is finished. A step
   * that paused keeps all of its tasks here, and `completed` says which already ran.
   */
  tasks: GraphTask[];
  /**
   * Tasks of the pending superstep that already finished before it paused or failed. Their writes
   * are already in `state`, so they are not run again, but their outgoing edges still count when the
   * step completes.
   */
  completed?: string[];
  /**
   * Routes chosen by `Command`s from tasks in `completed`, kept so a paused step still follows them
   * when it resumes without re-running those tasks. A plain string is a node; an object is a `Send`.
   */
  gotos?: Record<string, Array<string | { node: string; input?: unknown }>>;
  /** Where the run stands. */
  status: GraphStatus;
  /** Every question the paused superstep asked. Empty when the run is not waiting for input. */
  interrupts: PendingInterrupt[];
  /** Values already supplied for interrupts, keyed by `taskId:step:index`. */
  resolved?: Record<string, unknown>;
  /** Why the run failed, when it did. */
  error?: { name: string; message: string };
  /** Present when the run paused at a breakpoint rather than to ask a question. */
  breakpoint?: GraphBreakpoint;
  /** Failures in the step this checkpoint follows that a node's `onError` recovered from. */
  recovered?: RecoveredFailure[];
  /** Present when the run stopped because a drain was requested. `continue()` resumes it. */
  drained?: { reason?: string; at: string };
  /** ISO-8601 time the checkpoint was written. */
  createdAt: string;
  /** Application data, including `graph` when the graph was compiled with a name. */
  metadata?: Record<string, unknown>;
}

/**
 * A checkpoint as 1.x stored it: no version or id, tasks only when `next` could not say them, and the
 * first question repeated in `interrupt`. 2.x never writes this shape and reads it for the whole 2.x
 * line.
 */
export interface GraphCheckpointV1<S extends ChannelSchema = ChannelSchema>
  extends Omit<GraphCheckpoint<S>, 'version' | 'id' | 'tasks' | 'interrupts'> {
  /** Absent: version 1 had no version field. */
  version?: undefined;
  /** Tasks to run next, present only when they carry more than their node names. */
  tasks?: GraphTask[];
  /** The first pending question. */
  interrupt?: PendingInterrupt;
  /** Every pending question, when the step asked more than one. */
  interrupts?: PendingInterrupt[];
}

/** What a checkpointer may hand back: a checkpoint 2.x wrote, or one 1.x wrote before the upgrade. */
export type StoredGraphCheckpoint<S extends ChannelSchema = ChannelSchema> = GraphCheckpoint<S> | GraphCheckpointV1<S>;

/** Where a run paused for debugging. `continue()` carries on from it. */
export interface GraphBreakpoint {
  /** Whether the pause came before the nodes ran or after they did. */
  when: 'before' | 'after';
  /** The nodes the breakpoint is for. */
  nodes: string[];
}

/**
 * Durable storage for checkpoints.
 *
 * Deliberately not generic over the channel schema: a checkpointer persists opaque state, and
 * threading the schema through it would force every caller to annotate
 * `new MemoryGraphCheckpointer<MySchema>()` for no benefit. The graph casts at this boundary and
 * hands typed state back through `state()` and `history()`.
 *
 * `OperationStoreCheckpointer` adapts the `OperationStore` that already backs durable operations,
 * so a graph inherits Redis persistence without this module depending on that runtime.
 */
export interface GraphCheckpointer {
  /** Stores a checkpoint, replacing any at the same step or later. */
  put(checkpoint: GraphCheckpoint): Promise<void> | void;
  /**
   * Latest checkpoint for a thread, or the one at `step` when given. A store holding checkpoints
   * from 1.x may return them as they are; the graph reads either schema.
   */
  get(threadId: string, step?: number): Promise<StoredGraphCheckpoint | undefined> | StoredGraphCheckpoint | undefined;
  /** Newest first. Used for time travel and for showing an operator what happened. */
  history(threadId: string, limit?: number): Promise<StoredGraphCheckpoint[]> | StoredGraphCheckpoint[];
  /** Deletes every checkpoint of a thread. */
  delete?(threadId: string): Promise<void> | void;
  /** Every thread with a checkpoint, for tools that browse threads, such as the studio. */
  threadIds?(): Promise<string[]> | string[];
}

/** Options for one run of a compiled graph. */
export interface GraphRunOptions {
  /**
   * Identifies the run. Reusing one resumes that thread rather than starting a second.
   * Defaults to a generated id, returned on the result so the run can still be inspected or resumed.
   */
  threadId?: string;
  /**
   * Guards against a cycle that never terminates. Defaults to 25 supersteps.
   *
   * A cycle is a feature here, so the limit is what keeps a buggy router from looping forever.
   */
  maxSteps?: number;
  /** Stops the run. Tasks in flight see the signal. */
  signal?: AbortSignal;
  /** Application data recorded on every checkpoint of the run. */
  metadata?: Record<string, unknown>;
  /** Overrides the compiled `maxConcurrency` for this run. */
  maxConcurrency?: number;
  /** Breakpoints for this run only, replacing the compiled ones. */
  interruptBefore?: string[];
  /** Pauses after these nodes run and their writes are checkpointed. */
  interruptAfter?: string[];
  /**
   * Receives fine-grained events as they happen: each task starting, retrying, and finishing with
   * its update, every checkpoint written, and whatever nodes pass to `context.emit()`. A throwing
   * listener never fails the run.
   */
  onEvent?: (event: GraphEvent) => void;
  /** Receives what nodes pass to `context.report()`. A throwing callback never fails the node. */
  onProgress?: (progress: GraphProgress) => void;
  /** Overrides the compiled `durability` for this run. */
  durability?: DurabilityMode;
  /**
   * Also delivers the events of subgraphs run through `asNode()` to `onEvent`, each with the
   * `namespace` of nodes it came through. Defaults to false.
   */
  subgraphEvents?: boolean;
  /**
   * Lets the caller stop the run at the end of its current superstep: pass a `RunControl` and call
   * `drain()`, on SIGTERM for example. The run writes its checkpoint and ends with
   * `GraphDrainedError`, and `continue()` resumes it, on this worker or another.
   */
  control?: RunControlLike;
}

/** The outcome of a run. */
export interface GraphResult<S extends ChannelSchema, O extends keyof S = keyof S> {
  /** The thread the run belongs to. Generated when the run was started without one. */
  threadId: string;
  /** Where the run stands. */
  status: GraphStatus;
  /** State after the run: the graph's output channels when it declared any, every channel otherwise. */
  state: Pick<StateOf<S>, O>;
  /** Supersteps completed. */
  steps: number;
  /** Present when the run stopped to ask a human. The first question when several were asked. */
  interrupt?: PendingInterrupt;
  /** Every question a paused superstep asked. */
  interrupts?: PendingInterrupt[];
  /** Present when the run paused at a breakpoint. */
  breakpoint?: GraphBreakpoint;
  /** A `Command.PARENT` that ended the run. In memory only; used by `asNode()`. */
  parentCommand?: Command;
  /** Why the run failed, when it did. */
  error?: { name: string; message: string };
}

/** Fine-grained events delivered to `GraphRunOptions.onEvent`. */
export type GraphEvent = (
  | { type: 'task_start'; step: number; taskId: string; node: string; attempt: number }
  | { type: 'task_retry'; step: number; taskId: string; node: string; attempt: number; error: string }
  | {
      type: 'task_failed';
      step: number;
      taskId: string;
      node: string;
      attempts: number;
      error: string;
      /** True when the node's `onError` recovered, so the graph carries on. */
      recovered: boolean;
    }
  | {
      type: 'task_end';
      step: number;
      taskId: string;
      node: string;
      update?: unknown;
      goto?: string[];
      /** True when the result came from the node's cache and the node did not run. */
      cached?: boolean;
    }
  | { type: 'checkpoint'; step: number; status: GraphStatus; next: string[] }
  | { type: 'custom'; step: number; taskId: string; node: string; data: unknown }
  | { type: 'message'; step: number; taskId: string; node: string; chunk: GraphMessageChunk }
  | { type: 'tool'; step: number; taskId: string; node: string; tool: GraphToolEvent }
) & {
  /**
   * The nodes a subgraph event came through, outermost first: `['review']` for an event of a graph
   * that runs as the parent's `review` node. Absent for the graph's own events.
   */
  namespace?: string[];
};

/** A piece of a model's output, as a node streams it: text, or a reasoning summary. */
export interface GraphMessageChunk {
  /** `text` for visible output, `reasoning` for a reasoning summary. Defaults to `text`. */
  kind?: 'text' | 'reasoning';
  /** The text. */
  content: string;
  /** Identifies the message the chunk belongs to, when a node streams more than one. */
  messageId?: string;
}

/** A tool call's progress, as a node reports it. */
export interface GraphToolEvent {
  /** `start` when it is called, `progress` while it runs, then `result` or `error`. */
  phase: 'start' | 'progress' | 'result' | 'error';
  /** The call's id, matching the model's. */
  id: string;
  /** The tool's name. */
  name: string;
  /** The arguments, on `start`. */
  args?: unknown;
  /** Anything the tool reported, on `progress`. */
  progress?: unknown;
  /** What it returned, on `result`. */
  result?: unknown;
  /** Why it failed, on `error`. */
  error?: string;
}

/**
 * What `events()` can include. `values` is the state after each superstep; `updates` each task's
 * write; `messages` model output as nodes stream it; `tools` tool calls; `tasks` each task
 * starting, retrying, failing, and ending; `checkpoints` each write; `custom` what nodes emit.
 */
export type GraphStreamProjection = 'values' | 'updates' | 'messages' | 'tools' | 'tasks' | 'checkpoints' | 'custom';

/** One event of `events()`, tagged by its projection. */
export type GraphStreamEvent<S extends ChannelSchema = ChannelSchema> = (
  | { type: 'values'; step: number; status: GraphStatus; state: StateOf<S> }
  | { type: 'updates'; step: number; node: string; taskId: string; update: unknown }
  | { type: 'messages'; step: number; node: string; taskId: string; chunk: GraphMessageChunk }
  | { type: 'tools'; step: number; node: string; taskId: string; tool: GraphToolEvent }
  | {
      type: 'tasks';
      event: Extract<GraphEvent, { type: 'task_start' | 'task_retry' | 'task_failed' | 'task_end' }>;
    }
  | { type: 'checkpoints'; step: number; status: GraphStatus; next: string[] }
  | { type: 'custom'; step: number; node: string; taskId: string; data: unknown }
) & {
  /** The subgraph nodes it came through, outermost first. Empty for the graph's own events. */
  namespace: string[];
};

/**
 * What an event stream does when a reader falls behind within a superstep. At the end of each
 * superstep the run waits for its slowest reader, whatever the policy, so a slow reader slows the
 * graph down rather than filling memory.
 *
 * - `coalesce` (the default) merges a model chunk into the one before it from the same task, and a
 *   state snapshot into the one before it; when nothing can merge, the oldest event goes.
 * - `drop-oldest` and `drop-newest` lose events, and count them.
 * - `error` ends the stream with `GraphStreamOverflowError` and stops the run.
 */
export type GraphStreamOverflow = 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error';

/** Options for `events()`: the run's own options, what to include, and how much to buffer. */
export interface GraphEventsOptions extends GraphRunOptions {
  /** Projections to include. Defaults to `values`, `updates`, `messages`, `tools`, and `custom`. */
  include?: GraphStreamProjection[];
  /** Includes the events of subgraphs, with their `namespace`. Defaults to false. */
  subgraphs?: boolean;
  /** Events each reader holds before `overflow` applies. Defaults to 1,000. */
  maxBuffered?: number;
  /** What happens when a reader's buffer is full. Defaults to `coalesce`. */
  overflow?: GraphStreamOverflow;
}

/** What an event stream did to keep up with its slowest reader. */
export interface GraphStreamStats {
  /** The most events any reader held at once. */
  peak: number;
  /** Events merged into another. */
  coalesced: number;
  /** Events lost. */
  dropped: number;
}

/** One superstep, as seen by `stream()`. */
export interface GraphStepEvent<S extends ChannelSchema> {
  /**
   * `step` for an ordinary superstep, then `interrupt`, `breakpoint`, or `done` for the one that
   * ended the run.
   */
  type: 'step' | 'interrupt' | 'breakpoint' | 'done';
  /** The superstep this event describes. */
  step: number;
  /** Nodes that ran in this superstep. */
  nodes: string[];
  /** Tasks that ran, when any of them carried a `Send` input. */
  tasks?: GraphTask[];
  /** Attempts used per task, present only for tasks that needed more than one. */
  attempts?: Record<string, number>;
  /** State after the superstep. */
  state: StateOf<S>;
  /** Where the run stands. */
  status: GraphStatus;
  /** The first question asked, when the step paused for input. */
  interrupt?: PendingInterrupt;
  /** Every question asked, when the step paused for input. */
  interrupts?: PendingInterrupt[];
  /** The breakpoint the step stopped at. */
  breakpoint?: GraphBreakpoint;
  /** Failures in this step that a node's `onError` recovered from. */
  recovered?: RecoveredFailure[];
  /** A `Command.PARENT` that ended this run, for the graph that contains it. In memory only. */
  parentCommand?: Command;
}

/**
 * A graph's shape, as data: what `describe()` returns and what the visualizer draws.
 *
 * Plain JSON, so a UI, a test, or a documentation build can render it without importing the runtime.
 */
export interface GraphDescription {
  /** The graph's name, when it was compiled with one. */
  name?: string;
  /** Every node, with its options. */
  nodes: Array<{
    id: string;
    ends?: string[];
    defer?: boolean;
    retry?: boolean;
    /** Attempts its retry policy allows, when more than one. */
    maxAttempts?: number;
    timeoutMs?: number;
    /** Its run and idle limits, when it has either. */
    timeout?: NodeTimeout;
    /** True when the node recovers from failure through `onError`. */
    onError?: boolean;
    /** True when the node is declared safe to run twice. */
    idempotent?: boolean;
    /** True when the node reuses results through `cache`. */
    cache?: boolean;
    /** The graph this node runs, when it is a compiled graph used through `asNode()`. */
    subgraph?: GraphDescription;
  }>;
  /** Every static and conditional edge. */
  edges: Array<{
    from: string;
    to: string;
    /** Chosen by a router, a mapping key, or a declared `ends` entry rather than always taken. */
    conditional?: boolean;
    label?: string;
  }>;
  /** Routers that return names a diagram cannot know in advance: no mapping and no `ends`. */
  dynamic: string[];
  /** Channels a caller may set, when the graph restricts them. */
  input?: string[];
  /** Channels a caller gets back, when the graph restricts them. */
  output?: string[];
  /** When checkpoints are written. */
  durability?: DurabilityMode;
  /** Where checkpoints go: the in-process default, a store the application passed, or nowhere. */
  checkpointer?: 'memory' | 'custom' | 'none';
  /** Tasks a superstep runs at once. */
  maxConcurrency?: number;
}

/**
 * Options applied when a graph is compiled: stores, breakpoints, concurrency, retries, and failure
 * handling.
 */
export interface CompileOptions {
  /** Long-term memory handed to every node as `context.store`. */
  store?: Store;
  /** Default store for nodes that declare `cache` without their own. */
  cache?: CacheAdapter<NodeCacheEntry>;
  /** Pause before these nodes run, for inspecting or editing state. `continue()` resumes. */
  interruptBefore?: string[];
  /** Pause after these nodes run and their writes are checkpointed. `continue()` resumes. */
  interruptAfter?: string[];
  /**
   * Tasks run at once within a superstep. Defaults to 16; `1` runs them one at a time, in order.
   *
   * Writes are still reduced in task order whatever the timing, so a replay produces the same state.
   */
  maxConcurrency?: number;
  /** Default retry policy for every node. A node's own policy wins. */
  retry?: RetryPolicy;
  /**
   * Defaults for every node: a retry policy, timeouts, and an `onError`. A node's own options win,
   * field by field. `retry` here is the same as `compile({ retry })`, and wins over it.
   */
  nodeDefaults?: Pick<NodeOptions, 'retry' | 'timeout' | 'onError'>;
  /** When checkpoints are written: `sync` (the default), `async`, or `exit`. See `DurabilityMode`. */
  durability?: DurabilityMode;
  /**
   * Checkpoint writes `async` durability keeps in flight before the graph waits for the store to
   * catch up. Defaults to 8. Bounds what a slow store can cost in memory.
   */
  maxPendingWrites?: number;
  /**
   * What happens to sibling tasks when one fails. `fail-fast` (the default) aborts their signals;
   * `settle` lets them finish, which is worth it when their work is expensive to repeat.
   */
  onNodeError?: 'fail-fast' | 'settle';
  /**
   * Where checkpoints go. Defaults to an in-process `MemoryGraphCheckpointer` holding up to 1,000
   * threads, so interrupts, `state()`, and `history()` work without setup. Pass a persistent
   * checkpointer to survive restarts, or `false` to write no checkpoints at all.
   */
  checkpointer?: GraphCheckpointer | false;
  /** Supersteps allowed before the run fails with `GraphStepLimitError`. Defaults to 25. */
  maxSteps?: number;
  /** Identifies this graph. Recorded on every checkpoint as `metadata.graph`. */
  name?: string;
  /**
   * Runs every invocation as one operation of a client's lifecycle: pass `ai.lifecycle`. A run is
   * then authorized, counted, audited, and seen by the lifecycle's hooks like the client's own calls,
   * and the model calls its nodes make are operations of their own.
   */
  lifecycle?: OperationLifecycleLike;
  /** How the lifecycle labels these runs. Defaults to `graph`; `createAgent()` sets `agent`. */
  lifecycleFamily?: 'graph' | 'agent';
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}
