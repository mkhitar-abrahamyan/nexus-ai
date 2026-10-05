import type { GraphStreamProjection } from '../types/graph.js';
import type { AssistantRunContext, ServerAssistant } from '../types/server.js';

/**
 * The part of a compiled graph the adapter uses.
 *
 * Structural, so the server entry point never imports the graph runtime: an application that serves
 * plain functions does not load it, and one that serves graphs already has it.
 */
export interface GraphLike {
  /** Runs an input, yielding one event per superstep. */
  stream(
    input: unknown,
    options: {
      threadId?: string;
      signal?: AbortSignal;
      metadata?: Record<string, unknown>;
      tenantId?: string;
      control?: DrainSwitch;
    },
  ): AsyncIterable<unknown>;
  /** Answers an interrupt and continues the thread. */
  resume(
    threadId: string,
    value: unknown,
    options: { signal?: AbortSignal; metadata?: Record<string, unknown>; tenantId?: string; control?: DrainSwitch },
  ): AsyncIterable<unknown>;
  /** The thread's checkpoint, at its latest step or at one given. */
  state(
    threadId: string,
    step?: number,
  ): Promise<{ step?: number; state?: unknown; status?: string; metadata?: Record<string, unknown> } | undefined>;
  /** Runs a thread on from its latest checkpoint, which is how a recovered run resumes at its last step. */
  continue?(
    threadId: string,
    options: { signal?: AbortSignal; metadata?: Record<string, unknown>; tenantId?: string; control?: DrainSwitch },
  ): AsyncIterable<unknown>;
  /** Writes values into a thread's state, which is how a rollback is applied. */
  updateState?(threadId: string, values: Record<string, unknown>, options?: { asNode?: string }): Promise<unknown>;
  /** Runs an input as a stream of typed events. Used when the assistant serves `events`. */
  events?(input: unknown, options: GraphEventOptionsLike): GraphEventsLike;
  /** Like `events()`, answering an interrupt. */
  resumeEvents?(threadId: string, value: unknown, options: GraphEventOptionsLike): GraphEventsLike;
  /** Like `events()`, continuing a thread from its latest checkpoint. */
  continueEvents?(threadId: string, options: GraphEventOptionsLike): GraphEventsLike;
}

/** The options of a graph's `events()` the adapter passes. */
type GraphEventOptionsLike = {
  threadId?: string;
  tenantId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  control?: DrainSwitch;
  include?: GraphStreamProjection[];
};

/** A graph's event stream, as the adapter reads it: the events, then the run's result. */
type GraphEventsLike = AsyncIterable<unknown> & {
  result: Promise<{ status: string; state: unknown; interrupt?: unknown; interrupts?: unknown[] }>;
};

/** Asks a graph to stop after its current superstep. A graph's `RunControl` has this shape. */
type DrainSwitch = { readonly draining: boolean; readonly reason?: string };

/** Options for `graphAssistant()`. */
export interface GraphAssistantOptions {
  /** What the assistant is, reported by the assistants endpoint. */
  description?: string;
  /** Metadata recorded on every checkpoint the server's runs create. */
  metadata?: Record<string, unknown>;
  /**
   * Records these projections of the graph's event stream on each run, such as `messages` and
   * `tools`, so a client following the run sees model output and tool calls as they happen. The
   * run's last event still carries its state and any question, as without it. Defaults to none: one
   * event per superstep.
   */
  events?: GraphStreamProjection[];
}

/**
 * Serves a compiled graph as an assistant.
 *
 * Threads map to graph threads, so state, interrupts, history, and checkpoints are the graph's own;
 * the server adds only the record of which run owns a thread. A graph compiled without a
 * checkpointer still works for stateless runs, but cannot resume or roll back.
 *
 * A workflow from `nexus-ai-pro/graph/functional` is served the same way. When a worker recovers a
 * run, the assistant continues from the last checkpoint that run wrote, so only the step in flight
 * runs again.
 */
export function graphAssistant(graph: GraphLike, options: GraphAssistantOptions = {}): ServerAssistant {
  const projections = options.events?.length ? options.events : undefined;
  const eventOptions = (context: AssistantRunContext, threadId?: string): GraphEventOptionsLike => ({
    ...(threadId ? { threadId } : {}),
    signal: context.signal,
    metadata: { ...options.metadata, runId: context.runId },
    ...tenantOf(context),
    ...(context.control ? { control: context.control } : {}),
    include: [...(projections ?? []), 'values'],
  });
  return {
    description: options.description,
    stream(input: unknown, context: AssistantRunContext) {
      if (projections && graph.events) {
        return withResult(graph.events(input ?? {}, eventOptions(context, context.threadId)));
      }
      return graph.stream(input ?? {}, {
        threadId: context.threadId,
        signal: context.signal,
        metadata: { ...options.metadata, runId: context.runId },
        ...tenantOf(context),
        ...(context.control ? { control: context.control } : {}),
      });
    },
    resume(threadId: string, value: unknown, context: AssistantRunContext) {
      if (projections && graph.resumeEvents) {
        return withResult(graph.resumeEvents(threadId, value, eventOptions(context)));
      }
      return graph.resume(threadId, value, {
        signal: context.signal,
        metadata: { ...options.metadata, runId: context.runId },
        ...tenantOf(context),
        ...(context.control ? { control: context.control } : {}),
      });
    },
    async state(threadId: string) {
      return (await graph.state(threadId))?.state;
    },
    async step(threadId: string) {
      return (await graph.state(threadId))?.step;
    },
    async recover(threadId: string, context: AssistantRunContext) {
      if (!graph.continue) return undefined;
      const checkpoint = await graph.state(threadId);
      // Only a checkpoint this run wrote, and one it had not finished with, is a place to continue
      // from; anything else belongs to an earlier run, and the server starts this one again.
      if (checkpoint?.metadata?.runId !== context.runId) return undefined;
      if (checkpoint.status !== 'running' && checkpoint.status !== 'failed' && checkpoint.status !== 'interrupted') {
        return undefined;
      }
      if (projections && graph.continueEvents) return withResult(graph.continueEvents(threadId, eventOptions(context)));
      return graph.continue(threadId, {
        signal: context.signal,
        metadata: { ...options.metadata, runId: context.runId },
        ...tenantOf(context),
        ...(context.control ? { control: context.control } : {}),
      });
    },
    async restore(threadId: string, step: number) {
      if (!graph.updateState) return;
      const checkpoint = await graph.state(threadId, step);
      if (!checkpoint?.state) return;
      // Writing the earlier state forward is the rollback: the history stays, and the thread
      // continues from where it was before the run that is being undone.
      await graph.updateState(threadId, checkpoint.state as Record<string, unknown>);
    },
  };
}

/**
 * Serves a plain function as an assistant, for work that is not a graph.
 *
 * The function may return a value or yield events; the last value it yields is the run's output.
 */
export function functionAssistant(
  run: (input: unknown, context: AssistantRunContext) => AsyncIterable<unknown> | Promise<unknown> | unknown,
  options: { description?: string } = {},
): ServerAssistant {
  return {
    description: options.description,
    async *stream(input: unknown, context: AssistantRunContext) {
      const result = run(input, context);
      if (result !== null && typeof result === 'object' && Symbol.asyncIterator in (result as object)) {
        yield* result as AsyncIterable<unknown>;
        return;
      }
      yield { type: 'done', status: 'succeeded', state: await result };
    },
  };
}

/** The run's tenant, as the graph takes it, so a graph's checkpoints and store are the tenant's own. */
function tenantOf(context: AssistantRunContext): { tenantId?: string } {
  const tenantId = context.principal?.tenantId;
  return tenantId ? { tenantId } : {};
}

/**
 * The stream's events, then one event with the run's result, shaped as a graph's last step event is:
 * its status, its state, and any question. That last event is what the server reads a run's output
 * and interrupt from.
 */
async function* withResult(events: GraphEventsLike): AsyncIterable<unknown> {
  for await (const event of events) yield event;
  const result = await events.result;
  yield {
    type: result.status === 'awaiting_input' ? 'interrupt' : 'done',
    status: result.status,
    state: result.state,
    ...(result.interrupt === undefined ? {} : { interrupt: result.interrupt }),
    ...(result.interrupts === undefined ? {} : { interrupts: result.interrupts }),
  };
}
