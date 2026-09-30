import { randomBytes } from 'node:crypto';
import type {
  DurableOperationHandle,
  OperationContext,
  OperationEnqueueOptions,
  OperationEvent,
  OperationExecutor,
  OperationProgress,
  OperationRecord,
  OperationRetryConfig,
  OperationRunnerConfig,
  OperationStore,
  OperationStoreFilter,
  OperationSubmitOptions,
} from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import {
  OperationCancelledError,
  OperationDuplicateError,
  OperationExpiredError,
  OperationLeaseLostError,
  OperationNotFoundError,
  OperationReleasedError,
} from './errors.js';
import { LocalOperationHandle, describeOperationError } from './handle.js';
import { assertTransition, isClaimable } from './state-machine.js';
import { isUnheldQueued, matchesFilter } from './stats.js';
import { MemoryOperationStore } from './store.js';
import { deliverOperationWebhook } from './webhooks.js';

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Runs operations against a durable store.
 *
 * The runner owns the whole lifecycle: it persists a record before doing any work, claims a lease,
 * heartbeats while the executor runs, retries with backoff, dead-letters what never succeeds, and
 * emits signed webhooks. A crashed worker leaves a record whose lease simply lapses, which
 * `recover()` then picks up — that is the entire mechanism behind surviving a restart.
 *
 * With the default `MemoryOperationStore` this is a process-local runner with full lifecycle
 * semantics and no external dependency; swapping in `RedisOperationStore` makes it durable without
 * any other change.
 */
export class OperationRunner<TResult = unknown> {
  private readonly store: OperationStore<TResult>;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private operationCounter = 0;
  /** Handles of operations this runner is executing, so `release()` can reach them. */
  private readonly active = new Map<string, LocalOperationHandle<TResult>>();
  /** Operations being handed back to the queue, which the execution loop settles as a release. */
  private readonly releasing = new Set<string>();

  constructor(private readonly config: OperationRunnerConfig<TResult> = {}) {
    this.store = config.store ?? new MemoryOperationStore<TResult>();
    this.owner = config.owner ?? `worker-${randomBytes(6).toString('hex')}`;
    this.leaseMs = config.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = config.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.now = config.now ?? (() => new Date());
  }

  /** Identifier this runner writes into leases. */
  get workerId(): string {
    return this.owner;
  }

  /**
   * Accepts an operation and starts running it.
   *
   * Returns before the executor has done anything, so the caller can stream events or persist the
   * id. An `idempotencyKey` that matches an existing record replays that operation instead of
   * starting a second one, which is what stops an ambiguous timeout from double-charging.
   */
  async submit(
    executor: OperationExecutor<TResult>,
    options: OperationSubmitOptions = {},
  ): Promise<DurableOperationHandle<TResult>> {
    const { record, existing } = await this.createRecord(options);
    if (existing) return this.attachToRecord(record);
    return this.startHandle(record, executor, options.signal);
  }

  /**
   * Accepts an operation without running it, for a worker to claim.
   *
   * The record is stored as queued, and `claimQueued()` on any runner that shares the store runs it.
   * That is how an API replica accepts work that a separate pool of workers executes. Resolves to
   * the stored record, or to the one an `idempotencyKey` already names; read it again, or follow it
   * with `submit()` under the same key, to see how it ends.
   */
  async enqueue(options: OperationEnqueueOptions = {}): Promise<OperationRecord<TResult>> {
    return (await this.createRecord(options)).record;
  }

  /**
   * Claims up to `limit` queued operations that no worker holds, oldest first, and runs them here.
   *
   * Each claim is a compare-and-set on the record, so several workers polling one store never run
   * the same operation twice. Returns the handles of what this runner claimed; an empty list means the
   * queue had nothing for it.
   */
  async claimQueued(
    executor: OperationExecutor<TResult>,
    limit = 1,
    filter?: OperationStoreFilter,
  ): Promise<Array<DurableOperationHandle<TResult>>> {
    if (limit <= 0) return [];
    const nowIso = this.now().toISOString();
    const candidates = this.store.listQueued
      ? await this.store.listQueued(limit, filter)
      : queuedFromList((await this.store.list?.()) ?? [], nowIso, limit, filter);
    const claimed: Array<DurableOperationHandle<TResult>> = [];

    for (const record of candidates) {
      if (claimed.length >= limit) break;
      if (record.expiresAt && record.expiresAt <= nowIso) {
        await this.settleExpired(record);
        continue;
      }
      const running = await this.claim(record);
      if (running) claimed.push(await this.startHandle(running, executor, undefined, true));
    }
    return claimed;
  }

  /**
   * Hands an operation this runner is executing back to the queue, for another worker to continue.
   *
   * The executor's signal is aborted with an `OperationReleasedError`, and the record returns to
   * `queued` as a new attempt that does not count against `maxAttempts`. A draining worker gives its
   * work away this way rather than failing it. Returns false when this runner is not executing the
   * operation.
   */
  release(id: string): boolean {
    const handle = this.active.get(id);
    if (!handle) return false;
    this.releasing.add(id);
    if (handle.abort(new OperationReleasedError(id, this.owner))) return true;
    this.releasing.delete(id);
    return false;
  }

  /** Ids of the operations this runner is executing now, including any waiting to retry. */
  get executing(): string[] {
    return [...this.active.keys()];
  }

  /** Stores a new record, or finds the one an idempotency key already names. */
  private async createRecord(
    options: OperationSubmitOptions,
  ): Promise<{ record: OperationRecord<TResult>; existing: boolean }> {
    if (options.idempotencyKey && this.store.findByIdempotencyKey) {
      const existing = await this.store.findByIdempotencyKey(options.idempotencyKey);
      if (existing) return { record: existing, existing: true };
    }

    const id = options.id?.trim() || this.createOperationId();
    const createdAt = this.now().toISOString();
    const record: OperationRecord<TResult> = {
      id,
      status: 'queued',
      attempt: 1,
      maxAttempts: options.maxAttempts ?? this.config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      sequence: 0,
      createdAt,
      updatedAt: createdAt,
      expiresAt: options.expiresAt,
      idempotencyKey: options.idempotencyKey,
      kind: options.kind,
      traceContext: options.traceContext,
      metadata: options.metadata,
    };
    try {
      await this.store.create(record);
    } catch (error) {
      // Another worker created the operation between the lookup above and this write; replay it.
      if (error instanceof OperationDuplicateError && options.idempotencyKey && this.store.findByIdempotencyKey) {
        const winner = await this.store.findByIdempotencyKey(options.idempotencyKey);
        if (winner) return { record: winner, existing: true };
      }
      throw error;
    }
    await this.config.dispatcher?.dispatch(record as OperationRecord<unknown>);
    return { record, existing: false };
  }

  /** Reads the persisted record, without starting anything. */
  async read(id: string): Promise<OperationRecord<TResult> | undefined> {
    return this.store.read(id);
  }

  /**
   * Cancels a persisted operation, including one owned by another worker.
   *
   * The running worker notices through its heartbeat, which is why cancellation is observed rather
   * than immediate across processes.
   */
  async cancel(id: string, reason?: string): Promise<boolean> {
    const record = await this.store.read(id);
    if (!record) throw new OperationNotFoundError(id);
    if (isTerminalOperationStatus(record.status)) return false;

    const cancelling = this.advance(record, 'cancelling');
    if (!(await this.store.update(cancelling, record.sequence))) return false;

    const cancelled = this.advance(cancelling, 'cancelled');
    cancelled.completedAt = cancelled.updatedAt;
    cancelled.lease = undefined;
    cancelled.error = describeOperationError(new OperationCancelledError(id, reason));
    const written = await this.store.update(cancelled, cancelling.sequence);
    if (written) {
      await this.emitWebhook({
        operationId: id,
        sequence: cancelled.sequence,
        timestamp: cancelled.updatedAt,
        type: 'cancelled',
        status: 'cancelled',
        reason,
      });
    }
    return written;
  }

  /**
   * Re-runs operations whose lease lapsed, typically after a worker crashed.
   *
   * A record past its `expiresAt` is expired rather than retried, and one that has used every
   * attempt is dead-lettered, so a permanently failing operation cannot be recovered forever.
   */
  async recover(executor: OperationExecutor<TResult>, limit = 10): Promise<Array<DurableOperationHandle<TResult>>> {
    if (!this.store.claimExpired) return [];

    const nowIso = this.now().toISOString();
    const stale = await this.store.claimExpired(nowIso, limit);
    const resumed: Array<DurableOperationHandle<TResult>> = [];

    for (const record of stale) {
      if (record.expiresAt && record.expiresAt <= nowIso) {
        await this.settleExpired(record);
        continue;
      }
      if (record.attempt >= record.maxAttempts && record.status === 'running') {
        await this.settleDeadLetter(record, new OperationLeaseLostError(record.id, record.lease?.owner ?? 'unknown'));
        continue;
      }

      const requeued = this.advance(record, record.status === 'running' ? 'retrying' : record.status);
      requeued.lease = undefined;
      if (requeued.status === 'retrying') requeued.attempt = record.attempt + 1;
      if (!(await this.store.update(requeued, record.sequence))) continue;

      resumed.push(await this.startHandle(requeued, executor));
    }

    return resumed;
  }

  // ── Execution ────────────────────────────────────────────────────

  private async startHandle(
    record: OperationRecord<TResult>,
    executor: OperationExecutor<TResult>,
    externalSignal?: AbortSignal,
    claimed = false,
  ): Promise<DurableOperationHandle<TResult>> {
    const handle = new LocalOperationHandle<TResult>(record.id, {
      now: this.now,
      onEvent: (event) => {
        // A release is a hand-off to another worker, so receivers must not hear of a failure.
        if (event.type === 'failed' && event.error.name === 'OperationReleasedError') return;
        void this.emitWebhook(event);
      },
    });
    this.active.set(record.id, handle);
    const forget = (): void => {
      if (this.active.get(record.id) === handle) this.active.delete(record.id);
    };
    void handle.result().then(forget, forget);

    if (externalSignal) {
      const onAbort = (): void => void handle.cancel(abortReason(externalSignal));
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
      void handle.result().then(
        () => externalSignal.removeEventListener('abort', onAbort),
        () => externalSignal.removeEventListener('abort', onAbort),
      );
    }

    void this.execute(record, executor, handle, claimed);
    return this.decorate(handle);
  }

  private async execute(
    initial: OperationRecord<TResult>,
    executor: OperationExecutor<TResult>,
    handle: LocalOperationHandle<TResult>,
    preclaimed = false,
  ): Promise<void> {
    let record = initial;
    let alreadyClaimed = preclaimed;
    const retry = this.config.retry ?? {};
    const deadline = this.config.timeoutMs === undefined ? undefined : Date.now() + this.config.timeoutMs;

    while (true) {
      if (handle.status() === 'cancelled') return;
      if (this.releasing.has(record.id)) {
        await this.persistReleased(record, handle);
        return;
      }

      const claimed = alreadyClaimed ? record : await this.claim(record);
      alreadyClaimed = false;
      if (!claimed) {
        // Another worker owns it. The local handle stops here rather than racing.
        handle.settleFailure(new OperationLeaseLostError(record.id, record.lease?.owner ?? 'unknown'));
        return;
      }
      record = claimed;

      // The handle owns the observable lifecycle, so it has to be told the attempt started before
      // the executor runs; otherwise no running event fires and report() is silently dropped.
      if (!handle.markRunning(record.attempt)) return;

      const heartbeat = this.startHeartbeat(record, handle);
      let outcome: { ok: true; value: TResult } | { ok: false; error: unknown };
      try {
        const value = await executor(this.buildContext(record, handle));
        outcome = { ok: true, value };
      } catch (error) {
        outcome = { ok: false, error };
      } finally {
        heartbeat.stop();
      }
      record = heartbeat.latest();

      if (handle.status() === 'cancelled') {
        await this.persistCancelled(record);
        return;
      }
      // An executor that finished anyway keeps its result: re-queueing it would run the work twice.
      if (!outcome.ok && this.releasing.has(record.id)) {
        await this.persistReleased(record, handle);
        return;
      }
      this.releasing.delete(record.id);

      if (outcome.ok) {
        await this.persistSuccess(record, outcome.value);
        handle.settleSuccess(outcome.value);
        return;
      }

      const attemptsLeft = record.attempt < record.maxAttempts;
      const retryable = isRetryable(outcome.error, retry);
      const timedOut = deadline !== undefined && Date.now() >= deadline;

      if (!attemptsLeft || !retryable || timedOut) {
        await this.settleDeadLetter(record, outcome.error, !attemptsLeft && retryable);
        handle.settleFailure(outcome.error, !attemptsLeft && retryable);
        return;
      }

      const delayMs = retryDelay(retry, record.attempt);
      handle.markRetrying(outcome.error, delayMs);

      const retrying = this.advance(record, 'retrying');
      retrying.attempt = record.attempt + 1;
      retrying.lease = undefined;
      retrying.error = describeOperationError(outcome.error);
      if (!(await this.store.update(retrying, record.sequence))) return;
      record = retrying;

      await delay(delayMs, handle.signal);
      if (handle.status() === 'cancelled') {
        await this.persistCancelled(record);
        return;
      }

      const requeued = this.advance(record, 'queued');
      if (!(await this.store.update(requeued, record.sequence))) return;
      record = requeued;
    }
  }

  /** Moves a claimable record to `running` and stamps a lease. */
  private async claim(record: OperationRecord<TResult>): Promise<OperationRecord<TResult> | undefined> {
    const current = (await this.store.read(record.id)) ?? record;
    if (isTerminalOperationStatus(current.status)) return undefined;
    if (!isClaimable(current.status) && current.status !== 'running') return undefined;
    // A live lease held by another worker is never taken over here; lapsed ones are recovery's job.
    if (
      current.status === 'running' &&
      current.lease &&
      current.lease.owner !== this.owner &&
      current.lease.expiresAt > this.now().toISOString()
    ) {
      return undefined;
    }

    const running = this.advance(current, 'running');
    running.startedAt = running.startedAt ?? running.updatedAt;
    running.lease = {
      owner: this.owner,
      expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      heartbeatAt: running.updatedAt,
    };
    return (await this.store.update(running, current.sequence)) ? running : undefined;
  }

  private startHeartbeat(
    record: OperationRecord<TResult>,
    handle: LocalOperationHandle<TResult>,
  ): { stop: () => void; latest: () => OperationRecord<TResult>; beat: () => Promise<void> } {
    let latest = record;
    let stopped = false;

    const beat = async (): Promise<void> => {
      if (stopped) return;
      const current = await this.store.read(latest.id);
      if (!current) return;

      // A cancellation written by another process is observed here, which is what makes
      // cross-process cancellation work without a second channel.
      if (current.status === 'cancelling' || current.status === 'cancelled') {
        handle.cancel('cancelled by another worker');
        return;
      }
      if (current.lease && current.lease.owner !== this.owner) {
        handle.settleFailure(new OperationLeaseLostError(latest.id, current.lease.owner));
        return;
      }
      // Another worker has already settled it, which is what a takeover after a lapsed lease leaves
      // behind. There is nothing left to renew, and advancing a settled record would be illegal.
      if (isTerminalOperationStatus(current.status)) {
        handle.settleFailure(new OperationLeaseLostError(latest.id, current.lease?.owner ?? 'another worker'));
        return;
      }

      const renewed = this.advance(current, 'running');
      renewed.lease = {
        owner: this.owner,
        expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
        heartbeatAt: renewed.updatedAt,
      };
      renewed.progress = handle.progress() ?? current.progress;
      if (await this.store.update(renewed, current.sequence)) latest = renewed;
    };

    const timer = setInterval(() => {
      // A heartbeat that throws must not become an unhandled rejection: it stops the beat and fails
      // the local run, which is what losing the record means for this worker.
      void beat().catch((error: unknown) => {
        stopped = true;
        clearInterval(timer);
        handle.settleFailure(error);
      });
    }, this.heartbeatMs);
    // A heartbeat must never hold the process open on its own.
    timer.unref?.();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
      latest: () => latest,
      beat,
    };
  }

  private buildContext(record: OperationRecord<TResult>, handle: LocalOperationHandle<TResult>): OperationContext {
    return {
      operationId: record.id,
      attempt: record.attempt,
      signal: handle.signal,
      report: (progress: OperationProgress) => handle.report(progress),
      heartbeat: async () => {
        const current = await this.store.read(record.id);
        if (!current || isTerminalOperationStatus(current.status)) return;
        const renewed = this.advance(current, 'running');
        renewed.lease = {
          owner: this.owner,
          expiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
          heartbeatAt: renewed.updatedAt,
        };
        await this.store.update(renewed, current.sequence);
      },
      traceContext: record.traceContext,
      metadata: record.metadata,
    };
  }

  // ── Persistence helpers ──────────────────────────────────────────

  private async persistSuccess(record: OperationRecord<TResult>, value: TResult): Promise<void> {
    const succeeded = this.advance(record, 'succeeded');
    succeeded.result = value;
    succeeded.completedAt = succeeded.updatedAt;
    succeeded.lease = undefined;
    await this.store.update(succeeded, record.sequence);
  }

  private async persistCancelled(record: OperationRecord<TResult>): Promise<void> {
    const current = (await this.store.read(record.id)) ?? record;
    if (isTerminalOperationStatus(current.status)) return;
    const cancelled = this.advance(current, current.status === 'cancelling' ? 'cancelled' : 'cancelling');
    cancelled.lease = undefined;
    if (cancelled.status === 'cancelled') cancelled.completedAt = cancelled.updatedAt;
    const written = await this.store.update(cancelled, current.sequence);
    if (written && cancelled.status === 'cancelling') await this.persistCancelled(cancelled);
  }

  /**
   * Puts a released operation back in the queue and settles the local handle.
   *
   * A running record becomes a new attempt, with one more allowed, so the worker that claims it
   * knows to continue from where this one stopped and the hand-off costs nothing from the retry
   * budget.
   */
  private async persistReleased(
    record: OperationRecord<TResult>,
    handle: LocalOperationHandle<TResult>,
  ): Promise<void> {
    this.releasing.delete(record.id);
    let current = (await this.store.read(record.id)) ?? record;
    if (current.status === 'running') {
      const retrying = this.advance(current, 'retrying');
      retrying.lease = undefined;
      retrying.attempt = current.attempt + 1;
      retrying.maxAttempts = current.maxAttempts + 1;
      if (await this.store.update(retrying, current.sequence)) current = retrying;
    }
    if (current.status === 'retrying') {
      const queued = this.advance(current, 'queued');
      await this.store.update(queued, current.sequence);
    }
    handle.settleFailure(new OperationReleasedError(record.id, this.owner));
  }

  private async settleDeadLetter(record: OperationRecord<TResult>, error: unknown, deadLettered = true): Promise<void> {
    const current = (await this.store.read(record.id)) ?? record;
    if (isTerminalOperationStatus(current.status)) return;
    const failed = this.advance(current, 'failed');
    failed.error = describeOperationError(error);
    failed.completedAt = failed.updatedAt;
    failed.lease = undefined;
    failed.deadLettered = deadLettered || undefined;
    if (await this.store.update(failed, current.sequence)) {
      await this.emitWebhook({
        operationId: failed.id,
        sequence: failed.sequence,
        timestamp: failed.updatedAt,
        type: 'failed',
        status: 'failed',
        error: failed.error,
        deadLettered: failed.deadLettered,
      });
    }
  }

  private async settleExpired(record: OperationRecord<TResult>): Promise<void> {
    const expired = this.advance(record, 'expired');
    expired.completedAt = expired.updatedAt;
    expired.lease = undefined;
    expired.error = describeOperationError(new OperationExpiredError(record.id, record.expiresAt));
    if (await this.store.update(expired, record.sequence)) {
      await this.emitWebhook({
        operationId: expired.id,
        sequence: expired.sequence,
        timestamp: expired.updatedAt,
        type: 'expired',
        status: 'expired',
        error: expired.error,
      });
    }
  }

  /** Applies a checked transition and bumps the concurrency token. */
  private advance(record: OperationRecord<TResult>, to: OperationRecord<TResult>['status']): OperationRecord<TResult> {
    if (to !== record.status || to === 'running') assertTransition(record.status, to, record.id);
    return {
      ...record,
      status: to,
      sequence: record.sequence + 1,
      updatedAt: this.now().toISOString(),
    };
  }

  /**
   * Rebuilds a handle for an operation this process did not start.
   *
   * Used for an idempotency replay: the caller gets a handle that resolves from the stored record
   * rather than a second execution.
   */
  private async attachToRecord(record: OperationRecord<TResult>): Promise<DurableOperationHandle<TResult>> {
    const handle = new LocalOperationHandle<TResult>(record.id, { now: this.now });

    if (record.status === 'succeeded') handle.settleSuccess(record.result as TResult);
    else if (record.status === 'failed') handle.settleFailure(new Error(record.error?.message ?? 'Operation failed'));
    else if (record.status === 'cancelled') handle.cancel(record.error?.message);
    else if (record.status === 'expired') handle.markExpired(new OperationExpiredError(record.id, record.expiresAt));
    else {
      // Still in flight elsewhere. Poll the store rather than execute a second time.
      void this.followRecord(record.id, handle);
    }

    return this.decorate(handle);
  }

  private async followRecord(id: string, handle: LocalOperationHandle<TResult>): Promise<void> {
    while (!isTerminalOperationStatus(handle.status())) {
      await delay(this.heartbeatMs, handle.signal);
      const current = await this.store.read(id);
      if (!current) return;
      if (current.progress) handle.report(current.progress);
      if (current.status === 'succeeded') return handle.settleSuccess(current.result as TResult);
      if (current.status === 'failed') return handle.settleFailure(new Error(current.error?.message ?? 'failed'));
      if (current.status === 'cancelled') {
        handle.cancel(current.error?.message);
        return;
      }
      if (current.status === 'expired') {
        handle.markExpired(new OperationExpiredError(id, current.expiresAt));
        return;
      }
    }
  }

  private decorate(handle: LocalOperationHandle<TResult>): DurableOperationHandle<TResult> {
    const store = this.store;
    return {
      id: handle.id,
      status: () => handle.status(),
      result: () => handle.result(),
      cancel: (reason?: string) => handle.cancel(reason),
      events: () => handle.events(),
      progress: () => handle.progress(),
      record: async () => store.read(handle.id),
    };
  }

  private async emitWebhook(event: OperationEvent<unknown>): Promise<void> {
    const webhook = this.config.webhook;
    if (!webhook) return;
    try {
      await deliverOperationWebhook(webhook, event, Math.floor(this.now().getTime() / 1000));
    } catch (error) {
      // A receiver that rejects a notification must not turn a completed operation into a failed
      // one, so the error is reported and the lifecycle continues.
      this.config.onWebhookError?.(error, event as OperationEvent<TResult>);
    }
  }

  private createOperationId(): string {
    const configured = this.config.createOperationId?.();
    if (configured?.trim()) return configured;
    this.operationCounter += 1;
    return `op-${Date.now().toString(36)}-${this.operationCounter}-${randomBytes(3).toString('hex')}`;
  }
}

/** `listQueued()` for a store that can only list everything. */
function queuedFromList<TResult>(
  records: ReadonlyArray<OperationRecord<TResult>>,
  now: string,
  limit: number,
  filter?: OperationStoreFilter,
): Array<OperationRecord<TResult>> {
  return records
    .filter((record) => isUnheldQueued(record, now) && matchesFilter(record, filter))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .slice(0, limit);
}

function isRetryable(error: unknown, retry: OperationRetryConfig): boolean {
  if (retry.isRetryable) return retry.isRetryable(error);
  // A cancellation is a decision, not a fault; retrying it would defeat the cancel.
  return !(error instanceof OperationCancelledError);
}

function retryDelay(retry: OperationRetryConfig, attempt: number): number {
  const base = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const raw = retry.backoff === 'fixed' ? base : base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, max);
  const jitter = retry.jitter ?? 0;
  return jitter > 0 ? Math.round(capped * (1 - jitter + Math.random() * jitter)) : capped;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason === undefined) return undefined;
  return reason instanceof Error ? reason.message : String(reason);
}
