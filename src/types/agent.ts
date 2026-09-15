import type { Message, ToolDefinition } from './messages.js';
import type { NexusResponse } from './response.js';

export interface AgentStep {
  iteration: number;
  type: 'model' | 'tool' | 'final';
  message: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

export interface AgentConfig {
  model: string;
  goal: string;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  onStep?: (step: AgentStep) => void | Promise<void>;
  onToolCall?: (step: AgentStep) => void | Promise<void>;
}

export interface AgentResult {
  content: string;
  steps: AgentStep[];
  iterations: number;
  /**
   * Why the loop ended. `max_iterations` means the model was still requesting tools when the limit
   * was reached, so `content` is not a final answer. Always set by `AgentLoop`; optional in the type so
   * results constructed elsewhere, such as test doubles, keep compiling.
   */
  stopReason?: 'completed' | 'max_iterations';
  response: NexusResponse;
  messages: Message[];
}

export interface ToolExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}
