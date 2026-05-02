export type BudgetExceededAction = 'error' | 'truncate' | 'densify' | 'allow';

export interface DensificationConfig {
  enabled?: boolean;
  preserveCodeBlocks?: boolean;
  preserveMarkdown?: boolean;
  techniques?: Array<'whitespace-cleanup' | 'phrase-compression' | 'list-compaction'>;
}

export interface BudgetConfig {
  enabled?: boolean;
  maxInputTokens?: number;
  warnAt?: number;
  onExceeded?: BudgetExceededAction;
}

export interface TokenOptimizerConfig {
  enabled?: boolean;
  densification?: DensificationConfig;
  budget?: BudgetConfig;
}

export interface TokenUsageSnapshot {
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedPercent: number;
}

export interface OptimizationResult<T> {
  value: T;
  usage: TokenUsageSnapshot;
  techniquesApplied: string[];
  warnings: string[];
}
