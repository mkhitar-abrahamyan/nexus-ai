import type { PipelineTrace } from '../pipeline/types.js';

export interface ResponseMeta {
  requestId: string;
  providerUsed: string;
  modelUsed: string;
  latencyMs: number;
  tokensInput: number;
  tokensOutput: number;
  tokensSaved: number;
  estimatedCost: string;
  cacheHit: boolean;
  guardrailsApplied: string[];
  routingDecision?: {
    reason: string;
    fallbacksConsidered: number;
  };
  verification?: {
    ok: boolean;
    supportRatio: number;
    factsChecked: number;
    unsupportedFacts: string[];
  };
  pipeline?: PipelineTrace;
  semanticCache?: {
    hit: boolean;
    score: number;
    key: string;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface NexusResponse {
  content: string;
  role: 'assistant';
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  meta: ResponseMeta;
}

// ── Streaming ──────────────────────────────────────────────────────

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  meta?: Partial<ResponseMeta>;
  error?: string;
}

export interface NexusStream extends AsyncIterable<StreamChunk> {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
  abort(): void;
}
