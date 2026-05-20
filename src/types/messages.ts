export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ── Content Parts ──────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source:
    | { path: string }
    | { url: string }
    | { buffer: Buffer; mimeType?: string }
    | { base64: string; mimeType?: string };
}

export interface AudioContent {
  type: 'audio';
  source:
    | { path: string }
    | { buffer: Buffer; format?: string }
    | { stream: NodeJS.ReadableStream; format?: string; sampleRate?: number }
    | { transcript: string };
}

export interface VideoContent {
  type: 'video';
  source: {
    path: string;
    frameExtractionMode?: 'keyframes' | 'uniform' | 'all';
    maxFrames?: number;
    includeAudio?: boolean;
  };
}

export type ContentPart = TextContent | ImageContent | AudioContent | VideoContent;

// ── Tool Definitions ───────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: unknown;
}

// ── Messages ───────────────────────────────────────────────────────

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ── Request ────────────────────────────────────────────────────────

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  logitBias?: Record<string, number>;
  timeoutMs?: number;
  maxEstimatedCost?: number;
  estimatedOutputTokens?: number;
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoff?: 'fixed' | 'exponential';
  };
  responseFormat?: {
    type: 'json' | 'json_schema';
    schema?: Record<string, unknown>;
  };
  stop?: string | string[];
  stream?: boolean;
  signal?: AbortSignal;
  userId?: string;
  metadata?: Record<string, unknown>;
}
