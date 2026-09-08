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
  node: string;
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
}

export type NodeFn<S extends ChannelSchema> = (
  context: NodeContext<S>,
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` here is what lets a node with no return statement satisfy the type; `undefined` would force every side-effect node to write `return undefined`.
) => Promise<StateUpdate<S> | void> | StateUpdate<S> | void;

/**
 * Chooses where to go after a node.
 *
 * Returning an array fans out: every named node runs in the next superstep, and their writes are
 * combined by the channel reducers.
 */
export type EdgeRouter<S extends ChannelSchema> = (
  state: Readonly<StateOf<S>>,
) => string | string[] | Promise<string | string[]>;

export interface GraphCheckpoint<S extends ChannelSchema = ChannelSchema> {
  threadId: string;
  /** Supersteps completed. The checkpoint after step N describes the state entering step N+1. */
  step: number;
  state: StateOf<S>;
  /** Nodes to run next. Empty means the run is finished. */
  next: string[];
  status: GraphStatus;
  interrupt?: PendingInterrupt;
  /** Values already supplied for interrupts, keyed by `node:step:index`. */
  resolved?: Record<string, unknown>;
  error?: { name: string; message: string };
  createdAt: string;
  metadata?: Record<string, unknown>;
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
   * Defaults to a generated id, which means an unnamed run is not resumable.
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
}

export interface GraphResult<S extends ChannelSchema> {
  threadId: string;
  status: GraphStatus;
  state: StateOf<S>;
  steps: number;
  /** Present when the run stopped to ask a human. */
  interrupt?: PendingInterrupt;
  error?: { name: string; message: string };
}

/** One superstep, as seen by `stream()`. */
export interface GraphStepEvent<S extends ChannelSchema> {
  type: 'step' | 'interrupt' | 'done';
  step: number;
  /** Nodes that ran in this superstep. */
  nodes: string[];
  state: StateOf<S>;
  status: GraphStatus;
  interrupt?: PendingInterrupt;
}

export interface CompileOptions {
  checkpointer?: GraphCheckpointer;
  maxSteps?: number;
  /** Identifies this graph in checkpoints and subgraph node names. */
  name?: string;
  now?: () => Date;
}
