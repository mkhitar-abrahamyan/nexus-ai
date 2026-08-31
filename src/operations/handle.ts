import type {
  OperationErrorDescriptor,
  OperationEvent,
  OperationHandle,
  OperationProgress,
  OperationStatus,
} from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import { OperationCancelledError } from './errors.js';

export interface LocalOperationHandleOptions {
  now?: () => Date;
  /**
   * Builds the error `result()` rejects with on cancellation.
   *
   * Injected so a family can keep its own error type — the image family rejects with
   * `ImageOperationCancelledError` — without this module depending on any family.
   */
  cancellationError?: (id: string, reason?: string) => unknown;
  /** Called on every emitted event, for persistence, metrics, or webhooks. */
  onEvent?: (event: OperationEvent<unknown>) => void;
}

/**
 * A process-local operation handle: status, awaitable result, cancellation, and an event stream.
 *
 * This was the image family's private handle and is now shared, so every long-running family
 * reports the same lifecycle. It stays deliberately process-bound; durability is layered on top by
 * `OperationRunner` rather than folded in here, so a caller that does not need a store pays nothing
 * for one.
 */
export class LocalOperationHandle<TResult> implements OperationHandle<TResult> {
  private readonly controller = new AbortController();
  private readonly history: Array<OperationEvent<TResult>> = [];
  private readonly waiters = new Set<() => void>();
  private readonly resultPromise: Promise<TResult>;
  private readonly now: () => Date;
  private resolveResult!: (result: TResult) => void;
  private rejectResult!: (error: unknown) => void;
  private currentStatus: OperationStatus = 'queued';
  private currentProgress?: OperationProgress;
  private currentAttempt = 1;
  private sequence = 0;

  constructor(
    readonly id: string,
    private readonly options: LocalOperationHandleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.resultPromise = new Promise<TResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Consumers may choose events() without calling result(); keep that valid without hiding rejection from result().
    void this.resultPromise.catch(() => undefined);
    this.emit({ ...this.eventBase(), type: 'queued', status: 'queued' });
  }

  status(): OperationStatus {
    return this.currentStatus;
  }

  progress(): OperationProgress | undefined {
    return this.currentProgress;
  }

  /** Attempt currently running, starting at 1. */
  attempt(): number {
    return this.currentAttempt;
  }

  /** The signal handed to the executor, aborted on cancellation. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  result(): Promise<TResult> {
    return this.resultPromise;
  }

  cancel(reason?: string): boolean {
    if (isTerminalOperationStatus(this.currentStatus) || this.currentStatus === 'cancelling') return false;

    this.currentStatus = 'cancelling';
    this.emit({ ...this.eventBase(), type: 'cancelling', status: 'cancelling', reason });
    this.controller.abort(reason);

    this.currentStatus = 'cancelled';
    this.emit({ ...this.eventBase(), type: 'cancelled', status: 'cancelled', reason });
    this.rejectResult(this.buildCancellationError(reason));
    return true;
  }

  events(): AsyncIterable<OperationEvent<TResult>> {
    return this.iterateEvents();
  }

  /**
   * Moves the handle to `running` without executing anything.
   *
   * Used by `OperationRunner`, which owns the executor call itself so it can wrap it in a lease and
   * a heartbeat. Without this the handle would sit in `queued` for the whole run, suppressing both
   * the `running` event and every progress report.
   */
  markRunning(attempt = this.currentAttempt): boolean {
    if (isTerminalOperationStatus(this.currentStatus) || this.currentStatus === 'cancelling') return false;
    this.currentAttempt = attempt;
    this.currentStatus = 'running';
    this.emit({ ...this.eventBase(), type: 'running', status: 'running', attempt });
    return true;
  }

  /** Publishes progress. Ignored once the operation has settled. */
  report(progress: OperationProgress): void {
    if (this.currentStatus !== 'running') return;
    this.currentProgress = progress;
    this.emit({ ...this.eventBase(), type: 'progress', status: 'running', progress });
  }

  /** Records that the next attempt is scheduled, without running it. */
  markRetrying(error: unknown, delayMs: number): void {
    if (isTerminalOperationStatus(this.currentStatus)) return;
    this.currentStatus = 'retrying';
    this.emit({
      ...this.eventBase(),
      type: 'retrying',
      status: 'retrying',
      attempt: this.currentAttempt,
      delayMs,
      error: describeOperationError(error),
    });
    this.currentAttempt += 1;
  }

  markExpired(error?: unknown): boolean {
    if (isTerminalOperationStatus(this.currentStatus)) return false;
    this.currentStatus = 'expired';
    this.emit({
      ...this.eventBase(),
      type: 'expired',
      status: 'expired',
      error: error === undefined ? undefined : describeOperationError(error),
    });
    this.rejectResult(error ?? new OperationCancelledError(this.id, 'expired'));
    return true;
  }

  /**
   * Runs `executor` and settles the handle with its outcome.
   *
   * Deferred to a microtask so a caller always receives the handle before any event fires, which
   * keeps `events()` from missing the first transition.
   */
  start(executor: (signal: AbortSignal) => Promise<TResult>): void {
    queueMicrotask(() => {
      void this.run(executor);
    });
  }

  /** Runs `executor` inline, for a caller that is already inside an async context. */
  async run(executor: (signal: AbortSignal) => Promise<TResult>): Promise<void> {
    if (isTerminalOperationStatus(this.currentStatus)) return;

    this.currentStatus = 'running';
    this.emit({ ...this.eventBase(), type: 'running', status: 'running', attempt: this.currentAttempt });

    try {
      const value = await executor(this.controller.signal);
      // A cancellation that landed while the executor was in flight wins: the handle has already
      // rejected, and emitting a success after a terminal event would break the event contract.
      if (isTerminalOperationStatus(this.currentStatus)) return;

      this.settleSuccess(value);
    } catch (error) {
      if (isTerminalOperationStatus(this.currentStatus)) return;
      this.settleFailure(error);
    }
  }

  settleSuccess(value: TResult): void {
    if (isTerminalOperationStatus(this.currentStatus)) return;
    this.currentStatus = 'succeeded';
    this.emit({ ...this.eventBase(), type: 'succeeded', status: 'succeeded', result: value });
    this.resolveResult(value);
  }

  settleFailure(error: unknown, deadLettered?: boolean): void {
    if (isTerminalOperationStatus(this.currentStatus)) return;
    this.currentStatus = 'failed';
    this.emit({
      ...this.eventBase(),
      type: 'failed',
      status: 'failed',
      error: describeOperationError(error),
      deadLettered: deadLettered || undefined,
    });
    this.rejectResult(error);
  }

  private buildCancellationError(reason?: string): unknown {
    return this.options.cancellationError
      ? this.options.cancellationError(this.id, reason)
      : new OperationCancelledError(this.id, reason);
  }

  private async *iterateEvents(): AsyncGenerator<OperationEvent<TResult>, void, void> {
    let index = 0;
    let waiter: (() => void) | undefined;

    try {
      while (true) {
        const event = this.history[index];
        if (event) {
          index += 1;
          yield event;
          if (isTerminalOperationStatus(event.status)) return;
          continue;
        }

        if (isTerminalOperationStatus(this.currentStatus)) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
          this.waiters.add(resolve);
        });
        if (waiter) this.waiters.delete(waiter);
        waiter = undefined;
      }
    } finally {
      if (waiter) this.waiters.delete(waiter);
    }
  }

  private eventBase(): { operationId: string; sequence: number; timestamp: string } {
    return {
      operationId: this.id,
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
    };
  }

  private emit(event: OperationEvent<TResult>): void {
    this.history.push(event);
    this.options.onEvent?.(event as OperationEvent<unknown>);
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}

export function describeOperationError(error: unknown): OperationErrorDescriptor {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      code: typeof code === 'string' ? code : undefined,
    };
  }
  return { name: 'Error', message: String(error) };
}
