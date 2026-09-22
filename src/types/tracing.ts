/**
 * Traces: what actually happened during a run, in a shape you can query afterwards.
 *
 * The package already exported metrics and OpenTelemetry spans, but neither can answer "show me the
 * agent runs that failed yesterday and what the model was asked". A metric is a number without a
 * story, and an exported span leaves for another system. A run tree keeps the inputs, the outputs,
 * the cost, and the shape of the call, locally, where it can be searched, compared, and turned into
 * an evaluation dataset.
 */

/** What kind of work a run was, so a trace can be filtered and drawn by family. */
export type RunKind =
  | 'chain'
  | 'model'
  | 'tool'
  | 'graph'
  | 'node'
  | 'agent'
  | 'retriever'
  | 'embedding'
  | 'image'
  | 'voice'
  | 'realtime'
  | 'operation';

/** Where a run stands: still going, finished, or failed. */
export type RunStatus = 'running' | 'ok' | 'error';

/** A judgement attached to a run, by a person or an evaluator. */
export interface RunFeedback {
  /** What was judged, such as `helpful` or `mentions-refund`. */
  key: string;
  /** A numeric score. */
  score?: number;
  /** A non-numeric answer, such as a label or a correction. */
  value?: unknown;
  /** A readable note. */
  comment?: string;
  /** Who or what left it: a person, an online evaluator, a heuristic. */
  source?: string;
  /** ISO-8601 time the feedback was left. */
  createdAt: string;
}

/**
 * One unit of work in a trace: a model call, a tool call, a graph node, or anything else worth
 * timing.
 */
export interface Run {
  /** The run's id. */
  id: string;
  /** The trace it belongs to. Every run of one request shares it. */
  traceId: string;
  /** The run this one ran inside, absent for the root. */
  parentId?: string;
  /** What ran, such as a node or a tool name. */
  name: string;
  /** What kind of work it was. */
  kind: RunKind;
  /** Where it stands. */
  status: RunStatus;
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 end time. */
  endedAt?: string;
  /** Duration in milliseconds. */
  latencyMs?: number;
  /** What it received, after redaction. */
  inputs?: unknown;
  /** What it produced, after redaction. */
  outputs?: unknown;
  /** Why it failed, when it did. */
  error?: { name: string; message: string };
  /** Labels for filtering. */
  tags?: string[];
  /** Application data, queryable by dot path. */
  metadata?: Record<string, unknown>;
  /** Token counts and any other units a provider reported. */
  usage?: Record<string, number>;
  /** What it cost. */
  cost?: number;
  /** The model it called, for a model run. */
  model?: string;
  /** The provider it called, for a model run. */
  provider?: string;
  /** Judgements attached to it. */
  feedback?: RunFeedback[];
}

/** A run and the runs beneath it, which is how a trace is read rather than a flat list. */
export interface RunTree extends Run {
  /** The runs directly beneath this one, in start order. */
  children: RunTree[];
}

/** Filters for `TraceStore.query()`. Every field narrows the match; results come newest first. */
export interface RunQuery {
  /** Runs of one trace. */
  traceId?: string;
  /** Runs of one kind or any of several. */
  kind?: RunKind | RunKind[];
  /** Runs with this status. */
  status?: RunStatus;
  /** Runs with this name. */
  name?: string;
  /** Runs that called this model. */
  model?: string;
  /** Runs that called this provider. */
  provider?: string;
  /** Every tag listed must be present. */
  tags?: string[];
  /** Exact matches on metadata fields, as dot paths. */
  metadata?: Record<string, unknown>;
  /** Runs at least this slow, in milliseconds. */
  minLatencyMs?: number;
  /** Runs at least this expensive. */
  minCost?: number;
  /** ISO-8601 bounds on `startedAt`. */
  since?: string;
  /** Latest `startedAt` to include, ISO-8601. */
  until?: string;
  /** Only runs that have feedback under this key. */
  feedbackKey?: string;
  /** Most runs returned. Defaults to 50. */
  limit?: number;
  /** Runs skipped before the first returned, for paging. */
  offset?: number;
}

/** Where runs are kept, for querying, trees, and feedback. */
export interface TraceStore {
  /** Writes a run, replacing any earlier version of it. */
  save(run: Run): Promise<void> | void;
  /** Reads one run. */
  get(runId: string): Promise<Run | undefined> | Run | undefined;
  /** Runs matching a query, newest first. */
  query(query?: RunQuery): Promise<Run[]> | Run[];
  /** Every run of one trace, assembled into a tree. */
  tree(traceId: string): Promise<RunTree | undefined> | RunTree | undefined;
  /** Appends feedback to a run. */
  addFeedback?(runId: string, feedback: RunFeedback): Promise<void> | void;
  /** Removes runs older than a cutoff, returning how many went. */
  prune?(before: string): Promise<number> | number;
}

/**
 * What is removed from runs before they are stored, so a hidden field is never written anywhere.
 */
export interface RedactionPolicy {
  /** Drops inputs entirely, for a trace that must not hold prompts. */
  hideInputs?: boolean;
  /** Drops outputs entirely. */
  hideOutputs?: boolean;
  /** Dot paths to remove from inputs and outputs. */
  hideFields?: readonly string[];
  /** Last chance to rewrite a run before it is stored: PII redaction, truncation, anything. */
  redact?: (run: Run) => Run;
}

/** Which traces are kept. */
export interface SamplingPolicy {
  /** Share of traces kept, 0 to 1. Defaults to 1. */
  rate?: number;
  /**
   * Keep a trace regardless of the rate once it is finished and turns out to be interesting: an
   * error, a slow run, an expensive one. Tail sampling is why a 1% rate still shows every failure.
   */
  keepErrors?: boolean;
  /** Keeps any trace whose root ran longer than this, in milliseconds, whatever the rate. */
  keepSlowerThanMs?: number;
  /** Keeps any trace that cost more than this, whatever the rate. */
  keepCostlierThan?: number;
}
