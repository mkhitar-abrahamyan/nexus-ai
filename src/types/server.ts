/**
 * The self-hosted agent server: assistants, threads, runs, and cron jobs over HTTP.
 *
 * The server is a thin layer over parts that already exist. A run is a durable operation, so leases,
 * heartbeats, retries, idempotency, and crash recovery come from the operation runner; a thread is a
 * graph thread, so state, interrupts, and history come from the checkpointer; and an assistant is
 * anything that can stream events for an input, which a compiled graph already does.
 */

import type { Principal } from './principal.js';
import type { RunFeedback } from './tracing.js';

export type { Principal };

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
  /** The revision its last run used, which its next run keeps while that revision takes traffic. */
  revision?: string;
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
  /** The revision that served it, and the traffic split it was chosen under. */
  revision?: RunRevision;
  /** ISO-8601 time a worker first started it. The wait before this is time spent queued. */
  startedAt?: string;
  /** ISO-8601 time it finished. */
  finishedAt?: string;
  /** Milliseconds from the first start to the finish, across every attempt. */
  durationMs?: number;
  /** US dollars the assistant recorded through `recordCost()`, across every attempt. */
  cost?: number;
  /** The worker that ran its latest attempt. */
  worker?: string;
  /** Its latest attempt, starting at 1. */
  attempt?: number;
  /**
   * Scores left on the run by people or by online evaluation, through `POST /runs/:runId/feedback`
   * or `Deployments.evaluate()`. A canary guard compares them between revisions as its quality signal.
   */
  feedback?: RunFeedback[];
}

/** Why a run got the revision it did. */
export type RevisionReason = 'split' | 'thread' | 'requested';

/** Which revision of an assistant served a run, and under what traffic split. */
export interface RunRevision {
  /** The revision's id, such as `2026-09-30`. */
  id: string;
  /** The share of new traffic the revision had when it was chosen, from 0 to 1. */
  weight: number;
  /** The deployment's version when it was chosen. It goes up every time the split changes. */
  deployment: number;
  /**
   * Why this revision: the traffic split chose it, the thread stayed on the revision it started on,
   * or the request named it.
   */
  reason: RevisionReason;
}

/** What an assistant's `route()` is asked when a run starts. */
export interface RevisionRequest {
  /** The run being started. Stateless runs are split on it. */
  runId: string;
  /** The run's thread, when it has one. Runs on a thread are split on it, so a thread stays put. */
  threadId?: string;
  /** The revision the thread's last run used. */
  threadRevision?: string;
  /** A revision the request named, instead of leaving the choice to the split. */
  requested?: string;
  /** Who asked. */
  principal?: Principal;
}

/** The revision `route()` chose: where it came from, and its code. */
export interface RevisionChoice extends RunRevision {
  /** The revision's assistant, which runs this request. */
  assistant: ServerAssistant;
}

/**
 * Enforces per-tenant limits at the server: how many runs a tenant may have in flight, how many it may
 * start in a window, and how much it may spend.
 *
 * `tenantLimits()` from `nexus-ai-pro/server/tenancy` is the implementation. The server calls `admit()`
 * once, when it accepts a run, and `release()` once the run ends, on whichever worker ran it.
 */
export interface TenantGate {
  /** Admits a run, or throws a `TenantLimitError` that the server answers with `429`. */
  admit(run: { runId: string; assistant: string; principal?: Principal }): Promise<void> | void;
  /** Frees what the run held. Called once it finishes, fails, or is cancelled; calling it twice is harmless. */
  release(run: { runId: string; tenantId?: string }): Promise<void> | void;
  /**
   * Adds what a run spent to its tenant's budget. Resolves `false` to stop the run, when the budget is
   * spent and the limits say an overrun stops runs in flight.
   */
  spend(run: { runId: string; tenantId?: string }, usd: number): Promise<boolean> | boolean;
  /** A tenant's limits and what it has used, for `GET /usage`. */
  usage?(tenantId?: string): Promise<unknown> | unknown;
}

/** One server replica, as it reports itself in heartbeats and on `GET /scaling`. */
export interface ReplicaReport {
  /** The worker id it writes into leases. */
  id: string;
  /** ISO-8601 time it started. */
  startedAt: string;
  /** ISO-8601 time of this report. */
  heartbeatAt: string;
  /** Runs it is executing now. */
  inFlight: number;
  /** Runs it executes at once, when it has a cap. */
  capacity?: number;
  /** Whether it claims queued runs. An API replica in front of a worker pool does not. */
  claims: boolean;
  /** Whether it is draining: finishing or handing off its runs before it stops. */
  draining: boolean;
  /** The assistants it serves, each with the revisions it has, empty for an assistant without revisions. */
  assistants: Record<string, readonly string[]>;
  /** What the deployment added, such as the host, the image tag, or the zone. */
  metadata?: Record<string, unknown>;
}

/**
 * The numbers an autoscaler reads, from `GET /scaling`.
 *
 * `queued`, `running`, and `load` are counted across the whole deployment, so every replica reports
 * the same value. Scale workers on `load` divided by each worker's `capacity`.
 */
export interface ScalingSnapshot {
  /** Runs waiting for a worker. */
  queued: number;
  /** Runs executing, or waiting to retry, on any worker. */
  running: number;
  /** `queued` plus `running`: the work an autoscaler sizes the worker pool for. */
  load: number;
  /** Seconds the oldest queued run has waited, or 0. */
  oldestQueuedSeconds: number;
  /** Running runs whose lease lapsed: work a stopped worker left, until a live one takes it over. */
  lapsedLeases: number;
  /** The replica that answered. */
  replica: ReplicaReport;
  /**
   * Whether deployment changes are atomic across replicas, which they are when the state store has
   * `putIfVersion()`. When false, two replicas changing one deployment at once can lose a change.
   */
  atomicChanges?: boolean;
}

/** How traffic for one assistant is split between its revisions. */
export interface DeploymentRecord {
  /** The assistant. */
  assistant: string;
  /** Goes up by one with every change, and is recorded on every run. */
  version: number;
  /** The revision that takes whatever traffic no canary does. */
  live: string;
  /** Share of new runs per revision, from 0 to 1, summing to 1. */
  traffic: Record<string, number>;
  /** ISO-8601 time the current canary began, when one is taking traffic. */
  canarySince?: string;
  /** ISO-8601 time of the last change. */
  updatedAt: string;
  /** Who made the last change. */
  updatedBy?: string;
  /** Changes, newest first, up to the last 50. */
  history: DeploymentChangeRecord[];
}

/** A change to a deployment. */
export type DeploymentChange =
  | { action: 'split'; traffic: Record<string, number>; reason?: string }
  | { action: 'canary'; revision: string; weight: number; reason?: string }
  | { action: 'promote'; revision: string; reason?: string }
  | { action: 'rollback'; to?: string; reason?: string };

/** One entry in a deployment's history. */
export interface DeploymentChangeRecord {
  /** The version the change produced. */
  version: number;
  /** ISO-8601 time of the change. */
  at: string;
  /** What was done. */
  action: DeploymentChange['action'];
  /** The live revision after it. */
  live: string;
  /** The split after it. */
  traffic: Record<string, number>;
  /** Who did it: a person, or `guard` when a canary guard acted. */
  by?: string;
  /** Why, such as the regression that triggered a rollback. */
  reason?: string;
}

/**
 * What the server needs from a deployments registry: its routes read and change deployments, and
 * `start()` hands it a report of this replica to heartbeat. `Deployments` from
 * `nexus-ai-pro/server/deployments` is the implementation.
 */
export interface ServerDeployments {
  /** Every deployment. */
  list(): Promise<DeploymentRecord[]> | DeploymentRecord[];
  /** One assistant's deployment, when it has one. */
  get(assistant: string): Promise<DeploymentRecord | undefined> | DeploymentRecord | undefined;
  /** Applies a change and returns the deployment after it. */
  change(assistant: string, change: DeploymentChange, by?: string): Promise<DeploymentRecord>;
  /** The replicas whose heartbeats are fresh. */
  replicas(): Promise<ReplicaReport[]> | ReplicaReport[];
  /** What each revision's runs did since a time, for `GET /deployments/:assistant`. */
  stats?(assistant: string, options?: { since?: string }): Promise<unknown[]> | unknown[];
  /** Starts heartbeating this replica's report. */
  attach(report: () => ReplicaReport): Promise<void> | void;
  /** Stops heartbeating, and removes this replica's report. */
  detach(): Promise<void> | void;
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
  /**
   * Writes a record only when the stored one's `version` field is `expected`, or, with `expected`
   * `null`, only when none is stored, and resolves whether it wrote. Optional: with it, two replicas
   * changing one deployment at once never lose a change; without it, the later write wins.
   */
  putIfVersion?<V extends { version: number }>(
    namespace: readonly string[],
    key: string,
    value: V,
    expected: number | null,
  ): Promise<boolean> | boolean;
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
  /** Which attempt this is, starting at 1. Above 1 when a worker recovers the run after a crash or retries it. */
  attempt?: number;
  /** The revision serving the run, when the assistant has revisions. */
  revision?: string;
  /**
   * Set to draining when this replica drains and has a queue to hand work to. A graph served through
   * `graphAssistant()` reads it as its `RunControl`: it finishes its superstep, writes its checkpoint,
   * and stops, and another worker continues the run from there. A function assistant checks it between
   * its own steps and throws `RunHandOffError` to hand the run off the same way.
   */
  control?: { readonly draining: boolean; readonly reason?: string };
  /**
   * Records how far the run got, such as the last item it finished, so the worker that continues it
   * after a hand-off or a crash reads it as `progress` and carries on from there. Must be
   * serializable. Extends the run's lease, as a heartbeat does.
   */
  saveProgress?(details: unknown): Promise<void>;
  /** What the run saved with `saveProgress()` before this attempt, on a later attempt. */
  progress?: unknown;
  /**
   * Records US dollars the run spent, such as a model call's cost. The amount is added to the run's
   * `cost` and to its tenant's budget; a budget that stops runs in flight cancels this one.
   */
  recordCost(usd: number): Promise<void>;
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
  /**
   * Continues a run from where it stopped, on a later attempt. Resolves to the events of the
   * continued run, or `undefined` when there is nothing of this run to continue, in which case the
   * server starts it again. `graphAssistant()` provides it, so a recovered graph or workflow run
   * repeats only the step that was in flight.
   */
  recover?(
    threadId: string,
    context: AssistantRunContext,
  ): Promise<AsyncIterable<unknown> | undefined> | AsyncIterable<unknown> | undefined;
  /**
   * Chooses the revision that serves a run. An assistant from `Deployments.assistant()` has it; an
   * assistant without it is one revision, and runs as it is.
   */
  route?(request: RevisionRequest): Promise<RevisionChoice | undefined> | RevisionChoice | undefined;
  /** One revision's assistant, so a recovered run and a thread's state use the revision that ran. */
  revision?(id: string): ServerAssistant | undefined;
  /** The revisions this assistant has, for the assistants endpoint and replica reports. */
  readonly revisions?: readonly string[];
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
