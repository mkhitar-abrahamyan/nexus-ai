/**
 * Answers an MCP server's `sampling/createMessage` with this application's own model, through any
 * client with `complete()`, such as `NexusAI`: so a server's tool may ask for a completion, and every
 * call is still routed, budgeted, traced, and priced as every completion is.
 */
import type { CompletionRequest, ContentPart, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { McpError, type McpSamplingContent, type McpSamplingRequest, type McpSamplingResult } from './protocol.js';

/** Anything that completes a request, such as a `NexusAI` client. */
export interface McpSamplingClient {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/** Options for `samplingFrom()`. */
export interface McpSamplingOptions {
  /** The model asked when the server's hints name none of \`models\`. */
  model: string;
  /**
   * The models a server may have, by name: each of its hints, most preferred first, picks the first of
   * these whose name holds it, as MCP's model hints are matched. Without them, \`model\` answers every
   * request.
   */
  models?: readonly string[];
  /** The most tokens a request may ask for; a server asking more gets this many. */
  maxTokens?: number;
  /** Whether to keep the system prompt a server asks for. Defaults to true. */
  systemPrompt?: boolean;
  /**
   * Decides each request before it reaches the model, as MCP expects a person to be able to: \`false\`
   * refuses it, and the server is told so. Without it, every request is answered.
   */
  approve?: (request: McpSamplingRequest) => boolean | Promise<boolean>;
}

/**
 * A sampling handler for \`McpClientOptions.sampling\`, answering a server's requests with a client's
 * own completions: the conversation as messages, an image or audio as a part, the server's system
 * prompt, temperature, stop sequences, and token limit, the model chosen by its hints.
 */
export function samplingFrom(
  client: McpSamplingClient,
  options: McpSamplingOptions,
): (request: McpSamplingRequest, context: { signal: AbortSignal }) => Promise<McpSamplingResult> {
  return async (request, context) => {
    if (options.approve && !(await options.approve(request))) {
      throw new McpError('The request for a completion was declined', -1);
    }
    const model = modelFor(request, options);
    const messages: Message[] = [
      ...(request.systemPrompt && options.systemPrompt !== false
        ? [{ role: 'system' as const, content: request.systemPrompt }]
        : []),
      ...request.messages.map((message): Message => ({ role: message.role, content: partsOf(message.content) })),
    ];
    const maxTokens = Math.min(request.maxTokens, options.maxTokens ?? Number.POSITIVE_INFINITY);
    const response = await client.complete({
      model,
      messages,
      ...(Number.isFinite(maxTokens) ? { maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
      signal: context.signal,
    });
    return {
      role: 'assistant',
      content: { type: 'text', text: response.content },
      model: response.meta?.modelUsed || model,
      stopReason:
        response.finishReason === 'length'
          ? 'maxTokens'
          : response.finishReason === 'stop'
            ? 'endTurn'
            : response.finishReason,
    };
  };
}

/** The model a request's hints pick, most preferred first, or the default. */
function modelFor(request: McpSamplingRequest, options: McpSamplingOptions): string {
  for (const hint of request.modelPreferences?.hints ?? []) {
    const name = hint.name?.toLowerCase();
    if (!name) continue;
    const found = options.models?.find((model) => model.toLowerCase().includes(name));
    if (found) return found;
  }
  return options.model;
}

/** A sampled message's content as a message's: text as it is, an image or audio as a part. */
function partsOf(content: McpSamplingContent): string | ContentPart[] {
  if (content.type === 'text') return content.text;
  if (content.type === 'image')
    return [{ type: 'image', source: { base64: content.data, mimeType: content.mimeType } }];
  return [{ type: 'audio', source: { base64: content.data, format: content.mimeType.split('/')[1] ?? 'wav' } }];
}
