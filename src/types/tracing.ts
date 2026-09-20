/**
 * Traces: what actually happened during a run, in a shape you can query afterwards.
 *
 * The package already exported metrics and OpenTelemetry spans, but neither can answer "show me the
 * agent runs that failed yesterday and what the model was asked". A metric is a number without a
 * story, and an exported span leaves for another system. A run tree keeps the inputs, the outputs,
 * the cost, and the shape of the call, locally, where it can be searched, compared, and turned into
 * an evaluation dataset.
 */

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

export type RunStatus = 'running' | 'ok' | 'error';

export interface RunFeedback {
  key: string;
  score?: number;
  value?: unknown;
  comment?: string;
  /** Who or what left it: a person, an online evaluator, a heuristic. */
  source?: string;
  createdAt: string;
}

export interface Run {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  inputs?: unknown;
  outputs?: unknown;
  error?: { name: string; message: string };
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Token counts and any other units a provider reported. */
  usage?: Record<string, number>;
  cost?: number;
  model?: string;
  provider?: string;
  feedback?: RunFeedback[];
}

/** A run and the runs beneath it, which is how a trace is read rather than a flat list. */
export interface RunTree extends Run {
  children: RunTree[];
}

export interface RunQuery {
  traceId?: string;
  kind?: RunKind | RunKind[];
  status?: RunStatus;
  name?: string;
  model?: string;
  provider?: string;
  /** Every tag listed must be present. */
  tags?: string[];
  /** Exact matches on metadata fields, as dot paths. */
  metadata?: Record<string, unknown>;
  minLatencyMs?: number;
  minCost?: number;
  /** ISO-8601 bounds on `startedAt`. */
  since?: string;
  until?: string;
  /** Only runs that have feedback under this key. */
  feedbackKey?: string;
  limit?: number;
  offset?: number;
}

export interface TraceStore {
  /** Writes a run, replacing any earlier version of it. */
  save(run: Run): Promise<void> | void;
  get(runId: string): Promise<Run | undefined> | Run | undefined;
  /** Runs matching a query, newest first. */
  query(query?: RunQuery): Promise<Run[]> | Run[];
  /** Every run of one trace, assembled into a tree. */
  tree(traceId: string): Promise<RunTree | undefined> | RunTree | undefined;
  addFeedback?(runId: string, feedback: RunFeedback): Promise<void> | void;
  /** Removes runs older than a cutoff, returning how many went. */
  prune?(before: string): Promise<number> | number;
}

export interface RedactionPolicy {
  /** Drops inputs entirely, for a trace that must not hold prompts. */
  hideInputs?: boolean;
  hideOutputs?: boolean;
  /** Dot paths to remove from inputs and outputs. */
  hideFields?: readonly string[];
  /** Last chance to rewrite a run before it is stored: PII redaction, truncation, anything. */
  redact?: (run: Run) => Run;
}

export interface SamplingPolicy {
  /** Share of traces kept, 0 to 1. Defaults to 1. */
  rate?: number;
  /**
   * Keep a trace regardless of the rate once it is finished and turns out to be interesting: an
   * error, a slow run, an expensive one. Tail sampling is why a 1% rate still shows every failure.
   */
  keepErrors?: boolean;
  keepSlowerThanMs?: number;
  keepCostlierThan?: number;
}
