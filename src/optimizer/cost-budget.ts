import type { CostEstimate } from '../types/planning.js';

/**
 * Currency and cost-budget enforcement, with no dependency on the model registry.
 *
 * Split out of `optimizer/cost.ts` because enforcing a budget only compares two numbers, while
 * looking a price up needs the 101-model catalogue. Keeping them in one module meant every family
 * that merely enforces a budget — embeddings among them — dragged 30 KB of model data into its
 * import graph to do arithmetic. `optimizer/cost.ts` re-exports everything here, so no public
 * import changes.
 *
 * Distinct from `optimizer/budget.ts`, which enforces *token* budgets on a request before it is
 * sent. This module deals in money after a usage figure exists.
 */

export const DEFAULT_CURRENCY = 'USD';

export class CostBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostBudgetError';
  }
}

/** Formats an amount the way `ResponseMeta.estimatedCost` has always presented it. */
export function formatCost(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function assertWithinCostBudget(estimate: CostEstimate, maxEstimatedCost?: number): void {
  if (maxEstimatedCost === undefined) return;
  if (estimate.totalCost > maxEstimatedCost) {
    throw new CostBudgetError(
      `Estimated cost ${estimate.formatted} exceeds maxEstimatedCost $${maxEstimatedCost.toFixed(4)}`,
    );
  }
}
