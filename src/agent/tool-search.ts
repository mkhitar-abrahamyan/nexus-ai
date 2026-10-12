/**
 * Tool search: an agent with hundreds of tools marks most of them `deferred`, and the model finds the
 * few a task needs with `search_tools` instead of reading every definition on every call.
 *
 * The search ranks tools by BM25 over their names, descriptions, and argument names and descriptions,
 * and answers with the tools it found as `tool_reference` parts. A provider with tool references,
 * such as Anthropic, expands each reference into the tool's definition where it stands, so the tool
 * list at the front of the prompt never changes; every other provider is sent a found tool from then
 * on. Either way the model calls a found tool on its next turn.
 */
import type { ContentPart, ToolDefinition, ToolOutput } from '../types/messages.js';

/** The name of the search tool an agent with deferred tools offers. */
export const TOOL_SEARCH_NAME = 'search_tools';

/** Options for `toolSearchTool()`. */
export interface ToolSearchOptions {
  /** How many tools a search returns unless the model asks for another number. Defaults to 5. */
  limit?: number;
  /** The most a model may ask for. Defaults to 20. */
  maxLimit?: number;
}

/** One tool a search found, with its score. */
export interface ToolSearchHit {
  /** The tool. */
  tool: ToolDefinition;
  /** Its BM25 score for the query; higher is closer. */
  score: number;
}

/**
 * Ranks tools against a query by BM25 over their names, descriptions, and arguments. A tool's name
 * counts twice, so a query that names a tool finds it first. Returns the tools that match at all,
 * best first, at most `limit`.
 */
export function searchTools(tools: readonly ToolDefinition[], query: string, limit = 5): ToolSearchHit[] {
  return indexTools(tools)(query, limit);
}

/**
 * The tool an agent offers when it has deferred tools: `search_tools`, which finds deferred tools by
 * what a task needs and answers with them as tool references. `createAgent()` adds it on its own; an
 * application's own loop can offer it the same way.
 */
export function toolSearchTool(tools: readonly ToolDefinition[], options: ToolSearchOptions = {}): ToolDefinition {
  const search = indexTools(tools);
  const fallback = Math.max(1, options.limit ?? 5);
  const most = Math.max(fallback, options.maxLimit ?? 20);
  return {
    name: TOOL_SEARCH_NAME,
    description: `Finds tools for a task among ${tools.length} more tools that are not loaded yet, by their names, descriptions, and arguments. Describe what you need to do, such as "create a calendar event"; the tools found can be called right after.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the tool should do, in a few words' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: most,
          description: `How many tools to return. Defaults to ${fallback}`,
        },
      },
      required: ['query'],
    },
    capabilities: [],
    execute: async (args): Promise<ToolOutput> => {
      const query = String(args.query ?? '');
      const wanted = Math.min(most, Math.max(1, Math.floor(Number(args.limit) || fallback)));
      const hits = search(query, wanted);
      if (hits.length === 0) {
        return {
          type: 'tool_output',
          content: [{ type: 'text', text: `No tool matches "${query}". Try other words.` }],
        };
      }
      const listed = hits.map(({ tool }) => `- ${tool.name}: ${short(tool.description)}`).join('\n');
      const references: ContentPart[] = hits.map(({ tool }) => ({ type: 'tool_reference', name: tool.name }));
      return {
        type: 'tool_output',
        content: [{ type: 'text', text: `Found ${hits.length}, which you can call now:\n${listed}` }, ...references],
      };
    },
  };
}

const short = (text: string) => (text.length > 200 ? `${text.slice(0, 197)}...` : text);

/** The words of a text: lower case, split at punctuation, underscores, and case changes, lightly stemmed. */
function words(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  )
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map((word) => (word.length > 3 ? word.replace(/(?:ies|es|s)$/, (end) => (end === 'ies' ? 'y' : '')) : word));
}

const STOP = new Set([
  'the',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'it',
  'is',
  'as',
  'by',
  'with',
  'use',
  'this',
]);

/** What a tool is searched by: its name twice, its description, and each argument's name and description. */
function documentOf(tool: ToolDefinition): string[] {
  const properties = (tool.parameters as { properties?: Record<string, { description?: unknown }> }).properties ?? {};
  const argumentText = Object.entries(properties)
    .map(([name, schema]) => `${name} ${typeof schema?.description === 'string' ? schema.description : ''}`)
    .join(' ');
  const name = words(tool.name);
  return [...name, ...name, ...words(tool.description), ...words(argumentText)];
}

/** A BM25 index over tools, built once, answering any number of queries. */
function indexTools(tools: readonly ToolDefinition[]): (query: string, limit: number) => ToolSearchHit[] {
  const documents = tools.map((tool) => {
    const counts = new Map<string, number>();
    const terms = documentOf(tool);
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return { tool, counts, length: terms.length };
  });
  const average = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  const frequency = new Map<string, number>();
  for (const document of documents)
    for (const term of document.counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  return (query, limit) => {
    const terms = [...new Set(words(query))];
    const hits: ToolSearchHit[] = [];
    for (const document of documents) {
      let score = 0;
      for (const term of terms) {
        const count = document.counts.get(term);
        if (!count) continue;
        const appears = frequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - appears + 0.5) / (appears + 0.5));
        score += (idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * document.length) / average));
      }
      if (score > 0) hits.push({ tool: document.tool, score });
    }
    return hits.sort((x, y) => y.score - x.score || x.tool.name.localeCompare(y.tool.name)).slice(0, limit);
  };
}
