import type { CompareOptions } from '../evaluate/compare.js';
import type { Experiment, ExperimentStore } from '../types/evaluate.js';
import type { PromptReference } from '../types/prompts.js';
import type { GateResult } from './errors.js';
import type { PromotionContext, PromotionGate } from './registry.js';

/** Options for `experimentGate()`. */
export interface ExperimentGateOptions {
  /** Where experiments are stored. */
  store: ExperimentStore;
  /** Requires an experiment with this name. Any name counts when omitted. */
  experiment?: string;
  /** Requires the experiment to have run over this dataset. */
  dataset?: string;
  /** Minimum mean per metric, such as `{ correctness: 0.9 }`. A metric the experiment lacks fails. */
  thresholds?: Record<string, number>;
  /** Examples that may produce no output at all. Defaults to 0. */
  maxErrors?: number;
  /**
   * Also compares with the newest experiment for the version the label serves now, and refuses a
   * regression beyond noise. Options pass through to `compareExperiments()`.
   */
  noRegression?: boolean | CompareOptions;
  /** Experiments searched, newest first. Defaults to 50. */
  limit?: number;
  /** Names the gate in reports. Defaults to `experiment`. */
  name?: string;
}

function promptOf(experiment: Experiment): PromptReference | undefined {
  const prompt = experiment.metadata?.prompt as PromptReference | undefined;
  return prompt && typeof prompt === 'object' ? prompt : undefined;
}

/**
 * The newest experiment whose metadata names a subject's version, under the metadata key the subject
 * records: `prompt` for prompts, `context` for context bundles.
 */
async function newestFor(
  options: ExperimentGateOptions,
  subject: (experiment: Experiment) => { name?: string; version?: string } | undefined,
  name: string,
  version: string,
): Promise<Experiment | undefined> {
  const experiments = await options.store.list({
    ...(options.experiment === undefined ? {} : { name: options.experiment }),
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    limit: options.limit ?? 50,
  });
  return experiments.find((experiment) => {
    const found = subject(experiment);
    return found?.name === name && found.version === version;
  });
}

/**
 * The verdict of an experiment gate, for anything versioned whose experiments name it in metadata.
 * Shared by the prompt and context-bundle gates, so both judge a promotion the same way.
 */
export async function experimentVerdict(
  options: ExperimentGateOptions,
  subject: (experiment: Experiment) => { name?: string; version?: string } | undefined,
  name: string,
  version: string,
  currentVersion: string | undefined,
): Promise<GateResult> {
  const gate = options.name ?? 'experiment';
  const candidate = await newestFor(options, subject, name, version);
  if (!candidate) {
    return {
      gate,
      ok: false,
      reason: `no ${options.experiment ? `"${options.experiment}" ` : ''}experiment for ${version}`,
    };
  }
  if (candidate.errors > (options.maxErrors ?? 0)) {
    return { gate, ok: false, reason: `${candidate.errors} examples failed in ${candidate.id}` };
  }
  for (const [key, minimum] of Object.entries(options.thresholds ?? {})) {
    const metric = candidate.metrics.find((item) => item.key === key);
    if (!metric) return { gate, ok: false, reason: `${candidate.id} has no "${key}" metric` };
    if (metric.mean < minimum) {
      return { gate, ok: false, reason: `${key} is ${metric.mean.toFixed(3)}, below ${minimum}` };
    }
  }
  if (options.noRegression && currentVersion) {
    const baseline = await newestFor(options, subject, name, currentVersion);
    if (!baseline) {
      return { gate, ok: false, reason: `no experiment for the current version ${currentVersion}` };
    }
    const { compareExperiments } = await import('../evaluate/compare.js');
    const comparison = compareExperiments(
      baseline,
      candidate,
      options.noRegression === true ? {} : options.noRegression,
    );
    if (comparison.regressed) {
      const worse = comparison.metrics.filter((metric) => metric.verdict === 'worse').map((metric) => metric.key);
      return {
        gate,
        ok: false,
        reason: `regressed against ${baseline.id}${worse.length ? `: ${worse.join(', ')}` : ''}${
          comparison.newErrors.length ? `, new failures ${comparison.newErrors.join(', ')}` : ''
        }`,
      };
    }
  }
  return { gate, ok: true, reason: `passed ${candidate.id}` };
}

/**
 * Refuses a promotion until an experiment has passed for the exact version being promoted.
 *
 * An experiment counts for a version when its `metadata.prompt` names it, which `evaluatePrompt()`
 * records. With `thresholds` each named metric must reach its minimum mean; with `noRegression` the
 * candidate must not be worse, beyond noise, than the version it would replace.
 */
export function experimentGate(options: ExperimentGateOptions): PromotionGate {
  return (context: PromotionContext): Promise<GateResult> =>
    experimentVerdict(options, promptOf, context.name, context.version.version, context.current?.version);
}

/**
 * Refuses a promotion unless the version is what another label serves now, such as requiring
 * `staging` before `production`.
 */
export function servedByGate(label: string): PromotionGate {
  const gate = `served-by-${label}`;
  return async (context: PromotionContext): Promise<GateResult> => {
    const pointer = await context.registry.store.getLabel(context.name, label);
    return pointer?.version === context.version.version
      ? { gate, ok: true }
      : { gate, ok: false, reason: `${context.version.version} is not what "${label}" serves` };
  };
}
