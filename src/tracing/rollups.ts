import type { Run, RunFeedback, RunKind, RunQuery, RunTree, TraceStore } from '../types/tracing.js';

/**
 * Hourly totals of runs, so a dashboard reads a few rows instead of every trace.
 *
 * Traces are the forensic record: everything about one run. A chart of cost or errors over a week
 * needs none of that, only sums, and reading 100,000 traces to draw it is how a dashboard gets slow
 * as the service grows. A rollup keeps one row per hour, kind, model, provider, and tenant, updated
 * as runs finish.
 */

/** What one rollup row is counted by. */
export interface RollupKey {
  /** The hour, as ISO-8601 truncated to the hour: `2026-10-04T13:00:00.000Z`. */
  hour: string;
  /** The run kind. */
  kind: RunKind;
  /** The run's name, for root runs, such as a graph or an assistant. Empty for others. */
  name: string;
  /** The model, or an empty string. */
  model: string;
  /** The provider, or an empty string. */
  provider: string;
  /** `metadata.tenantId`, or an empty string. */
  tenant: string;
}

/** The totals of one rollup row. */
export interface RollupTotals {
  /** Runs counted. */
  runs: number;
  /** Of those, runs that failed. */
  errors: number;
  /** Their cost. */
  cost: number;
  /** Input tokens reported. */
  inputTokens: number;
  /** Output tokens reported. */
  outputTokens: number;
  /** Latency counts per bucket of `ROLLUP_LATENCY_BOUNDS_MS`, for percentiles without the runs. */
  latency: number[];
}

/** One rollup row: its key and its totals. */
export interface RollupRow extends RollupKey, RollupTotals {}

/** Which rows to read. Every field narrows; the hour range is inclusive. */
export interface RollupQuery {
  /** The first hour, ISO-8601. */
  since?: string;
  /** The last hour, ISO-8601. */
  until?: string;
  /** Rows of these kinds. */
  kind?: RunKind | RunKind[];
  /** Rows of this model. */
  model?: string;
  /** Rows of this provider. */
  provider?: string;
  /** Rows of this tenant. */
  tenant?: string;
  /** Rows of this name. */
  name?: string;
}

/** Where rollup rows live. Adding to a row that does not exist creates it. */
export interface RollupStore {
  /** Adds totals to the row for `key`. */
  add(key: RollupKey, totals: RollupTotals): Promise<void> | void;
  /** Rows matching a query, oldest hour first. */
  query(query?: RollupQuery): Promise<RollupRow[]> | RollupRow[];
}

/**
 * Upper bounds of the latency buckets, in milliseconds; a last bucket holds everything slower. A
 * percentile read from them is exact to the bucket, which is close enough for a chart.
 */
export const ROLLUP_LATENCY_BOUNDS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;

/** The latency at percentile `p`, 0 to 1, from rollup buckets: the bound of the bucket it falls in. */
export function rollupPercentile(latency: readonly number[], p: number): number | undefined {
  const total = latency.reduce((sum, count) => sum + count, 0);
  if (total === 0) return undefined;
  const target = Math.max(1, Math.ceil(total * Math.min(1, Math.max(0, p))));
  let seen = 0;
  for (const [index, count] of latency.entries()) {
    seen += count;
    if (seen >= target) return ROLLUP_LATENCY_BOUNDS_MS[index] ?? Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** Rows summed across their keys: a total over a day, a model, or a whole range. */
export function sumRollups(rows: readonly RollupTotals[]): RollupTotals {
  const total: RollupTotals = emptyTotals();
  for (const row of rows) {
    total.runs += row.runs;
    total.errors += row.errors;
    total.cost += row.cost;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    for (const [index, count] of row.latency.entries()) total.latency[index] = (total.latency[index] ?? 0) + count;
  }
  return total;
}

/** Rollup rows in process memory. Rows are small, so a year of hourly rows for a few models fits easily. */
export class MemoryRollupStore implements RollupStore {
  private readonly rows = new Map<string, RollupRow>();

  /** Adds totals to a row. */
  add(key: RollupKey, totals: RollupTotals): void {
    const id = `${key.hour}|${key.kind}|${key.name}|${key.model}|${key.provider}|${key.tenant}`;
    const row = this.rows.get(id);
    if (!row) {
      this.rows.set(id, { ...key, ...totals, latency: [...totals.latency] });
      return;
    }
    row.runs += totals.runs;
    row.errors += totals.errors;
    row.cost += totals.cost;
    row.inputTokens += totals.inputTokens;
    row.outputTokens += totals.outputTokens;
    for (const [index, count] of totals.latency.entries()) row.latency[index] = (row.latency[index] ?? 0) + count;
  }

  /** Rows matching a query, oldest hour first. */
  query(query: RollupQuery = {}): RollupRow[] {
    return [...this.rows.values()]
      .filter((row) => matches(row, query))
      .sort((a, b) => a.hour.localeCompare(b.hour))
      .map((row) => ({ ...row, latency: [...row.latency] }));
  }

  /** Rows held. */
  size(): number {
    return this.rows.size;
  }
}

/** Options for `rollupTraceStore()`. */
export interface RollupTraceStoreOptions {
  /** Which finished runs are counted. Defaults to every root run, and every model and embedding run. */
  include?: (run: Run) => boolean;
}

/**
 * Wraps a trace store so every run that finishes is also added to a rollup.
 *
 * Reads go to the wrapped store unchanged. A run is counted once, when it is saved finished; a save
 * of a run still running, which an `incremental` tracer makes, is not counted, and neither is
 * feedback added later.
 */
export function rollupTraceStore(
  store: TraceStore,
  rollups: RollupStore,
  options: RollupTraceStoreOptions = {},
): TraceStore {
  const include = options.include ?? ((run: Run) => !run.parentId || run.kind === 'model' || run.kind === 'embedding');
  return {
    async save(run: Run) {
      await store.save(run);
      if (run.status === 'running' || !include(run)) return;
      await rollups.add(rollupKeyOf(run), totalsOf(run));
    },
    get: (runId: string) => store.get(runId),
    query: (query?: RunQuery) => store.query(query),
    tree: (traceId: string): Promise<RunTree | undefined> | RunTree | undefined => store.tree(traceId),
    async addFeedback(runId: string, feedback: RunFeedback) {
      if (store.addFeedback) {
        await store.addFeedback(runId, feedback);
        return;
      }
      // Straight to the wrapped store: feedback is not a second finish, so it is not counted again.
      const run = await store.get(runId);
      if (run) await store.save({ ...run, feedback: [...(run.feedback ?? []), feedback] });
    },
    ...(store.prune
      ? { prune: (before: string) => (store.prune as (cutoff: string) => Promise<number> | number)(before) }
      : {}),
  };
}

/** The rollup row a finished run belongs to. */
export function rollupKeyOf(run: Run): RollupKey {
  const started = new Date(run.startedAt);
  started.setUTCMinutes(0, 0, 0);
  const tenant = run.metadata?.tenantId;
  return {
    hour: started.toISOString(),
    kind: run.kind,
    name: run.parentId ? '' : run.name,
    model: run.model ?? '',
    provider: run.provider ?? '',
    tenant: typeof tenant === 'string' ? tenant : '',
  };
}

function totalsOf(run: Run): RollupTotals {
  const totals = emptyTotals();
  totals.runs = 1;
  totals.errors = run.status === 'error' ? 1 : 0;
  totals.cost = run.cost ?? 0;
  totals.inputTokens = run.usage?.inputTokens ?? run.usage?.promptTokens ?? 0;
  totals.outputTokens = run.usage?.outputTokens ?? run.usage?.completionTokens ?? 0;
  const latency = run.latencyMs ?? 0;
  const bucket = ROLLUP_LATENCY_BOUNDS_MS.findIndex((bound) => latency <= bound);
  totals.latency[bucket === -1 ? ROLLUP_LATENCY_BOUNDS_MS.length : bucket] = 1;
  return totals;
}

function emptyTotals(): RollupTotals {
  return {
    runs: 0,
    errors: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    latency: Array.from({ length: ROLLUP_LATENCY_BOUNDS_MS.length + 1 }, () => 0),
  };
}

function matches(row: RollupRow, query: RollupQuery): boolean {
  if (query.since && row.hour < hourOf(query.since)) return false;
  if (query.until && row.hour > query.until) return false;
  if (query.kind !== undefined && !(Array.isArray(query.kind) ? query.kind : [query.kind]).includes(row.kind))
    return false;
  if (query.model !== undefined && row.model !== query.model) return false;
  if (query.provider !== undefined && row.provider !== query.provider) return false;
  if (query.tenant !== undefined && row.tenant !== query.tenant) return false;
  if (query.name !== undefined && row.name !== query.name) return false;
  return true;
}

function hourOf(iso: string): string {
  const date = new Date(iso);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}
