import type { Channel } from '../types/graph.js';

/**
 * The last write wins.
 *
 * The right default for a scalar a node computes fresh each time. Under fan-out the winner is
 * whichever branch reduced last, so prefer an accumulating channel when several branches write the
 * same slot and the outcome matters.
 */
export function lastValue<T>(initial?: T): Channel<T> {
  return {
    reduce: (_current, update) => update,
    ...(initial === undefined ? {} : { initial: () => initial }),
  };
}

/** Concatenates every write, which is what a message history or an event log wants. */
export function appendList<T>(): Channel<T[]> {
  return {
    reduce: (current, update) => [...(current ?? []), ...update],
    initial: () => [],
  };
}

/** Shallow-merges object writes, so two branches can each contribute their own keys. */
export function mergeObject<T extends Record<string, unknown>>(): Channel<T> {
  return {
    reduce: (current, update) => ({ ...(current ?? {}), ...update }) as T,
    initial: () => ({}) as T,
  };
}

/** Sums numeric writes, for a counter several branches increment. */
export function counter(initial = 0): Channel<number> {
  return {
    reduce: (current, update) => (current ?? initial) + update,
    initial: () => initial,
  };
}

/** Keeps distinct values in first-seen order. */
export function appendSet<T>(): Channel<T[]> {
  return {
    reduce: (current, update) => {
      const seen = new Set(current ?? []);
      const merged = [...(current ?? [])];
      for (const value of update) {
        if (!seen.has(value)) {
          seen.add(value);
          merged.push(value);
        }
      }
      return merged;
    },
    initial: () => [],
  };
}

/** Builds a channel from a plain reducer, for a rule none of the built-ins covers. */
export function reducerChannel<T>(reduce: (current: T | undefined, update: T) => T, initial?: () => T): Channel<T> {
  return { reduce, ...(initial ? { initial } : {}) };
}
