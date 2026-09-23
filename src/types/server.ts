/**
 * The self-hosted agent server: assistants, threads, runs, and cron jobs over HTTP.
 *
 * The server is a thin layer over parts that already exist. A run is a durable operation, so leases,
 * heartbeats, retries, idempotency, and crash recovery come from the operation runner; a thread is a
 * graph thread, so state, interrupts, and history come from the checkpointer; and an assistant is
 * anything that can stream events for an input, which a compiled graph already does.
 */

/** Who is making a request, as the server's authentication hook reports them. */
export interface Principal {
  /** Isolates threads, runs, and cron jobs. Requests only ever see their own tenant's resources. */
  tenantId?: string;
  /** Who the caller is, recorded on what they create. */
  userId?: string;
  /** What the caller may do. A route that names a scope refuses a principal without it. */
  scopes?: readonly string[];
}

/** Where a run stands, as the server reports it. */
export type RunStatus = 'queued' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

/** What happens when a run is requested for a thread that is already running one. */
export type ThreadBusyPolicy = 'reject' | 'enqueue' | 'interrupt' | 'rollback';

/** A conversation, and the state an assistant keeps for it. */
export interface ThreadRecord {
  /** The thread's id. */
  id: string;
  /** The assistant it belongs to. */
  assistant: string;
  /** The tenant that owns it. */
  tenantId?: string;
  /** Who created it. */
  createdBy?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 time of the last run on it. */
  updatedAt: string;
  /** The run in flight, when there is one. */
  activeRunId?: string;
  /** Application data supplied when it was created. */
  metadata?: Record<string, unknown>;
}

/** A run of an assistant, whether or not it belongs to a thread. */
export interface RunRecord {
  /** The run's id, which is also its operation id. */
  id: string;
  /** The assistant that ran. */
  assistant: string;
  /** The thread it belongs to, when it has one. */
  threadId?: string;
  /** The tenant that owns it. */
  tenantId?: string;
  /** Where it stands. */
  status: RunStatus;
  /** ISO-8601 time it was accepted. */
  createdAt: string;
  /** ISO-8601 time of the last change. */
  updatedAt: string;
  /** What it produced, once it succeeded. */
  output?: unknown;
  /** Why it failed, or the reason it was cancelled. */
  error?: { message: string; name?: string; code?: string };
  /** What it is waiting for, when it is awaiting input. */
  interrupt?: unknown;
  /** Application data supplied when it was submitted. */
  metadata?: Record<string, unknown>;
}

/** One event of a run, as the event log stores it and the event stream sends it. */
export interface RunEvent {
  /** Position in the run's log, starting at 1. A client resumes from the last id it saw. */
  id: number;
  /** The run it belongs to. */
  runId: string;
  /** What kind of event it is: the assistant's own event types, or the server's `status` and `error`. */
  type: string;
  /** ISO-8601 time it was recorded. */
  at: string;
  /** The event itself: a graph step, a status change, or whatever the assistant emitted. */
  data: unknown;
}

/**
 * Where run events are kept so a disconnected client can catch up.
 *
 * In one process the in-memory log is enough. Across replicas the log has to be shared, which is
 * what the Redis log is for: a client that reconnects to another replica still resumes exactly where
 * it left off.
 */
export interface RunEventLog {
  /** Appends an event and returns it with the id it was given. */
  append(runId: string, event: Omit<RunEvent, 'id' | 'runId'>): Promise<RunEvent> | RunEvent;
  /** Events of a run after an id, oldest first. */
  read(runId: string, options?: { after?: number; limit?: number }): Promise<RunEvent[]> | RunEvent[];
  /**
   * Resolves when an event after `after` exists, or when `signal` aborts or the wait times out.
   * Returning nothing simply means the caller should read again.
   */
  wait?(runId: string, after: number, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /** Forgets a run's events. */
  clear?(runId: string): Promise<void> | void;
}

/** Where threads and runs are recorded. Any `Store` satisfies it; the server namespaces its keys. */
export interface ServerStateStore {
  /** Reads a record. */
  get<V>(namespace: readonly string[], key: string): Promise<V | undefined> | V | undefined;
  /** Writes a record. */
  put<V>(namespace: readonly string[], key: string, value: V): Promise<void> | void;
  /** Removes a record. */
  delete(namespace: readonly string[], key: string): Promise<void> | void;
  /** Records under a namespace, newest first. */
  list<V>(namespace: readonly string[], options?: { limit?: number }): Promise<V[]> | V[];
}

/** What an assistant receives when the server runs it. */
export interface AssistantRunContext {
  /** The thread being run, when the run has one. */
  threadId?: string;
  /** The run's id. */
  runId: string;
  /** Aborted when the run is cancelled, expires, or loses its lease. */
  signal: AbortSignal;
  /** Who asked. */
  principal?: Principal;
  /** Application data submitted with the run. */
  metadata?: Record<string, unknown>;
}

/**
 * Anything the server can run: a compiled graph, an agent, or a function.
 *
 * Only `stream` is required, and a compiled graph satisfies it as it is. The optional members are
 * what a thread needs: `state` to report it, `resume` to answer an interrupt, and `restore` for the
 * `rollback` busy policy.
 */
export interface ServerAssistant {
  /** What the assistant is, reported by the assistants endpoint. */
  description?: string;
  /** Runs an input, yielding events as it goes. The last state it yields is the run's output. */
  stream(input: unknown, context: AssistantRunContext): AsyncIterable<unknown>;
  /** Answers an interrupt and continues the thread. */
  resume?(threadId: string, value: unknown, context: AssistantRunContext): AsyncIterable<unknown>;
  /** The thread's current state, for the state endpoint. */
  state?(threadId: string): Promise<unknown> | unknown;
  /** Restores a thread to the state it had before a step, for the `rollback` policy. */
  restore?(threadId: string, step: number): Promise<void> | void;
  /** The step the thread is at now, recorded before a run so `restore` has somewhere to go back to. */
  step?(threadId: string): Promise<number | undefined> | number | undefined;
}

/** A scheduled run of an assistant. */
export interface CronRecord {
  /** The job's id. */
  id: string;
  /** The assistant it runs. */
  assistant: string;
  /** The input it runs with. */
  input?: unknown;
  /** The thread it runs on. Without one, every firing is a stateless run. */
  threadId?: string;
  /** How often it fires: a cron expression, or an interval in milliseconds. */
  schedule: { cron: string; timezone?: 'utc' } | { everyMs: number };
  /** The tenant that owns it. */
  tenantId?: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 time it last fired. */
  lastRunAt?: string;
  /** The run the last firing created. */
  lastRunId?: string;
  /** Stops it firing without deleting it. */
  paused?: boolean;
  /** Application data supplied when it was created. */
  metadata?: Record<string, unknown>;
}
