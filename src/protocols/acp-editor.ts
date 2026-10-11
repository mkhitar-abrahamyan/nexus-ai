/**
 * The editor an ACP session runs in, as tools an agent can use: the editor's files and terminal,
 * through the ACP connection, and the MCP servers the editor offers for the session.
 *
 * ```ts
 * const editor = acpEditor();
 * const agent = createAgent({ client: ai, toolSource: editor.toolSource, interruptOn: { editor_write_file: true } });
 * serveAcp(agent, { input: process.stdin, output: process.stdout }, { editor });
 * ```
 *
 * A tool is offered only when the editor said it can do that thing, in `initialize`. Each declares
 * what it touches, as `filesystem:read:<path>`, `filesystem:write:<path>`, or `shell:<command>`, so a
 * permission policy decides it like any other tool, and an approval asks the person in the editor.
 */
import type { ToolSourceContext } from '../agent/create-agent.js';
import { createHttpTransport, createStdioTransport, McpClient } from '../mcp/client.js';
import type { ToolDefinition } from '../types/messages.js';
import type { AcpConnection, AcpEditorBridge, AcpSessionInfo } from './acp.js';

/** Options for `acpEditor()`. */
export interface AcpEditorOptions {
  /** Offers the editor's files, when the editor can read or write them. Defaults to true. */
  files?: boolean;
  /** Offers the editor's terminal, when the editor has one. Defaults to true. */
  terminal?: boolean;
  /** Connects the MCP servers the editor offers for a session, and offers their tools. Defaults to true. */
  mcp?: boolean;
  /** How long a request to an MCP server may take, in milliseconds. Defaults to 30 seconds. */
  mcpTimeoutMs?: number;
  /** Replaces `fetch` for MCP servers reached over HTTP: a proxy, or a test. */
  mcpFetch?: typeof globalThis.fetch;
  /** The most terminal output a command returns, in bytes. Defaults to 64 KB. */
  maxOutputBytes?: number;
  /** Receives an MCP server that failed to start, whose tools are then not offered. */
  onError?: (error: unknown, server: string) => void;
}

/** The editor, as tools for an agent. */
export interface AcpEditor extends AcpEditorBridge {
  /** The tools of one session, for `CreateAgentOptions.toolSource`: the session is the run's thread. */
  toolSource(context: ToolSourceContext): Promise<ToolDefinition[]>;
  /** Closes every MCP server it connected. */
  close(): Promise<void>;
}

/** An MCP server the editor offers, as ACP describes it. */
interface OfferedServer {
  name?: string;
  type?: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  url?: string;
  headers?: Array<{ name: string; value: string }>;
}

/** The editor's files, terminal, and MCP servers, as tools an agent's `toolSource` supplies per session. */
export function acpEditor(options: AcpEditorOptions = {}): AcpEditor {
  let connection: AcpConnection | undefined;
  const servers = new Map<string, Promise<{ clients: McpClient[]; tools: ToolDefinition[] }>>();
  const maxOutput = options.maxOutputBytes ?? 65_536;

  /** Connects a session's MCP servers once, keeping those that start. */
  const mcpTools = (session: AcpSessionInfo) => {
    let connected = servers.get(session.id);
    if (!connected) {
      connected = (async () => {
        const clients: McpClient[] = [];
        const tools: ToolDefinition[] = [];
        for (const offered of session.mcpServers as OfferedServer[]) {
          const name = String(offered.name ?? 'mcp');
          try {
            const transport = offered.command
              ? createStdioTransport({
                  command: offered.command,
                  args: offered.args ?? [],
                  env: Object.fromEntries((offered.env ?? []).map((item) => [item.name, item.value])),
                  ...(session.cwd ? { cwd: session.cwd } : {}),
                })
              : offered.url && (offered.type === 'http' || offered.type === undefined)
                ? createHttpTransport({
                    url: offered.url,
                    headers: Object.fromEntries((offered.headers ?? []).map((item) => [item.name, item.value])),
                    ...(options.mcpFetch ? { fetch: options.mcpFetch } : {}),
                  })
                : undefined;
            if (!transport) throw new Error(`MCP server "${name}" uses a transport this agent does not speak`);
            const client = new McpClient(transport, { timeoutMs: options.mcpTimeoutMs ?? 30_000 });
            tools.push(...(await client.toNexusTools({ prefix: name.replace(/[^A-Za-z0-9_-]/g, '_') })));
            clients.push(client);
          } catch (error) {
            options.onError?.(error, name);
          }
        }
        return { clients, tools };
      })();
      servers.set(session.id, connected);
    }
    return connected;
  };

  const tools = (session: AcpSessionInfo): ToolDefinition[] => {
    const editor = connection as AcpConnection;
    const offered = editor.capabilities();
    const ask = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      editor.request(method, { sessionId: session.id, ...params }, signal);
    const absolute = (path: unknown) => absolutePath(String(path ?? ''), session.cwd);
    const list: ToolDefinition[] = [];
    if (options.files !== false && offered.fs?.readTextFile) {
      list.push({
        name: 'editor_read_file',
        description:
          'Reads a text file through the editor, including changes the person has not saved. Give a path, and optionally the line to start at and how many lines to read.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, line: { type: 'number' }, limit: { type: 'number' } },
          required: ['path'],
        },
        capabilities: (args) => [`filesystem:read:${absolute(args.path)}`],
        execute: async (args, context) => {
          const result = (await ask(
            'fs/read_text_file',
            {
              path: absolute(args.path),
              ...(typeof args.line === 'number' ? { line: args.line } : {}),
              ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            },
            context?.signal,
          )) as { content?: string };
          return result?.content ?? '';
        },
      });
    }
    if (options.files !== false && offered.fs?.writeTextFile) {
      list.push({
        name: 'editor_write_file',
        description:
          'Writes a text file through the editor, which shows the change. Give a path and the whole content.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        capabilities: (args) => [`filesystem:write:${absolute(args.path)}`],
        execute: async (args, context) => {
          await ask(
            'fs/write_text_file',
            { path: absolute(args.path), content: String(args.content ?? '') },
            context?.signal,
          );
          return `Wrote ${absolute(args.path)}`;
        },
      });
    }
    if (options.terminal !== false && offered.terminal) {
      list.push({
        name: 'editor_run_command',
        description:
          "Runs a command in the editor's terminal, which the person sees, and returns its output and exit code.",
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
          },
          required: ['command'],
        },
        capabilities: (args) => [
          `shell:${[String(args.command ?? ''), ...((args.args as string[] | undefined) ?? [])].join(' ')}`,
        ],
        execute: async (args, context) => {
          const created = (await ask(
            'terminal/create',
            {
              command: String(args.command ?? ''),
              args: Array.isArray(args.args) ? args.args.map(String) : [],
              cwd: absolute(args.cwd ?? '.'),
              outputByteLimit: maxOutput,
            },
            context?.signal,
          )) as { terminalId: string };
          const terminalId = created.terminalId;
          // A run that is cancelled stops the command; the terminal is always released.
          const kill = () => void ask('terminal/kill', { terminalId }).catch(() => undefined);
          context?.signal?.addEventListener('abort', kill, { once: true });
          try {
            const exit = (await ask('terminal/wait_for_exit', { terminalId }, context?.signal)) as {
              exitCode?: number | null;
              signal?: string | null;
            };
            const output = (await ask('terminal/output', { terminalId })) as { output?: string; truncated?: boolean };
            return {
              exitCode: exit?.exitCode ?? null,
              ...(exit?.signal ? { signal: exit.signal } : {}),
              output: output?.output ?? '',
              ...(output?.truncated ? { truncated: true } : {}),
            };
          } finally {
            context?.signal?.removeEventListener('abort', kill);
            await ask('terminal/release', { terminalId }).catch(() => undefined);
          }
        },
      });
    }
    return list;
  };

  return {
    attach(next) {
      connection = next;
    },
    detach() {
      return this.close();
    },
    async toolSource(context) {
      const session = connection?.session(context.threadId);
      if (!connection || !session) return [];
      const own = tools(session);
      if (options.mcp === false || session.mcpServers.length === 0) return own;
      return [...own, ...(await mcpTools(session)).tools];
    },
    async close() {
      const connected = [...servers.values()];
      servers.clear();
      for (const { clients } of await Promise.all(connected)) {
        await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      }
    },
  };
}

/** A path as the editor wants it, absolute: a relative one is taken from the session's directory. */
function absolutePath(path: string, cwd: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  const separator = /^[A-Za-z]:/.test(base) || base.includes('\\') ? '\\' : '/';
  // One separator throughout, the one the directory uses.
  const relative = path === '.' || path === '' ? '' : path.replace(/^\.[\\/]/, '').replace(/[\\/]+/g, separator);
  return relative ? `${base}${separator}${relative}` : base;
}
