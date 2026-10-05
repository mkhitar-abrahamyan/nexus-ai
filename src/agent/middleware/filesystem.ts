import type { Message } from '../../types/messages.js';
import type { AgentMiddleware } from '../create-agent.js';
import type { Sandbox } from '../sandbox.js';

/** Where `filesystemContext()` reads and writes: a `Sandbox`, or anything with the same file methods. */
export type FilesystemContextSource = Pick<Sandbox, 'readFile'> & Partial<Pick<Sandbox, 'writeFile' | 'listFiles'>>;

/** Where large tool results go instead of the transcript. */
export interface ContextOffloadOptions {
  /** Results longer than this, in characters, are offloaded. Defaults to 20,000. */
  overChars?: number;
  /** The directory they are written to, inside the source. Defaults to `.context`. */
  directory?: string;
  /** How much of a result stays in the transcript as a preview, in characters. Defaults to 1,000. */
  previewChars?: number;
  /** Tools whose results are never offloaded. Defaults to `read_file`, so reading one back cannot loop. */
  exclude?: readonly string[];
}

/** Options for `filesystemContext()`. */
export interface FilesystemContextOptions {
  /** Where files are read from and offloaded to. */
  source: FilesystemContextSource;
  /**
   * Files whose contents the model sees on every call, after the system prompt: project
   * instructions such as `AGENTS.md`, conventions, a glossary. A missing file is skipped.
   */
  include?: readonly string[];
  /** Lists a directory after the files, so the model knows what exists without a tool call. Needs `listFiles`. */
  listing?: { directory?: string; maxEntries?: number };
  /** The most characters of included files, together. Defaults to 32,000; the rest is cut. */
  maxChars?: number;
  /** Writes large tool results to a file and leaves a preview and the path. Needs `writeFile`. */
  offload?: ContextOffloadOptions | boolean;
}

/**
 * The filesystem as the agent's context: files in, large results out.
 *
 * Instruction files reach the model on every call without a tool call, read once per run and placed
 * right after the system prompt, so the prefix a provider caches stays the same. A tool result too
 * large for the context is written to a file instead, and the model reads a preview and a path it can
 * open with `read_file` when it needs the rest: the transcript stays small however much a tool
 * returns, and nothing is lost.
 */
export function filesystemContext(options: FilesystemContextOptions): AgentMiddleware {
  const maxChars = options.maxChars ?? 32_000;
  const offload =
    options.offload === true
      ? {}
      : options.offload === false || options.offload === undefined
        ? undefined
        : options.offload;
  if (offload && !options.source.writeFile) {
    throw new TypeError('filesystemContext() offloading needs a source with writeFile()');
  }
  // Read once per run: keyed by thread and turn, and bounded, so a long-lived agent never grows it.
  const loaded = new Map<string, Promise<string | undefined>>();

  const load = async (): Promise<string | undefined> => {
    const sections: string[] = [];
    let budget = maxChars;
    for (const file of options.include ?? []) {
      if (budget <= 0) break;
      let text: string;
      try {
        text = await options.source.readFile(file);
      } catch {
        continue;
      }
      const cut =
        text.length > budget ? `${text.slice(0, budget)}\n[cut: ${text.length - budget} more characters]` : text;
      budget -= text.length;
      sections.push(`<file path="${file}">\n${cut}\n</file>`);
    }
    if (options.listing && options.source.listFiles) {
      try {
        const entries = await options.source.listFiles(options.listing.directory ?? '.');
        const max = options.listing.maxEntries ?? 200;
        const shown = entries.slice(0, max).join('\n');
        sections.push(
          `<listing directory="${options.listing.directory ?? '.'}">\n${shown}${entries.length > max ? `\n[${entries.length - max} more]` : ''}\n</listing>`,
        );
      } catch {
        // A missing directory lists nothing.
      }
    }
    return sections.length ? `Files from the workspace:\n\n${sections.join('\n\n')}` : undefined;
  };

  return {
    name: 'filesystem-context',
    async beforeModel({ request, state, threadId }) {
      if (!options.include?.length && !options.listing) return;
      const turn = state.messages.filter((message) => message.role === 'user').length;
      const key = `${threadId}:${turn}`;
      let pending = loaded.get(key);
      if (!pending) {
        pending = load();
        loaded.set(key, pending);
        if (loaded.size > 256) loaded.delete(loaded.keys().next().value as string);
      }
      const text = await pending;
      if (!text) return;
      const systemCount = request.messages.findIndex((message) => message.role !== 'system');
      const at = systemCount === -1 ? request.messages.length : systemCount;
      const context: Message = { role: 'system', content: text };
      return { ...request, messages: [...request.messages.slice(0, at), context, ...request.messages.slice(at)] };
    },
    async wrapToolCall(call, next) {
      const result = await next();
      if (!offload || !result.ok || (offload.exclude ?? ['read_file']).includes(call.name)) return result;
      const value = result.result;
      if ((value as { type?: unknown } | null)?.type === 'tool_output') return result;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text === undefined || text.length <= (offload.overChars ?? 20_000)) return result;

      const directory = (offload.directory ?? '.context').replace(/\/+$/, '');
      const file = `${directory}/${`${call.name}-${call.id}`.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`;
      // The same call writes the same file, so a replayed step rewrites it harmlessly.
      await options.source.writeFile?.(file, text);
      const preview = text.slice(0, offload.previewChars ?? 1_000);
      return {
        ok: true,
        result: `${preview}\n\n[This result is ${text.length} characters; the first ${preview.length} are above. The whole result is in ${file}: read it with read_file when you need the rest.]`,
      };
    },
  };
}
