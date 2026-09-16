import type { InterruptRequest, PendingInterrupt } from '../types/graph.js';

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export class GraphValidationError extends GraphError {
  constructor(message: string, cause?: unknown) {
    super(message, 'GRAPH_VALIDATION_ERROR', cause);
    this.name = 'GraphValidationError';
  }
}

/**
 * Thrown by `context.interrupt()` to suspend the graph.
 *
 * Control flow, not a failure: the runtime catches it, checkpoints, and reports `awaiting_input`.
 * It escapes to the caller only when a node interrupts on a graph compiled without a checkpointer,
 * where there would be nothing to resume from.
 */
export class GraphInterrupt extends GraphError {
  constructor(
    public readonly request: InterruptRequest,
    public readonly node: string,
    public readonly step: number,
    public readonly index: number,
    /** Task that asked. Equal to `node` unless the task came from a `Send`. */
    public readonly taskId: string = node,
  ) {
    super(`Graph interrupted at "${node}": ${request.reason}`, 'GRAPH_INTERRUPT');
    this.name = 'GraphInterrupt';
  }
}

/**
 * Raised when a run exceeds its superstep budget.
 *
 * Cycles are a supported shape, so this is the only thing standing between a mistaken router and an
 * infinite loop. The message names what was still pending.
 */
export class GraphStepLimitError extends GraphError {
  constructor(
    public readonly maxSteps: number,
    public readonly pending: readonly string[],
  ) {
    super(
      `Graph exceeded ${maxSteps} supersteps without reaching END. Pending: ${pending.join(', ') || 'none'}. Raise maxSteps, or check that a conditional edge eventually routes to END.`,
      'GRAPH_STEP_LIMIT',
    );
    this.name = 'GraphStepLimitError';
  }
}

export class GraphNodeError extends GraphError {
  constructor(
    public readonly node: string,
    public readonly step: number,
    cause: unknown,
  ) {
    super(
      `Graph node "${node}" failed at step ${step}: ${cause instanceof Error ? cause.message : String(cause)}`,
      'GRAPH_NODE_ERROR',
      cause,
    );
    this.name = 'GraphNodeError';
  }
}

export class GraphThreadNotFoundError extends GraphError {
  constructor(public readonly threadId: string) {
    super(
      `No checkpoint for thread "${threadId}". A thread is resumable only when the graph was compiled with a checkpointer and run with an explicit threadId.`,
      'GRAPH_THREAD_NOT_FOUND',
    );
    this.name = 'GraphThreadNotFoundError';
  }
}

export class GraphNotInterruptedError extends GraphError {
  constructor(
    public readonly threadId: string,
    public readonly status: string,
  ) {
    super(
      `Thread "${threadId}" is ${status}, not awaiting input, so there is nothing to resume with`,
      'GRAPH_NOT_INTERRUPTED',
    );
    this.name = 'GraphNotInterruptedError';
  }
}

/**
 * Raised when a node outlives its `timeoutMs`.
 *
 * Separate from an ordinary failure because it is usually worth retrying, and because the node's
 * signal was aborted underneath it rather than the node choosing to stop.
 */
export class GraphNodeTimeoutError extends GraphError {
  constructor(
    public readonly node: string,
    public readonly timeoutMs: number,
  ) {
    super(`Graph node "${node}" exceeded its ${timeoutMs}ms timeout`, 'GRAPH_NODE_TIMEOUT');
    this.name = 'GraphNodeTimeoutError';
  }
}

/**
 * Stable key for one interrupt, so a replayed node picks up the answer it was given.
 *
 * Keyed by task rather than node, so several `Send` tasks of one node each keep their own answer.
 * For a node reached through an ordinary edge the task id is the node name, so keys written by
 * earlier releases still resolve.
 */
export function interruptKey(pending: Pick<PendingInterrupt, 'node' | 'step' | 'index'> & { taskId?: string }): string {
  return `${pending.taskId ?? pending.node}:${pending.step}:${pending.index}`;
}
