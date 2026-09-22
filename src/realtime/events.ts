export type EventMap = object;

/** A small typed event emitter, with no dependency on Node's `events`. */
export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<(payload: Events[keyof Events]) => void>>();

  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): () => void {
    const listeners = this.listeners.get(event) || new Set<(payload: Events[keyof Events]) => void>();
    listeners.add(listener as (payload: Events[keyof Events]) => void);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  /** Subscribes to the next occurrence of an event only. Returns a function that unsubscribes. */
  once<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): () => void {
    let unsubscribe: () => void = () => {};
    unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  /** Removes a listener. */
  off<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener as (payload: Events[keyof Events]) => void);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  /** Calls every listener of an event, in the order they subscribed. */
  emit<Event extends keyof Events>(event: Event, payload: Events[Event]): void {
    for (const listener of [...(this.listeners.get(event) || [])]) {
      listener(payload);
    }
  }

  /** Removes every listener of an event, or of every event. */
  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  /** Listeners of an event. */
  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size || 0;
  }
}
