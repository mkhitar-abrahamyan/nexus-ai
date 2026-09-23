import type { RunEvent, RunEventLog } from '../types/server.js';

/** Options for the in-memory run event log. */
export interface MemoryRunEventLogOptions {
  /** Events kept per run before the oldest are dropped. Defaults to 1,000. */
  maxEventsPerRun?: number;
  /** Runs kept before the least recently written is dropped. Defaults to 1,000. */
  maxRuns?: number;
}

/**
 * Run events in process memory, with waiters woken as events arrive.
 *
 * The default, and all a single-process server needs: a client that reconnects reads what it missed
 * from here. Across replicas the log has to be shared, which is what `RedisRunEventLog` is for.
 */
export class MemoryRunEventLog implements RunEventLog {
  private readonly runs = new Map<string, RunEvent[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly maxEvents: number;
  private readonly maxRuns: number;

  constructor(options: MemoryRunEventLogOptions = {}) {
    this.maxEvents = options.maxEventsPerRun ?? 1_000;
    this.maxRuns = options.maxRuns ?? 1_000;
  }

  /** Appends an event, numbering it, and wakes anything waiting on this run. */
  append(runId: string, event: Omit<RunEvent, 'id' | 'runId'>): RunEvent {
    const events = this.runs.get(runId) ?? [];
    const previous = events[events.length - 1];
    const full: RunEvent = { ...event, runId, id: (previous?.id ?? 0) + 1 };
    events.push(full);
    // Dropping the oldest keeps a long run bounded; a client that was that far behind re-reads state.
    if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
    this.runs.delete(runId);
    this.runs.set(runId, events);
    while (this.runs.size > this.maxRuns) this.runs.delete(this.runs.keys().next().value as string);
    for (const wake of [...(this.waiters.get(runId) ?? [])]) wake();
    this.waiters.delete(runId);
    return full;
  }

  /** Events of a run after an id, oldest first. */
  read(runId: string, options: { after?: number; limit?: number } = {}): RunEvent[] {
    const after = options.after ?? 0;
    const events = (this.runs.get(runId) ?? []).filter((event) => event.id > after);
    return options.limit === undefined ? events : events.slice(0, options.limit);
  }

  /** Resolves as soon as an event after `after` exists, or when the wait is aborted or times out. */
  wait(runId: string, after: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    if (this.read(runId, { after, limit: 1 }).length > 0) return Promise.resolve();
    if (options.signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(runId) ?? new Set();
      const done = (): void => {
        waiters.delete(wake);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', done);
        resolve();
      };
      const wake = done;
      const timer = setTimeout(done, options.timeoutMs ?? 30_000);
      if (typeof timer === 'object') timer.unref?.();
      waiters.add(wake);
      this.waiters.set(runId, waiters);
      options.signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Forgets a run's events. */
  clear(runId: string): void {
    this.runs.delete(runId);
  }
}

/**
 * The Redis commands the event log needs, in `ioredis` argument order.
 *
 * Structural, as with the other Redis adapters, so no Redis client becomes a dependency.
 */
export interface RedisEventLogLikeClient {
  /** Appends to a list and returns its new length, which numbers the event. */
  rpush(key: string, value: string): Promise<number | unknown> | number | unknown;
  /** Reads a range of a list. */
  lrange(key: string, start: number, stop: number): Promise<string[]> | string[];
  /** Trims a list to a range. */
  ltrim(key: string, start: number, stop: number): Promise<unknown> | unknown;
  /** Sets a key's lifetime in seconds. */
  expire(key: string, seconds: number): Promise<unknown> | unknown;
  /** Deletes a key. */
  del(key: string): Promise<unknown> | unknown;
}

/** Options for the Redis run event log. */
export interface RedisRunEventLogOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:runs:`. */
  prefix?: string;
  /** Events kept per run. Defaults to 1,000. */
  maxEventsPerRun?: number;
  /** How long a run's events live after the last append, in seconds. Defaults to one day. */
  ttlSeconds?: number;
  /** How often a waiting reader looks again, in milliseconds. Defaults to 250. */
  pollIntervalMs?: number;
}

/**
 * Run events in Redis, so a client can reconnect to any replica and resume.
 *
 * One list per run, whose length numbers each event, which is what makes ids stable without a second
 * counter. Waiting readers poll rather than subscribe, so the log needs no second connection and no
 * pub/sub delivery guarantees; the poll interval is the only latency a reconnecting client sees.
 */
export class RedisRunEventLog implements RunEventLog {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisEventLogLikeClient,
    private readonly options: RedisRunEventLogOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:runs:';
  }

  /** Appends an event, numbered by the list's new length. */
  async append(runId: string, event: Omit<RunEvent, 'id' | 'runId'>): Promise<RunEvent> {
    const key = this.key(runId);
    const length = Number(await this.client.rpush(key, JSON.stringify(event)));
    const max = this.options.maxEventsPerRun ?? 1_000;
    if (length > max) await this.client.ltrim(key, -max, -1);
    await this.client.expire(key, this.options.ttlSeconds ?? 86_400);
    return { ...event, runId, id: length };
  }

  /** Events of a run after an id, oldest first. */
  async read(runId: string, options: { after?: number; limit?: number } = {}): Promise<RunEvent[]> {
    const after = options.after ?? 0;
    const raw = await this.client.lrange(this.key(runId), after, options.limit ? after + options.limit - 1 : -1);
    return raw.map((value, index) => ({
      ...(JSON.parse(value) as Omit<RunEvent, 'id' | 'runId'>),
      runId,
      id: after + index + 1,
    }));
  }

  /** Polls until an event after `after` exists, or the wait is aborted or times out. */
  async wait(runId: string, after: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const interval = this.options.pollIntervalMs ?? 250;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (!options.signal?.aborted && Date.now() < deadline) {
      if ((await this.read(runId, { after, limit: 1 })).length > 0) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, interval);
        if (typeof timer === 'object') timer.unref?.();
      });
    }
  }

  /** Forgets a run's events. */
  async clear(runId: string): Promise<void> {
    await this.client.del(this.key(runId));
  }

  private key(runId: string): string {
    return `${this.prefix}events:${runId}`;
  }
}
