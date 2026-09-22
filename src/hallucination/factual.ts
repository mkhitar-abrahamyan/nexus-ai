import type { CompletionRequest, Message } from '../types/messages.js';

/** Options for `withFactualDefaults()`. */
export interface FactualOptions {
  /** Temperature used when the request sets none. Defaults to 0. */
  temperature?: number;
  /** Top-p used when the request sets none. Defaults to 0.1. */
  topP?: number;
  /** Tells the model what to answer when it is not sure. Defaults to true. */
  requireUnknownFallback?: boolean;
  /** That answer. Defaults to `I don't know.` */
  unknownAnswer?: string;
  /** Whether the model reasons privately, shows a brief summary, or is not told to reason. */
  chainOfThought?: 'none' | 'private' | 'brief';
  /** Worked examples, added as conversation turns before the request. */
  examples?: Array<{ input: string; output: string }>;
}

/**
 * Adds a system message that asks for factual, conservative answers, with low sampling defaults.
 */
export function withFactualDefaults(request: CompletionRequest, options: FactualOptions = {}): CompletionRequest {
  const unknownAnswer = options.unknownAnswer || "I don't know.";
  const instructions = [
    'Be factual, concise, and conservative.',
    options.requireUnknownFallback !== false ? `If you are not sure, answer exactly: "${unknownAnswer}"` : '',
    'Do not invent facts, citations, APIs, prices, dates, versions, or capabilities.',
    options.chainOfThought === 'brief' ? 'Show a brief reasoning summary.' : '',
    options.chainOfThought === 'private' ? 'Think step by step internally, but only provide the final answer.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const exampleMessages: Message[] = (options.examples || []).flatMap((example) => [
    { role: 'user' as const, content: example.input },
    { role: 'assistant' as const, content: example.output },
  ]);

  return {
    ...request,
    temperature: request.temperature ?? options.temperature ?? 0,
    topP: request.topP ?? options.topP ?? 0.1,
    messages: [{ role: 'system', content: instructions }, ...exampleMessages, ...request.messages],
  };
}

/** Adds a system message asking for JSON only, with low sampling defaults. */
export function asJsonOnly(request: CompletionRequest): CompletionRequest {
  return {
    ...request,
    temperature: request.temperature ?? 0,
    topP: request.topP ?? 0.1,
    messages: [
      { role: 'system', content: 'Return only valid JSON. Do not include markdown, prose, or code fences.' },
      ...request.messages,
    ],
  };
}
