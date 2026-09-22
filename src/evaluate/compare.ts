import type { EvaluationScore, ExampleResult, Experiment } from '../types/evaluate.js';
import { stats } from './run.js';

/** How one metric moved between two experiments. */
export interface MetricComparison {
  /** The score key. */
  key: string;
  /** Mean in the baseline. */
  baseline: number;
  /** Mean in the candidate. */
  candidate: number;
  /** Mean of the per-example differences, candidate minus baseline. */
  delta: number;
  /** 95% interval for the delta, from a paired bootstrap. Excludes zero when the change is real. */
  ci95: [number, number];
  /** `better`, `worse`, or `unchanged` — unchanged when the interval spans zero. */
  verdict: 'better' | 'worse' | 'unchanged';
}

/** How one example's score moved. */
export interface ExampleComparison {
  /** The example. */
  exampleId: string;
  /** The score key. */
  key: string;
  /** Its score in the baseline. */
  baseline: number;
  /** Its score in the candidate. */
  candidate: number;
  /** The change, signed so a positive number is always an improvement. */
  delta: number;
}

/** What changed between a baseline experiment and a candidate. */
export interface ExperimentComparison {
  /** The baseline experiment. */
  baseline: { id: string; name: string };
  /** The candidate experiment. */
  candidate: { id: string; name: string };
  /** Present when the two experiments did not run over the same dataset version. */
  datasetMismatch?: { baseline: string; candidate: string };
  /** One entry per metric both experiments scored. */
  metrics: MetricComparison[];
  /** The examples that moved most, worst first. */
  regressions: ExampleComparison[];
  /** The examples that improved most, best first. */
  improvements: ExampleComparison[];
  /** True when any metric got worse beyond noise, or a new error appeared. */
  regressed: boolean;
  /** Examples that failed in the candidate but not the baseline. */
  newErrors: string[];
  /** Examples that failed in the baseline but not the candidate. */
  fixedErrors: string[];
}

/**
 * Options for `compareExperiments()`. `latency`, `total-cost`, and `cost` are lower-is-better
 * unless replaced.
 */
export interface CompareOptions {
  /** Metrics where a lower number is better, such as latency or cost. */
  lowerIsBetter?: readonly string[];
  /** Bootstrap resamples used for the interval. Defaults to 2,000. */
  resamples?: number;
  /** Deterministic sampling, so a comparison in CI is reproducible. Defaults to a fixed seed. */
  seed?: number;
  /** Examples listed in `regressions` and `improvements`. Defaults to 10. */
  topExamples?: number;
}

/**
 * Compares two experiments and says whether the change is real.
 *
 * A mean that moved from 0.81 to 0.83 says nothing on its own — with twenty examples that is noise,
 * and shipping on it is how a quality gate becomes a coin toss. The interval comes from a paired
 * bootstrap over the per-example deltas, which needs no assumption about how the scores are
 * distributed, and pairing is what removes the variation caused by the examples themselves.
 */
export function compareExperiments(
  baseline: Experiment,
  candidate: Experiment,
  options: CompareOptions = {},
): ExperimentComparison {
  const lowerIsBetter = new Set(options.lowerIsBetter ?? ['latency', 'total-cost', 'cost']);
  const baselineScores = index(baseline.results);
  const candidateScores = index(candidate.results);

  const keys = [
    ...new Set([...baselineScores.keys(), ...candidateScores.keys()].map((entry) => entry.split('␟')[1] as string)),
  ];
  const metrics: MetricComparison[] = [];
  const exampleDeltas: ExampleComparison[] = [];

  for (const key of keys) {
    const pairs: Array<{ exampleId: string; baseline: number; candidate: number }> = [];
    for (const [entry, value] of baselineScores) {
      const [exampleId, metric] = entry.split('␟') as [string, string];
      if (metric !== key) continue;
      const other = candidateScores.get(entry);
      if (other === undefined) continue;
      pairs.push({ exampleId, baseline: value, candidate: other });
    }
    if (pairs.length === 0) continue;

    const deltas = pairs.map((pair) => pair.candidate - pair.baseline);
    const meanDelta = stats(deltas).mean;
    const ci95 = bootstrapInterval(deltas, options.resamples ?? 2_000, options.seed ?? 12_345);
    const improved = lowerIsBetter.has(key) ? meanDelta < 0 : meanDelta > 0;
    const significant = ci95[0] > 0 || ci95[1] < 0;

    metrics.push({
      key,
      baseline: stats(pairs.map((pair) => pair.baseline)).mean,
      candidate: stats(pairs.map((pair) => pair.candidate)).mean,
      delta: meanDelta,
      ci95,
      verdict: !significant ? 'unchanged' : improved ? 'better' : 'worse',
    });

    for (const pair of pairs) {
      if (pair.candidate === pair.baseline) continue;
      exampleDeltas.push({
        exampleId: pair.exampleId,
        key,
        baseline: pair.baseline,
        candidate: pair.candidate,
        delta: lowerIsBetter.has(key) ? pair.baseline - pair.candidate : pair.candidate - pair.baseline,
      });
    }
  }

  const failed = (experiment: Experiment): Set<string> =>
    new Set(experiment.results.filter((result) => result.error).map((result) => result.exampleId));
  const baselineFailures = failed(baseline);
  const candidateFailures = failed(candidate);
  const newErrors = [...candidateFailures].filter((id) => !baselineFailures.has(id));
  const fixedErrors = [...baselineFailures].filter((id) => !candidateFailures.has(id));

  const top = options.topExamples ?? 10;
  return {
    baseline: { id: baseline.id, name: baseline.name },
    candidate: { id: candidate.id, name: candidate.name },
    ...(baseline.dataset.version === candidate.dataset.version
      ? {}
      : { datasetMismatch: { baseline: baseline.dataset.version, candidate: candidate.dataset.version } }),
    metrics,
    regressions: exampleDeltas
      .filter((item) => item.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, top),
    improvements: exampleDeltas
      .filter((item) => item.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, top),
    regressed: metrics.some((metric) => metric.verdict === 'worse') || newErrors.length > 0,
    newErrors,
    fixedErrors,
  };
}

/** A comparison as text, for a pull-request comment or a CI log. */
export function formatComparison(comparison: ExperimentComparison): string {
  const lines = [`${comparison.candidate.name} vs ${comparison.baseline.name}`];
  if (comparison.datasetMismatch) {
    lines.push(
      `  ! dataset differs: ${comparison.datasetMismatch.baseline} vs ${comparison.datasetMismatch.candidate}; the comparison is not like for like`,
    );
  }
  for (const metric of comparison.metrics) {
    const arrow = metric.verdict === 'better' ? '▲' : metric.verdict === 'worse' ? '▼' : '=';
    lines.push(
      `  ${arrow} ${metric.key}: ${round(metric.baseline)} → ${round(metric.candidate)} (${signed(metric.delta)}, 95% CI ${round(metric.ci95[0])}..${round(metric.ci95[1])})`,
    );
  }
  if (comparison.newErrors.length > 0) lines.push(`  ! new failures: ${comparison.newErrors.join(', ')}`);
  if (comparison.fixedErrors.length > 0) lines.push(`  + fixed failures: ${comparison.fixedErrors.join(', ')}`);
  for (const example of comparison.regressions.slice(0, 5)) {
    lines.push(`  - ${example.exampleId} ${example.key}: ${round(example.baseline)} → ${round(example.candidate)}`);
  }
  return lines.join('\n');
}

function index(results: ExampleResult[]): Map<string, number> {
  // Repetitions of one example are averaged first, so a noisy target does not dominate the pairing.
  const grouped = new Map<string, number[]>();
  for (const result of results) {
    for (const score of result.scores) {
      const key = `${result.exampleId}␟${score.key}`;
      grouped.set(key, [...(grouped.get(key) ?? []), score.score]);
    }
  }
  return new Map([...grouped.entries()].map(([key, values]) => [key, stats(values).mean]));
}

/** Paired bootstrap: resample the per-example deltas and take the middle 95% of the means. */
function bootstrapInterval(deltas: number[], resamples: number, seed: number): [number, number] {
  if (deltas.length < 2) return [0, 0];
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let sample = 0; sample < resamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(random() * deltas.length)] as number;
    }
    means.push(total / deltas.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)] as number, means[Math.floor(resamples * 0.975)] as number];
}

/** A small deterministic generator, so a CI comparison gives the same verdict twice. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${round(value)}`;
}

/** Summary scores as a map, for asserting on one in a test or a gate. */
export function scoreMap(scores: EvaluationScore[]): Record<string, number> {
  return Object.fromEntries(scores.map((score) => [score.key, score.score]));
}
