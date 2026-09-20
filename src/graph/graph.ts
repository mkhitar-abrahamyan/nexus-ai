import { randomBytes } from 'node:crypto';
import type {
  ChannelSchema,
  CompileOptions,
  EdgeRouter,
  CommandTarget,
  GraphCheckpoint,
  GraphCheckpointer,
  GraphDescription,
  GraphEvent,
  GraphProgress,
  GraphResult,
  GraphRunOptions,
  GraphStatus,
  GraphStepEvent,
  GraphTask,
  NodeContext,
  NodeFn,
  NodeOptions,
  PendingInterrupt,
  RetryPolicy,
  StateOf,
  StateUpdate,
} from '../types/graph.js';
import { Command, END, Send, START } from '../types/graph.js';
import { MemoryGraphCheckpointer } from './checkpointer.js';
import {
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
  options: NodeOptions;
}

/** A route in serializable form: a node name, or a `Send` flattened to its node and input. */
type RouteRecord = string | { node: string; input?: unknown };

/** Marks the function `asNode()` returns, so `describe()` can draw the graph inside it. */
const SUBGRAPH = Symbol('nexus.graph.subgraph');

/**
 * Further updates carried by a Command, reduced after its own `update`. Used when a subgraph hands
 * control to its parent: the subgraph's shared state and the update it addressed to the parent are
 * two writes, and merging them into one object would let one overwrite the other.
 */
const FOLLOWING_UPDATES = Symbol('nexus.graph.followingUpdates');

type TaskOutcome<S extends ChannelSchema> =
  | { kind: 'ok'; updates: Array<StateUpdate<S>>; goto?: RouteRecord[]; parent?: Command; attempts: number }
  | { kind: 'interrupt'; interrupt: PendingInterrupt; attempts: number }
  | { kind: 'aborted'; attempts: number }
  | { kind: 'failed'; error: unknown; attempts: number };

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
export class StateGraph<S extends ChannelSchema> {
  private readonly nodes = new Map<string, GraphNodeDefinition<S>>();
  private readonly edges: Array<Edge<S>> = [];

  constructor(private readonly channels: S) {
    if (!channels || typeof channels !== 'object' || Object.keys(channels).length === 0) {
      throw new GraphValidationError('A graph needs at least one state channel');
    }
    for (const [name, channel] of Object.entries(channels)) {
      if (typeof channel?.reduce !== 'function') {
        throw new GraphValidationError(`Channel "${name}" must provide a reduce() function`);
      }
    }
  }

  addNode(name: string, fn: NodeFn<S>, options: NodeOptions = {}): this {
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
  compile(options: CompileOptions = {}): CompiledGraph<S> {
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
        if (edge.router && !edge.mapping) return new CompiledGraph(this.channels, this.nodes, this.edges, options);
      }
    }
    const orphans = [...this.nodes.keys()].filter((node) => !reachable.has(node));
    if (orphans.length > 0) {
      throw new GraphValidationError(`No edge reaches ${orphans.map((node) => `"${node}"`).join(', ')}`);
    }

    return new CompiledGraph(this.channels, this.nodes, this.edges, options);
  }
}

/** A validated graph, ready to run. */
export class CompiledGraph<S extends ChannelSchema> {
  private readonly now: () => Date;
  private readonly store: GraphCheckpointer | undefined;

  constructor(
    private readonly channels: S,
    private readonly nodes: Map<string, GraphNodeDefinition<S>>,
    private readonly edges: Array<Edge<S>>,
    private readonly options: CompileOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = options.checkpointer === false ? undefined : (options.checkpointer ?? new MemoryGraphCheckpointer());
  }

  /** Runs to completion, to an interrupt, or to the step limit. */
  async invoke(input: StateUpdate<S> = {}, runOptions: GraphRunOptions = {}): Promise<GraphResult<S>> {
    // Resolve the id here rather than inside stream(), so the result reports the id actually used.
    const threadId = resolveThreadId(runOptions.threadId);
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.stream(input, { ...runOptions, threadId })) last = event;
    return this.toResult(threadId, last);
  }

  /** Yields one event per superstep, so a caller can render progress as it happens. */
  stream(input: StateUpdate<S> = {}, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    const threadId = resolveThreadId(runOptions.threadId);
    return this.run(threadId, runOptions, async () => {
      const state = this.seedState(input);
      const next = this.entryNodes();
      return { threadId, step: 0, state, next, status: 'running', createdAt: this.now().toISOString() };
    });
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
      if (checkpoint.status !== 'awaiting_input' || !checkpoint.interrupt) {
        throw new GraphNotInterruptedError(threadId, checkpoint.status);
      }
      return {
        ...checkpoint,
        status: 'running',
        interrupt: undefined,
        interrupts: undefined,
        resolved: { ...checkpoint.resolved, [checkpoint.interrupt.id]: value },
      };
    });
  }

  /** Like `resume`, but returns the final result rather than the stream. */
  async resumeWith(threadId: string, value: unknown, runOptions: GraphRunOptions = {}): Promise<GraphResult<S>> {
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
      if (checkpoint.status !== 'awaiting_input' || !checkpoint.interrupt) {
        throw new GraphNotInterruptedError(threadId, checkpoint.status);
      }
      const pending = checkpoint.interrupts ?? [checkpoint.interrupt];
      const unknown = Object.keys(answers).filter((id) => !pending.some((item) => item.id === id));
      if (unknown.length > 0) {
        throw new GraphValidationError(
          `Thread "${threadId}" has no pending question with id ${unknown.map((id) => `"${id}"`).join(', ')}. Pending: ${pending.map((item) => `"${item.id}"`).join(', ')}.`,
        );
      }
      return {
        ...checkpoint,
        status: 'running',
        interrupt: undefined,
        interrupts: undefined,
        resolved: { ...checkpoint.resolved, ...answers },
      };
    });
  }

  /** Like `resumeInterrupts`, but returns the final result rather than the stream. */
  async resumeInterruptsWith(
    threadId: string,
    answers: Record<string, unknown>,
    runOptions: GraphRunOptions = {},
  ): Promise<GraphResult<S>> {
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.resumeInterrupts(threadId, answers, runOptions)) last = event;
    return this.toResult(threadId, last);
  }

  /** Continues a thread that stopped for any other reason, such as the step limit. */
  continue(threadId: string, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const checkpoint = await this.requireCheckpoint(threadId);
      return { ...checkpoint, status: 'running', error: undefined };
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
      const checkpoint = (await this.checkpointer()?.get(threadId, step)) as GraphCheckpoint<S> | undefined;
      if (!checkpoint) throw new GraphThreadNotFoundError(threadId);
      return { ...checkpoint, status: 'running' };
    });
  }

  /** Latest checkpoint, or the one at `step`. */
  async state(threadId: string, step?: number): Promise<GraphCheckpoint<S> | undefined> {
    return (await this.checkpointer()?.get(threadId, step)) as GraphCheckpoint<S> | undefined;
  }

  /** Checkpoints for a thread, newest first. */
  async history(threadId: string, limit?: number): Promise<Array<GraphCheckpoint<S>>> {
    return ((await this.checkpointer()?.history(threadId, limit)) ?? []) as Array<GraphCheckpoint<S>>;
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
      const runOptions: GraphRunOptions = {
        threadId: `${context.threadId}:${context.taskId}`,
        signal: context.signal,
      };
      const paused = await this.state(runOptions.threadId as string);
      let result: GraphResult<S>;

      if (paused?.status === 'awaiting_input' && paused.interrupt) {
        // The parent node is being replayed after an answer. Every answer the subgraph already
        // received came through an earlier parent interrupt, so consume those positions in order;
        // the next position is the answer to the question the subgraph is waiting on now.
        const answered = Object.keys(paused.resolved ?? {}).length;
        for (let index = 0; index < answered; index += 1) context.interrupt({ reason: paused.interrupt.reason });
        result = this.checkpointResult(paused);
      } else {
        const seed: Record<string, unknown> = {};
        for (const key of Object.keys(this.channels)) {
          if (key in context.state) seed[key] = (context.state as Record<string, unknown>)[key];
        }
        result = await this.invoke(seed as StateUpdate<S>, runOptions);
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
      const { ends, defer, retry, timeoutMs } = definition.options;
      return {
        id,
        ...(ends?.length ? { ends: [...ends] } : {}),
        ...(defer ? { defer } : {}),
        ...((retry?.maxAttempts ?? this.options.retry?.maxAttempts ?? 1) > 1 ? { retry: true } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
    options: { asNode?: string } = {},
  ): Promise<GraphCheckpoint<S>> {
    const checkpoint = await this.requireCheckpoint(threadId);
    const state = this.reduce(checkpoint.state, [update]);
    const createdAt = this.now().toISOString();

    if (!options.asNode) {
      const edited: GraphCheckpoint<S> = {
        ...checkpoint,
        state,
        createdAt,
        metadata: { ...checkpoint.metadata, source: 'update' },
      };
      await this.save(edited);
      return edited;
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
    const written: GraphCheckpoint<S> = {
      threadId,
      step,
      state,
      ...pendingFields(next),
      status: next.length > 0 ? 'running' : 'completed',
      resolved: checkpoint.resolved,
      createdAt,
      metadata: { ...checkpoint.metadata, source: 'update', asNode: options.asNode },
    };
    await this.save(written);
    return written;
  }

  /**
   * Copies a thread's history up to `step` into a new thread, and returns the new thread's id.
   *
   * Rewinding with `resumeFrom()` replaces the original timeline. A fork keeps it: both threads stay
   * readable and runnable, so two answers to the same question can be compared side by side. Every
   * copied checkpoint records `metadata.forkedFrom`.
   */
  async fork(threadId: string, options: { step?: number; threadId?: string } = {}): Promise<string> {
    const store = this.checkpointer();
    if (!store) throw new GraphValidationError('fork() needs a checkpointer to copy history from');
    const history = (await store.history(threadId, Number.MAX_SAFE_INTEGER)) as Array<GraphCheckpoint<S>>;
    if (history.length === 0) throw new GraphThreadNotFoundError(threadId);

    const cutoff = options.step ?? (history[0] as GraphCheckpoint<S>).step;
    const lineage = history.filter((item) => item.step <= cutoff).reverse();
    if (lineage.at(-1)?.step !== cutoff) {
      throw new GraphValidationError(`Thread "${threadId}" has no checkpoint at step ${cutoff} to fork from`);
    }
    const forkId = resolveThreadId(options.threadId);
    if (await store.get(forkId)) {
      throw new GraphValidationError(`Thread "${forkId}" already exists; choose another id for the fork`);
    }
    for (const item of lineage) {
      await store.put({
        ...item,
        threadId: forkId,
        metadata: { ...item.metadata, forkedFrom: { threadId, step: cutoff } },
      } as GraphCheckpoint);
    }
    return forkId;
  }

  // ── Execution ────────────────────────────────────────────────────

  private async *run(
    threadId: string,
    runOptions: GraphRunOptions,
    seed: () => Promise<GraphCheckpoint<S>>,
  ): AsyncGenerator<GraphStepEvent<S>, void, void> {
    const maxSteps = runOptions.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const stopBefore = runOptions.interruptBefore ?? this.options.interruptBefore ?? [];
    const stopAfter = runOptions.interruptAfter ?? this.options.interruptAfter ?? [];
    const persist = async (written: GraphCheckpoint<S>): Promise<void> => {
      await this.save(written);
      notify(runOptions, { type: 'checkpoint', step: written.step, status: written.status, next: written.next });
    };

    let checkpoint = await seed();
    // continue() from a "before" breakpoint must run the step it paused in front of, not pause again.
    let passBreakpoint = checkpoint.breakpoint?.when === 'before';
    if (checkpoint.breakpoint) checkpoint = { ...checkpoint, breakpoint: undefined };
    await persist(checkpoint);

    while (checkpoint.next.length > 0) {
      if (runOptions.signal?.aborted) {
        checkpoint = { ...checkpoint, status: 'interrupted', createdAt: this.now().toISOString() };
        await persist(checkpoint);
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
        await persist(checkpoint);
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

      if (failure) {
        // Keep what the siblings that already finished wrote, and carry only the unfinished tasks, so
        // continue() retries the failure without repeating side effects that already happened.
        const failed: GraphCheckpoint<S> = {
          ...checkpoint,
          state,
          ...pausedFields(allTasks, unfinished),
          completed,
          ...routeFields,
          status: 'failed',
          error: {
            name: failure.error instanceof Error ? failure.error.name : 'Error',
            message: describe(failure.error),
          },
          createdAt: this.now().toISOString(),
        };
        await persist(failed);
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
          status: asking ? 'awaiting_input' : 'interrupted',
          ...(asking ? { interrupt: interrupts[0], interrupts } : {}),
          createdAt: this.now().toISOString(),
        };
        await persist(checkpoint);
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
          createdAt: this.now().toISOString(),
          ...(runOptions.metadata ? { metadata: runOptions.metadata } : {}),
        };
        await persist(checkpoint);
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
        createdAt: this.now().toISOString(),
        ...(runOptions.metadata ? { metadata: runOptions.metadata } : {}),
      };
      await persist(checkpoint);
      yield this.toEvent(checkpoint, ranNodes, ranTasks, attempts);
      if (breakAfter.length > 0) return;
    }
  }

  /** Runs one task to a verdict, applying its retry policy and timeout. */
  private async runTask(
    task: GraphTask,
    step: number,
    threadId: string,
    checkpoint: GraphCheckpoint<S>,
    runOptions: GraphRunOptions,
    stepSignal: AbortSignal,
  ): Promise<TaskOutcome<S>> {
    const definition = this.nodes.get(task.node);
    if (!definition) throw new GraphValidationError(`Node "${task.node}" disappeared before it could run`);
    const policy = { ...DEFAULT_RETRY, ...this.options.retry, ...definition.options.retry };
    const timeoutMs = definition.options.timeoutMs;
    let attempts = 0;

    while (true) {
      attempts += 1;
      notify(runOptions, { type: 'task_start', step, taskId: task.id, node: task.node, attempt: attempts });
      const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
      const sources = [stepSignal, ...(runOptions.signal ? [runOptions.signal] : []), ...(timeout ? [timeout] : [])];
      const signal = sources.length === 1 ? (sources[0] as AbortSignal) : AbortSignal.any(sources);

      try {
        const running = this.runNode(definition.fn, task, step, threadId, checkpoint, runOptions, signal, attempts);
        if (timeout) running.catch(() => undefined);
        // A node is asked to stop through its signal, but nothing forces it to listen, so the timeout
        // also has to end the attempt on its own.
        const output = timeout
          ? await Promise.race([
              running,
              rejectWhenAborted(timeout, () => new GraphNodeTimeoutError(task.node, timeoutMs as number)),
            ])
          : await running;
        // A command for the parent graph carries an update meant for the parent's state, not this one.
        const parent = output.command?.graph === Command.PARENT ? output.command : undefined;
        const goto = parent ? undefined : toRouteRecords(output.command?.goto);
        const updates = parent ? [] : output.updates;
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

        const failure = timeout?.aborted ? new GraphNodeTimeoutError(task.node, timeoutMs as number) : error;
        const retryable = policy.retryOn ? policy.retryOn(failure, attempts) : isRetryable(failure);
        if (attempts >= Math.max(1, policy.maxAttempts) || !retryable) {
          return { kind: 'failed', error: failure, attempts };
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
      }
    }
  }

  private async runNode(
    fn: NodeFn<S>,
    task: GraphTask,
    step: number,
    threadId: string,
    checkpoint: GraphCheckpoint<S>,
    runOptions: GraphRunOptions,
    signal: AbortSignal,
    attempt: number,
  ): Promise<{ updates: Array<StateUpdate<S>>; command?: Command }> {
    const node = task.node;
    let interruptIndex = 0;
    const context: NodeContext<S> = {
      state: Object.freeze({ ...checkpoint.state }),
      node,
      step,
      threadId,
      taskId: task.id,
      input: task.input,
      attempt,
      signal,
      ...(this.options.store ? { store: this.options.store } : {}),
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
      emit: (data) => notify(runOptions, { type: 'custom', step, taskId: task.id, node, data }),
      report: (progress) => {
        if (!runOptions.onProgress) return;
        try {
          runOptions.onProgress({ ...progress, step, node });
        } catch {
          // Progress is informational; a broken listener must not fail the node reporting it.
        }
      },
    };

    const result = await fn(context);
    if (result instanceof Command) {
      const following = (result as { [FOLLOWING_UPDATES]?: Array<StateUpdate<S>> })[FOLLOWING_UPDATES] ?? [];
      const own = result.update as StateUpdate<S> | undefined;
      return { updates: [...(own ? [own] : []), ...following], command: result };
    }
    return { updates: result ? [result as StateUpdate<S>] : [] };
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
        tasks.push({ id: `${target.node}#${step + 1}.${sends++}`, node: target.node, input: target.input });
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
      add(typeof target === 'string' ? target : new Send(target.node, target.input), from);
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

  private async requireCheckpoint(threadId: string): Promise<GraphCheckpoint<S>> {
    const checkpoint = await this.checkpointer()?.get(threadId);
    if (!checkpoint) throw new GraphThreadNotFoundError(threadId);
    return checkpoint as GraphCheckpoint<S>;
  }

  /** Persists a checkpoint. The store keeps opaque state; the schema stays this class's business. */
  private async save(checkpoint: GraphCheckpoint<S>): Promise<void> {
    const store = this.checkpointer();
    if (!store) return;
    const named = this.options.name
      ? { ...checkpoint, metadata: { ...checkpoint.metadata, graph: this.options.name } }
      : checkpoint;
    await store.put(named as GraphCheckpoint);
  }

  private checkpointResult(checkpoint: GraphCheckpoint<S>): GraphResult<S> {
    return {
      threadId: checkpoint.threadId,
      status: checkpoint.status,
      state: checkpoint.state,
      steps: checkpoint.step,
      ...(checkpoint.interrupt ? { interrupt: checkpoint.interrupt } : {}),
      ...(checkpoint.interrupts ? { interrupts: checkpoint.interrupts } : {}),
      ...(checkpoint.breakpoint ? { breakpoint: checkpoint.breakpoint } : {}),
    };
  }

  private checkpointer(): GraphCheckpointer | undefined {
    return this.store;
  }

  private toEvent(
    checkpoint: GraphCheckpoint<S>,
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
      ...(checkpoint.interrupt ? { interrupt: checkpoint.interrupt } : {}),
      ...(checkpoint.interrupts?.length ? { interrupts: checkpoint.interrupts } : {}),
      ...(checkpoint.breakpoint ? { breakpoint: checkpoint.breakpoint } : {}),
    };
  }

  private toResult(threadId: string, last: GraphStepEvent<S> | undefined): GraphResult<S> {
    if (!last) {
      return { threadId, status: 'completed', state: this.seedState({}), steps: 0 };
    }
    return {
      threadId,
      status: last.status,
      state: last.state,
      steps: last.step,
      ...(last.interrupt ? { interrupt: last.interrupt } : {}),
      ...(last.interrupts ? { interrupts: last.interrupts } : {}),
      ...(last.breakpoint ? { breakpoint: last.breakpoint } : {}),
      ...(last.parentCommand ? { parentCommand: last.parentCommand } : {}),
    };
  }
}

/** Starts a graph definition. */
export function createGraph<S extends ChannelSchema>(config: { channels: S }): StateGraph<S> {
  return new StateGraph(config.channels);
}

function resolveThreadId(requested: string | undefined): string {
  return requested?.trim() || `thread-${randomBytes(6).toString('hex')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tasks a checkpoint describes. A plain checkpoint names only nodes, and each is one task. */
function tasksOf(checkpoint: GraphCheckpoint<ChannelSchema>): GraphTask[] {
  if (checkpoint.tasks?.length) return checkpoint.tasks;
  return checkpoint.next.map((node) => ({ id: node, node }));
}

/**
 * Writes the pending work onto a checkpoint.
 *
 * `tasks` is stored only when it says something `next` cannot: a `Send` input, or two tasks of one
 * node. A graph that never uses `Send` therefore writes exactly the checkpoint it always did.
 */
function pendingFields(tasks: GraphTask[]): { next: string[]; tasks?: GraphTask[] } {
  const next = tasks.map((task) => task.node);
  const plain = tasks.every((task) => task.id === task.node && task.input === undefined);
  return plain ? { next } : { next, tasks };
}

/**
 * Writes the pending work of a step that stopped early.
 *
 * The whole step's task list is kept, not just what is left, because the tasks that finished are what
 * `completed` refers to and what the step routes from once it finishes.
 */
function pausedFields(all: GraphTask[], unfinished: GraphTask[]): { next: string[]; tasks?: GraphTask[] } {
  if (all.length === unfinished.length) return pendingFields(unfinished);
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
      ? { node: target.node, ...(target.input === undefined ? {} : { input: target.input }) }
      : target,
  );
}

function routeName(route: RouteRecord): string {
  return typeof route === 'string' ? route : route.node;
}

/** Rejects when `signal` aborts, so an attempt can end even if the node itself never returns. */
function rejectWhenAborted(signal: AbortSignal, error: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(error());
      return;
    }
    signal.addEventListener('abort', () => reject(error()), { once: true });
  });
}

/** A mistake in the graph itself will fail the same way every time, so retrying only wastes time. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof GraphValidationError);
}

export type { GraphProgress, GraphStatus };
