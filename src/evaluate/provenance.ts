import type { Evaluator, EvaluatorProvenance } from '../types/evaluate.js';

const PROVENANCE = Symbol('nexus.evaluate.provenance');

/**
 * Says where an evaluator's scores come from: its name and version, the judge model and prompt
 * version behind it, and its rubric. `evaluate()` records it on the experiment, so a score of 0.87
 * can be traced to exactly what produced it, and two experiments scored by different judges are not
 * compared as if they were alike.
 *
 * Returns the same evaluator, marked; it runs exactly as before.
 *
 * @example
 * ```ts
 * const grounded = withProvenance(groundedness, {
 *   name: 'groundedness',
 *   version: '3',
 *   judge: { model: 'claude-sonnet-5-5', promptVersion: 'grounded-v3', temperature: 0 },
 *   rubric: 'Every claim is supported by a cited passage.',
 * });
 * ```
 */
export function withProvenance<I = unknown, O = unknown>(
  evaluator: Evaluator<I, O>,
  provenance: Omit<EvaluatorProvenance, 'keys' | 'position'>,
): Evaluator<I, O> {
  Object.defineProperty(evaluator, PROVENANCE, { value: provenance, configurable: true });
  return evaluator;
}

/** What an evaluator declared through `withProvenance()`, if anything. */
export function declaredProvenance(evaluator: unknown): Omit<EvaluatorProvenance, 'keys' | 'position'> | undefined {
  if (typeof evaluator !== 'function') return undefined;
  return (evaluator as { [PROVENANCE]?: Omit<EvaluatorProvenance, 'keys' | 'position'> })[PROVENANCE];
}
