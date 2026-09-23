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
    options: { threadId?: string; signal?: AbortSignal; metadata?: Record<string, unknown> },
  ): AsyncIterable<unknown>;
  /** Answers an interrupt and continues the thread. */
  resume(
    threadId: string,
    value: unknown,
    options: { signal?: AbortSignal; metadata?: Record<string, unknown> },
  ): AsyncIterable<unknown>;
  /** The thread's checkpoint, at its latest step or at one given. */
  state(threadId: string, step?: number): Promise<{ step?: number; state?: unknown } | undefined>;
  /** Writes values into a thread's state, which is how a rollback is applied. */
  updateState?(threadId: string, values: Record<string, unknown>, options?: { asNode?: string }): Promise<unknown>;
}

/** Options for `graphAssistant()`. */
export interface GraphAssistantOptions {
  /** What the assistant is, reported by the assistants endpoint. */
  description?: string;
  /** Metadata recorded on every checkpoint the server's runs create. */
  metadata?: Record<string, unknown>;
}

/**
 * Serves a compiled graph as an assistant.
 *
 * Threads map to graph threads, so state, interrupts, history, and checkpoints are the graph's own;
 * the server adds only the record of which run owns a thread. A graph compiled without a
 * checkpointer still works for stateless runs, but cannot resume or roll back.
 */
export function graphAssistant(graph: GraphLike, options: GraphAssistantOptions = {}): ServerAssistant {
  return {
    description: options.description,
    stream(input: unknown, context: AssistantRunContext) {
      return graph.stream(input ?? {}, {
        threadId: context.threadId,
        signal: context.signal,
        metadata: { ...options.metadata, runId: context.runId },
      });
    },
    resume(threadId: string, value: unknown, context: AssistantRunContext) {
      return graph.resume(threadId, value, {
        signal: context.signal,
        metadata: { ...options.metadata, runId: context.runId },
      });
    },
    async state(threadId: string) {
      return (await graph.state(threadId))?.state;
    },
    async step(threadId: string) {
      return (await graph.state(threadId))?.step;
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
