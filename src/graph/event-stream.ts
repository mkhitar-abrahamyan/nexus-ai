import type {
  ChannelSchema,
  GraphEvent,
  GraphResult,
  GraphStepEvent,
  GraphStreamEvent,
  GraphStreamOverflow,
  GraphStreamProjection,
  GraphStreamStats,
} from '../types/graph.js';
import { GraphError } from './errors.js';

const DEFAULT_INCLUDE: GraphStreamProjection[] = ['values', 'updates', 'messages', 'tools', 'custom'];
const DEFAULT_MAX_BUFFERED = 1_000;

/** Raised by an event stream whose reader fell behind with `overflow: 'error'`. The run is stopped. */
export class GraphStreamOverflowError extends GraphError {
  constructor(
    /** The buffer that filled. */
    public readonly maxBuffered: number,
  ) {
    super(`A graph event reader fell more than ${maxBuffered} events behind`, 'GRAPH_STREAM_OVERFLOW');
    this.name = 'GraphStreamOverflowError';
  }
}

/** What starts the run behind a stream: given the event listener and a signal, the step events. */
export type GraphRunStarter<S extends ChannelSchema> = (
  onEvent: (event: GraphEvent) => void,
  signal: AbortSignal,
) => AsyncIterable<GraphStepEvent<S>>;

interface StreamSettings {
  include: GraphStreamProjection[];
  subgraphs: boolean;
  maxBuffered: number;
  overflow: GraphStreamOverflow;
}

/** One reader's bounded buffer. */
class Reader<S extends ChannelSchema> {
  readonly queue: Array<GraphStreamEvent<S>> = [];
  private waiting: ((result: IteratorResult<GraphStreamEvent<S>>) => void) | undefined;
  private failure: ((error: unknown) => void) | undefined;
  private drained: Array<() => void> = [];
  ended = false;
  error: unknown;
  closed = false;

  constructor(
    private readonly accepts: (event: GraphStreamEvent<S>) => boolean,
    private readonly settings: StreamSettings,
    private readonly stats: GraphStreamStats,
    private readonly onOverflow: (error: GraphStreamOverflowError) => void,
  ) {}

  push(event: GraphStreamEvent<S>): void {
    if (this.closed || !this.accepts(event)) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.failure = undefined;
      resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= this.settings.maxBuffered && !this.makeRoom(event)) return;
    this.queue.push(event);
    this.stats.peak = Math.max(this.stats.peak, this.queue.length);
  }

  /** Frees a slot for `event` under the overflow policy. Returns false when `event` is not kept. */
  private makeRoom(event: GraphStreamEvent<S>): boolean {
    switch (this.settings.overflow) {
      case 'drop-newest':
        this.stats.dropped += 1;
        return false;
      case 'drop-oldest':
        this.queue.shift();
        this.stats.dropped += 1;
        return true;
      case 'error':
        this.onOverflow(new GraphStreamOverflowError(this.settings.maxBuffered));
        return false;
      default: {
        if (this.coalesce(event)) {
          this.stats.coalesced += 1;
          return false;
        }
        this.queue.shift();
        this.stats.dropped += 1;
        return true;
      }
    }
  }

  /** Merges `event` into a queued event it continues. */
  private coalesce(event: GraphStreamEvent<S>): boolean {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index] as GraphStreamEvent<S>;
      if (event.type === 'messages' && queued.type === 'messages') {
        const sameMessage =
          queued.taskId === event.taskId &&
          (queued.chunk.kind ?? 'text') === (event.chunk.kind ?? 'text') &&
          queued.chunk.messageId === event.chunk.messageId &&
          queued.namespace.join('/') === event.namespace.join('/');
        if (!sameMessage) continue;
        this.queue[index] = {
          ...queued,
          chunk: { ...queued.chunk, content: queued.chunk.content + event.chunk.content },
        };
        return true;
      }
      // A newer snapshot of the state makes an older one unread news.
      if (
        event.type === 'values' &&
        queued.type === 'values' &&
        queued.namespace.join('/') === event.namespace.join('/')
      ) {
        this.queue[index] = event;
        return true;
      }
    }
    return false;
  }

  /** Resolves when this reader holds no more than half its buffer, or has stopped reading. */
  whenDrained(): Promise<void> {
    if (this.closed || this.queue.length <= this.settings.maxBuffered / 2) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  next(): Promise<IteratorResult<GraphStreamEvent<S>>> {
    const event = this.queue.shift();
    if (this.queue.length <= this.settings.maxBuffered / 2) this.releaseWaiters();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.ended || this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiting = resolve;
      this.failure = reject;
    });
  }

  end(error?: unknown): void {
    this.ended = true;
    if (error !== undefined) this.error = error;
    this.releaseWaiters();
    if (!this.waiting) return;
    const resolve = this.waiting;
    const reject = this.failure;
    this.waiting = undefined;
    this.failure = undefined;
    if (error !== undefined) reject?.(error);
    else resolve({ value: undefined, done: true });
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    this.end();
  }

  private releaseWaiters(): void {
    const waiters = this.drained;
    this.drained = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * A graph run as one stream of typed events, with each projection readable on its own.
 *
 * Iterate the stream for every included event, or take `messages()`, `tools()`, `values()`, or
 * `updates()` for one kind. Every reader gets its own bounded buffer. The run starts when the first
 * reader asks for an event, so create every reader before reading any. It stops when every reader
 * has stopped.
 */
export class GraphEventStream<S extends ChannelSchema, O extends keyof S = keyof S>
  implements AsyncIterable<GraphStreamEvent<S>>
{
  private readonly readers: Array<Reader<S>> = [];
  private readonly controller = new AbortController();
  private started = false;
  private readonly stats: GraphStreamStats = { peak: 0, coalesced: 0, dropped: 0 };
  private resolveResult!: (result: GraphResult<S, O>) => void;
  private rejectResult!: (error: unknown) => void;
  /** Resolves with the run's result once it ends, or rejects with its error. */
  readonly result: Promise<GraphResult<S, O>>;

  constructor(
    private readonly start: GraphRunStarter<S>,
    private readonly toResult: (last: GraphStepEvent<S> | undefined) => GraphResult<S, O>,
    private readonly settings: StreamSettings,
  ) {
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // A caller who reads only the events must not see an unhandled rejection from the result.
    this.result.catch(() => undefined);
  }

  /** Every included event. */
  [Symbol.asyncIterator](): AsyncIterator<GraphStreamEvent<S>> {
    return this.reader(() => true);
  }

  /** Model output, as nodes stream it. */
  messages(): AsyncIterable<Extract<GraphStreamEvent<S>, { type: 'messages' }>> {
    return this.only('messages');
  }

  /** Tool calls: each starting, progressing, and returning or failing. */
  tools(): AsyncIterable<Extract<GraphStreamEvent<S>, { type: 'tools' }>> {
    return this.only('tools');
  }

  /** The state after each superstep. */
  values(): AsyncIterable<Extract<GraphStreamEvent<S>, { type: 'values' }>> {
    return this.only('values');
  }

  /** Each task's write. */
  updates(): AsyncIterable<Extract<GraphStreamEvent<S>, { type: 'updates' }>> {
    return this.only('updates');
  }

  /** How the stream kept up with its slowest reader so far. */
  streamStats(): GraphStreamStats {
    return { ...this.stats };
  }

  /** A reader for one projection, registered now so it sees the run from its first event. */
  private only<T extends GraphStreamEvent<S>['type']>(
    type: T,
  ): AsyncIterable<Extract<GraphStreamEvent<S>, { type: T }>> {
    const iterator = this.reader((event) => event.type === type) as AsyncIterator<
      Extract<GraphStreamEvent<S>, { type: T }>
    >;
    return { [Symbol.asyncIterator]: () => iterator };
  }

  private reader(accepts: (event: GraphStreamEvent<S>) => boolean): AsyncIterator<GraphStreamEvent<S>> {
    const reader = new Reader<S>(accepts, this.settings, this.stats, (error) => this.fail(error));
    if (this.started) reader.end();
    else this.readers.push(reader);
    return {
      next: () => {
        this.begin();
        return reader.next();
      },
      return: async () => {
        reader.close();
        // A run nobody reads any more has nobody to deliver to.
        if (this.readers.every((item) => item.closed)) this.controller.abort(new Error('Every reader stopped'));
        return { value: undefined, done: true };
      },
    };
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private publish(event: GraphStreamEvent<S>): void {
    if (event.namespace.length > 0 && !this.settings.subgraphs) return;
    const projection: GraphStreamProjection = event.type;
    if (!this.settings.include.includes(projection)) return;
    for (const reader of this.readers) reader.push(event);
  }

  private fail(error: unknown): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(error);
    for (const reader of this.readers) reader.end(error);
    this.rejectResult(error);
  }

  private async pump(): Promise<void> {
    let last: GraphStepEvent<S> | undefined;
    try {
      for await (const step of this.start((event) => {
        for (const item of fromGraphEvent<S>(event)) this.publish(item);
      }, this.controller.signal)) {
        last = step;
        this.publish({ type: 'values', step: step.step, status: step.status, state: step.state, namespace: [] });
        // Between supersteps the run waits for its slowest reader, so falling behind slows the graph
        // instead of growing a buffer.
        await Promise.all(this.readers.map((reader) => reader.whenDrained()));
      }
      for (const reader of this.readers) reader.end();
      this.resolveResult(this.toResult(last));
    } catch (error) {
      const reason = this.controller.signal.reason;
      this.fail(reason instanceof GraphStreamOverflowError ? reason : error);
    }
  }
}

/** Builds a stream's settings from its options. */
export function streamSettings(options: {
  include?: GraphStreamProjection[];
  subgraphs?: boolean;
  maxBuffered?: number;
  overflow?: GraphStreamOverflow;
}): StreamSettings {
  return {
    include: options.include ?? DEFAULT_INCLUDE,
    subgraphs: options.subgraphs ?? false,
    maxBuffered: Math.max(2, options.maxBuffered ?? DEFAULT_MAX_BUFFERED),
    overflow: options.overflow ?? 'coalesce',
  };
}

/** A runtime event in the stream's shape: one event, or two for a task that ended with a write. */
function fromGraphEvent<S extends ChannelSchema>(event: GraphEvent): Array<GraphStreamEvent<S>> {
  const namespace = event.namespace ?? [];
  switch (event.type) {
    case 'message':
      return [
        { type: 'messages', step: event.step, node: event.node, taskId: event.taskId, chunk: event.chunk, namespace },
      ];
    case 'tool':
      return [{ type: 'tools', step: event.step, node: event.node, taskId: event.taskId, tool: event.tool, namespace }];
    case 'custom':
      return [
        { type: 'custom', step: event.step, node: event.node, taskId: event.taskId, data: event.data, namespace },
      ];
    case 'checkpoint':
      return [{ type: 'checkpoints', step: event.step, status: event.status, next: event.next, namespace }];
    case 'task_end':
      // A task's end is a task event, and its write is an update.
      return [
        { type: 'tasks', event, namespace },
        ...(event.update === undefined
          ? []
          : [
              {
                type: 'updates' as const,
                step: event.step,
                node: event.node,
                taskId: event.taskId,
                update: event.update,
                namespace,
              },
            ]),
      ];
    default:
      return [{ type: 'tasks', event, namespace }];
  }
}
