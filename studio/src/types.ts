/**
 * What the studio reads, and how it is configured.
 *
 * Every source is optional and structural. The studio shows a view for each source it is given and
 * hides the rest, and it reads each one through the same adapter the application already uses, so a
 * trace store in Postgres, prompts in Redis, and experiments in files all work without the studio
 * knowing which is which.
 */
import type { CompletionRequest } from 'nexus-ai-pro';
import type { DatasetStore, Experiment, ExperimentStore } from 'nexus-ai-pro/evaluate';
import type { OperationStore } from 'nexus-ai-pro/operations';
import type { PromptRegistry } from 'nexus-ai-pro/prompts/registry';
import type { Run, RunQuery, TraceStore } from 'nexus-ai-pro/tracing';

/** The part of a compiled graph the threads view uses. A compiled graph satisfies it as it is. */
export interface StudioGraphLike {
  /** The graph's shape, for the diagram. */
  describe(): {
    name?: string;
    nodes: Array<{ id: string; ends?: string[]; defer?: boolean; cache?: boolean }>;
    edges: Array<{ from: string; to: string; conditional?: boolean; label?: string }>;
    dynamic: string[];
  };
  /** A thread's checkpoint, at its latest step or at one given. */
  state(threadId: string, step?: number): Promise<StudioCheckpoint | undefined>;
  /** A thread's checkpoints, newest first. */
  history(threadId: string, limit?: number): Promise<StudioCheckpoint[]>;
  /** Copies a thread, optionally from an earlier step, and returns the new thread's id. */
  fork?(threadId: string, options?: { step?: number; threadId?: string }): Promise<string>;
  /** Writes values into a thread's state, as if a node had. */
  updateState?(threadId: string, values: Record<string, unknown>, options?: { asNode?: string }): Promise<unknown>;
  /** Answers the thread's interrupt and runs on. */
  resumeWith?(threadId: string, value: unknown): Promise<unknown>;
  /** Answers several interrupts at once, by interrupt id. */
  resumeInterruptsWith?(threadId: string, answers: Record<string, unknown>): Promise<unknown>;
}

/** One checkpoint, as the studio reads it. */
export interface StudioCheckpoint {
  /** The thread. */
  threadId: string;
  /** The superstep. */
  step: number;
  /** State after the step. */
  state: unknown;
  /** Nodes that run next. */
  next: string[];
  /** Where the thread stands. */
  status: string;
  /** The first question asked, when the thread paused for input. */
  interrupt?: StudioInterrupt;
  /** Every question asked, when the thread paused for input. */
  interrupts?: StudioInterrupt[];
  /** ISO-8601 time the checkpoint was written. */
  createdAt?: string;
}

/** A question a paused thread is waiting on. */
export interface StudioInterrupt {
  /** Stable id, used to answer it. */
  id: string;
  /** The node that asked. */
  node: string;
  /** Why it asked. */
  reason?: string;
  /** What it showed the person. */
  payload?: unknown;
  /** ISO-8601 time it was asked. */
  requestedAt?: string;
}

/** A graph and how to find its threads. */
export interface StudioGraphSource {
  /** The compiled graph. */
  graph: StudioGraphLike;
  /** Lists threads. Defaults to the checkpointer's `threadIds()`, when it has one. */
  threads?: () => Promise<string[]> | string[];
  /** The graph's checkpointer, used only to list threads. */
  checkpointer?: { threadIds?(): Promise<string[]> | string[] };
}

/** The part of an annotation queue the inbox uses. `AnnotationQueue` satisfies it. */
export interface StudioReviewQueue {
  /** Items, optionally with one status. */
  list(status?: 'pending' | 'claimed' | 'reviewed'): Array<{
    id: string;
    status: string;
    subject: unknown;
    rubric: Array<{ key: string; prompt: string; type: string; choices?: string[] }>;
    answers: unknown[];
    enqueuedAt?: string;
  }>;
  /** Claims the next item for a reviewer. */
  claim(reviewer: string): unknown;
  /** Records a reviewer's answers. */
  submit(
    itemId: string,
    answer: { reviewer: string; scores: Array<{ key: string; score: number; comment?: string }>; note?: string },
  ): unknown;
}

/** The part of a prompt registry the prompts view uses. `PromptRegistry` satisfies it. */
export type StudioPromptRegistry = Pick<
  PromptRegistry,
  'names' | 'versions' | 'labels' | 'history' | 'diff' | 'promote' | 'rollback' | 'render'
>;

/**
 * A client, for the playground and the health view. `NexusAI` satisfies it; each member is optional,
 * and the studio shows only what the client can report.
 */
export interface StudioClient {
  /** Runs a completion, for the prompt playground. */
  complete?(request: CompletionRequest): Promise<unknown>;
  /** Provider health snapshots. */
  getProviderHealth?(): unknown;
  /** Circuit breaker state per provider. */
  getCircuitBreakerStatus?(): unknown;
  /** Counters, histograms, and gauges. */
  getMetricsSnapshot?(): unknown;
  /** Response-cache size and capacity. */
  getCacheStats?(): unknown;
}

/** The part of an operation store the operations view uses. The view is hidden when the store cannot list. */
export type StudioOperationStore = Pick<OperationStore<unknown>, 'list'>;

/** The part of an asset store the assets view uses. */
export interface StudioAssetStore {
  /** Totals and limits, as `MemoryAssetStore` reports them. */
  snapshot?(): unknown;
  /** Asset descriptions, for a store that can list. */
  list?(): Promise<unknown[]> | unknown[];
}

/** The part of a shared circuit store the health view uses. */
export interface StudioCircuitStore {
  /** Every provider's shared circuit state. */
  read(): Promise<unknown[]> | unknown[];
}

/** A spending limit shown against what traces recorded. */
export interface StudioBudget {
  /** What the budget is called, such as `production`. */
  name: string;
  /** The limit, in US dollars. */
  limit: number;
  /** The window it applies to. */
  period: 'day' | 'week' | 'month';
  /** Which runs count against it. Defaults to every run. */
  filter?: RunQuery;
}

/** Everything the studio can show. Give it what you have; the rest is hidden. */
export interface StudioSources {
  /** Traces, for the traces and costs views. */
  traces?: TraceStore;
  /** Graphs whose threads the studio browses, edits, forks, and resumes, by name. */
  graphs?: Record<string, StudioGraphSource | StudioGraphLike>;
  /** Annotation queues, for the inbox, by name. */
  reviews?: Record<string, StudioReviewQueue>;
  /** Datasets. */
  datasets?: DatasetStore;
  /** Experiments, for listing and comparing. */
  experiments?: ExperimentStore;
  /** The prompt registry, for versions, diffs, promotion, and the playground. */
  prompts?: StudioPromptRegistry;
  /** A client, for the playground and the health view. */
  client?: StudioClient;
  /** Shared circuit state, for the health view on a deployment with several workers. */
  circuits?: StudioCircuitStore;
  /** The operation store, for the queue view. */
  operations?: StudioOperationStore;
  /** An asset store, for the assets view. */
  assets?: StudioAssetStore;
  /** Budgets shown against recorded cost. */
  budgets?: StudioBudget[];
}

/** Options for the studio server. */
export interface StudioOptions {
  /**
   * The access token every request must carry. Defaults to a random one, printed in the URL the studio
   * starts with. Anyone with it can read and change what the studio shows, so treat it as a password.
   */
  token?: string;
  /** Host names the studio answers to, besides `localhost`, `127.0.0.1`, and `[::1]`. */
  allowedHosts?: readonly string[];
  /** Who actions taken in the studio are recorded as, such as a promotion's `by`. Defaults to `studio`. */
  actor?: string;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** Costs aggregated from traces. */
export interface StudioCostReport {
  /** The window, in days. */
  days: number;
  /** Total cost in the window, in US dollars. */
  total: number;
  /** Cost per UTC day, oldest first. */
  byDay: Array<{ day: string; cost: number; runs: number }>;
  /** Cost per model, highest first. */
  byModel: Array<{ model: string; cost: number; runs: number }>;
  /** The most expensive runs. */
  top: Array<Pick<Run, 'id' | 'traceId' | 'name' | 'model'> & { cost: number }>;
  /** Each configured budget, with what has been spent against it. */
  budgets: Array<StudioBudget & { spent: number; remaining: number; exceeded: boolean }>;
}

export type { Experiment };
