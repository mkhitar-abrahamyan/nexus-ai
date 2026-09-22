/**
 * What happens when a request exceeds its token budget: fail, truncate, densify, or send it anyway.
 */
export type BudgetExceededAction = 'error' | 'truncate' | 'densify' | 'allow';

/** Rewriting prompts to use fewer tokens without changing what they say. */
export interface DensificationConfig {
  /** Turns densification on. */
  enabled?: boolean;
  /** Leaves fenced code blocks untouched. Defaults to true. */
  preserveCodeBlocks?: boolean;
  /**
   * Ignored: densification never rewrites Markdown structure.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  preserveMarkdown?: boolean;
  /** Techniques to apply. Defaults to all three. */
  techniques?: Array<'whitespace-cleanup' | 'phrase-compression' | 'list-compaction'>;
}

/** A limit on how many input tokens a request may use. */
export interface BudgetConfig {
  /** Turns the budget on. */
  enabled?: boolean;
  /** Most input tokens allowed. */
  maxInputTokens?: number;
  /** Share of the limit at which a warning is recorded, from 0 to 1. Defaults to 0.8. */
  warnAt?: number;
  /** What happens over the limit. */
  onExceeded?: BudgetExceededAction;
}

/** Token optimization applied before a request is sent. */
export interface TokenOptimizerConfig {
  /** Turns optimization on. */
  enabled?: boolean;
  /** Prompt densification. */
  densification?: DensificationConfig;
  /** Input token budget. */
  budget?: BudgetConfig;
}

/** Token counts before and after optimization. */
export interface TokenUsageSnapshot {
  /** Estimated tokens before. */
  beforeTokens: number;
  /** Estimated tokens after. */
  afterTokens: number;
  /** Tokens saved. */
  savedTokens: number;
  /** Share saved, as a percentage. */
  savedPercent: number;
}

/** An optimized value with what optimization did to it. */
export interface OptimizationResult<T> {
  /** The optimized value. */
  value: T;
  /** Token counts before and after. */
  usage: TokenUsageSnapshot;
  /** Techniques applied. */
  techniquesApplied: string[];
  /** Anything the caller should know, such as a budget warning. */
  warnings: string[];
}
