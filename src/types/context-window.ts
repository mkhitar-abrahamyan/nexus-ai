import type { CompletionRequest, Message } from './messages.js';

/**
 * How a long conversation is cut to fit: keep the last messages or the last tokens, optionally with
 * a summary of what was cut, or `auto` to choose from the limits configured and whether summaries
 * are on.
 */
export type ContextWindowStrategy =
  | 'last-messages'
  | 'last-tokens'
  | 'last-messages-with-summary'
  | 'last-tokens-with-summary'
  | 'auto';

/**
 * Who writes the summary of cut messages: a local extractive summary, the model through the client,
 * or your own function.
 */
export type ContextSummaryMode = 'local' | 'provider' | 'custom';

/** What a custom summarizer receives. */
export interface ContextSummaryInput {
  /** The request being trimmed. */
  request: CompletionRequest;
  /** The messages to summarize. */
  messages: Message[];
  /** Those messages as one text, ready to put in a prompt. */
  serializedMessages: string;
  /** Longest the summary may be, in tokens. */
  maxTokens: number;
  /** Model to summarize with. */
  model?: string;
  /** Instructions for the summary. */
  instruction: string;
  /** Sampling temperature for the summary. */
  temperature?: number;
}

/** Writes a summary of the messages cut from a conversation. */
export type ContextSummarizer = (input: ContextSummaryInput) => string | Promise<string>;

/** How cut messages are summarized. */
export interface ContextSummaryConfig {
  /** Turns summaries on. */
  enabled?: boolean;
  /** Who writes the summary. Defaults to `local`. */
  mode?: ContextSummaryMode;
  /** Model used in `provider` mode. */
  model?: string;
  /** Longest a summary may be, in tokens. Defaults to 512. */
  maxTokens?: number;
  /** Sampling temperature in `provider` mode. */
  temperature?: number;
  /** Instructions given to the summarizer. */
  instruction?: string;
  /** Heading the summary is inserted under. Defaults to `Earlier conversation summary`. */
  label?: string;
  /** Role of the inserted summary message. Defaults to `system`. */
  insertAsRole?: 'system' | 'user';
  /** Your own summarizer, used instead of either built-in mode. */
  summarizer?: ContextSummarizer;
  /**
   * Falls back to a local summary when `provider` mode fails. Defaults to true; `false` fails the
   * request instead.
   */
  fallbackToLocal?: boolean;
}

/** Keeps long conversations within a model's context window. */
export interface ContextWindowConfig {
  /** Turns trimming on. */
  enabled?: boolean;
  /** How the conversation is cut. */
  strategy?: ContextWindowStrategy;
  /** Conversation messages kept, system messages aside. Defaults to 20. */
  lastMessages?: number;
  /** Longest the request may be, in estimated tokens. */
  maxInputTokens?: number;
  /**
   * Tokens held back for the summary when trimming by tokens. Defaults to the summary's
   * `maxTokens`.
   */
  summaryReserveTokens?: number;
  /** Keeps system messages whatever else is cut. Defaults to true. */
  preserveSystemMessages?: boolean;
  /** How cut messages are summarized. */
  summary?: ContextSummaryConfig;
}

/** What trimming did to a request. */
export interface ContextWindowUsage {
  /** The strategy actually applied, which `auto` resolves to one of the others. */
  strategy: ContextWindowStrategy;
  /** Estimated tokens before trimming. */
  beforeTokens: number;
  /** Estimated tokens after trimming. */
  afterTokens: number;
  /** Tokens saved. */
  savedTokens: number;
  /** Messages before trimming. */
  originalMessages: number;
  /** Messages after trimming, the summary included. */
  finalMessages: number;
  /** Messages kept unchanged. */
  keptMessages: number;
  /** Messages folded into a summary. */
  summarizedMessages: number;
  /** Messages removed without a summary. */
  droppedMessages: number;
  /** Estimated tokens in the summary. */
  summaryTokens: number;
  /** Summaries inserted. */
  summariesCreated: number;
  /** Who wrote the summary. */
  summaryMode?: ContextSummaryMode;
  /** Model that wrote the summary, in `provider` mode. */
  summaryModel?: string;
}

/** A trimmed value with what trimming did to it. */
export interface ContextWindowResult<T> {
  /** The trimmed value. */
  value: T;
  /** Token and message counts before and after. */
  usage: ContextWindowUsage;
  /** Techniques applied, for response metadata. */
  techniquesApplied: string[];
  /** Anything the caller should know, such as a summary that fell back to the local mode. */
  warnings: string[];
}
