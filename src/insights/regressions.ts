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

/**
 * Each run's score for a feedback key: the mean of the scores it was given, so a run counts once
 * however many times it was rated. One caller rating one run a hundred times can then neither meet a
 * minimum sample alone nor outweigh every other run.
 */
function runScores(runs: readonly RunSample[], key: string): number[] {
  return runs.flatMap((run) => {
    const given = (run.feedback ?? [])
      .filter((item) => item.key === key)
      .map((item) => item.score)
      .filter(isNumber);
    return given.length ? [given.reduce((sum, score) => sum + score, 0) / given.length] : [];
  });
}

/** Options for `compareRuns()`: what is compared, and how large a change must be to count. */
export interface CompareRunsOptions {
  /** Names the group in each regression and its summary. Defaults to `runs`. */
  group?: string;
  /** Metrics compared. Defaults to all three. */
  metrics?: readonly RegressionMetric[];
  /** Feedback keys whose mean score is compared, such as `helpfulness`. */
  feedback?: readonly string[];
  /**
   * Runs each side needs before it is judged; for a feedback score, runs that have one. Defaults to
   * 20. A run counts once per feedback key, however many times it was rated.
   */
  minRuns?: number;
  /** A rise in p95 latency, relative, that counts. Defaults to 0.25, a quarter slower. */
  latencyIncrease?: number;
  /**
   * The smallest rise in p95 latency, in milliseconds, that counts, however large it is relatively.
   * Defaults to 0; raise it so a run that goes from 2 ms to 3 ms is not a regression.
   */
  minLatencyChangeMs?: number;
  /** A rise in mean cost, relative, that counts. Defaults to 0.25. */
  costIncrease?: number;
  /**
   * Judges every metric the way an evaluation comparison does, at this confidence, such as 0.95. Each
   * metric is resampled by bootstrap, and it regresses only when two things hold: the change's
   * interval does not reach zero, and the change is at least that metric's minimum effect. Noise and
   * trivia both stay below the bar. Without it, the error rate uses a z-test at 95%, and latency and
   * cost use their margins alone.
   */
  confidence?: number;
  /** The smallest rise in the error rate, absolute, that counts under `confidence`. Defaults to 0.02. */
  minErrorRateIncrease?: number;
  /** The smallest fall in a feedback score's mean, absolute, that counts under `confidence`. Defaults to 0.05. */
  minFeedbackDrop?: number;
  /** Bootstrap resamples under `confidence`. Defaults to 1,000. */
  resamples?: number;
  /** Seeds the resampling, so the same runs always get the same verdict. Defaults to 1. */
  seed?: number;
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
  /**
   * Runs each window needs before a group is judged; for a feedback score, runs that have one.
   * Defaults to 20.
   */
  minRuns?: number;
  /** A rise in p95 latency, relative, that counts. Defaults to 0.25, a quarter slower. */
  latencyIncrease?: number;
  /**
   * The smallest rise in p95 latency, in milliseconds, that counts, however large it is relatively.
   * Defaults to 0; raise it so a run that goes from 2 ms to 3 ms is not a regression.
   */
  minLatencyChangeMs?: number;
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
  /** The change's interval, in the units of `change`, when the comparison was judged with `confidence`. */
  interval?: [number, number];
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
  if (options.confidence !== undefined) return judgedRegressions(baseline, current, options, options.confidence);
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
      if (
        before !== undefined &&
        after !== undefined &&
        before > 0 &&
        after >= before * (1 + margin) &&
        after - before >= (options.minLatencyChangeMs ?? 0)
      ) {
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
    const scores = (runs: readonly RunSample[]) => runScores(runs, feedbackKey);
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

/**
 * `compareRuns()` under `confidence`: each metric judged by a bootstrap interval and a minimum effect,
 * as an evaluation comparison judges a score.
 */
function judgedRegressions(
  baseline: readonly RunSample[],
  current: readonly RunSample[],
  options: CompareRunsOptions,
  confidence: number,
): Regression[] {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError('confidence is between 0 and 1, such as 0.95');
  const name = options.group ?? 'runs';
  const minRuns = options.minRuns ?? 20;
  const metrics = new Set(options.metrics ?? ['error-rate', 'latency', 'cost']);
  const judge = (
    before: readonly number[],
    after: readonly number[],
    shape: Pick<MetricVerdictOptions, 'statistic' | 'relative' | 'worse' | 'minEffect'>,
  ) =>
    before.length >= minRuns && after.length >= minRuns
      ? metricVerdict(before, after, {
          ...shape,
          confidence,
          resamples: options.resamples ?? 1_000,
          seed: options.seed ?? 1,
        })
      : undefined;
  const regressions: Regression[] = [];
  const add = (metric: string, verdict: MetricVerdict | undefined, counts: Regression['samples'], line: string) => {
    if (!verdict?.regressed) return;
    regressions.push({
      group: name,
      metric,
      baseline: verdict.baseline,
      current: verdict.current,
      change: verdict.change,
      samples: counts,
      interval: verdict.interval,
      summary: `${name}: ${line} (${Math.round(confidence * 100)}% interval ${formatInterval(verdict.interval, metric)})`,
    });
  };
  const counts = { baseline: baseline.length, current: current.length };

  if (metrics.has('error-rate')) {
    const errors = (runs: readonly RunSample[]) => runs.map((run) => (run.status === 'error' ? 1 : 0));
    const verdict = judge(errors(baseline), errors(current), {
      statistic: meanOf,
      relative: false,
      worse: 'rise',
      minEffect: options.minErrorRateIncrease ?? 0.02,
    });
    add(
      'error-rate',
      verdict,
      counts,
      `error rate rose from ${percent(verdict?.baseline ?? 0)} to ${percent(verdict?.current ?? 0)}`,
    );
  }
  if (metrics.has('latency')) {
    const latencies = (runs: readonly RunSample[]) => runs.map((run) => run.latencyMs).filter(isNumber);
    const before = latencies(baseline);
    const after = latencies(current);
    const verdict = judge(before, after, {
      statistic: (values) => percentile(values, 0.95) ?? 0,
      relative: true,
      worse: 'rise',
      minEffect: options.latencyIncrease ?? 0.25,
    });
    // A relative rise of a few milliseconds is not a regression, however confident.
    const large = verdict && verdict.current - verdict.baseline >= (options.minLatencyChangeMs ?? 0);
    add(
      'latency-p95',
      large ? verdict : undefined,
      { baseline: before.length, current: after.length },
      `p95 latency rose from ${Math.round(verdict?.baseline ?? 0)}ms to ${Math.round(verdict?.current ?? 0)}ms`,
    );
  }
  if (metrics.has('cost')) {
    const costs = (runs: readonly RunSample[]) => runs.map((run) => run.cost).filter(isNumber);
    const before = costs(baseline);
    const after = costs(current);
    const verdict = judge(before, after, {
      statistic: meanOf,
      relative: true,
      worse: 'rise',
      minEffect: options.costIncrease ?? 0.25,
    });
    add(
      'cost',
      verdict,
      { baseline: before.length, current: after.length },
      `mean cost rose from $${(verdict?.baseline ?? 0).toFixed(4)} to $${(verdict?.current ?? 0).toFixed(4)}`,
    );
  }
  for (const feedbackKey of options.feedback ?? []) {
    const scores = (runs: readonly RunSample[]) => runScores(runs, feedbackKey);
    const before = scores(baseline);
    const after = scores(current);
    const verdict = judge(before, after, {
      statistic: meanOf,
      relative: false,
      worse: 'fall',
      minEffect: options.minFeedbackDrop ?? 0.05,
    });
    add(
      `feedback:${feedbackKey}`,
      verdict,
      { baseline: before.length, current: after.length },
      `${feedbackKey} fell from ${(verdict?.baseline ?? 0).toFixed(2)} to ${(verdict?.current ?? 0).toFixed(2)}`,
    );
  }
  return regressions;
}

/** How a metric is judged under `confidence`. */
interface MetricVerdictOptions {
  /** The statistic compared: a mean, or a percentile. */
  statistic: (values: readonly number[]) => number;
  /** Whether the change is a ratio, for latency and cost, or a difference, for rates and scores. */
  relative: boolean;
  /** Whether a rise is worse, for errors, latency, and cost, or a fall, for a quality score. */
  worse: 'rise' | 'fall';
  /** The smallest change in the bad direction that counts. */
  minEffect: number;
  confidence: number;
  resamples: number;
  seed: number;
}

interface MetricVerdict {
  baseline: number;
  current: number;
  change: number;
  interval: [number, number];
  regressed: boolean;
}

/**
 * One metric compared between two independent samples by bootstrap: both sides resampled with
 * replacement, the change computed each time, the interval taken from the percentiles. It regresses
 * when the observed change is at least `minEffect` in the bad direction and the interval does not
 * reach zero.
 */
function metricVerdict(
  baseline: readonly number[],
  current: readonly number[],
  options: MetricVerdictOptions,
): MetricVerdict {
  const change = (before: number, after: number) =>
    options.relative ? (before === 0 ? 0 : after / before - 1) : after - before;
  const before = options.statistic(baseline);
  const after = options.statistic(current);
  const random = seeded(options.seed);
  const resample = (values: readonly number[]) =>
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] as number);
  const draws: number[] = [];
  for (let index = 0; index < options.resamples; index += 1) {
    draws.push(change(options.statistic(resample(baseline)), options.statistic(resample(current))));
  }
  draws.sort((a, b) => a - b);
  const tail = (1 - options.confidence) / 2;
  const at = (quantile: number) =>
    draws[Math.min(draws.length - 1, Math.max(0, Math.floor(quantile * draws.length)))] as number;
  const interval: [number, number] = [at(tail), at(1 - tail)];
  const observed = change(before, after);
  const regressed =
    options.worse === 'rise'
      ? observed >= options.minEffect && interval[0] > 0
      : -observed >= options.minEffect && interval[1] < 0;
  return { baseline: before, current: after, change: observed, interval, regressed };
}

/** Mulberry32: the same seed gives the same resamples, so a judgement can be reproduced. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function meanOf(values: readonly number[]): number {
  return mean(values) ?? 0;
}

function formatInterval(interval: [number, number], metric: string): string {
  const relative = metric === 'latency-p95' || metric === 'cost';
  const show = (value: number) => (relative ? `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%` : value.toFixed(3));
  return `${show(interval[0])} to ${show(interval[1])}`;
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
