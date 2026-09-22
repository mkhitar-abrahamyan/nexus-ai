import type { ToolDefinition } from '../types/messages.js';
import {
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  LineDecoder,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpTransport,
} from './protocol.js';

/** A tool an MCP server offers. */
export interface McpToolDescriptor {
  /** The tool's name. */
  name: string;
  /** What the tool does, for the model. */
  description?: string;
  /** JSON Schema for the arguments. */
  inputSchema?: Record<string, unknown>;
}

/** A resource an MCP server offers. */
export interface McpResourceDescriptor {
  /** The resource's URI. */
  uri: string;
  /** A readable name. */
  name?: string;
  /** What the resource contains. */
  description?: string;
  /** Its MIME type. */
  mimeType?: string;
}

/** One piece of content from an MCP server: text, or base64 data with a MIME type. */
export interface McpContent {
  /** `text`, `image`, `resource`, or another type the server defines. */
  type: string;
  /** The text, for text content. */
  text?: string;
  /** Base64 data, for binary content. */
  data?: string;
  /** MIME type of `data`. */
  mimeType?: string;
  [key: string]: unknown;
}

/** What a tool call returned. */
export interface McpToolResult {
  /** The result, as content parts. */
  content: McpContent[];
  /** True when the tool reported a failure rather than a result. */
  isError?: boolean;
}

/** Options for an MCP client. */
export interface McpClientOptions {
  /** Name and version this client reports in the handshake. */
  clientInfo?: { name: string; version: string };
  /** How long a request waits before failing. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/**
 * Talks to an MCP server.
 *
 * This is how the package reaches a tool ecosystem without maintaining its own catalogue of
 * integrations: anything exposed over MCP — a filesystem server, a database, an internal service —
 * becomes tools an agent can call, through `toNexusTools()`.
 */
export class McpClient {
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private initialized = false;
  private serverInfo: { name?: string; version?: string } = {};

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions = {},
  ) {
    transport.onMessage((message) => this.receive(message));
    transport.onClose?.(() => this.failAll(new McpError('The MCP connection closed')));
  }

  /** Performs the handshake. Called automatically by the first request that needs it. */
  async connect(): Promise<{ name?: string; version?: string }> {
    if (this.initialized) return this.serverInfo;
    await this.transport.start?.();
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: this.options.clientInfo ?? { name: 'nexus-ai-pro', version: '1.x' },
    })) as { serverInfo?: { name?: string; version?: string } };

    this.initialized = true;
    this.serverInfo = result?.serverInfo ?? {};
    await this.notify('notifications/initialized');
    return this.serverInfo;
  }

  /** Lists the server's tools. */
  async listTools(): Promise<McpToolDescriptor[]> {
    await this.connect();
    const result = (await this.request('tools/list')) as { tools?: McpToolDescriptor[] };
    return result?.tools ?? [];
  }

  /**
   * Calls a tool. A tool that fails reports `isError` rather than throwing; a protocol failure
   * throws `McpError`.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.connect();
    const result = (await this.request('tools/call', { name, arguments: args })) as McpToolResult;
    return { content: result?.content ?? [], ...(result?.isError ? { isError: true } : {}) };
  }

  /** Lists the server's resources. */
  async listResources(): Promise<McpResourceDescriptor[]> {
    await this.connect();
    const result = (await this.request('resources/list')) as { resources?: McpResourceDescriptor[] };
    return result?.resources ?? [];
  }

  /** Reads a resource's content. */
  async readResource(uri: string): Promise<McpContent[]> {
    await this.connect();
    const result = (await this.request('resources/read', { uri })) as { contents?: McpContent[] };
    return result?.contents ?? [];
  }

  /** Lists the server's prompts. */
  async listPrompts(): Promise<Array<{ name: string; description?: string }>> {
    await this.connect();
    const result = (await this.request('prompts/list')) as { prompts?: Array<{ name: string; description?: string }> };
    return result?.prompts ?? [];
  }

  /** Renders a prompt with arguments into messages. */
  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Array<{ role: string; content: McpContent }>> {
    await this.connect();
    const result = (await this.request('prompts/get', { name, arguments: args })) as {
      messages?: Array<{ role: string; content: McpContent }>;
    };
    return result?.messages ?? [];
  }

  /**
   * The server's tools, ready for `createAgent` or `ToolExecutor`.
   *
   * Names are prefixed when asked, because two servers can both offer `search` and a model has to be
   * able to tell them apart.
   */
  async toNexusTools(options: { prefix?: string } = {}): Promise<ToolDefinition[]> {
    const tools = await this.listTools();
    return tools.map((descriptor) => ({
      name: options.prefix ? `${options.prefix}_${descriptor.name}` : descriptor.name,
      description: descriptor.description ?? `MCP tool ${descriptor.name}`,
      parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
      execute: async (args: Record<string, unknown>) => {
        const result = await this.callTool(descriptor.name, args);
        const text = result.content
          .map((part) => part.text ?? (part.type === 'text' ? '' : JSON.stringify(part)))
          .filter(Boolean)
          .join('\n');
        if (result.isError) throw new McpError(text || `MCP tool ${descriptor.name} failed`);
        return text;
      },
    }));
  }

  /** Closes the connection and rejects every request still waiting. */
  async close(): Promise<void> {
    this.failAll(new McpError('The MCP client was closed'));
    await this.transport.close();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    // The timer is deliberately not unref'd: a request in flight is work in progress, and a process
    // that exits while waiting would look like a hang rather than a timeout.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(
        this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      ).catch((error) => {
        this.settle(id, undefined, error);
      });
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private receive(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      this.settle(
        message.id,
        message.result,
        message.error ? new McpError(message.error.message, message.error.code, message.error.data) : undefined,
      );
      return;
    }
    // A server may ask the client for things (sampling, roots). Refusing politely is better than
    // leaving it waiting for a reply that never comes.
    if (isRequest(message)) {
      void this.transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32_601, message: `This client does not implement "${message.method}"` },
      });
    }
  }

  private settle(id: JsonRpcId, result: unknown, error: unknown): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (error) waiting.reject(error);
    else waiting.resolve(result);
  }

  private failAll(error: unknown): void {
    for (const [id] of this.pending) this.settle(id, undefined, error);
  }
}

/** Launches a local MCP server as a child process and talks to it over stdin and stdout. */
export interface StdioClientOptions {
  /** Executable to run. */
  command: string;
  /** Its arguments. */
  args?: string[];
  /** Environment variables for the process. */
  env?: Record<string, string>;
  /** Working directory for the process. */
  cwd?: string;
}

/**
 * Runs an MCP server as a child process and speaks to it over its stdin and stdout.
 *
 * The transport most MCP servers ship with. `node:child_process` is imported lazily, so a browser
 * or edge build that only uses the HTTP transport never reaches for it.
 */
export function createStdioTransport(options: StdioClientOptions): McpTransport {
  let child: { stdin: { write(data: string): void }; stdout: NodeJS.EventEmitter; kill(): void } | undefined;
  const decoder = new LineDecoder();
  let onMessage: (message: JsonRpcMessage) => void = () => undefined;
  let onClose: () => void = () => undefined;

  return {
    async start() {
      const { spawn } = await import('node:child_process');
      const spawned = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      spawned.stdout.setEncoding('utf8');
      spawned.stdout.on('data', (chunk: string) => {
        for (const message of decoder.push(chunk)) onMessage(message);
      });
      spawned.on('close', () => onClose());
      child = spawned as never;
    },
    send(message) {
      if (!child) throw new McpError('The MCP transport is not started');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      child?.kill();
      child = undefined;
    },
  };
}

/** Connects to a remote MCP server over HTTP. */
export interface HttpClientOptions {
  /** The server's endpoint. */
  url: string;
  /** Headers sent with every request, such as authorization. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Speaks to an MCP server over HTTP, one POST per message.
 *
 * Server-initiated streaming is not implemented: this covers request and response, which is what
 * calling a tool needs.
 */
export function createHttpTransport(options: HttpClientOptions): McpTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let onMessage: (message: JsonRpcMessage) => void = () => undefined;
  let sessionId: string | undefined;

  return {
    async send(message) {
      const response = await fetchImplementation(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...options.headers,
        },
        body: JSON.stringify(message),
      });
      sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      if (!response.ok) throw new McpError(`MCP HTTP transport failed with ${response.status}`);
      if (response.status === 202) return;

      const body = await response.text();
      if (!body.trim()) return;
      // A server may answer as JSON or as a one-event SSE stream; both carry the same JSON-RPC body.
      for (const payload of body.startsWith('event:') || body.startsWith('data:') ? sseData(body) : [body]) {
        try {
          onMessage(JSON.parse(payload) as JsonRpcMessage);
        } catch {
          // Ignore a frame that is not JSON-RPC, rather than failing the whole exchange.
        }
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    close() {
      sessionId = undefined;
    },
  };
}

function sseData(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}
