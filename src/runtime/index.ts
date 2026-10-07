/**
 * The portable kernel: the contracts every model call and tool call is built on, for any JavaScript
 * runtime. That means Node.js, Deno, Bun, edge runtimes such as Cloudflare Workers and Vercel's,
 * and browsers.
 *
 * Nothing here, nor anything it imports, uses `fs`, `net`, `child_process`, Node's `crypto`, or
 * Node's globals, and CI runs its tests on each runtime. The provider adapters, graphs, agents, and
 * protocols are portable too, on their own entry points.
 */
export type {
  AssetContent,
  AudioContent,
  BinaryBuffer,
  CacheHint,
  CompletionRequest,
  ContentPart,
  ImageContent,
  Message,
  MessageRole,
  PromptCacheConfig,
  ReasoningConfig,
  TextContent,
  ToolCallResult,
  ToolChoice,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  VideoContent,
} from '../types/messages.js';
export type {
  CacheOutcome,
  NexusResponse,
  NexusStream,
  ResponseCost,
  ResponseMeta,
  StreamChunk,
  TokenUsage,
  ToolCall,
} from '../types/response.js';
export type { ProviderCallContext } from '../types/lifecycle.js';
export { BaseProvider, type ProviderInfo } from '../providers/base.js';
export {
  categorizeProviderError,
  createProviderHttpError,
  isAbortError,
  isRetryableProviderError,
  NexusProviderError,
  type NexusProviderErrorCategory,
  type NexusProviderErrorOptions,
  toNexusProviderError,
} from '../providers/errors.js';
export { isToolOutput, ToolExecutor, tool, toolMessageContent, toolOutput } from '../agent/tool.js';
export {
  capabilitiesOf,
  isSensitiveCapability,
  type ParsedCapability,
  parseCapability,
} from '../agent/capabilities.js';
export {
  type NegotiateOptions,
  type NegotiationResult,
  NexusCapabilityError,
  negotiateCompletionRequest,
} from '../capabilities/negotiate.js';
export { collectStream, createTextStream, mapStream } from '../core/streaming.js';
export { type RuntimeInfo, type RuntimeName, runtimeInfo } from './detect.js';
