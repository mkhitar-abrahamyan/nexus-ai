import { type BatchJobState, isTerminalBatchStatus } from '../types/batch.js';

/** How a batch is waited on. */
export interface BatchPollOptions {
  /** The first wait between polls, in milliseconds. */
  intervalMs: number;
  /** The longest wait, once backoff has grown it. */
  maxIntervalMs: number;
  /** Stops waiting. The provider-side batch keeps running. */
  signal: AbortSignal;
  /** Called with each state that is not yet final. */
  onState?: (state: BatchJobState) => void;
}

/**
 * Polls a batch until it reaches a status it never leaves. A batch measured in hours does not deserve
 * a fixed short interval: the wait grows by half each time up to the maximum, which keeps the poll
 * count sane without delaying a fast batch, which the first few short polls still catch.
 */
export async function pollUntilSettled(
  poll: () => Promise<BatchJobState>,
  options: BatchPollOptions,
): Promise<BatchJobState> {
  let interval = options.intervalMs;
  let state = await poll();
  while (!isTerminalBatchStatus(state.status)) {
    if (options.signal.aborted) throw options.signal.reason ?? new Error('aborted');
    options.onState?.(state);
    await delay(interval, options.signal);
    interval = Math.min(Math.round(interval * 1.5), options.maxIntervalMs);
    state = await poll();
  }
  return state;
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
