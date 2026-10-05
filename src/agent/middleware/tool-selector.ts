import type { CompletionRequest, ToolDefinition } from '../../types/messages.js';
import type { AgentMiddleware, AgentMiddlewareContext } from '../create-agent.js';
import { textOf, turnOf } from './shared.js';

/** What a rule chooses tools from. */
export interface ToolSelectionContext extends AgentMiddlewareContext {
  /** The request about to be sent. */
  request: CompletionRequest;
  /** Every tool the request offers. */
  tools: readonly ToolDefinition[];
  /** What the turn is about: the text `query` returned. */
  query: string;
}

/** Options for `toolSelector()`. Give it `select`, `embed`, or both. */
export interface ToolSelectorOptions {
  /**
   * A rule: the names of the tools to send. With `embed` too, the rule narrows the candidates and
   * similarity ranks what is left.
   */
  select?: (context: ToolSelectionContext) => readonly string[] | Promise<readonly string[]>;
  /**
   * Embeds texts, for choosing by similarity: any embedding function, such as one from
   * `toEmbeddingFunction()`. Each tool is embedded once, from `describe`; the query once per turn.
   */
  embed?: (texts: string[]) => Promise<readonly (readonly number[])[]> | readonly (readonly number[])[];
  /** The most tools sent, `always` included. Defaults to 12. */
  maxTools?: number;
  /** The lowest similarity a tool needs to be sent, from -1 to 1. Defaults to none. */
  minScore?: number;
  /** Tools sent on every call, whatever the turn is about. */
  always?: readonly string[];
  /**
   * Keeps every tool the model already called this turn, so a tool it is halfway through using
   * never disappears from under it. Defaults to true.
   */
  keepUsed?: boolean;
  /** What the turn is about. Defaults to the latest user message. */
  query?: (context: AgentMiddlewareContext & { request: CompletionRequest }) => string;
  /** The text a tool is embedded from. Defaults to its name and description. */
  describe?: (tool: ToolDefinition) => string;
  /** Called with each selection, for logs and for measuring what the selector saves. */
  onSelect?: (selection: ToolSelection) => void;
}

/** What `toolSelector()` sent for one call. */
export interface ToolSelection {
  /** The query the tools were chosen for. */
  query: string;
  /** The names of the tools sent. */
  selected: string[];
  /** How many tools the request offered. */
  offered: number;
  /** Each ranked tool's similarity to the query, when tools were chosen by similarity. */
  scores?: Record<string, number>;
}

/**
 * Sends a model only the tools relevant to the turn.
 *
 * An agent with 150 tools otherwise sends 150 schemas on every call: the tokens are paid each time,
 * the call is slower, and a model choosing among that many picks worse. A rule, embedding
 * similarity, or both choose a dozen; tools named in `always`, the tool a `toolChoice` forces, and
 * the tools the model already used this turn are always kept. The agent can still run every tool —
 * only what the model is offered changes.
 */
export function toolSelector(options: ToolSelectorOptions): AgentMiddleware {
  if (!options.select && !options.embed) {
    throw new TypeError('toolSelector() needs a select rule, an embed function, or both');
  }
  const maxTools = Math.max(1, options.maxTools ?? 12);
  const describe = options.describe ?? ((tool: ToolDefinition) => `${tool.name}: ${tool.description}`);
  const vectors = new Map<string, readonly number[]>();
  let lastQuery: { text: string; vector: readonly number[] } | undefined;

  const embedTools = async (tools: readonly ToolDefinition[]): Promise<void> => {
    const missing = [...new Set(tools.map(describe).filter((text) => !vectors.has(text)))];
    if (missing.length === 0 || !options.embed) return;
    const embedded = await options.embed(missing);
    missing.forEach((text, index) => {
      const vector = embedded[index];
      if (vector) vectors.set(text, normalize(vector));
    });
  };
  const embedQuery = async (text: string): Promise<readonly number[] | undefined> => {
    if (!options.embed || !text.trim()) return undefined;
    if (lastQuery?.text === text) return lastQuery.vector;
    const [vector] = await options.embed([text]);
    if (!vector) return undefined;
    lastQuery = { text, vector: normalize(vector) };
    return lastQuery.vector;
  };

  return {
    name: 'tool-selector',
    async beforeModel(context) {
      const { request } = context;
      const offered = request.tools ?? [];
      // Similarity alone has nothing to cut below the limit; a rule may still narrow a short list.
      if (offered.length === 0 || (!options.select && offered.length <= maxTools)) return;

      const query = options.query?.(context) ?? latestUserText(context.state.messages);
      const kept = new Set<string>(options.always ?? []);
      if (request.toolChoice && typeof request.toolChoice === 'object') kept.add(request.toolChoice.name);
      if (options.keepUsed !== false) {
        for (const message of turnOf(context.state.messages)) {
          for (const call of message.toolCalls ?? []) kept.add(call.function.name);
        }
      }

      let candidates = offered.filter((tool) => !kept.has(tool.name));
      if (options.select) {
        const chosen = new Set(await options.select({ ...context, tools: offered, query }));
        candidates = candidates.filter((tool) => chosen.has(tool.name));
      }

      let scores: Record<string, number> | undefined;
      const room = Math.max(0, maxTools - kept.size);
      if (options.embed) {
        const vector = await embedQuery(query);
        if (vector) {
          await embedTools(candidates);
          scores = {};
          const ranked = candidates
            .map((tool) => ({ tool, score: dot(vector, vectors.get(describe(tool)) ?? []) }))
            .filter((entry) => options.minScore === undefined || entry.score >= options.minScore)
            .sort((left, right) => right.score - left.score);
          for (const entry of ranked) scores[entry.tool.name] = round(entry.score);
          candidates = ranked.map((entry) => entry.tool);
        }
      }

      const names = new Set([...kept, ...candidates.slice(0, room).map((tool) => tool.name)]);
      const tools = offered.filter((tool) => names.has(tool.name));
      options.onSelect?.({
        query,
        selected: tools.map((tool) => tool.name),
        offered: offered.length,
        ...(scores ? { scores } : {}),
      });
      return { ...request, tools };
    },
  };
}

function latestUserText(messages: AgentMiddlewareContext['state']['messages']): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return textOf(message.content);
  }
  return '';
}

function normalize(vector: readonly number[]): readonly number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += (left[index] as number) * (right[index] as number);
  return total;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
