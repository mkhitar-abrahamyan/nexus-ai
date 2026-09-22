/** Options for `runBatch()`. */
export interface BatchOptions {
  /** Items processed at once. Defaults to 3. */
  concurrency?: number;
  /** Stops starting new items after the first failure. Off by default. */
  stopOnError?: boolean;
}

/** The outcome of one batch item. */
export interface BatchItemResult<T> {
  /** The item's position in the input. */
  index: number;
  /** True when the worker returned a value. */
  ok: boolean;
  /** The value returned. */
  value?: T;
  /** Why the worker failed. */
  error?: string;
}

/**
 * Runs a worker over items with bounded concurrency, collecting a result per item in input order.
 * Failures are recorded rather than thrown.
 */
export async function runBatch<TInput, TOutput>(
  items: TInput[],
  worker: (item: TInput, index: number) => Promise<TOutput>,
  options: BatchOptions = {},
): Promise<Array<BatchItemResult<TOutput>>> {
  const concurrency = Math.max(1, options.concurrency || 3);
  const results: Array<BatchItemResult<TOutput>> = [];
  let nextIndex = 0;
  let stopped = false;

  async function runNext(): Promise<void> {
    if (stopped) return;
    const index = nextIndex;
    nextIndex += 1;
    if (index >= items.length) return;

    try {
      const value = await worker(items[index], index);
      results[index] = { index, ok: true, value };
    } catch (error) {
      results[index] = {
        index,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      if (options.stopOnError) {
        stopped = true;
        return;
      }
    }

    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()));
  return results.filter(Boolean);
}
