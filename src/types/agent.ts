import type { Message, ToolDefinition } from './messages.js';
import type { NexusResponse } from './response.js';

/** One step of an `AgentLoop` run. */
export interface AgentStep {
  /** Which model call it belonged to, starting at 1. */
  iteration: number;
  /** A model reply, a tool call, or the final answer. */
  type: 'model' | 'tool' | 'final';
  /** What happened, for display. */
  message: string;
  /** The tool called, for a tool step. */
  toolName?: string;
  /** Its arguments. */
  toolArgs?: Record<string, unknown>;
  /** What it returned. */
  toolResult?: unknown;
}

/**
 * Configuration for `AgentLoop`, the simple tool-calling loop. `createAgent()` is the graph-based
 * agent with checkpoints and approvals.
 */
export interface AgentConfig {
  /** Model the loop calls. */
  model: string;
  /** What the agent should achieve, sent as the user message. */
  goal: string;
  /** System prompt placed before the goal. */
  systemPrompt?: string;
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /** Model calls allowed before the loop stops with `max_iterations`. */
  maxIterations?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Output token limit. */
  maxTokens?: number;
  /** Application data sent with every request. */
  metadata?: Record<string, unknown>;
  /** Called after every step. */
  onStep?: (step: AgentStep) => void | Promise<void>;
  /** Called after every tool call. */
  onToolCall?: (step: AgentStep) => void | Promise<void>;
}

/** The outcome of an `AgentLoop` run. */
export interface AgentResult {
  /** The final answer's text. */
  content: string;
  /** Every step, in order. */
  steps: AgentStep[];
  /** Model calls made. */
  iterations: number;
  /**
   * Why the loop ended. `max_iterations` means the model was still requesting tools when the limit
   * was reached, so `content` is not a final answer. Always set by `AgentLoop`; optional in the type so
   * results constructed elsewhere, such as test doubles, keep compiling.
   */
  stopReason?: 'completed' | 'max_iterations';
  /** The last model response. */
  response: NexusResponse;
  /** The whole conversation, tool calls and results included. */
  messages: Message[];
}

/** What running one tool produced. */
export interface ToolExecutionResult {
  /** True when the tool returned a value. */
  ok: boolean;
  /** The value returned. */
  result?: unknown;
  /** Why the tool failed. */
  error?: string;
}
