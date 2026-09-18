/**
 * Typed state graphs: nodes, edges, cycles, subgraphs, and durable checkpoints.
 *
 * The execution model is a superstep loop. Each step runs the pending nodes, reduces whatever they
 * returned into the state channels, writes a checkpoint, and computes the next set of nodes. That
 * shape is what makes a graph resumable: a checkpoint is a complete description of where the run
 * is, so a different process can pick it up.
 */

/** Entry sentinel. An edge from `START` names the first node. */
export const START = '__start__';
/** Terminal sentinel. An edge to `END` finishes that branch. */
export const END = '__end__';

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
    readonly node: string,
    readonly input?: unknown,
  ) {}
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
  static readonly PARENT = '__parent__';

  readonly update?: U;
  readonly goto?: CommandTarget;
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
  id: string;
  node: string;
  input?: unknown;
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

export interface NodeOptions {
  retry?: RetryPolicy;
  /** Aborts the node's signal and fails the attempt when it runs longer than this. */
  timeoutMs?: number;
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

export type ChannelSchema = Record<string, Channel<unknown>>;

/** The state object a schema describes. */
export type StateOf<S extends ChannelSchema> = {
  [K in keyof S]: S[K] extends Channel<infer T> ? T : never;
};

/** What a node may write back. Omitted channels are left untouched. */
export type StateUpdate<S extends ChannelSchema> = Partial<StateOf<S>>;

export interface GraphProgress {
  step: number;
  node: string;
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

export interface PendingInterrupt extends InterruptRequest {
  /** Stable identity of this question, used to answer it through `resumeInterrupts()`. */
  id: string;
  node: string;
  /** Task that asked, which differs from `node` only for `Send` tasks. */
  taskId?: string;
  step: number;
  /** Position of this interrupt within the node, so a node may ask more than one question. */
  index: number;
  requestedAt: string;
}

export interface NodeContext<S extends ChannelSchema> {
  /** Current state. Frozen: a node writes by returning an update, never by mutation. */
  readonly state: Readonly<StateOf<S>>;
  readonly node: string;
  readonly step: number;
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
  /** Reports progress without writing to state. */
  report(progress: Omit<GraphProgress, 'step' | 'node'>): void;
  /**
   * Sends anything to the run's `onEvent` listener as a `custom` event: model tokens as they stream,
   * intermediate results, a status line. Nothing is written to state or checkpointed.
   */
  emit(data: unknown): void;
}

export type NodeFn<S extends ChannelSchema> = (
  context: NodeContext<S>,
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` here is what lets a node with no return statement satisfy the type; `undefined` would force every side-effect node to write `return undefined`.
) => Promise<NodeResult<S>> | NodeResult<S>;

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

export interface GraphCheckpoint<S extends ChannelSchema = ChannelSchema> {
  threadId: string;
  /** Supersteps completed. The checkpoint after step N describes the state entering step N+1. */
  step: number;
  state: StateOf<S>;
  /** Nodes to run next. Empty means the run is finished. */
  next: string[];
  /**
   * Tasks to run next, present only when they carry more than their node names: `Send` inputs, or
   * several tasks of one node. Otherwise `next` says everything, and a plain graph's checkpoint is
   * exactly what it was before.
   */
  tasks?: GraphTask[];
  /**
   * Nodes of the pending superstep that already finished before it paused or failed. Their writes
   * are already in `state`, so they are not run again, but their outgoing edges still count when the
   * step completes.
   */
  completed?: string[];
  /**
   * Routes chosen by `Command`s from tasks in `completed`, kept so a paused step still follows them
   * when it resumes without re-running those tasks. A plain string is a node; an object is a `Send`.
   */
  gotos?: Record<string, Array<string | { node: string; input?: unknown }>>;
  status: GraphStatus;
  /** First pending question, kept for callers that expect exactly one. */
  interrupt?: PendingInterrupt;
  /** Every question the paused superstep asked. Parallel tasks can each ask one. */
  interrupts?: PendingInterrupt[];
  /** Values already supplied for interrupts, keyed by `taskId:step:index`. */
  resolved?: Record<string, unknown>;
  error?: { name: string; message: string };
  /** Present when the run paused at a breakpoint rather than to ask a question. */
  breakpoint?: GraphBreakpoint;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Where a run paused for debugging. `continue()` carries on from it. */
export interface GraphBreakpoint {
  when: 'before' | 'after';
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
  put(checkpoint: GraphCheckpoint): Promise<void> | void;
  /** Latest checkpoint for a thread, or the one at `step` when given. */
  get(threadId: string, step?: number): Promise<GraphCheckpoint | undefined> | GraphCheckpoint | undefined;
  /** Newest first. Used for time travel and for showing an operator what happened. */
  history(threadId: string, limit?: number): Promise<GraphCheckpoint[]> | GraphCheckpoint[];
  delete?(threadId: string): Promise<void> | void;
}

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
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /** Overrides the compiled `maxConcurrency` for this run. */
  maxConcurrency?: number;
  /** Breakpoints for this run only, replacing the compiled ones. */
  interruptBefore?: string[];
  interruptAfter?: string[];
  /**
   * Receives fine-grained events as they happen: each task starting, retrying, and finishing with
   * its update, every checkpoint written, and whatever nodes pass to `context.emit()`. A throwing
   * listener never fails the run.
   */
  onEvent?: (event: GraphEvent) => void;
  /** Receives what nodes pass to `context.report()`. A throwing callback never fails the node. */
  onProgress?: (progress: GraphProgress) => void;
}

export interface GraphResult<S extends ChannelSchema> {
  threadId: string;
  status: GraphStatus;
  state: StateOf<S>;
  steps: number;
  /** Present when the run stopped to ask a human. The first question when several were asked. */
  interrupt?: PendingInterrupt;
  /** Every question a paused superstep asked. */
  interrupts?: PendingInterrupt[];
  /** Present when the run paused at a breakpoint. */
  breakpoint?: GraphBreakpoint;
  /** A `Command.PARENT` that ended the run. In memory only; used by `asNode()`. */
  parentCommand?: Command;
  error?: { name: string; message: string };
}

/** Fine-grained events delivered to `GraphRunOptions.onEvent`. */
export type GraphEvent =
  | { type: 'task_start'; step: number; taskId: string; node: string; attempt: number }
  | { type: 'task_retry'; step: number; taskId: string; node: string; attempt: number; error: string }
  | { type: 'task_end'; step: number; taskId: string; node: string; update?: unknown; goto?: string[] }
  | { type: 'checkpoint'; step: number; status: GraphStatus; next: string[] }
  | { type: 'custom'; step: number; taskId: string; node: string; data: unknown };

/** One superstep, as seen by `stream()`. */
export interface GraphStepEvent<S extends ChannelSchema> {
  type: 'step' | 'interrupt' | 'breakpoint' | 'done';
  step: number;
  /** Nodes that ran in this superstep. */
  nodes: string[];
  /** Tasks that ran, when any of them carried a `Send` input. */
  tasks?: GraphTask[];
  /** Attempts used per task, present only for tasks that needed more than one. */
  attempts?: Record<string, number>;
  state: StateOf<S>;
  status: GraphStatus;
  interrupt?: PendingInterrupt;
  interrupts?: PendingInterrupt[];
  breakpoint?: GraphBreakpoint;
  /** A `Command.PARENT` that ended this run, for the graph that contains it. In memory only. */
  parentCommand?: Command;
}

/**
 * A graph's shape, as data: what `describe()` returns and what the visualizer draws.
 *
 * Plain JSON, so a UI, a test, or a documentation build can render it without importing the runtime.
 */
export interface GraphDescription {
  name?: string;
  nodes: Array<{
    id: string;
    ends?: string[];
    defer?: boolean;
    retry?: boolean;
    timeoutMs?: number;
    /** The graph this node runs, when it is a compiled graph used through `asNode()`. */
    subgraph?: GraphDescription;
  }>;
  edges: Array<{
    from: string;
    to: string;
    /** Chosen by a router, a mapping key, or a declared `ends` entry rather than always taken. */
    conditional?: boolean;
    label?: string;
  }>;
  /** Routers that return names a diagram cannot know in advance: no mapping and no `ends`. */
  dynamic: string[];
}

export interface CompileOptions {
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
  maxSteps?: number;
  /** Identifies this graph. Recorded on every checkpoint as `metadata.graph`. */
  name?: string;
  now?: () => Date;
}
