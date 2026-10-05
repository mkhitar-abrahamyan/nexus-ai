import type { CompletionRequest, Message } from '../../types/messages.js';
import type { AgentMiddleware } from '../create-agent.js';
import { textOf } from './shared.js';

/** One cleared result, for a custom placeholder. */
export interface ClearedToolResult {
  /** The tool whose result was cleared. */
  tool: string;
  /** How long the result was, in characters. */
  length: number;
}

/** What one edit did, for logs and for measuring what it saves. */
export interface ContextEdit {
  /** Tool results cleared. */
  cleared: number;
  /** The request's estimated tokens before. */
  tokensBefore: number;
  /** And after. */
  tokensAfter: number;
}

/** Options for `contextEditor()`. */
export interface ContextEditorOptions {
  /** Editing starts once the request's estimated tokens pass this. Defaults to 30,000. */
  triggerTokens?: number;
  /** The most recent tool results, kept whole. Defaults to 3. */
  keepToolResults?: number;
  /**
   * Results are cleared this many at a time, so the edited prefix stays the same for several calls
   * and a provider's prompt cache keeps working between edits. Defaults to 5.
   */
  batch?: number;
  /** Tools whose results are never cleared. */
  exclude?: readonly string[];
  /** Also empties the arguments of each call whose result is cleared, for tools that take large inputs. */
  clearArguments?: boolean;
  /** What a cleared result says instead. Defaults to a line naming the tool and how to get it back. */
  placeholder?: string | ((cleared: ClearedToolResult) => string);
  /** Estimates a request's tokens. Defaults to about four characters a token. */
  estimateTokens?: (request: CompletionRequest) => number;
  /** Called after each edit. */
  onEdit?: (edit: ContextEdit) => void;
}

/**
 * Clears old tool results from what the model is sent, once the request grows past a threshold.
 *
 * Tool output is most of a long agent's context, and the model rarely needs a result from twenty
 * steps ago verbatim. Every result but the most recent few is replaced by a short placeholder, in
 * batches, so the edited prefix stays the same between edits and a provider's prompt cache keeps
 * working. Only the request changes: the transcript in state keeps every result, and checkpoints,
 * events, and a later summary still see them.
 */
export function contextEditor(options: ContextEditorOptions = {}): AgentMiddleware {
  const triggerTokens = options.triggerTokens ?? 30_000;
  const keep = Math.max(0, options.keepToolResults ?? 3);
  const batch = Math.max(1, options.batch ?? 5);
  const exclude = new Set(options.exclude ?? []);
  const estimate = options.estimateTokens ?? estimateRequestTokens;
  const placeholder = (cleared: ClearedToolResult): string =>
    typeof options.placeholder === 'function'
      ? options.placeholder(cleared)
      : (options.placeholder ??
        `[Cleared to save context: the result of ${cleared.tool}, ${cleared.length} characters. Call the tool again if you need it.]`);

  return {
    name: 'context-editor',
    beforeModel({ request }) {
      const tokensBefore = estimate(request);
      if (tokensBefore <= triggerTokens) return;

      const names = new Map<string, string>();
      for (const message of request.messages) {
        for (const call of message.toolCalls ?? []) names.set(call.id, call.function.name);
      }
      const results = request.messages.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
      // Whole batches only, once there is a batch to clear; the count changes once every `batch` results.
      const eligible = Math.max(0, results.length - keep);
      const count = eligible < batch ? eligible : eligible - (eligible % batch);
      const clearable = new Set(
        results.slice(0, count).filter((index) => {
          const id = request.messages[index]?.toolCallId;
          return !exclude.has(names.get(id ?? '') ?? '');
        }),
      );
      if (clearable.size === 0) return;

      const clearedIds = new Set<string>();
      const messages = request.messages.map((message, index): Message => {
        if (!clearable.has(index)) return message;
        const text = textOf(message.content);
        const tool = names.get(message.toolCallId ?? '') ?? 'a tool';
        clearedIds.add(message.toolCallId ?? '');
        return { ...message, content: placeholder({ tool, length: text.length }) };
      });
      const edited = options.clearArguments
        ? messages.map((message) =>
            message.toolCalls?.some((call) => clearedIds.has(call.id))
              ? {
                  ...message,
                  toolCalls: message.toolCalls.map((call) =>
                    clearedIds.has(call.id) ? { ...call, function: { ...call.function, arguments: '{}' } } : call,
                  ),
                }
              : message,
          )
        : messages;

      const next = { ...request, messages: edited };
      options.onEdit?.({ cleared: clearable.size, tokensBefore, tokensAfter: estimate(next) });
      return next;
    },
  };
}

/** About four characters a token, over the messages, the tool calls, and the tool schemas. */
export function estimateRequestTokens(request: CompletionRequest): number {
  let characters = 0;
  for (const message of request.messages) {
    characters += textOf(message.content).length + 4;
    for (const call of message.toolCalls ?? [])
      characters += call.function.name.length + call.function.arguments.length;
  }
  for (const tool of request.tools ?? []) {
    characters += tool.name.length + tool.description.length + JSON.stringify(tool.parameters ?? {}).length;
  }
  return Math.ceil(characters / 4);
}
