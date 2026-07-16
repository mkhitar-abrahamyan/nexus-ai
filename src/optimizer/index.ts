import type { CompletionRequest } from '../types/messages.js';
import type { OptimizationResult, TokenOptimizerConfig } from '../types/optimizer.js';
import { Tokenizer } from '../utils/tokenizer.js';
import { PromptDensifier } from './densifier.js';
import { BudgetEnforcer } from './budget.js';

export class TokenOptimizer {
  private tokenizer = new Tokenizer();
  private densifier = new PromptDensifier();
  private budget = new BudgetEnforcer(this.tokenizer);

  constructor(private config: TokenOptimizerConfig = {}) {}

  optimize(request: CompletionRequest): OptimizationResult<CompletionRequest> {
    if (this.config.enabled === false) {
      return {
        value: request,
        usage: {
          beforeTokens: 0,
          afterTokens: 0,
          savedTokens: 0,
          savedPercent: 0,
        },
        techniquesApplied: [],
        warnings: [],
      };
    }

    const beforeTokens = this.tokenizer.estimateRequestTokens(request);
    let value = request;
    const techniquesApplied: string[] = [];
    const warnings: string[] = [];

    const budgetConfig = this.config.budget || {};
    const preBudget = this.budget.check(value, budgetConfig);
    warnings.push(...preBudget.warnings);

    const shouldDensify =
      this.config.densification?.enabled !== false &&
      (this.config.densification?.enabled === true || budgetConfig.onExceeded === 'densify' || preBudget.exceeded);

    if (shouldDensify) {
      const densified = this.densifier.densifyRequest(value, this.config.densification);
      value = densified.request;
      techniquesApplied.push(...densified.techniques);
    }

    value = this.budget.enforce(value, budgetConfig);

    const afterTokens = this.tokenizer.estimateRequestTokens(value);
    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const savedPercent = beforeTokens === 0 ? 0 : Math.round((savedTokens / beforeTokens) * 10000) / 100;

    return {
      value,
      usage: {
        beforeTokens,
        afterTokens,
        savedTokens,
        savedPercent,
      },
      techniquesApplied: [...new Set(techniquesApplied)],
      warnings,
    };
  }
}

export { PromptDensifier } from './densifier.js';
export { BudgetEnforcer, TokenBudgetError } from './budget.js';
