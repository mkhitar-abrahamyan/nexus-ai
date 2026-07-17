export type EventMap = object;

export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<(payload: Events[keyof Events]) => void>>();

  on<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): () => void {
    const listeners = this.listeners.get(event) || new Set<(payload: Events[keyof Events]) => void>();
    listeners.add(listener as (payload: Events[keyof Events]) => void);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  once<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): () => void {
    let unsubscribe: () => void = () => {};
    unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<Event extends keyof Events>(event: Event, listener: (payload: Events[Event]) => void): void {
    const listeners = this.listeners.get(event);
    listeners?.delete(listener as (payload: Events[keyof Events]) => void);
    if (listeners?.size === 0) this.listeners.delete(event);
  }

  emit<Event extends keyof Events>(event: Event, payload: Events[Event]): void {
    for (const listener of [...(this.listeners.get(event) || [])]) {
      listener(payload);
    }
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size || 0;
  }
}
