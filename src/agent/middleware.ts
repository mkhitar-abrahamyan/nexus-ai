import type { Message } from '../types/messages.js';
import type { AgentMiddleware } from './create-agent.js';

/**
 * Middleware that ships with the agent.
 *
 * Each is small on purpose: the seam matters more than the set, and an application's real policy is
 * usually its own. These cover the three every long-running agent needs — a transcript that does not
 * grow forever, secrets that never reach a provider, and a cap on tool use.
 */

export interface SummarizeOptions {
  /** Messages kept verbatim at the end of the transcript. Defaults to 6. */
  keepLast?: number;
  /** Summarizing starts once the transcript passes this many messages. Defaults to 20. */
  triggerAfter?: number;
  /** Turns the older messages into one summary. Usually a cheap model. */
  summarize: (messages: Message[]) => Promise<string> | string;
}

/**
 * Replaces the older half of a long transcript with a summary.
 *
 * An agent that runs for hours otherwise re-sends its whole history on every call, which costs more
 * each turn and eventually exceeds the context window.
 */
export function summarizeHistory(options: SummarizeOptions): AgentMiddleware {
  const keepLast = options.keepLast ?? 6;
  const triggerAfter = options.triggerAfter ?? 20;

  return {
    name: 'summarize-history',
    async beforeModel({ request }) {
      const messages = request.messages;
      if (messages.length <= triggerAfter) return;

      const system = messages.filter((message) => message.role === 'system');
      const body = messages.filter((message) => message.role !== 'system');
      if (body.length <= keepLast) return;

      const older = body.slice(0, body.length - keepLast);
      const recent = body.slice(body.length - keepLast);
      const summary = await options.summarize(older);

      return {
        ...request,
        messages: [...system, { role: 'user', content: `Summary of the conversation so far:\n${summary}` }, ...recent],
      };
    },
  };
}

/** Options for `redactMiddleware()`. */
export interface RedactOptions {
  /** Patterns replaced before a message reaches the provider. */
  patterns: readonly RegExp[];
  /** Text each match is replaced with. Defaults to `[redacted]`. */
  replacement?: string;
  /** Also redact what the model sends back, for anything written to logs or state. */
  redactOutput?: boolean;
}

/**
 * Redacts matching text from requests, and optionally from responses.
 *
 * For an agent whose transcript may contain a key, an account number, or anything else that should
 * not leave the process. The full security pipeline is in `nexus-ai-pro/security`; this is the small
 * version that needs no configuration.
 */
export function redactMessages(options: RedactOptions): AgentMiddleware {
  const replacement = options.replacement ?? '[redacted]';
  const scrub = (text: string): string =>
    options.patterns.reduce(
      (current, pattern) =>
        current.replace(
          new RegExp(pattern, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
          replacement,
        ),
      text,
    );

  return {
    name: 'redact-messages',
    beforeModel({ request }) {
      return {
        ...request,
        messages: request.messages.map((message) =>
          typeof message.content === 'string' ? { ...message, content: scrub(message.content) } : message,
        ),
      };
    },
    afterModel({ response }) {
      if (!options.redactOutput) return;
      return { ...response, content: scrub(response.content) };
    },
  };
}

/**
 * Caps how often a tool may be called in one run.
 *
 * A model that loops on the same call otherwise burns the iteration budget, and with an expensive
 * tool it burns money too.
 */
export function limitToolCalls(limits: Record<string, number>): AgentMiddleware {
  const counts = new Map<string, number>();
  return {
    name: 'limit-tool-calls',
    async wrapToolCall(call, next) {
      const limit = limits[call.name];
      if (limit === undefined) return next();
      const used = counts.get(call.name) ?? 0;
      if (used >= limit) {
        return { ok: false, error: `Tool "${call.name}" has already run ${limit} times in this run` };
      }
      counts.set(call.name, used + 1);
      return next();
    },
  };
}
