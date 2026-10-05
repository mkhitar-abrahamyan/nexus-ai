/**
 * A signal that aborts when any of its sources does, and can be let go of.
 *
 * `AbortSignal.any()` cannot be undone: in Node 22 a source signal keeps a reference for every signal
 * ever composed from it, about half a kilobyte each, for as long as the source lives. A graph composes
 * one per task attempt from the run's signal, so a long-lived signal shared by many runs — a server's,
 * a worker's — grew without bound. A linked signal listens to its sources directly and `dispose()`
 * removes the listeners, so a finished attempt keeps nothing.
 */
export interface LinkedSignal {
  /** Aborts, with that source's reason, when any source aborts. */
  readonly signal: AbortSignal;
  /** Stops listening to the sources. Safe to call more than once. */
  dispose(): void;
}

const NOTHING_TO_DISPOSE = () => undefined;

/** Links the given signals; missing ones are ignored, and one signal is returned as it is. */
export function linkSignals(sources: ReadonlyArray<AbortSignal | undefined>): LinkedSignal {
  const present = sources.filter((source): source is AbortSignal => source !== undefined);
  if (present.length === 1) return { signal: present[0] as AbortSignal, dispose: NOTHING_TO_DISPOSE };
  const controller = new AbortController();
  const aborted = present.find((source) => source.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return { signal: controller.signal, dispose: NOTHING_TO_DISPOSE };
  }
  const listeners: Array<[AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [source, listener] of listeners.splice(0)) source.removeEventListener('abort', listener);
  };
  for (const source of present) {
    const listener = () => {
      controller.abort(source.reason);
      dispose();
    };
    source.addEventListener('abort', listener, { once: true });
    listeners.push([source, listener]);
  }
  return { signal: controller.signal, dispose };
}
