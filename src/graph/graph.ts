import { randomBytes } from 'node:crypto';
import type {
  ChannelSchema,
  CompileOptions,
  EdgeRouter,
  CommandTarget,
  DurabilityMode,
  GraphCheckpoint,
  GraphCheckpointer,
  GraphDescription,
  GraphEvent,
  GraphEventsOptions,
  GraphInput,
  GraphProgress,
  GraphResult,
  GraphRunOptions,
  GraphStatus,
  GraphStepEvent,
  GraphTask,
  NodeContext,
  NodeFailure,
  NodeFn,
  NodeOptions,
  NodeResult,
  NodeTimeout,
  PendingInterrupt,
  RecoveredFailure,
  RetryPolicy,
  StateOf,
  StateUpdate,
} from '../types/graph.js';
import { Command, END, Send, START } from '../types/graph.js';
import { tenantStore } from '../store/tenant.js';
import { linkSignals } from '../utils/signals.js';
import { MemoryGraphCheckpointer } from './checkpointer.js';
import { type CheckpointDraft, migrateCheckpoint, toCheckpoint } from './checkpoint-migration.js';
import { CheckpointWriter } from './durability.js';
import { GraphEventStream, streamSettings } from './event-stream.js';
import type { NodeCache } from './node-cache.js';
import {
  GraphDrainedError,
  GraphInterrupt,
  GraphNodeError,
  GraphNodeTimeoutError,
  GraphNotInterruptedError,
  GraphStepLimitError,
  GraphThreadNotFoundError,
  GraphValidationError,
  interruptKey,
} from './errors.js';

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_RETRY: Required<Omit<RetryPolicy, 'retryOn'>> = {
  maxAttempts: 1,
  initialIntervalMs: 250,
  backoffFactor: 2,
  maxIntervalMs: 30_000,
  jitter: true,
};

interface GraphNodeDefinition<S extends ChannelSchema> {
  fn: NodeFn<S>;
  options: NodeOptions<S>;
}

/** A route in serializable form: a node name, or a `Send` flattened to its node, input, and timeout. */
type RouteRecord = string | { node: string; input?: unknown; timeout?: NodeTimeout };

/** Marks the function `asNode()` returns, so `describe()` can draw the graph inside it. */
const SUBGRAPH = Symbol('nexus.graph.subgraph');

/** Hands a subgraph's events to the run of the node that runs it, under that node's namespace. */
const FORWARD_EVENT = Symbol('nexus.graph.forwardEvent');

/**
 * Further updates carried by a Command, reduced after its own `update`. Used when a subgraph hands
 * control to its parent: the subgraph's shared state and the update it addressed to the parent are
 * two writes, and merging them into one object would let one overwrite the other.
 */
const FOLLOWING_UPDATES = Symbol('nexus.graph.followingUpdates');

type TaskOutcome<S extends ChannelSchema> =
  | {
      kind: 'ok';
      updates: Array<StateUpdate<S>>;
      goto?: RouteRecord[];
      parent?: Command;
      attempts: number;
      /** Present when this result is what `onError` decided after the node failed. */
      recovered?: RecoveredFailure;
    }
  | { kind: 'interrupt'; interrupt: PendingInterrupt; attempts: number }
  | { kind: 'aborted'; attempts: number }
  | { kind: 'failed'; error: unknown; attempts: number };

/** Which channels a caller may write and read, as `createGraph()` declared them. */
interface GraphScope {
  input?: readonly string[];
  output?: readonly string[];
}

interface Edge<S extends ChannelSchema> {
  from: string;
  to?: string;
  router?: EdgeRouter<S>;
  /** Maps a router's return value onto node names, so a router can return a domain word. */
  mapping?: Record<string, string>;
}

/**
 * Builds a typed state graph.
 *
 * Nodes read a frozen state and return an update; channels decide how updates combine. Edges may be
 * static or conditional, may form cycles, and a compiled graph can be used as a node inside another
 * graph.
 */
export class StateGraph<S extends ChannelSchema, I extends keyof S = keyof S, O extends keyof S = keyof S> {
  private readonly nodes = new Map<string, GraphNodeDefinition<S>>();
  private readonly edges: Array<Edge<S>> = [];

  constructor(
    private readonly channels: S,
    private readonly scope: GraphScope = {},
  ) {
    if (!channels || typeof channels !== 'object' || Object.keys(channels).length === 0) {
      throw new GraphValidationError('A graph needs at least one state channel');
    }
    for (const [name, channel] of Object.entries(channels)) {
      if (typeof channel?.reduce !== 'function') {
        throw new GraphValidationError(`Channel "${name}" must provide a reduce() function`);
      }
    }
    for (const [field, names] of [
      ['input', scope.input],
      ['output', scope.output],
    ] as const) {
      for (const name of names ?? []) {
        if (!Object.hasOwn(channels, name)) {
          throw new GraphValidationError(`The ${field} channel "${name}" is not one of the graph's channels`);
        }
      }
    }
  }

  /** Adds a node. Returns the graph, for chaining. */
  addNode(name: string, fn: NodeFn<S>, options: NodeOptions<S> = {}): this {
    const normalized = name.trim();
    if (!normalized) throw new GraphValidationError('A node name must not be empty');
    if (normalized === START || normalized === END) {
      throw new GraphValidationError(`"${normalized}" is reserved and cannot be used as a node name`);
    }
    if (this.nodes.has(normalized)) throw new GraphValidationError(`Node "${normalized}" is already defined`);
    if (typeof fn !== 'function') throw new GraphValidationError(`Node "${normalized}" must be a function`);

    this.nodes.set(normalized, { fn, options });
    return this;
  }

  /** Adds an edge that always runs `to` after `from`. Returns the graph, for chaining. */
  addEdge(from: string, to: string): this {
    this.edges.push({ from, to });
    return this;
  }

  /**
   * Routes on state after `from` runs.
   *
   * Returning an array fans out: every named node runs in the next superstep and their writes are
   * combined by the channel reducers.
   */
  addConditionalEdges(from: string, router: EdgeRouter<S>, mapping?: Record<string, string>): this {
    if (typeof router !== 'function') {
      throw new GraphValidationError(`Conditional edge from "${from}" needs a router function`);
    }
    this.edges.push({ from, router, mapping });
    return this;
  }

  /** Names the first node. Equivalent to an edge from `START`. */
  setEntry(node: string): this {
    return this.addEdge(START, node);
  }

  /** Validates the shape and returns something runnable. */
  compile(options: CompileOptions = {}): CompiledGraph<S, I, O> {
    const entries = this.edges.filter((edge) => edge.from === START);
    if (entries.length === 0) {
      throw new GraphValidationError('A graph needs an entry point. Call setEntry(node).');
    }

    for (const edge of this.edges) {
      if (edge.from !== START && !this.nodes.has(edge.from)) {
        throw new GraphValidationError(`Edge references unknown node "${edge.from}"`);
      }
      const targets = [edge.to, ...Object.values(edge.mapping ?? {})].filter(Boolean) as string[];
      for (const target of targets) {
        if (target !== END && !this.nodes.has(target)) {
          throw new GraphValidationError(`Edge from "${edge.from}" targets unknown node "${target}"`);
        }
      }
    }

    // A node nothing routes to can never run, which is nearly always a typo in an edge.
    const reachable = new Set<string>();
    const queue = entries.map((edge) => edge.to).filter(Boolean) as string[];
    while (queue.length) {
      const node = queue.pop() as string;
      if (reachable.has(node) || node === END) continue;
      reachable.add(node);
      for (const target of this.nodes.get(node)?.options.ends ?? []) {
        if (target !== END) queue.push(target);
      }
      for (const edge of this.edges.filter((item) => item.from === node)) {
        if (edge.to && edge.to !== END) queue.push(edge.to);
        for (const target of Object.values(edge.mapping ?? {})) if (target !== END) queue.push(target);
        // A router without a mapping can reach anything, so reachability cannot be proven; treat
        // every node as reachable rather than report a false positive.
        if (edge.router && !edge.mapping) {
          return new CompiledGraph<S, I, O>(this.channels, this.nodes, this.edges, options, this.scope);
        }
      }
    }
    const orphans = [...this.nodes.keys()].filter((node) => !reachable.has(node));
    if (orphans.length > 0) {
      throw new GraphValidationError(`No edge reaches ${orphans.map((node) => `"${node}"`).join(', ')}`);
    }

    return new CompiledGraph<S, I, O>(this.channels, this.nodes, this.edges, options, this.scope);
  }
}

/** A validated graph, ready to run. */
export class CompiledGraph<S extends ChannelSchema, I extends keyof S = keyof S, O extends keyof S = keyof S> {
  private readonly now: () => Date;
  private readonly store: GraphCheckpointer | undefined;
  /** Loaded the first time a node that declares `cache` runs, and not before. */
  private nodeCache: Promise<NodeCache> | undefined;
  /** The checkpoint writers of runs in progress, so `flush()` can wait for them. */
  private readonly writers = new Set<CheckpointWriter<CheckpointDraft<S>>>();

  constructor(
    private readonly channels: S,
    private readonly nodes: Map<string, GraphNodeDefinition<S>>,
    private readonly edges: Array<Edge<S>>,
    private readonly options: CompileOptions,
    private readonly scope: GraphScope = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = options.checkpointer === false ? undefined : (options.checkpointer ?? new MemoryGraphCheckpointer());
  }

  /**
   * Waits until every checkpoint written by runs in progress is in the store. Only `async` and
   * `exit` durability leave any outstanding; a run always waits for its own before it returns.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.writers].map((writer) => writer.flush()));
  }

  /** Runs to completion, to an interrupt, or to the step limit. */
  async invoke(input: GraphInput<S, I> = {}, runOptions: GraphRunOptions = {}): Promise<GraphResult<S, O>> {
    // Resolve the id here rather than inside stream(), so the result reports the id actually used.
    const threadId = resolveThreadId(runOptions.threadId);
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.stream(input, { ...runOptions, threadId })) last = event;
    return this.toResult(threadId, last);
  }

  /** Yields one event per superstep, so a caller can render progress as it happens. */
  stream(input: GraphInput<S, I> = {}, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    const threadId = resolveThreadId(runOptions.threadId);
    return this.run(threadId, runOptions, async () => {
      this.assertInput(input);
      if (runOptions.tenantId !== undefined) {
        const existing = await this.checkpointer()?.get(threadId);
        if (existing && !ownedBy(existing, runOptions.tenantId)) {
          throw new GraphValidationError(`Thread "${threadId}" cannot be used by this tenant; choose another id`);
        }
      }
      const state = this.seedState(input as StateUpdate<S>);
      const next = this.entryNodes();
      return { threadId, step: 0, state, next, status: 'running', createdAt: this.now().toISOString() };
    });
  }

  /**
   * Runs the graph as one stream of typed events: the state after each superstep, each task's write,
   * model output as nodes stream it, tool calls, task progress, checkpoints, and custom events.
   *
   * Iterate it for everything included, or read one projection with `messages()`, `tools()`,
   * `values()`, or `updates()`. Each reader has its own bounded buffer, and the run waits for the
   * slowest at the end of every superstep, so a slow reader slows the graph rather than filling
   * memory. `result` resolves with the run's result.
   */
  events(input: GraphInput<S, I> = {}, options: GraphEventsOptions = {}): GraphEventStream<S, O> {
    const threadId = resolveThreadId(options.threadId);
    return this.eventStream(threadId, options, (runOptions) => this.stream(input, runOptions));
  }

  /** Like `events()`, answering the question a paused thread is waiting on. */
  resumeEvents(threadId: string, value: unknown, options: GraphEventsOptions = {}): GraphEventStream<S, O> {
    return this.eventStream(threadId, options, (runOptions) => this.resume(threadId, value, runOptions));
  }

  /** Like `events()`, carrying a thread on from a breakpoint, a drain, or a failure. */
  continueEvents(threadId: string, options: GraphEventsOptions = {}): GraphEventStream<S, O> {
    return this.eventStream(threadId, options, (runOptions) => this.continue(threadId, runOptions));
  }

  private eventStream(
    threadId: string,
    options: GraphEventsOptions,
    run: (runOptions: GraphRunOptions) => AsyncIterable<GraphStepEvent<S>>,
  ): GraphEventStream<S, O> {
    return new GraphEventStream<S, O>(
      (onEvent, signal) => {
        const linked = linkSignals([options.signal, signal]);
        return releasing(
          run({
            ...options,
            threadId,
            signal: linked.signal,
            ...(options.subgraphs ? { subgraphEvents: true } : {}),
            onEvent: (event) => {
              options.onEvent?.(event);
              onEvent(event);
            },
          }),
          linked.dispose,
        );
      },
      (last) => this.toResult(threadId, last),
      streamSettings(options),
    );
  }

  /**
   * Supplies the value a node asked for and continues.
   *
   * The interrupted node runs again from the top; `context.interrupt()` returns `value` this time
   * instead of throwing. A node that interrupts should therefore keep the work before the interrupt
   * cheap and free of side effects, because it happens twice.
   */
  resume(threadId: string, value: unknown, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const checkpoint = await this.requireCheckpoint(threadId);
      const [first] = checkpoint.interrupts;
      if (checkpoint.status !== 'awaiting_input' || !first) {
        throw new GraphNotInterruptedError(threadId, checkpoint.status);
      }
      return {
        ...checkpoint,
        status: 'running',
        interrupts: [],
        resolved: { ...checkpoint.resolved, [first.id]: value },
      };
    });
  }

  /** Like `resume`, but returns the final result rather than the stream. */
  async resumeWith(threadId: string, value: unknown, runOptions: GraphRunOptions = {}): Promise<GraphResult<S, O>> {
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.resume(threadId, value, runOptions)) last = event;
    return this.toResult(threadId, last);
  }

  /**
   * Answers several of a paused step's questions at once, keyed by interrupt id.
   *
   * Parallel tasks can each ask something, so one answer is not always enough. Questions left
   * unanswered are asked again when the step runs.
   */
  resumeInterrupts(
    threadId: string,
    answers: Record<string, unknown>,
    runOptions: GraphRunOptions = {},
  ): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const checkpoint = await this.requireCheckpoint(threadId);
      if (checkpoint.status !== 'awaiting_input' || checkpoint.interrupts.length === 0) {
        throw new GraphNotInterruptedError(threadId, checkpoint.status);
      }
      const pending = checkpoint.interrupts;
      const unknown = Object.keys(answers).filter((id) => !pending.some((item) => item.id === id));
      if (unknown.length > 0) {
        throw new GraphValidationError(
          `Thread "${threadId}" has no pending question with id ${unknown.map((id) => `"${id}"`).join(', ')}. Pending: ${pending.map((item) => `"${item.id}"`).join(', ')}.`,
        );
      }
      return {
        ...checkpoint,
        status: 'running',
        interrupts: [],
        resolved: { ...checkpoint.resolved, ...answers },
      };
    });
  }

  /** Like `resumeInterrupts`, but returns the final result rather than the stream. */
  async resumeInterruptsWith(
    threadId: string,
    answers: Record<string, unknown>,
    runOptions: GraphRunOptions = {},
  ): Promise<GraphResult<S, O>> {
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.resumeInterrupts(threadId, answers, runOptions)) last = event;
    return this.toResult(threadId, last);
  }

  /** Continues a thread that stopped for any other reason, such as the step limit. */
  continue(threadId: string, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const checkpoint = await this.requireCheckpoint(threadId);
      return { ...checkpoint, status: 'running', error: undefined, drained: undefined };
    });
  }

  /**
   * Rewinds to an earlier superstep and runs forward from there.
   *
   * Checkpoints after `step` belong to the timeline being abandoned, so the checkpointer drops them
   * once the rewound checkpoint is written.
   */
  resumeFrom(threadId: string, step: number, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const stored = await this.checkpointer()?.get(threadId, step);
      if (!stored) throw new GraphThreadNotFoundError(threadId);
      return { ...(migrateCheckpoint(stored) as GraphCheckpoint<S>), status: 'running' };
    });
  }

  /**
   * Latest checkpoint, or the one at `step`. With a `tenantId`, a thread another tenant owns reads
   * as absent.
   */
  async state(
    threadId: string,
    step?: number,
    options: { tenantId?: string } = {},
  ): Promise<GraphCheckpoint<S> | undefined> {
    const stored = await this.checkpointer()?.get(threadId, step);
    if (!stored || !ownedBy(stored, options.tenantId)) return undefined;
    return migrateCheckpoint(stored) as GraphCheckpoint<S>;
  }

  /** Checkpoints for a thread, newest first. With a `tenantId`, another tenant's thread has none. */
  async history(
    threadId: string,
    limit?: number,
    options: { tenantId?: string } = {},
  ): Promise<Array<GraphCheckpoint<S>>> {
    const stored = (await this.checkpointer()?.history(threadId, limit)) ?? [];
    if (stored[0] && !ownedBy(stored[0], options.tenantId)) return [];
    return stored.map((item) => migrateCheckpoint(item) as GraphCheckpoint<S>);
  }

  /**
   * Wraps this graph as a node in another graph.
   *
   * The subgraph runs to completion within one superstep of the parent. Channels the two graphs
   * share by name are passed in and merged back; anything else stays private to the subgraph.
   *
   * When the subgraph interrupts, the parent interrupts with the same question. Resuming the parent
   * passes the answer into the subgraph, which continues where it stopped rather than starting over.
   */
  asNode<P extends ChannelSchema>(): NodeFn<P> {
    const node: NodeFn<P> = async (context) => {
      // Keyed by task, not node, so parallel Send copies of one subgraph node never share a thread.
      const forward = (context as { [FORWARD_EVENT]?: (event: GraphEvent) => void })[FORWARD_EVENT];
      const runOptions: GraphRunOptions = {
        threadId: `${context.threadId}:${context.taskId}`,
        signal: context.signal,
        ...(forward ? { onEvent: forward, subgraphEvents: true } : {}),
      };
      const paused = await this.state(runOptions.threadId as string);
      let result: GraphResult<S, O>;

      const question = paused?.status === 'awaiting_input' ? paused.interrupts[0] : undefined;
      if (paused && question) {
        // The parent node is being replayed after an answer. Every answer the subgraph already
        // received came through an earlier parent interrupt, so consume those positions in order;
        // the next position is the answer to the question the subgraph is waiting on now.
        const answered = Object.keys(paused.resolved ?? {}).length;
        for (let index = 0; index < answered; index += 1) context.interrupt({ reason: question.reason });
        result = this.checkpointResult(paused);
      } else {
        // Only the channels the subgraph accepts are passed in; with no declared input, every
        // channel the two graphs share by name.
        const seed: Record<string, unknown> = {};
        for (const key of this.scope.input ?? Object.keys(this.channels)) {
          if (key in context.state) seed[key] = (context.state as Record<string, unknown>)[key];
        }
        result = await this.invoke(seed as GraphInput<S, I>, runOptions);
      }

      while (result.status === 'awaiting_input' && result.interrupt) {
        const answer = context.interrupt({ reason: result.interrupt.reason, payload: result.interrupt.payload });
        result = await this.resumeWith(runOptions.threadId as string, answer, runOptions);
      }

      const update: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.state)) {
        if (key in context.state) update[key] = value;
      }
      // A Command.PARENT from inside the subgraph becomes this node's own Command in the parent.
      if (result.parentCommand) {
        const command = new Command({ update: update as StateUpdate<P>, goto: result.parentCommand.goto });
        const addressed = result.parentCommand.update as StateUpdate<P> | undefined;
        if (addressed) Object.defineProperty(command, FOLLOWING_UPDATES, { value: [addressed] });
        return command;
      }
      return update as StateUpdate<P>;
    };
    Object.defineProperty(node, SUBGRAPH, { value: this });
    return node;
  }

  /**
   * The graph's shape as plain data: nodes, edges, and which routes are chosen at run time.
   *
   * What `nexus-ai-pro/graph/visualize` draws, and what a UI or a test can inspect without running
   * anything. Subgraphs added through `asNode()` are described inside the node that runs them.
   */
  describe(): GraphDescription {
    const nodes = [...this.nodes.entries()].map(([id, definition]) => {
      const subgraph = (definition.fn as { [SUBGRAPH]?: CompiledGraph<ChannelSchema> })[SUBGRAPH];
      const { ends, defer, timeoutMs, cache, idempotent, effects, interrupts } = definition.options;
      const maxAttempts = this.retryPolicy(definition).maxAttempts;
      const timeout = this.timeoutOf(definition);
      return {
        id,
        ...(ends?.length ? { ends: [...ends] } : {}),
        ...(defer ? { defer } : {}),
        ...(maxAttempts > 1 ? { retry: true, maxAttempts } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(timeout.runMs !== undefined || timeout.idleMs !== undefined ? { timeout } : {}),
        ...(this.errorHandler(definition) ? { onError: true } : {}),
        ...(idempotent ? { idempotent: true } : {}),
        ...(cache ? { cache: true } : {}),
        ...(effects?.length ? { effects: [...effects] } : {}),
        ...(interrupts ? { interrupts: true } : {}),
        ...(subgraph ? { subgraph: subgraph.describe() } : {}),
      };
    });

    const edges: GraphDescription['edges'] = [];
    const dynamic = new Set<string>();
    for (const edge of this.edges) {
      if (edge.router) {
        if (edge.mapping) {
          for (const [label, to] of Object.entries(edge.mapping)) {
            edges.push({ from: edge.from, to, conditional: true, label });
          }
        } else if (!this.nodes.get(edge.from)?.options.ends?.length) {
          dynamic.add(edge.from);
        }
      } else if (edge.to) {
        edges.push({ from: edge.from, to: edge.to });
      }
    }
    for (const [id, definition] of this.nodes) {
      for (const to of definition.options.ends ?? []) {
        if (!edges.some((edge) => edge.from === id && edge.to === to)) edges.push({ from: id, to, conditional: true });
      }
    }

    return {
      ...(this.options.name ? { name: this.options.name } : {}),
      nodes,
      edges,
      dynamic: [...dynamic],
      ...(this.scope.input ? { input: [...this.scope.input] } : {}),
      ...(this.scope.output ? { output: [...this.scope.output] } : {}),
      durability: this.options.durability ?? 'sync',
      checkpointer:
        this.options.checkpointer === false ? 'none' : this.options.checkpointer === undefined ? 'memory' : 'custom',
      maxConcurrency: this.options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      ...(this.options.tools?.length
        ? {
            tools: this.options.tools.map((tool) => ({
              ...tool,
              ...(tool.capabilities ? { capabilities: [...tool.capabilities] } : {}),
            })),
          }
        : {}),
    };
  }

  /**
   * Edits a thread's state.
   *
   * Without `asNode`, the update is merged into the latest checkpoint in place, through the channel
   * reducers, and the run continues exactly where it was — including a thread paused for input.
   * With `asNode`, the update is applied as if that node had just produced it: a new checkpoint is
   * written and the next step follows that node's edges. That is how an operator corrects a wrong
   * intermediate result and lets the rest of the graph run on the fix.
   */
  async updateState(
    threadId: string,
    update: StateUpdate<S>,
    options: { asNode?: string; tenantId?: string } = {},
  ): Promise<GraphCheckpoint<S>> {
    const checkpoint = await this.requireCheckpoint(threadId, options.tenantId);
    const state = this.reduce(checkpoint.state, [update]);
    const createdAt = this.now().toISOString();

    if (!options.asNode) {
      return this.save({
        ...checkpoint,
        state,
        createdAt,
        metadata: { ...checkpoint.metadata, source: 'update' },
      });
    }

    if (!this.nodes.has(options.asNode)) {
      throw new GraphValidationError(`updateState asNode "${options.asNode}" is not a node in this graph`);
    }
    if (checkpoint.status === 'awaiting_input') {
      throw new GraphValidationError(
        `Thread "${threadId}" is waiting for an answer. Answer it first, or update state without asNode to keep the question pending.`,
      );
    }
    const step = checkpoint.step + 1;
    const next = await this.nextTasks([options.asNode], state, step);
    return this.save({
      threadId,
      step,
      state,
      ...pendingFields(next),
      status: next.length > 0 ? 'running' : 'completed',
      resolved: checkpoint.resolved,
      createdAt,
      metadata: { ...checkpoint.metadata, source: 'update', asNode: options.asNode },
    });
  }

  /**
   * Copies a thread's history up to `step` into a new thread, and returns the new thread's id.
   *
   * Rewinding with `resumeFrom()` replaces the original timeline. A fork keeps it: both threads stay
   * readable and runnable, so two answers to the same question can be compared side by side. Every
   * copied checkpoint records `metadata.forkedFrom`, and keeps the tenant of the thread it came from.
   * With a `tenantId`, another tenant's thread is not found.
   */
  async fork(threadId: string, options: { step?: number; threadId?: string; tenantId?: string } = {}): Promise<string> {
    const store = this.checkpointer();
    if (!store) throw new GraphValidationError('fork() needs a checkpointer to copy history from');
    const history = (await store.history(threadId, Number.MAX_SAFE_INTEGER)).map((item) => migrateCheckpoint(item));
    if (history.length === 0 || !ownedBy(history[0] as GraphCheckpoint, options.tenantId)) {
      throw new GraphThreadNotFoundError(threadId);
    }

    const cutoff = options.step ?? (history[0] as GraphCheckpoint).step;
    const lineage = history.filter((item) => item.step <= cutoff).reverse();
    if (lineage.at(-1)?.step !== cutoff) {
      throw new GraphValidationError(`Thread "${threadId}" has no checkpoint at step ${cutoff} to fork from`);
    }
    const forkId = resolveThreadId(options.threadId);
    if (await store.get(forkId)) {
      throw new GraphValidationError(`Thread "${forkId}" already exists; choose another id for the fork`);
    }
    for (const item of lineage) {
      await store.put(
        toCheckpoint({
          ...item,
          threadId: forkId,
          metadata: { ...item.metadata, forkedFrom: { threadId, step: cutoff } },
        }),
      );
    }
    return forkId;
  }

  // ── Execution ────────────────────────────────────────────────────

  /**
   * Runs the supersteps, as one operation of the compiled lifecycle when there is one. The run is
   * admitted before its first superstep and finishes with its last, however it ends.
   */
  private async *run(
    threadId: string,
    runOptions: GraphRunOptions,
    seed: () => Promise<CheckpointDraft<S>>,
  ): AsyncGenerator<GraphStepEvent<S>, void, void> {
    const lifecycle = this.options.lifecycle;
    if (!lifecycle) {
      yield* this.runSteps(threadId, runOptions, seed);
      return;
    }
    const ticket = await lifecycle.start(
      {
        family: this.options.lifecycleFamily ?? 'graph',
        operation: this.options.name ? `${this.options.lifecycleFamily ?? 'graph'}.${this.options.name}` : 'graph.run',
        metadata: { threadId, ...(this.options.name ? { graph: this.options.name } : {}) },
      },
      runOptions.signal ? { signal: runOptions.signal } : {},
    );
    let last: GraphStepEvent<S> | undefined;
    let settled = false;
    try {
      for await (const event of this.runSteps(threadId, runOptions, seed)) {
        last = event;
        yield event;
      }
      settled = true;
      await ticket.succeed({ metadata: { threadId, status: last?.status ?? 'completed', steps: last?.step ?? 0 } });
    } catch (error) {
      settled = true;
      await ticket.fail(error);
      throw error;
    } finally {
      // The caller stopped reading the stream before the run ended.
      if (!settled)
        await ticket.fail(
          Object.assign(new Error('The graph run was stopped before it ended'), { name: 'AbortError' }),
        );
    }
  }

  /**
   * Runs the step loop with a checkpoint writer for the run's durability mode. However the run ends,
   * every checkpoint it handed over is in the store before this returns or throws.
   */
  private async *runSteps(
    threadId: string,
    runOptions: GraphRunOptions,
    seed: () => Promise<CheckpointDraft<S>>,
  ): AsyncGenerator<GraphStepEvent<S>, void, void> {
    const mode: DurabilityMode = runOptions.durability ?? this.options.durability ?? 'sync';
    const writer = new CheckpointWriter<CheckpointDraft<S>>(
      async (written) => {
        await this.save(written);
        notify(runOptions, { type: 'checkpoint', step: written.step, status: written.status, next: written.next });
      },
      mode,
      this.options.maxPendingWrites,
    );
    this.writers.add(writer);
    let failed = false;
    try {
      yield* this.steps(threadId, runOptions, seed, (written, durable) => writer.persist(written, durable));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.writers.delete(writer);
      // On the way out of an error, the error is what the caller needs; a write failing as well is
      // secondary.
      if (failed) await writer.flush().catch(() => undefined);
      else await writer.flush();
    }
  }

  private async *steps(
    threadId: string,
    runOptions: GraphRunOptions,
    seed: () => Promise<CheckpointDraft<S>>,
    persist: (written: CheckpointDraft<S>, durable?: boolean) => Promise<void>,
  ): AsyncGenerator<GraphStepEvent<S>, void, void> {
    const maxSteps = runOptions.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const stopBefore = runOptions.interruptBefore ?? this.options.interruptBefore ?? [];
    const stopAfter = runOptions.interruptAfter ?? this.options.interruptAfter ?? [];

    let checkpoint: CheckpointDraft<S> = await seed();
    const owner = tenantOf(checkpoint);
    if (runOptions.tenantId !== undefined && owner !== undefined && owner !== runOptions.tenantId) {
      throw new GraphThreadNotFoundError(threadId);
    }
    const tenantId = runOptions.tenantId ?? owner;
    if (tenantId !== undefined) {
      runOptions = { ...runOptions, tenantId, metadata: { ...runOptions.metadata, tenantId } };
      // Checkpoints that pause within a step copy this one, so it carries the tenant too.
      if (owner === undefined) checkpoint = { ...checkpoint, metadata: { ...checkpoint.metadata, tenantId } };
    }
    // continue() from a "before" breakpoint must run the step it paused in front of, not pause again.
    let passBreakpoint = checkpoint.breakpoint?.when === 'before';
    if (checkpoint.breakpoint) checkpoint = { ...checkpoint, breakpoint: undefined };
    if (checkpoint.next.length === 0) {
      // Nothing is left to run, as when continue() reaches a thread that already finished: it stays
      // finished, and the caller still gets its state.
      if (checkpoint.status === 'running') checkpoint = { ...checkpoint, status: 'completed' };
      await persist(checkpoint, true);
      yield this.toEvent(checkpoint, []);
      return;
    }
    await persist(checkpoint);

    while (checkpoint.next.length > 0) {
      // A drain is honoured between supersteps, never inside one, so nothing is left half done.
      if (runOptions.control?.draining) {
        const at = this.now().toISOString();
        checkpoint = {
          ...checkpoint,
          status: 'interrupted',
          drained: { ...(runOptions.control.reason ? { reason: runOptions.control.reason } : {}), at },
          createdAt: at,
        };
        await persist(checkpoint, true);
        throw new GraphDrainedError(threadId, checkpoint.step, runOptions.control.reason);
      }
      if (runOptions.signal?.aborted) {
        checkpoint = { ...checkpoint, status: 'interrupted', createdAt: this.now().toISOString() };
        await persist(checkpoint, true);
        yield this.toEvent(checkpoint, []);
        return;
      }
      if (checkpoint.step >= maxSteps) {
        throw new GraphStepLimitError(maxSteps, checkpoint.next);
      }

      const step = checkpoint.step + 1;
      const allTasks = tasksOf(checkpoint);
      // Tasks of this step that finished before an earlier pause or failure. Their writes are already
      // in state; they only still count for routing once the step completes.
      const carried = checkpoint.completed ?? [];
      const waiting = allTasks.filter((task) => !carried.includes(task.id));
      // A deferred task waits while anything else is still pending, so an aggregator after branches of
      // different lengths runs once, after the longest.
      const eager = waiting.filter((task) => !this.nodes.get(task.node)?.options.defer);
      const pendingTasks = eager.length > 0 ? eager : waiting;
      const held = eager.length > 0 ? waiting.filter((task) => !eager.includes(task)) : [];

      const breakBefore = passBreakpoint
        ? []
        : distinctNodes(pendingTasks.filter((task) => stopBefore.includes(task.node)));
      passBreakpoint = false;
      if (breakBefore.length > 0) {
        checkpoint = {
          ...checkpoint,
          status: 'interrupted',
          breakpoint: { when: 'before', nodes: breakBefore },
          createdAt: this.now().toISOString(),
        };
        await persist(checkpoint, true);
        yield this.toEvent(checkpoint, []);
        return;
      }

      const failFast = (this.options.onNodeError ?? 'fail-fast') === 'fail-fast';
      // Aborting this cancels the siblings of a task that failed, and nothing else.
      const stepAbort = new AbortController();
      const outcomes: Array<TaskOutcome<S> | undefined> = new Array(pendingTasks.length);

      await runConcurrently(
        pendingTasks,
        runOptions.maxConcurrency ?? this.options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        async (task, index) => {
          const outcome = await this.runTask(task, step, threadId, checkpoint, runOptions, stepAbort.signal);
          outcomes[index] = outcome;
          if (outcome.kind === 'failed' && failFast) stepAbort.abort(outcome.error);
        },
      );

      const updates: Array<StateUpdate<S>> = [];
      const finished: string[] = [];
      const interrupts: PendingInterrupt[] = [];
      const attempts: Record<string, number> = {};
      const gotos: Record<string, RouteRecord[]> = { ...(checkpoint.gotos ?? {}) };
      let parentCommand: Command | undefined;
      let failure: { task: GraphTask; error: unknown } | undefined;
      const recovered: RecoveredFailure[] = [];

      // Results are folded in task order, never completion order, so timing cannot change the state a
      // replay produces.
      for (const [index, task] of pendingTasks.entries()) {
        const outcome = outcomes[index];
        if (!outcome) continue;
        if (outcome.attempts > 1) attempts[task.id] = outcome.attempts;
        if (outcome.kind === 'ok') {
          updates.push(...outcome.updates);
          if (outcome.goto?.length) gotos[task.id] = outcome.goto;
          parentCommand ??= outcome.parent;
          if (outcome.recovered) recovered.push(outcome.recovered);
          finished.push(task.id);
        } else if (outcome.kind === 'interrupt') {
          interrupts.push(outcome.interrupt);
        } else if (outcome.kind === 'failed') {
          failure ??= { task, error: outcome.error };
        }
        // An aborted sibling simply stays pending, so it runs again on the next attempt.
      }

      const state = this.reduce(checkpoint.state, updates);
      const unfinished = waiting.filter((task) => !finished.includes(task.id));
      const completed = [...carried, ...finished];
      const ranNodes = distinctNodes(allTasks.filter((task) => completed.includes(task.id)));
      const ranTasks = pendingTasks;
      const routeFields = Object.keys(gotos).length > 0 ? { gotos } : {};
      const recoveryFields = recovered.length > 0 ? { recovered } : {};

      if (failure) {
        // Keep what the siblings that already finished wrote, and carry only the unfinished tasks, so
        // continue() retries the failure without repeating side effects that already happened.
        const failed: CheckpointDraft<S> = {
          ...checkpoint,
          state,
          ...pausedFields(allTasks, unfinished),
          completed,
          ...routeFields,
          ...recoveryFields,
          status: 'failed',
          error: {
            name: failure.error instanceof Error ? failure.error.name : 'Error',
            message: describe(failure.error),
          },
          createdAt: this.now().toISOString(),
        };
        await persist(failed, true);
        throw failure.error instanceof GraphNodeError
          ? failure.error
          : new GraphNodeError(failure.task.node, step, failure.error);
      }

      if (interrupts.length > 0 || runOptions.signal?.aborted) {
        const asking = interrupts.length > 0;
        checkpoint = {
          ...checkpoint,
          state,
          ...pausedFields(allTasks, unfinished),
          completed,
          ...routeFields,
          ...recoveryFields,
          status: asking ? 'awaiting_input' : 'interrupted',
          interrupts,
          createdAt: this.now().toISOString(),
        };
        await persist(checkpoint, true);
        yield this.toEvent(checkpoint, ranNodes, ranTasks, attempts);
        return;
      }

      if (parentCommand) {
        // Control passes to the graph that contains this one; nothing else in this graph runs.
        checkpoint = {
          threadId,
          step,
          state,
          next: [],
          status: 'completed',
          resolved: checkpoint.resolved,
          ...recoveryFields,
          createdAt: this.now().toISOString(),
          ...(runOptions.metadata ? { metadata: runOptions.metadata } : {}),
        };
        await persist(checkpoint, true);
        yield { ...this.toEvent(checkpoint, ranNodes, ranTasks, attempts), parentCommand };
        return;
      }

      // Route from every task of the step, including those that finished before a pause or failure;
      // otherwise their outgoing edges and their Command routes would be lost on resume.
      const nodeOf = new Map(allTasks.map((task) => [task.id, task.node]));
      const routes = completed.flatMap((id) =>
        (gotos[id] ?? []).map((target) => ({ from: nodeOf.get(id) ?? id, target })),
      );
      const routed = await this.nextTasks(ranNodes, state, step, routes);
      const next = [...routed, ...held.filter((task) => !routed.some((item) => item.id === task.id))];

      const breakAfter =
        next.length > 0
          ? distinctNodes(pendingTasks.filter((task) => finished.includes(task.id) && stopAfter.includes(task.node)))
          : [];
      checkpoint = {
        threadId,
        step,
        state,
        ...pendingFields(next),
        status: breakAfter.length > 0 ? 'interrupted' : next.length > 0 ? 'running' : 'completed',
        ...(breakAfter.length > 0 ? { breakpoint: { when: 'after' as const, nodes: breakAfter } } : {}),
        resolved: checkpoint.resolved,
        ...recoveryFields,
        createdAt: this.now().toISOString(),
        ...(runOptions.metadata ? { metadata: runOptions.metadata } : {}),
      };
      // A recovery decision is written before anything it routes to can run, in every mode, so a
      // crash after it resumes into the same path. So is a run's last checkpoint.
      await persist(checkpoint, recovered.length > 0 || next.length === 0 || breakAfter.length > 0);
      yield this.toEvent(checkpoint, ranNodes, ranTasks, attempts);
      if (breakAfter.length > 0) return;
    }
  }

  /** Runs one task to a verdict, applying its retry policy and timeout. */
  private async runTask(
    task: GraphTask,
    step: number,
    threadId: string,
    checkpoint: CheckpointDraft<S>,
    runOptions: GraphRunOptions,
    stepSignal: AbortSignal,
  ): Promise<TaskOutcome<S>> {
    const definition = this.nodes.get(task.node);
    if (!definition) throw new GraphValidationError(`Node "${task.node}" disappeared before it could run`);
    const policy = this.retryPolicy(definition);
    const limits = { ...this.timeoutOf(definition), ...task.timeout };
    const cachePolicy = definition.options.cache;
    const cache = cachePolicy ? await this.loadNodeCache() : undefined;
    const cacheKey = cachePolicy && cache ? cache.key(cachePolicy, task.node, checkpoint.state, task.input) : undefined;
    if (cachePolicy && cache && cacheKey !== undefined) {
      const hit = await cache.read(cachePolicy, cacheKey);
      if (hit) {
        const updates = hit.updates as Array<StateUpdate<S>>;
        const goto = hit.goto?.length ? (hit.goto as RouteRecord[]) : undefined;
        notify(runOptions, {
          type: 'task_end',
          step,
          taskId: task.id,
          node: task.node,
          ...(updates.length === 1 ? { update: updates[0] } : updates.length > 1 ? { update: updates } : {}),
          ...(goto ? { goto: goto.map(routeName) } : {}),
          cached: true,
        });
        return { kind: 'ok', updates, goto, attempts: 0 };
      }
    }
    let attempts = 0;
    const firstAttemptAt = this.now().toISOString();

    while (true) {
      attempts += 1;
      notify(runOptions, { type: 'task_start', step, taskId: task.id, node: task.node, attempt: attempts });
      const timer = attemptTimer(task.node, limits);
      // Linked rather than composed with AbortSignal.any(), and released when the attempt ends, so a
      // long-lived run signal keeps nothing for each attempt it outlives.
      const linked = linkSignals([stepSignal, runOptions.signal, timer?.signal]);
      const signal = linked.signal;

      try {
        const running = this.runNode(
          definition.fn,
          task,
          step,
          threadId,
          checkpoint,
          runOptions,
          signal,
          attempts,
          timer?.touch,
        );
        if (timer) running.catch(() => undefined);
        // A node is asked to stop through its signal, but nothing forces it to listen, so the timeout
        // also has to end the attempt on its own.
        const output = timer ? await Promise.race([running, timer.expired]) : await running;
        // A command for the parent graph carries an update meant for the parent's state, not this one.
        const parent = output.command?.graph === Command.PARENT ? output.command : undefined;
        const goto = parent ? undefined : toRouteRecords(output.command?.goto);
        const updates = parent ? [] : output.updates;
        // A result that depended on a human's answer, or that addressed the parent graph, is not a
        // function of this node's state and input, so the key would not describe it.
        if (cachePolicy && cache && cacheKey !== undefined && !parent && !output.interrupted) {
          await cache.write(cachePolicy, cacheKey, { updates, ...(goto?.length ? { goto } : {}) });
        }
        notify(runOptions, {
          type: 'task_end',
          step,
          taskId: task.id,
          node: task.node,
          ...(updates.length === 1 ? { update: updates[0] } : updates.length > 1 ? { update: updates } : {}),
          ...(goto?.length ? { goto: goto.map(routeName) } : {}),
        });
        return { kind: 'ok', updates, goto, parent, attempts };
      } catch (error) {
        timer?.stop();
        if (error instanceof GraphInterrupt) {
          return {
            kind: 'interrupt',
            attempts,
            interrupt: {
              ...error.request,
              id: interruptKey({ node: error.node, taskId: error.taskId, step: error.step, index: error.index }),
              node: error.node,
              ...(error.taskId === error.node ? {} : { taskId: error.taskId }),
              step: error.step,
              index: error.index,
              requestedAt: this.now().toISOString(),
            },
          };
        }
        // A cancelled run or a sibling's failure is not this task's fault, so it stays pending rather
        // than being recorded as the reason the step failed.
        if (runOptions.signal?.aborted || stepSignal.aborted) return { kind: 'aborted', attempts };

        const failure = timer?.error() ?? error;
        const retryable = policy.retryOn ? policy.retryOn(failure, attempts) : isRetryable(failure);
        if (attempts >= Math.max(1, policy.maxAttempts) || !retryable) {
          return this.recover(definition, task, step, checkpoint, runOptions, {
            node: task.node,
            taskId: task.id,
            step,
            attempts,
            firstAttemptAt,
            failedAt: this.now().toISOString(),
            error: failure,
            retryExhausted: retryable,
            ...(failure instanceof GraphNodeTimeoutError
              ? { timeout: { type: failure.kind, limitMs: failure.timeoutMs } }
              : {}),
            ...(task.input === undefined ? {} : { input: task.input }),
            threadId,
          });
        }
        notify(runOptions, {
          type: 'task_retry',
          step,
          taskId: task.id,
          node: task.node,
          attempt: attempts,
          error: describe(failure),
        });
        await delay(backoffDelay(policy, attempts), runOptions.signal);
      } finally {
        timer?.stop();
        linked.dispose();
      }
    }
  }

  /**
   * Hands a failure to the node's `onError`, and turns what it decides into the task's result. With
   * no handler, or for a mistake in the graph itself, the task fails as it always did.
   */
  private async recover(
    definition: GraphNodeDefinition<S>,
    task: GraphTask,
    step: number,
    checkpoint: CheckpointDraft<S>,
    runOptions: GraphRunOptions,
    failure: NodeFailure,
  ): Promise<TaskOutcome<S>> {
    const handler = this.errorHandler(definition);
    const event = {
      type: 'task_failed' as const,
      step,
      taskId: task.id,
      node: task.node,
      attempts: failure.attempts,
      error: describe(failure.error),
    };
    if (!handler || failure.error instanceof GraphValidationError) {
      notify(runOptions, { ...event, recovered: false });
      return { kind: 'failed', error: failure.error, attempts: failure.attempts };
    }
    let decided: NodeResult<S>;
    try {
      decided = await handler(failure, { state: Object.freeze({ ...checkpoint.state }) });
    } catch (error) {
      notify(runOptions, { ...event, recovered: false });
      return { kind: 'failed', error, attempts: failure.attempts };
    }
    const command = decided instanceof Command ? decided : undefined;
    const parent = command?.graph === Command.PARENT ? command : undefined;
    const goto = parent ? undefined : toRouteRecords(command?.goto);
    const own = command ? (command.update as StateUpdate<S> | undefined) : (decided as StateUpdate<S> | undefined);
    const updates = parent || !own ? [] : [own];
    notify(runOptions, { ...event, recovered: true });
    return {
      kind: 'ok',
      updates,
      goto,
      parent,
      attempts: failure.attempts,
      recovered: {
        node: failure.node,
        taskId: failure.taskId,
        step,
        attempts: failure.attempts,
        error: {
          name: failure.error instanceof Error ? failure.error.name : 'Error',
          message: describe(failure.error),
        },
        failedAt: failure.failedAt,
        retryExhausted: failure.retryExhausted,
        ...(failure.timeout ? { timeout: failure.timeout } : {}),
        ...(goto?.length ? { goto: goto.map(routeName) } : {}),
      },
    };
  }

  /** The node's retry policy over the graph's defaults. */
  private retryPolicy(definition: GraphNodeDefinition<S>): Required<Omit<RetryPolicy, 'retryOn'>> & RetryPolicy {
    return {
      ...DEFAULT_RETRY,
      ...this.options.retry,
      ...this.options.nodeDefaults?.retry,
      ...definition.options.retry,
    };
  }

  /** The node's run and idle limits over the graph's defaults. `timeout.runMs` wins over `timeoutMs`. */
  private timeoutOf(definition: GraphNodeDefinition<S>): NodeTimeout {
    const defaults = this.options.nodeDefaults?.timeout;
    const own = definition.options;
    const runMs = own.timeout?.runMs ?? own.timeoutMs ?? defaults?.runMs;
    const idleMs = own.timeout?.idleMs ?? defaults?.idleMs;
    return { ...(runMs === undefined ? {} : { runMs }), ...(idleMs === undefined ? {} : { idleMs }) };
  }

  private errorHandler(definition: GraphNodeDefinition<S>): NodeOptions<S>['onError'] {
    return definition.options.onError ?? (this.options.nodeDefaults?.onError as NodeOptions<S>['onError']);
  }

  private async runNode(
    fn: NodeFn<S>,
    task: GraphTask,
    step: number,
    threadId: string,
    checkpoint: CheckpointDraft<S>,
    runOptions: GraphRunOptions,
    signal: AbortSignal,
    attempt: number,
    touch: () => void = noop,
  ): Promise<{ updates: Array<StateUpdate<S>>; command?: Command; interrupted: boolean }> {
    const node = task.node;
    let interruptIndex = 0;
    const context: NodeContext<S> = {
      state: Object.freeze({ ...checkpoint.state }),
      node,
      step,
      threadId,
      ...(runOptions.tenantId !== undefined ? { tenantId: runOptions.tenantId } : {}),
      taskId: task.id,
      input: task.input,
      attempt,
      signal,
      ...(this.options.store
        ? {
            store:
              runOptions.tenantId !== undefined
                ? tenantStore(this.options.store, runOptions.tenantId)
                : this.options.store,
          }
        : {}),
      interrupt: <T>(request: Parameters<NodeContext<S>['interrupt']>[0]): T => {
        const index = interruptIndex++;
        const key = interruptKey({ node, taskId: task.id, step, index });
        if (checkpoint.resolved && key in checkpoint.resolved) {
          return checkpoint.resolved[key] as T;
        }
        if (!this.checkpointer()) {
          throw new GraphValidationError(
            `Node "${node}" called interrupt(), but the graph was compiled without a checkpointer, so there would be nothing to resume from.`,
          );
        }
        throw new GraphInterrupt(request, node, step, index, task.id);
      },
      emit: (data) => {
        touch();
        notify(runOptions, { type: 'custom', step, taskId: task.id, node, data });
      },
      heartbeat: touch,
      message: (chunk) => {
        touch();
        notify(runOptions, { type: 'message', step, taskId: task.id, node, chunk });
      },
      tool: (event) => {
        touch();
        notify(runOptions, { type: 'tool', step, taskId: task.id, node, tool: event });
      },
      report: (progress) => {
        touch();
        if (!runOptions.onProgress) return;
        try {
          runOptions.onProgress({ ...progress, step, node });
        } catch {
          // Progress is informational; a broken listener must not fail the node reporting it.
        }
      },
    };

    // Only when asked for, so a listener written for 2.0 sees exactly the events it did. Not
    // enumerable, so a node that spreads its context does not carry it along.
    if (runOptions.subgraphEvents) {
      Object.defineProperty(context, FORWARD_EVENT, {
        value: (event: GraphEvent) => notify(runOptions, { ...event, namespace: [node, ...(event.namespace ?? [])] }),
      });
    }
    const result = await fn(context);
    const interrupted = interruptIndex > 0;
    if (result instanceof Command) {
      const following = (result as { [FOLLOWING_UPDATES]?: Array<StateUpdate<S>> })[FOLLOWING_UPDATES] ?? [];
      const own = result.update as StateUpdate<S> | undefined;
      return { updates: [...(own ? [own] : []), ...following], command: result, interrupted };
    }
    return { updates: result ? [result as StateUpdate<S>] : [], interrupted };
  }

  private loadNodeCache(): Promise<NodeCache> {
    this.nodeCache ??= import('./node-cache.js').then(
      ({ NodeCache }) => new NodeCache(this.options.name ?? '', this.options.cache, () => this.now().getTime()),
    );
    return this.nodeCache;
  }

  /** Rejects writes to channels the graph does not accept from a caller. */
  private assertInput(input: object): void {
    const allowed = this.scope.input;
    if (!allowed) return;
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || allowed.includes(key)) continue;
      throw new GraphValidationError(
        `"${key}" is not an input of this graph. It accepts ${allowed.length ? allowed.map((name) => `"${name}"`).join(', ') : 'no input'}.`,
      );
    }
  }

  /** State as a caller sees it: the output channels, when the graph declared them. */
  private visible(state: StateOf<S>): Pick<StateOf<S>, O> {
    const output = this.scope.output;
    if (!output) return state;
    const visible: Record<string, unknown> = {};
    for (const key of output) visible[key] = (state as Record<string, unknown>)[key];
    return visible as Pick<StateOf<S>, O>;
  }

  /** Combines this superstep's writes into state through each channel's reducer. */
  private reduce(state: StateOf<S>, updates: Array<StateUpdate<S>>): StateOf<S> {
    if (updates.length === 0) return state;
    const next = { ...state } as Record<string, unknown>;

    for (const update of updates) {
      for (const [key, value] of Object.entries(update)) {
        if (value === undefined) continue;
        const channel = this.channels[key];
        if (!channel) {
          throw new GraphValidationError(
            `A node wrote to "${key}", which is not a declared channel. Add it to the graph's channels.`,
          );
        }
        next[key] = channel.reduce(next[key], value);
      }
    }
    return next as StateOf<S>;
  }

  /** Follows every edge out of the nodes that ran, producing the next step's tasks. */
  private async nextTasks(
    ran: string[],
    state: StateOf<S>,
    step: number,
    routes: Array<{ from: string; target: RouteRecord }> = [],
  ): Promise<GraphTask[]> {
    const tasks: GraphTask[] = [];
    let sends = 0;

    const add = (target: string | Send, from: string): void => {
      if (target instanceof Send) {
        if (target.node === END) return;
        if (!this.nodes.has(target.node)) {
          throw new GraphValidationError(`Send from "${from}" targets unknown node "${target.node}"`);
        }
        // Ids come from the step and the order they were produced, so replaying the same routing
        // decisions rebuilds exactly the same tasks.
        tasks.push({
          id: `${target.node}#${step + 1}.${sends++}`,
          node: target.node,
          input: target.input,
          ...(target.options?.timeout ? { timeout: target.options.timeout } : {}),
        });
        return;
      }
      if (target === END) return;
      if (!this.nodes.has(target)) {
        throw new GraphValidationError(`Router on "${from}" returned unknown target "${target}"`);
      }
      if (!tasks.some((task) => task.id === target)) tasks.push({ id: target, node: target });
    };

    for (const node of ran) {
      for (const edge of this.edges) {
        if (edge.from !== node) continue;

        if (edge.router) {
          const decided = await edge.router(Object.freeze({ ...state }));
          for (const target of Array.isArray(decided) ? decided : [decided]) {
            add(typeof target === 'string' ? (edge.mapping?.[target] ?? target) : target, node);
          }
          continue;
        }
        if (edge.to) add(edge.to, node);
      }
    }
    // Routes a node chose itself through a Command, after its edges.
    for (const { from, target } of routes) {
      add(
        typeof target === 'string'
          ? target
          : new Send(target.node, target.input, target.timeout ? { timeout: target.timeout } : undefined),
        from,
      );
    }
    return tasks;
  }

  private entryNodes(): string[] {
    return this.edges
      .filter((edge) => edge.from === START && edge.to && edge.to !== END)
      .map((edge) => edge.to as string);
  }

  private seedState(input: StateUpdate<S>): StateOf<S> {
    const state = {} as Record<string, unknown>;
    for (const [key, channel] of Object.entries(this.channels)) {
      state[key] = channel.initial ? channel.initial() : undefined;
    }
    return this.reduce(state as StateOf<S>, [input]);
  }

  private async requireCheckpoint(threadId: string, tenantId?: string): Promise<GraphCheckpoint<S>> {
    const checkpoint = await this.checkpointer()?.get(threadId);
    if (!checkpoint || !ownedBy(checkpoint, tenantId)) throw new GraphThreadNotFoundError(threadId);
    return migrateCheckpoint(checkpoint) as GraphCheckpoint<S>;
  }

  /**
   * Completes a checkpoint in the current schema and persists it. The store keeps opaque state; the
   * schema stays this class's business.
   */
  private async save(draft: CheckpointDraft<S>): Promise<GraphCheckpoint<S>> {
    const checkpoint = toCheckpoint(draft);
    const store = this.checkpointer();
    if (!store) return checkpoint;
    const named = this.options.name
      ? { ...checkpoint, metadata: { ...checkpoint.metadata, graph: this.options.name } }
      : checkpoint;
    await store.put(named as GraphCheckpoint);
    return checkpoint;
  }

  private checkpointResult(checkpoint: GraphCheckpoint<S>): GraphResult<S, O> {
    return {
      threadId: checkpoint.threadId,
      status: checkpoint.status,
      state: this.visible(checkpoint.state),
      steps: checkpoint.step,
      ...(checkpoint.interrupts.length
        ? { interrupt: checkpoint.interrupts[0], interrupts: checkpoint.interrupts }
        : {}),
      ...(checkpoint.breakpoint ? { breakpoint: checkpoint.breakpoint } : {}),
    };
  }

  private checkpointer(): GraphCheckpointer | undefined {
    return this.store;
  }

  private toEvent(
    checkpoint: CheckpointDraft<S>,
    nodes: string[],
    tasks?: GraphTask[],
    attempts?: Record<string, number>,
  ): GraphStepEvent<S> {
    const dynamic = tasks?.some((task) => task.id !== task.node || task.input !== undefined);
    return {
      type:
        checkpoint.status === 'awaiting_input'
          ? 'interrupt'
          : checkpoint.breakpoint
            ? 'breakpoint'
            : checkpoint.next.length
              ? 'step'
              : 'done',
      step: checkpoint.step,
      nodes,
      ...(dynamic ? { tasks } : {}),
      ...(attempts && Object.keys(attempts).length > 0 ? { attempts } : {}),
      state: checkpoint.state,
      status: checkpoint.status,
      ...(checkpoint.interrupts?.length
        ? { interrupt: checkpoint.interrupts[0], interrupts: checkpoint.interrupts }
        : {}),
      ...(checkpoint.breakpoint ? { breakpoint: checkpoint.breakpoint } : {}),
      ...(checkpoint.recovered?.length ? { recovered: checkpoint.recovered } : {}),
    };
  }

  private toResult(threadId: string, last: GraphStepEvent<S> | undefined): GraphResult<S, O> {
    if (!last) {
      return { threadId, status: 'completed', state: this.visible(this.seedState({})), steps: 0 };
    }
    return {
      threadId,
      status: last.status,
      state: this.visible(last.state),
      steps: last.step,
      ...(last.interrupt ? { interrupt: last.interrupt } : {}),
      ...(last.interrupts ? { interrupts: last.interrupts } : {}),
      ...(last.breakpoint ? { breakpoint: last.breakpoint } : {}),
      ...(last.parentCommand ? { parentCommand: last.parentCommand } : {}),
    };
  }
}

/**
 * Starts a graph definition.
 *
 * `input` and `output` restrict which channels a caller may set and which come back, so working
 * channels stay internal. Both default to every channel. As a subgraph, a graph receives only its
 * input channels from the parent and merges back only its output channels. Checkpoints, `state()`,
 * and stream events still carry the whole state, because they describe the thread rather than
 * answer a caller.
 */
// An empty list gives TypeScript nothing to infer from, so it would fall back to "every channel";
// these overloads keep `input: []` and `output: []` meaning "none" in the types as well as at run
// time, without a `const` type parameter that would raise the TypeScript version consumers need.
export function createGraph<S extends ChannelSchema>(config: {
  channels: S;
  input: readonly [];
  output: readonly [];
}): StateGraph<S, never, never>;
export function createGraph<S extends ChannelSchema, O extends keyof S & string = keyof S & string>(config: {
  channels: S;
  input: readonly [];
  output?: readonly O[];
}): StateGraph<S, never, O>;
export function createGraph<S extends ChannelSchema, I extends keyof S & string = keyof S & string>(config: {
  channels: S;
  input?: readonly I[];
  output: readonly [];
}): StateGraph<S, I, never>;
export function createGraph<
  S extends ChannelSchema,
  I extends keyof S & string = keyof S & string,
  O extends keyof S & string = keyof S & string,
>(config: { channels: S; input?: readonly I[]; output?: readonly O[] }): StateGraph<S, I, O>;
export function createGraph<S extends ChannelSchema>(config: {
  channels: S;
  input?: readonly string[];
  output?: readonly string[];
}): StateGraph<S> {
  return new StateGraph<S>(config.channels, {
    ...(config.input ? { input: [...config.input] } : {}),
    ...(config.output ? { output: [...config.output] } : {}),
  });
}

function resolveThreadId(requested: string | undefined): string {
  return requested?.trim() || `thread-${randomBytes(6).toString('hex')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tasks a checkpoint describes. A draft without them names only nodes, and each is one task. */
function tasksOf(checkpoint: CheckpointDraft<ChannelSchema>): GraphTask[] {
  if (checkpoint.tasks?.length) return checkpoint.tasks;
  return checkpoint.next.map((node) => ({ id: node, node }));
}

/** Writes the pending work onto a checkpoint: the nodes to run next, and the tasks that run them. */
function pendingFields(tasks: GraphTask[]): { next: string[]; tasks: GraphTask[] } {
  return { next: tasks.map((task) => task.node), tasks };
}

/**
 * Writes the pending work of a step that stopped early.
 *
 * The whole step's task list is kept, not just what is left, because the tasks that finished are what
 * `completed` refers to and what the step routes from once it finishes.
 */
function pausedFields(all: GraphTask[], unfinished: GraphTask[]): { next: string[]; tasks: GraphTask[] } {
  return { next: unfinished.map((task) => task.node), tasks: all };
}

function distinctNodes(tasks: GraphTask[]): string[] {
  const nodes: string[] = [];
  for (const task of tasks) if (!nodes.includes(task.node)) nodes.push(task.node);
  return nodes;
}

/**
 * Runs tasks with a bounded number in flight, preserving nothing about completion order.
 *
 * A single task skips the pool entirely, so a linear graph pays no scheduling cost for a feature it
 * does not use.
 */
async function runConcurrently<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const bound = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : items.length;
  if (items.length === 1 || bound === 1) {
    for (const [index, item] of items.entries()) await worker(item as T, index);
    return;
  }

  let cursor = 0;
  const runners = Array.from({ length: Math.min(bound, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
}

function backoffDelay(policy: Required<Omit<RetryPolicy, 'retryOn'>>, attempt: number): number {
  const raw = policy.initialIntervalMs * policy.backoffFactor ** (attempt - 1);
  const capped = Math.min(raw, policy.maxIntervalMs);
  // Jitter keeps simultaneous tasks from retrying in lockstep against the same dependency.
  return policy.jitter ? Math.round(capped * (0.5 + Math.random() / 2)) : Math.round(capped);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    // Deliberately not unref'd: a run waiting to retry is work in progress, and the process should
    // stay alive for it exactly as it does while a node is running.
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A mistake in the graph itself will fail the same way every time, so retrying only wastes time. */
/** Delivers a fine-grained event. A listener that throws must never fail the run it observes. */
function notify(runOptions: GraphRunOptions, event: GraphEvent): void {
  if (!runOptions.onEvent) return;
  try {
    runOptions.onEvent(event);
  } catch {
    // Observation only.
  }
}

/** Flattens a Command's targets to a form a checkpoint can store as JSON. */
function toRouteRecords(goto: CommandTarget | undefined): RouteRecord[] | undefined {
  if (goto === undefined) return undefined;
  return (Array.isArray(goto) ? goto : [goto]).map((target) =>
    target instanceof Send
      ? {
          node: target.node,
          ...(target.input === undefined ? {} : { input: target.input }),
          ...(target.options?.timeout ? { timeout: target.options.timeout } : {}),
        }
      : target,
  );
}

function routeName(route: RouteRecord): string {
  return typeof route === 'string' ? route : route.node;
}

function noop(): void {}

/** One attempt's run and idle limits: a signal for the node, and a promise that ends the attempt. */
interface AttemptTimer {
  /** Aborted when either limit is reached. */
  signal: AbortSignal;
  /** Rejects with the timeout error when a limit is reached, so an attempt ends even if the node never returns. */
  expired: Promise<never>;
  /** Restarts the idle limit. */
  touch: () => void;
  /** The timeout error, once a limit was reached. */
  error: () => GraphNodeTimeoutError | undefined;
  /** Clears the timers. */
  stop: () => void;
}

function attemptTimer(node: string, limits: NodeTimeout): AttemptTimer | undefined {
  const { runMs, idleMs } = limits;
  if (runMs === undefined && idleMs === undefined) return undefined;
  const controller = new AbortController();
  let reached: GraphNodeTimeoutError | undefined;
  let reject: (error: unknown) => void = noop;
  const expired = new Promise<never>((_, fail) => {
    reject = fail;
  });
  expired.catch(noop);
  const fire = (error: GraphNodeTimeoutError) => {
    if (reached) return;
    reached = error;
    controller.abort(error);
    reject(error);
  };
  const runTimer =
    runMs === undefined ? undefined : setTimeout(() => fire(new GraphNodeTimeoutError(node, runMs)), runMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleMs === undefined || reached) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire(new GraphNodeTimeoutError(node, idleMs, 'idle')), idleMs);
  };
  armIdle();
  return {
    signal: controller.signal,
    expired,
    touch: armIdle,
    error: () => reached,
    stop: () => {
      if (runTimer) clearTimeout(runTimer);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    },
  };
}

/** A mistake in the graph itself will fail the same way every time, so retrying only wastes time. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof GraphValidationError);
}

export type { GraphProgress, GraphStatus };

/** The tenant a checkpoint's run recorded, if any. */
function tenantOf(checkpoint: { metadata?: Record<string, unknown> }): string | undefined {
  const tenantId = checkpoint.metadata?.tenantId;
  return typeof tenantId === 'string' ? tenantId : undefined;
}

/**
 * Whether a caller may use a thread: always without a tenant of its own, and with one, when the
 * thread is that tenant's or was written with no tenant at all.
 */
function ownedBy(checkpoint: { metadata?: Record<string, unknown> }, tenantId: string | undefined): boolean {
  if (tenantId === undefined) return true;
  const owner = tenantOf(checkpoint);
  return owner === undefined || owner === tenantId;
}

/** Yields everything a stream yields, then releases what it held, however the stream ends. */
async function* releasing<T>(source: AsyncIterable<T>, release: () => void): AsyncGenerator<T, void, void> {
  try {
    yield* source;
  } finally {
    release();
  }
}
