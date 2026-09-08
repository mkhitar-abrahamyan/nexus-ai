import { randomBytes } from 'node:crypto';
import type {
  ChannelSchema,
  CompileOptions,
  EdgeRouter,
  GraphCheckpoint,
  GraphProgress,
  GraphResult,
  GraphRunOptions,
  GraphStatus,
  GraphStepEvent,
  NodeContext,
  NodeFn,
  PendingInterrupt,
  StateOf,
  StateUpdate,
} from '../types/graph.js';
import { END, START } from '../types/graph.js';
import {
  GraphInterrupt,
  GraphNodeError,
  GraphNotInterruptedError,
  GraphStepLimitError,
  GraphThreadNotFoundError,
  GraphValidationError,
  interruptKey,
} from './errors.js';

const DEFAULT_MAX_STEPS = 25;

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
  private readonly nodes = new Map<string, NodeFn<S>>();
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

  addNode(name: string, fn: NodeFn<S>): this {
    const normalized = name.trim();
    if (!normalized) throw new GraphValidationError('A node name must not be empty');
    if (normalized === START || normalized === END) {
      throw new GraphValidationError(`"${normalized}" is reserved and cannot be used as a node name`);
    }
    if (this.nodes.has(normalized)) throw new GraphValidationError(`Node "${normalized}" is already defined`);
    if (typeof fn !== 'function') throw new GraphValidationError(`Node "${normalized}" must be a function`);

    this.nodes.set(normalized, fn);
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

  constructor(
    private readonly channels: S,
    private readonly nodes: Map<string, NodeFn<S>>,
    private readonly edges: Array<Edge<S>>,
    private readonly options: CompileOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Runs to completion, to an interrupt, or to the step limit. */
  async invoke(input: StateUpdate<S> = {}, runOptions: GraphRunOptions = {}): Promise<GraphResult<S>> {
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.stream(input, runOptions)) last = event;
    return this.toResult(runOptions.threadId ?? '', last);
  }

  /** Yields one event per superstep, so a caller can render progress as it happens. */
  stream(input: StateUpdate<S> = {}, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    const threadId = runOptions.threadId?.trim() || `thread-${randomBytes(6).toString('hex')}`;
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
        resolved: { ...checkpoint.resolved, [interruptKey(checkpoint.interrupt)]: value },
      };
    });
  }

  /** Like `resume`, but returns the final result rather than the stream. */
  async resumeWith(threadId: string, value: unknown, runOptions: GraphRunOptions = {}): Promise<GraphResult<S>> {
    let last: GraphStepEvent<S> | undefined;
    for await (const event of this.resume(threadId, value, runOptions)) last = event;
    return this.toResult(threadId, last);
  }

  /** Continues a thread that stopped for any other reason, such as the step limit. */
  continue(threadId: string, runOptions: GraphRunOptions = {}): AsyncIterable<GraphStepEvent<S>> {
    return this.run(threadId, runOptions, async () => {
      const checkpoint = await this.requireCheckpoint(threadId);
      return { ...checkpoint, status: 'running' };
    });
  }

  /** Rewinds to an earlier superstep and runs forward from there. */
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
   */
  asNode<P extends ChannelSchema>(): NodeFn<P> {
    return async (context) => {
      const seed: Record<string, unknown> = {};
      for (const key of Object.keys(this.channels)) {
        if (key in context.state) seed[key] = (context.state as Record<string, unknown>)[key];
      }

      const result = await this.invoke(seed as StateUpdate<S>, {
        threadId: `${context.threadId}:${context.node}`,
        signal: context.signal,
      });

      const update: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.state)) {
        if (key in context.state) update[key] = value;
      }
      return update as StateUpdate<P>;
    };
  }

  // ── Execution ────────────────────────────────────────────────────

  private async *run(
    threadId: string,
    runOptions: GraphRunOptions,
    seed: () => Promise<GraphCheckpoint<S>>,
  ): AsyncGenerator<GraphStepEvent<S>, void, void> {
    const maxSteps = runOptions.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let checkpoint = await seed();
    await this.save(checkpoint);

    while (checkpoint.next.length > 0) {
      if (runOptions.signal?.aborted) {
        checkpoint = { ...checkpoint, status: 'interrupted', createdAt: this.now().toISOString() };
        await this.save(checkpoint);
        yield this.toEvent(checkpoint, []);
        return;
      }
      if (checkpoint.step >= maxSteps) {
        throw new GraphStepLimitError(maxSteps, checkpoint.next);
      }

      const step = checkpoint.step + 1;
      const running = [...checkpoint.next];
      const updates: Array<StateUpdate<S>> = [];
      const finished: string[] = [];
      let pending: PendingInterrupt | undefined;

      for (const node of running) {
        const fn = this.nodes.get(node);
        if (!fn) throw new GraphValidationError(`Node "${node}" disappeared before it could run`);

        try {
          const update = await this.runNode(fn, node, step, threadId, checkpoint, runOptions);
          if (update) updates.push(update);
          finished.push(node);
        } catch (error) {
          if (error instanceof GraphInterrupt) {
            // Checkpoint what the other branches produced before suspending, so their work is not
            // repeated when a human answers.
            pending = {
              ...error.request,
              node: error.node,
              step: error.step,
              index: error.index,
              requestedAt: this.now().toISOString(),
            };
            break;
          }
          const failed: GraphCheckpoint<S> = {
            ...checkpoint,
            status: 'failed',
            error: { name: error instanceof Error ? error.name : 'Error', message: describe(error) },
            createdAt: this.now().toISOString(),
          };
          await this.save(failed);
          throw error instanceof GraphNodeError ? error : new GraphNodeError(node, step, error);
        }
      }

      const state = this.reduce(checkpoint.state, updates);

      if (pending) {
        // Only the nodes that did not finish are carried forward. A sibling branch that already
        // completed had its writes reduced into the state above, so resuming must not run it again
        // and duplicate whatever side effect it had.
        checkpoint = {
          ...checkpoint,
          state,
          next: running.filter((node) => !finished.includes(node)),
          status: 'awaiting_input',
          interrupt: pending,
          createdAt: this.now().toISOString(),
        };
        await this.save(checkpoint);
        yield this.toEvent(checkpoint, running);
        return;
      }

      const next = await this.nextNodes(running, state);
      checkpoint = {
        threadId,
        step,
        state,
        next,
        status: next.length > 0 ? 'running' : 'completed',
        resolved: checkpoint.resolved,
        createdAt: this.now().toISOString(),
        ...(runOptions.metadata ? { metadata: runOptions.metadata } : {}),
      };
      await this.save(checkpoint);
      yield this.toEvent(checkpoint, running);
    }
  }

  private async runNode(
    fn: NodeFn<S>,
    node: string,
    step: number,
    threadId: string,
    checkpoint: GraphCheckpoint<S>,
    runOptions: GraphRunOptions,
  ): Promise<StateUpdate<S> | undefined> {
    let interruptIndex = 0;
    const context: NodeContext<S> = {
      state: Object.freeze({ ...checkpoint.state }),
      node,
      step,
      threadId,
      signal: runOptions.signal ?? new AbortController().signal,
      interrupt: <T>(request: Parameters<NodeContext<S>['interrupt']>[0]): T => {
        const index = interruptIndex++;
        const key = interruptKey({ node, step, index });
        if (checkpoint.resolved && key in checkpoint.resolved) {
          return checkpoint.resolved[key] as T;
        }
        if (!this.checkpointer()) {
          throw new GraphValidationError(
            `Node "${node}" called interrupt(), but the graph was compiled without a checkpointer, so there would be nothing to resume from.`,
          );
        }
        throw new GraphInterrupt(request, node, step, index);
      },
      report: (progress) => this.options.checkpointer && void progress,
    };

    const result = await fn(context);
    return (result ?? undefined) as StateUpdate<S> | undefined;
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

  private async nextNodes(ran: string[], state: StateOf<S>): Promise<string[]> {
    const next: string[] = [];
    for (const node of ran) {
      for (const edge of this.edges) {
        if (edge.from !== node) continue;

        if (edge.router) {
          const decided = await edge.router(Object.freeze({ ...state }));
          for (const target of Array.isArray(decided) ? decided : [decided]) {
            const resolved = edge.mapping?.[target] ?? target;
            if (resolved !== END && !this.nodes.has(resolved)) {
              throw new GraphValidationError(`Router on "${node}" returned unknown target "${target}"`);
            }
            if (resolved !== END && !next.includes(resolved)) next.push(resolved);
          }
          continue;
        }
        if (edge.to && edge.to !== END && !next.includes(edge.to)) next.push(edge.to);
      }
    }
    return next;
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
    await this.checkpointer()?.put(checkpoint as GraphCheckpoint);
  }

  private checkpointer() {
    return this.options.checkpointer;
  }

  private toEvent(checkpoint: GraphCheckpoint<S>, nodes: string[]): GraphStepEvent<S> {
    return {
      type: checkpoint.status === 'awaiting_input' ? 'interrupt' : checkpoint.next.length ? 'step' : 'done',
      step: checkpoint.step,
      nodes,
      state: checkpoint.state,
      status: checkpoint.status,
      ...(checkpoint.interrupt ? { interrupt: checkpoint.interrupt } : {}),
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
    };
  }
}

/** Starts a graph definition. */
export function createGraph<S extends ChannelSchema>(config: { channels: S }): StateGraph<S> {
  return new StateGraph(config.channels);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { GraphProgress, GraphStatus };
