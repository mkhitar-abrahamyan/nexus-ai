import type { GraphEvent, GraphResult } from '../types/graph.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { RunHandle, Tracer } from './tracer.js';

export interface GraphTracingOptions {
  name?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  inputs?: unknown;
  /** `graph` by default; an agent run is worth labelling as one. */
  kind?: 'graph' | 'agent';
}

export interface GraphTracing {
  /** Spread into a run's options: `graph.invoke(input, { threadId, ...tracing.runOptions })`. */
  runOptions: { onEvent: (event: GraphEvent) => void };
  /** The run every task hangs from. */
  root: RunHandle;
  /** The active run for a node, so a model call inside it nests where it belongs. */
  runFor(node: string): RunHandle | undefined;
  finish(result?: GraphResult<never> | { status?: string; state?: unknown }): Promise<void>;
}

/**
 * Records a graph or agent run as a trace.
 *
 * The graph already reports every task starting, retrying, and finishing; tracing is that stream
 * written down as a tree. Nothing inside the graph knows about tracing, and a run without it pays
 * nothing.
 */
export function traceGraph(tracer: Tracer, options: GraphTracingOptions = {}): GraphTracing {
  const root = tracer.startRun({
    name: options.name ?? 'graph',
    kind: options.kind ?? 'graph',
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });

  const active = new Map<string, RunHandle>();
  const retries = new Map<string, number>();
  const emitted = new Map<string, unknown[]>();

  const onEvent = (event: GraphEvent): void => {
    switch (event.type) {
      case 'task_start': {
        if (active.has(event.taskId)) return;
        active.set(
          event.taskId,
          root.child({
            name: event.node,
            kind: 'node',
            metadata: { step: event.step, taskId: event.taskId },
          }),
        );
        return;
      }
      case 'task_retry': {
        retries.set(event.taskId, event.attempt);
        return;
      }
      case 'custom': {
        emitted.set(event.taskId, [...(emitted.get(event.taskId) ?? []), event.data]);
        return;
      }
      case 'task_end': {
        const handle = active.get(event.taskId);
        if (!handle) return;
        active.delete(event.taskId);
        void handle.finish({
          outputs: event.update,
          metadata: {
            ...(retries.get(event.taskId) ? { attempts: retries.get(event.taskId) } : {}),
            ...(event.goto ? { goto: event.goto } : {}),
            ...(emitted.get(event.taskId) ? { emitted: emitted.get(event.taskId) } : {}),
          },
        });
        return;
      }
      default:
        return;
    }
  };

  return {
    runOptions: { onEvent },
    root,
    runFor: (node) => [...active.values()].find((handle) => handle.id && nameOf(active, handle) === node),
    async finish(result) {
      // A task still open means the run stopped mid-step: a pause, an abort, or a failure.
      for (const [taskId, handle] of active) {
        active.delete(taskId);
        await handle.finish({ metadata: { unfinished: true } });
      }
      const status = (result as { status?: string } | undefined)?.status;
      await root.finish({
        outputs: result === undefined ? undefined : (result as { state?: unknown }).state,
        ...(status && status !== 'completed' ? { metadata: { status } } : {}),
        ...(status === 'failed' ? { error: new Error('The graph run failed') } : {}),
      });
    },
  };
}

// The map is keyed by task id; a node name is recovered from the run it started.
const names = new WeakMap<RunHandle, string>();
function nameOf(active: Map<string, RunHandle>, handle: RunHandle): string | undefined {
  if (names.has(handle)) return names.get(handle);
  for (const [taskId, item] of active) {
    if (item === handle) {
      // A plain node's task id is its name; a Send task's id starts with the node name.
      const name = taskId.includes('#') ? (taskId.split('#')[0] as string) : taskId;
      names.set(handle, name);
      return name;
    }
  }
  return undefined;
}

export interface ModelClientLike {
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/**
 * Wraps a model client so every call becomes a run, with its tokens and cost.
 *
 * `parent` decides where the call hangs: pass `() => tracing.runFor('model')` and a model call lands
 * inside the node that made it rather than beside it.
 */
export function traceModelClient<T extends ModelClientLike>(
  client: T,
  tracer: Tracer,
  options: { parent?: () => RunHandle | undefined; name?: string } = {},
): T {
  return {
    ...client,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      const parent = options.parent?.();
      const start = {
        name: options.name ?? 'model',
        kind: 'model' as const,
        inputs: request,
        ...(request.model ? { model: request.model } : {}),
      };
      const handle = parent ? parent.child(start) : tracer.startRun(start);

      try {
        const response = await client.complete(request);
        await handle.finish({
          outputs: { content: response.content, ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}) },
          ...(response.meta?.usage
            ? {
                usage: {
                  inputTokens: response.meta.usage.inputTokens,
                  outputTokens: response.meta.usage.outputTokens,
                  totalTokens: response.meta.usage.totalTokens,
                },
              }
            : {}),
          ...(response.meta?.cost?.amount === undefined ? {} : { cost: response.meta.cost.amount }),
          metadata: {
            provider: response.meta?.providerUsed,
            model: response.meta?.modelUsed,
            finishReason: response.finishReason,
          },
        });
        return response;
      } catch (error) {
        await handle.finish({ error });
        throw error;
      }
    },
  } as T;
}
