import type { NexusAIConfig } from '../types/config.js';
import type { CostEstimate } from '../types/planning.js';
import { resolveModel } from '../models/registry.js';

export interface CostEstimateInput {
  model: string;
  inputTokens: number;
  outputTokens?: number;
  config?: Pick<NexusAIConfig, 'models'>;
}

export class CostBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostBudgetError';
  }
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const resolved = resolveModel(input.model, input.config);
  const caps = resolved.capabilities;
  const outputTokens = input.outputTokens ?? 0;
  const inputCost = caps ? (input.inputTokens / 1000) * caps.costPer1kInput : 0;
  const outputCost = caps ? (outputTokens / 1000) * caps.costPer1kOutput : 0;
  const totalCost = inputCost + outputCost;

  return {
    model: resolved.model,
    inputTokens: input.inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost,
    formatted: `$${totalCost.toFixed(4)}`,
  };
}

export function assertWithinCostBudget(estimate: CostEstimate, maxEstimatedCost?: number): void {
  if (maxEstimatedCost === undefined) return;
  if (estimate.totalCost > maxEstimatedCost) {
    throw new CostBudgetError(
      `Estimated cost ${estimate.formatted} exceeds maxEstimatedCost $${maxEstimatedCost.toFixed(4)}`,
    );
  }
}
