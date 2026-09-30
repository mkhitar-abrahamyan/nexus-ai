import type { Run, RunQuery, TraceStore } from '../types/tracing.js';

/** A span of time, as ISO-8601 bounds. */
export interface TimeWindow {
  /** Start, inclusive. */
  since: string;
  /** End, exclusive. Defaults to now. */
  until?: string;
}

/** A metric `detectRegressions()` can compare. */
export type RegressionMetric = 'error-rate' | 'latency' | 'cost';

/**
 * The part of a run `compareRuns()` reads. A traced `Run` satisfies it, and so does a server run
 * mapped to it, which is how a canary is judged against the live revision.
 */
export interface RunSample {
  /** `error` counts against the error rate; anything else counts as a success. */
  status: string;
  /** How long it took, for p95 latency. */
  latencyMs?: number;
  /** What it cost, for mean cost. */
  cost?: number;
  /** Scores people or evaluators gave it, for the feedback comparison. */
  feedback?: ReadonlyArray<{ key: string; score?: number }>;
}

/** Options for `compareRuns()`: what is compared, and how large a change must be to count. */
export interface CompareRunsOptions {
  /** Names the group in each regression and its summary. Defaults to `runs`. */
  group?: string;
  /** Metrics compared. Defaults to all three. */
  metrics?: readonly RegressionMetric[];
  /** Feedback keys whose mean score is compared, such as `helpfulness`. */
  feedback?: readonly string[];
  /** Runs, or feedback scores, each side needs before it is judged. Defaults to 20. */
  minRuns?: number;
  /** A rise in p95 latency, relative, that counts. Defaults to 0.25, a quarter slower. */
  latencyIncrease?: number;
  /** A rise in mean cost, relative, that counts. Defaults to 0.25. */
  costIncrease?: number;
}

/** Options for `detectRegressions()`. */
export interface DetectRegressionsOptions {
  /** Where the runs are. */
  store: TraceStore;
  /** The window being judged, such as the last day. */
  current: TimeWindow;
  /** The window it is compared with, such as the week before. */
  baseline: TimeWindow;
  /** Narrows the runs read. */
  query?: RunQuery;
  /** Compares each run name, model, or provider on its own. Defaults to `name`. */
  groupBy?: 'name' | 'model' | 'provider';
  /** Metrics compared. Defaults to all three. */
  metrics?: readonly RegressionMetric[];
  /** Feedback keys whose mean score is compared, such as `helpfulness`. */
  feedback?: readonly string[];
  /** Runs, or feedback scores, each window needs before a group is judged. Defaults to 20. */
  minRuns?: number;
  /** A rise in p95 latency, relative, that counts. Defaults to 0.25, a quarter slower. */
  latencyIncrease?: number;
  /** A rise in mean cost, relative, that counts. Defaults to 0.25. */
  costIncrease?: number;
  /** Only root runs. On by default. */
  roots?: boolean;
  /** Runs read per window. Defaults to 10,000. */
  limit?: number;
}

/** A metric that got worse between the baseline window and the current one. */
export interface Regression {
  /** The run name, model, or provider. */
  group: string;
  /** `error-rate`, `latency-p95`, `cost`, or `feedback:<key>`. */
  metric: string;
  /** The metric in the baseline window. */
  baseline: number;
  /** The metric in the current window. */
  current: number;
  /** How the metric moved: an absolute change for rates and scores, a relative one for latency and cost. */
  change: number;
  /** Runs, or scores, in each window. */
  samples: { baseline: number; current: number };
  /** One readable line. */
  summary: string;
}

/**
 * Compares a current window of traces with a baseline window and reports what got worse, per run
 * name, model, or provider. An error rate counts when the rise passes a two-proportion z-test at 95%;
 * p95 latency and mean cost when they rise by the relative margin; a feedback score when its mean
 * falls by more than twice the standard error. A group without `minRuns` in both windows is not
 * judged, so a quiet endpoint does not raise alarms on noise.
 */
export async function detectRegressions(options: DetectRegressionsOptions): Promise<Regression[]> {
  const read = async (window: TimeWindow) => {
    const runs = await options.store.query({
      ...options.query,
      since: window.since,
      ...(window.until ? { until: window.until } : {}),
      limit: options.limit ?? 10_000,
    });
    return (options.roots ?? true) ? runs.filter((run) => !run.parentId) : runs;
  };
  const [baselineRuns, currentRuns] = await Promise.all([read(options.baseline), read(options.current)]);
  const key = options.groupBy ?? 'name';
  const group = (runs: Run[]) => {
    const groups = new Map<string, Run[]>();
    for (const run of runs) {
      const name = run[key] ?? 'unknown';
      groups.set(name, [...(groups.get(name) ?? []), run]);
    }
    return groups;
  };
  const baselineGroups = group(baselineRuns);
  const currentGroups = group(currentRuns);
  const regressions: Regression[] = [];
  for (const [name, current] of currentGroups) {
    regressions.push(...compareRuns(baselineGroups.get(name) ?? [], current, { ...options, group: name }));
  }
  return regressions;
}

/**
 * Compares two sets of runs and reports what got worse in the second, with the same tests
 * `detectRegressions()` applies to time windows: a two-proportion z-test at 95% for the error rate, a
 * relative margin for p95 latency and mean cost, and twice the standard error for a feedback score.
 * Neither side is judged below `minRuns`, so a handful of runs never raises an alarm.
 *
 * The two sets can be anything comparable: last week and this week, or — as the canary guard in
 * `nexus-ai-pro/server/deployments` uses it — the live revision and a canary over the same hour.
 */
export function compareRuns(
  baseline: readonly RunSample[],
  current: readonly RunSample[],
  options: CompareRunsOptions = {},
): Regression[] {
  const name = options.group ?? 'runs';
  const minRuns = options.minRuns ?? 20;
  const metrics = new Set(options.metrics ?? ['error-rate', 'latency', 'cost']);
  const regressions: Regression[] = [];
  const samples = { baseline: baseline.length, current: current.length };
  if (samples.baseline >= minRuns && samples.current >= minRuns) {
    if (metrics.has('error-rate')) {
      const before = baseline.filter((run) => run.status === 'error').length;
      const after = current.filter((run) => run.status === 'error').length;
      const p1 = before / baseline.length;
      const p2 = after / current.length;
      const pooled = (before + after) / (baseline.length + current.length);
      const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / baseline.length + 1 / current.length));
      if (p2 > p1 && standardError > 0 && (p2 - p1) / standardError >= 1.96) {
        regressions.push({
          group: name,
          metric: 'error-rate',
          baseline: p1,
          current: p2,
          change: p2 - p1,
          samples,
          summary: `${name}: error rate rose from ${percent(p1)} to ${percent(p2)}`,
        });
      }
    }
    if (metrics.has('latency')) {
      const before = percentile(baseline.map((run) => run.latencyMs).filter(isNumber), 0.95);
      const after = percentile(current.map((run) => run.latencyMs).filter(isNumber), 0.95);
      const margin = options.latencyIncrease ?? 0.25;
      if (before !== undefined && after !== undefined && before > 0 && after >= before * (1 + margin)) {
        regressions.push({
          group: name,
          metric: 'latency-p95',
          baseline: before,
          current: after,
          change: after / before - 1,
          samples,
          summary: `${name}: p95 latency rose from ${Math.round(before)}ms to ${Math.round(after)}ms`,
        });
      }
    }
    if (metrics.has('cost')) {
      const before = mean(baseline.map((run) => run.cost).filter(isNumber));
      const after = mean(current.map((run) => run.cost).filter(isNumber));
      const margin = options.costIncrease ?? 0.25;
      if (before !== undefined && after !== undefined && before > 0 && after >= before * (1 + margin)) {
        regressions.push({
          group: name,
          metric: 'cost',
          baseline: before,
          current: after,
          change: after / before - 1,
          samples,
          summary: `${name}: mean cost rose from $${before.toFixed(4)} to $${after.toFixed(4)}`,
        });
      }
    }
  }
  for (const feedbackKey of options.feedback ?? []) {
    const scores = (runs: readonly RunSample[]) =>
      runs
        .flatMap((run) => (run.feedback ?? []).filter((item) => item.key === feedbackKey).map((item) => item.score))
        .filter(isNumber);
    const before = scores(baseline);
    const after = scores(current);
    if (before.length < minRuns || after.length < minRuns) continue;
    const m1 = mean(before) as number;
    const m2 = mean(after) as number;
    const standardError = Math.sqrt(variance(before) / before.length + variance(after) / after.length);
    if (m2 < m1 && (standardError === 0 || (m1 - m2) / standardError >= 1.96)) {
      regressions.push({
        group: name,
        metric: `feedback:${feedbackKey}`,
        baseline: m1,
        current: m2,
        change: m2 - m1,
        samples: { baseline: before.length, current: after.length },
        summary: `${name}: ${feedbackKey} fell from ${m1.toFixed(2)} to ${m2.toFixed(2)}`,
      });
    }
  }
  return regressions;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mean(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const average = mean(values) ?? 0;
  return values.length < 2
    ? 0
    : values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
}

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
