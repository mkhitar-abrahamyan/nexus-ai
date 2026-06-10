import type { CompletionRequest, Message } from './messages.js';

export type ContextWindowStrategy =
  | 'last-messages'
  | 'last-tokens'
  | 'last-messages-with-summary'
  | 'last-tokens-with-summary'
  | 'auto';

export type ContextSummaryMode = 'local' | 'provider' | 'custom';

export interface ContextSummaryInput {
  request: CompletionRequest;
  messages: Message[];
  serializedMessages: string;
  maxTokens: number;
  model?: string;
  instruction: string;
  temperature?: number;
}

export type ContextSummarizer = (input: ContextSummaryInput) => string | Promise<string>;

export interface ContextSummaryConfig {
  enabled?: boolean;
  mode?: ContextSummaryMode;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  instruction?: string;
  label?: string;
  insertAsRole?: 'system' | 'user';
  summarizer?: ContextSummarizer;
  fallbackToLocal?: boolean;
}

export interface ContextWindowConfig {
  enabled?: boolean;
  strategy?: ContextWindowStrategy;
  lastMessages?: number;
  maxInputTokens?: number;
  summaryReserveTokens?: number;
  preserveSystemMessages?: boolean;
  summary?: ContextSummaryConfig;
}

export interface ContextWindowUsage {
  strategy: ContextWindowStrategy;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  originalMessages: number;
  finalMessages: number;
  keptMessages: number;
  summarizedMessages: number;
  droppedMessages: number;
  summaryTokens: number;
  summariesCreated: number;
  summaryMode?: ContextSummaryMode;
  summaryModel?: string;
}

export interface ContextWindowResult<T> {
  value: T;
  usage: ContextWindowUsage;
  techniquesApplied: string[];
  warnings: string[];
}
