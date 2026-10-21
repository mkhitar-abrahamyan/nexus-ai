import type { GraphEvent, GraphResult } from '../types/graph.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { RunAttributeValue } from '../types/tracing.js';
import type { RunEventInput, RunHandle, Tracer } from './tracer.js';

/** Progress reports a tool run keeps: the latest, when a long tool reports often. */
const MAX_PROGRESS = 50;

/** Options for `traceGraph()`. */
export interface GraphTracingOptions {
  /** Name of the root run. Defaults to `graph`. */
  name?: string;
  /** Labels for filtering. */
  tags?: string[];
  /** Metadata added to the root run. */
  metadata?: Record<string, unknown>;
  /** Inputs recorded on the root run. */
  inputs?: unknown;
  /** `graph` by default; an agent run is worth labelling as one. */
  kind?: 'graph' | 'agent';
}

/** Tracing for one graph run: a root run with one child per task. */
export interface GraphTracing {
  /** Spread into a run's options: `graph.invoke(input, { threadId, ...tracing.runOptions })`. */
  runOptions: { onEvent: (event: GraphEvent) => void };
  /** The run every task hangs from. */
  root: RunHandle;
  /** The active run for a node, so a model call inside it nests where it belongs. */
  runFor(node: string): RunHandle | undefined;
  /** Finishes the root run, recording the result's status and state. */
  finish(result?: GraphResult<never> | { status?: string; state?: unknown }): Promise<void>;
}

/**
 * Records a graph or agent run as a trace.
 *
 * The graph already reports every task starting, retrying, and finishing; tracing is that stream
 * written down as a tree. A retry is an event on its task's run, and a tool's progress an event on
 * the tool's. A task that follows a step of several tasks, such as the join after a fan-out, links to
 * each of them. Nothing inside the graph knows about tracing, and a run without it pays nothing.
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
  const tools = new Map<string, RunHandle>();
  /** Progress each tool call reported, kept with its run when it finishes. */
  const progress = new Map<string, Array<{ at: string; progress: unknown }>>();
  /** Each step's task runs, by namespace and step, for the step after to link back to. */
  const steps = new Map<string, RunHandle[]>();

  const onEvent = (event: GraphEvent): void => {
    switch (event.type) {
      case 'task_start': {
        if (active.has(event.taskId)) return;
        const scope = (event.namespace ?? []).join('/');
        // A task after a step that ran several came from each of them: a join after a fan-out.
        const before = steps.get(`${scope}:${event.step - 1}`) ?? [];
        const handle = root.child({
          name: event.node,
          kind: 'node',
          metadata: { step: event.step, taskId: event.taskId },
          ...(before.length > 1 ? { links: before.map((run) => run.link({ 'nexus.link': 'previous_step' })) } : {}),
        });
        active.set(event.taskId, handle);
        const key = `${scope}:${event.step}`;
        steps.set(key, [...(steps.get(key) ?? []), handle]);
        steps.delete(`${scope}:${event.step - 2}`);
        return;
      }
      case 'task_retry': {
        retries.set(event.taskId, event.attempt);
        active.get(event.taskId)?.event('retry', { 'nexus.attempt': event.attempt, 'error.message': event.error });
        return;
      }
      case 'tool': {
        // A tool call is a run of its own, inside the node that made it.
        const key = `${event.taskId}:${event.tool.id}`;
        if (event.tool.phase === 'start') {
          const parent = active.get(event.taskId) ?? root;
          tools.set(
            key,
            parent.child({
              name: event.tool.name,
              kind: 'tool',
              inputs: event.tool.args,
              metadata: { callId: event.tool.id },
            }),
          );
          return;
        }
        if (event.tool.phase === 'progress') {
          tools.get(key)?.event('progress', progressAttributes(event.tool.progress));
          // The latest reports are the ones worth keeping when a long tool reports often.
          const reports = [
            ...(progress.get(key) ?? []),
            { at: new Date().toISOString(), progress: event.tool.progress },
          ];
          progress.set(key, reports.slice(-MAX_PROGRESS));
          return;
        }
        const handle = tools.get(key);
        if (!handle) return;
        tools.delete(key);
        const reported = progress.get(key);
        progress.delete(key);
        const metadata = reported ? { metadata: { progress: reported } } : {};
        void handle.finish(
          event.tool.phase === 'error'
            ? { error: new Error(event.tool.error ?? 'The tool failed'), ...metadata }
            : { outputs: event.tool.result, ...metadata },
        );
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
      // A task or tool still open means the run stopped mid-step: a pause, an abort, or a failure.
      for (const [key, handle] of tools) {
        tools.delete(key);
        await handle.finish({ metadata: { unfinished: true } });
      }
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

/** Any client with a `complete()` method. */
export interface ModelClientLike {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/**
 * Wraps a model client so every call becomes a run, with its tokens and cost.
 *
 * `parent` decides where the call hangs: pass `() => tracing.runFor('model')` and a model call lands
 * inside the node that made it rather than beside it.
 *
 * What the response reports becomes the run's events: each attempt that failed before it, as `retry`
 * on the same provider or `failover` to another, at the time it failed; each guardrail applied, as
 * `guardrail`; the cache's answer, as `cache`; and each capability warning.
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
          ...(response.meta?.modelUsed ? { model: response.meta.modelUsed } : {}),
          ...(response.meta?.providerUsed ? { provider: response.meta.providerUsed } : {}),
          events: responseEvents(response),
          metadata: {
            provider: response.meta?.providerUsed,
            model: response.meta?.modelUsed,
            finishReason: response.finishReason,
            // A request rendered from a prompt carries its version, so a trace answers "which prompt ran".
            ...(request.metadata?.prompt === undefined ? {} : { prompt: request.metadata.prompt }),
            // And a request rendered from a context bundle names the bundle version, so a trace answers
            // "which context ran", and a query or an insight can narrow by it.
            ...(request.metadata?.context === undefined ? {} : { context: request.metadata.context }),
            // What the response cache did, and why: a hit, a miss, a stale entry, a bypass, or an error.
            ...(response.meta?.cache ? { cache: response.meta.cache } : {}),
            ...(request.tenantId ? { tenantId: request.tenantId } : {}),
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

/** Anything with a `retrieve()` method, such as every retriever in `nexus-ai-pro/rag`. */
export interface RetrieverLike {
  /** The documents that best answer a query, best first. Its options are recorded, all but a `signal`. */
  retrieve(query: string, options?: object): Promise<readonly unknown[]>;
}

/**
 * Wraps a retriever so every retrieval becomes a run of kind `retriever`, holding the query and the
 * documents that came back, so an evaluator reading the trace sees what an answer rested on. Every
 * other member of the retriever is its own.
 *
 * `parent` decides where the retrieval hangs; without it, under the run in scope.
 */
export function traceRetriever<T extends RetrieverLike>(
  retriever: T,
  tracer: Tracer,
  options: { parent?: () => RunHandle | undefined; name?: string } = {},
): T {
  const retrieve = async (query: string, retrieveOptions?: object): Promise<readonly unknown[]> => {
    const parent = options.parent?.();
    const { signal: _signal, ...asked } = (retrieveOptions ?? {}) as { signal?: AbortSignal };
    const start = {
      name: options.name ?? 'retrieve',
      kind: 'retriever' as const,
      inputs: { query, ...asked },
    };
    const handle = parent ? parent.child(start) : tracer.startRun(start);
    try {
      const documents = await retriever.retrieve(query, retrieveOptions);
      await handle.finish({ outputs: { documents }, metadata: { documents: documents.length } });
      return documents;
    } catch (error) {
      await handle.finish({ error });
      throw error;
    }
  };
  return new Proxy(retriever, {
    get(target, property) {
      if (property === 'retrieve') return retrieve;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A tool's progress report as an event's attributes: its number, total, and message, or the report as text. */
function progressAttributes(report: unknown): Record<string, RunAttributeValue> {
  if (typeof report === 'number') return { 'nexus.progress': report };
  if (typeof report === 'string') return { 'nexus.progress.message': report };
  if (report && typeof report === 'object') {
    const { progress, total, message } = report as { progress?: unknown; total?: unknown; message?: unknown };
    const attributes: Record<string, RunAttributeValue> = {};
    if (typeof progress === 'number') attributes['nexus.progress'] = progress;
    if (typeof total === 'number') attributes['nexus.progress.total'] = total;
    if (typeof message === 'string') attributes['nexus.progress.message'] = message;
    if (Object.keys(attributes).length) return attributes;
  }
  return { 'nexus.progress.message': JSON.stringify(report)?.slice(0, 1024) ?? String(report) };
}

/** What a response reports, as the events of its model run. */
function responseEvents(response: NexusResponse): RunEventInput[] {
  const meta = response.meta;
  if (!meta) return [];
  const events: RunEventInput[] = [];
  for (const attempt of meta.failedAttempts ?? []) {
    events.push({
      name: attempt.provider === meta.providerUsed ? 'retry' : 'failover',
      time: attempt.at,
      attributes: {
        'gen_ai.provider.name': attempt.provider,
        'gen_ai.request.model': attempt.model,
        'error.message': attempt.error,
        ...(attempt.category ? { 'error.type': attempt.category } : {}),
      },
    });
  }
  for (const name of meta.guardrailsApplied ?? [])
    events.push({ name: 'guardrail', attributes: { 'nexus.guardrail': name } });
  if (meta.cache) {
    events.push({
      name: 'cache',
      attributes: {
        'nexus.cache.outcome': meta.cache.outcome,
        ...(meta.cache.layer ? { 'nexus.cache.layer': meta.cache.layer } : {}),
        'nexus.cache.reason': meta.cache.reason,
      },
    });
  }
  for (const warning of meta.capabilityWarnings ?? []) {
    events.push({
      name: 'capability_warning',
      attributes: { 'nexus.capability.feature': warning.feature, 'nexus.capability.action': String(warning.action) },
    });
  }
  return events;
}
