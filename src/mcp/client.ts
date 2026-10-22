import type { ToolContext, ToolDefinition } from '../types/messages.js';
import {
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  LineDecoder,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpTransport,
} from './protocol.js';

/**
 * What a server says a tool does, as MCP's tool annotations: hints, which a client trusts only as far
 * as it trusts the server. A hint left out takes the specification's default.
 */
export interface McpToolAnnotations {
  /** A name for people. */
  title?: string;
  /** It changes nothing. Defaults to false. */
  readOnlyHint?: boolean;
  /** When it changes things, it may destroy or overwrite them, not only add. Defaults to true. */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments changes nothing more. Defaults to false. */
  idempotentHint?: boolean;
  /** It reaches things beyond the server, such as the web. Defaults to true. */
  openWorldHint?: boolean;
}

/** A tool an MCP server offers. */
export interface McpToolDescriptor {
  /** The tool's name. */
  name: string;
  /** What the tool does, for the model. */
  description?: string;
  /** JSON Schema for the arguments. */
  inputSchema?: Record<string, unknown>;
  /** What the server says the tool does. */
  annotations?: McpToolAnnotations;
}

/**
 * The capabilities an MCP tool declares, from what its server says of it in its annotations, so a
 * permission policy decides it as it decides any tool:
 * - `mcp.read:<server>/<tool>` for a tool that only reads;
 * - `mcp.write:<server>/<tool>` for one that changes things but destroys nothing;
 * - `mcp.destructive:<server>/<tool>` for one that may destroy or overwrite;
 * - and `network`, beside it, for one that reaches beyond its server.
 *
 * A hint left out takes the specification's default: not read-only, destructive, and open. A tool
 * with no annotations at all declares nothing, `undefined`, so a policy decides it as undeclared.
 */
export function mcpToolCapabilities(tool: McpToolDescriptor, server: string): string[] | undefined {
  const hints = tool.annotations;
  if (!hints || typeof hints !== 'object') return undefined;
  const effect =
    hints.readOnlyHint === true ? 'mcp.read' : hints.destructiveHint === false ? 'mcp.write' : 'mcp.destructive';
  return [`${effect}:${server}/${tool.name}`, ...(hints.openWorldHint === false ? [] : ['network'])];
}

/** Options for `McpClient.toNexusTools()`. */
export interface McpToolsOptions {
  /** Put before each tool's name with an underscore, so two servers' `search` tools differ. */
  prefix?: string;
  /**
   * The capabilities each tool declares: `true` reads them from the server's annotations, with
   * `mcpToolCapabilities()`, under the server's name (the prefix, or the name the server gives); a
   * function decides them per tool. Without it, a tool declares none, as before 2.17.
   */
  capabilities?: boolean | ((tool: McpToolDescriptor) => readonly string[] | undefined);
  /** The server's name in each capability, when `capabilities` is `true`. Defaults to the prefix. */
  server?: string;
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
  /**
   * When the transport closes, as an SSE stream that ends or a server process that exits does, the
   * next request opens it again and repeats the handshake, since the server's session went with it.
   * Requests in flight still fail, and a client closed with `close()` stays closed. Needs a transport
   * that can open again: `createStdioTransport` starts a new process, `createSseTransport` with
   * `reopen` a new stream.
   */
  reconnect?: boolean;
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
  /** Where each progress token's reports go, while its tool call runs. */
  private readonly progress = new Map<
    string,
    (progress: { progress: number; total?: number; message?: string }) => void
  >();
  private initialized = false;
  private connecting: Promise<{ name?: string; version?: string }> | undefined;
  private serverInfo: { name?: string; version?: string } = {};
  /** Who hears that the server's tools changed. */
  private readonly toolsChanged = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions = {},
  ) {
    transport.onMessage((message) => this.receive(message));
    transport.onClose?.(() => {
      this.failAll(new McpError('The MCP connection closed'));
      // Reconnecting, the next request opens the transport and greets the server again.
      if (this.options.reconnect && !this.stopped) this.initialized = false;
    });
  }

  /**
   * Hears each `notifications/tools/list_changed` the server sends: its tools are no longer what
   * `listTools()` returned. Returns a function that stops hearing.
   */
  onToolsChanged(handler: () => void): () => void {
    this.toolsChanged.add(handler);
    return () => {
      this.toolsChanged.delete(handler);
    };
  }

  /**
   * Performs the handshake and returns the server's name and version. Called automatically by the
   * first request that needs it; requests made together share one handshake.
   */
  async connect(): Promise<{ name?: string; version?: string }> {
    if (this.initialized) return this.serverInfo;
    this.connecting ??= this.handshake().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async handshake(): Promise<{ name?: string; version?: string }> {
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
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { progress?: (progress: { progress: number; total?: number; message?: string }) => void } = {},
  ): Promise<McpToolResult> {
    await this.connect();
    // With `progress`, the call names a token, and the server's notifications for it arrive there.
    const token = options.progress ? `progress-${this.nextId}` : undefined;
    if (token && options.progress) this.progress.set(token, options.progress);
    try {
      const result = (await this.request('tools/call', {
        name,
        arguments: args,
        ...(token ? { _meta: { progressToken: token } } : {}),
      })) as McpToolResult;
      return { content: result?.content ?? [], ...(result?.isError ? { isError: true } : {}) };
    } finally {
      if (token) this.progress.delete(token);
    }
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
  async toNexusTools(options: McpToolsOptions = {}): Promise<ToolDefinition[]> {
    const tools = await this.listTools();
    const server = options.server ?? options.prefix ?? this.serverInfo.name ?? 'mcp';
    const declared = (descriptor: McpToolDescriptor) => {
      const { capabilities } = options;
      if (!capabilities) return undefined;
      const list = capabilities === true ? mcpToolCapabilities(descriptor, server) : capabilities(descriptor);
      return list === undefined ? undefined : [...list];
    };
    return tools.map((descriptor) => {
      const capabilities = declared(descriptor);
      return {
        name: options.prefix ? `${options.prefix}_${descriptor.name}` : descriptor.name,
        description: descriptor.description ?? `MCP tool ${descriptor.name}`,
        parameters: descriptor.inputSchema ?? { type: 'object', properties: {} },
        ...(capabilities ? { capabilities } : {}),
        execute: async (args: Record<string, unknown>, context?: ToolContext) => {
          const progress = context?.progress;
          const result = await this.callTool(descriptor.name, args, progress ? { progress } : {});
          const text = result.content
            .map((part) => part.text ?? (part.type === 'text' ? '' : JSON.stringify(part)))
            .filter(Boolean)
            .join('\n');
          if (result.isError) throw new McpError(text || `MCP tool ${descriptor.name} failed`);
          return text;
        },
      };
    });
  }

  /** Closes the connection and rejects every request still waiting. */
  async close(): Promise<void> {
    this.stopped = true;
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
    if (isNotification(message) && message.method === 'notifications/tools/list_changed') {
      for (const handler of this.toolsChanged) {
        try {
          handler();
        } catch {
          // One listener's failure does not keep the others from hearing it.
        }
      }
      return;
    }
    if (isNotification(message) && message.method === 'notifications/progress') {
      const params = (message.params ?? {}) as {
        progressToken?: unknown;
        progress?: unknown;
        total?: unknown;
        message?: unknown;
      };
      const report = this.progress.get(String(params.progressToken));
      report?.({
        progress: typeof params.progress === 'number' ? params.progress : 0,
        ...(typeof params.total === 'number' ? { total: params.total } : {}),
        ...(typeof params.message === 'string' ? { message: params.message } : {}),
      });
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
  /**
   * Which of this process's environment variables the server inherits, besides `env`. By default,
   * only what a process needs to start: the path, the home and temporary directories, the user, the
   * locale and terminal, the Windows system variables, proxies, and certificate settings. A server is
   * often third-party code, and must not see this process's API keys or database URLs. A list adds
   * the variables it names, `true` passes the whole environment, as releases before 2.4 did, and
   * `false` passes nothing but `env`.
   */
  inheritEnv?: boolean | readonly string[];
}

/** The variables a server inherits by default: enough to start a process, and nothing secret. */
const INHERITED_ENV = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

/**
 * The environment a server process starts with. Names compare without case, as Windows compares
 * them, and `LC_` locale settings are kept with the rest of the locale.
 */
export function serverEnvironment(
  source: Record<string, string | undefined>,
  options: Pick<StdioClientOptions, 'env' | 'inheritEnv'> = {},
): Record<string, string> {
  if (options.inheritEnv === false) return { ...options.env };
  const named = new Set(
    (Array.isArray(options.inheritEnv) ? options.inheritEnv : []).map((name) => name.toUpperCase()),
  );
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (options.inheritEnv === true || INHERITED_ENV.has(upper) || upper.startsWith('LC_') || named.has(upper)) {
      inherited[name] = value;
    }
  }
  return { ...inherited, ...options.env };
}

/**
 * Runs an MCP server as a child process and speaks to it over its stdin and stdout.
 *
 * The transport most MCP servers ship with. `node:child_process` is imported lazily, so a browser
 * or edge build that only uses the HTTP transport never reaches for it. When the process exits, the
 * transport closes; started again, it runs a new one.
 */
export function createStdioTransport(options: StdioClientOptions): McpTransport {
  let child:
    | {
        stdin: { write(data: string): void };
        stdout: NodeJS.EventEmitter;
        kill(): void;
        exitCode: number | null;
        signalCode: string | null;
        once(event: 'close', listener: () => void): void;
      }
    | undefined;
  let onMessage: (message: JsonRpcMessage) => void = () => undefined;
  let onClose: () => void = () => undefined;

  return {
    async start() {
      // Each process reads its own lines, so a line one left unfinished never joins the next one's.
      const decoder = new LineDecoder();
      const { spawn } = await import('node:child_process');
      const spawned = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: serverEnvironment(process.env, options),
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
    /** Stops the server and waits, up to two seconds, for its process to exit, so nothing it holds outlives it. */
    async close() {
      const running = child;
      child = undefined;
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => running.once('close', () => resolve()));
      running.kill();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref?.())]);
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

/** Connects to a remote MCP server over HTTP with Server-Sent Events, the transport before streamable HTTP. */
export interface SseClientOptions {
  /** The server's event stream: a `GET` here opens it, and the server names where to post messages. */
  url: string;
  /** Headers sent with the stream's request and with every message, such as authorization. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** How long to wait for the server to name where messages go, in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /**
   * Opens a new stream when the next message is sent after the stream ended, rather than staying
   * closed. The server starts a new session on it, so an `McpClient` with `reconnect` greets it again.
   */
  reopen?: boolean;
}

/**
 * Speaks to an MCP server over HTTP with Server-Sent Events, as MCP's 2024-11-05 transport: one
 * long `GET` the server answers on, and a `POST` per message to the endpoint the stream names
 * first. The endpoint must be on the stream's own origin, so a server cannot send the messages, and
 * their headers, anywhere else. When the stream ends, the transport closes; with `reopen`, the next
 * message opens a new one.
 */
export function createSseTransport(options: SseClientOptions): McpTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let onMessage: (message: JsonRpcMessage) => void = () => undefined;
  const onClose: Array<() => void> = [];
  let endpoint: string | undefined;
  let opening: Promise<void> | undefined;
  let closed = false;
  /** Set by `close()`: a transport closed on purpose never opens again. */
  let stopped = false;
  let stream = new AbortController();
  /** The transport closes when its current stream ends; a stream already replaced closes nothing. */
  const ended = (from: AbortController) => {
    if (closed || from !== stream) return;
    closed = true;
    for (const handler of onClose) handler();
  };

  const open = async () => {
    const own = new AbortController();
    stream = own;
    try {
      const response = await fetchImplementation(options.url, {
        headers: { accept: 'text/event-stream', ...options.headers },
        signal: own.signal,
      });
      if (!response.ok || !response.body) throw new McpError(`MCP SSE transport failed with ${response.status}`);
      const reader = response.body.getReader();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new McpError(`The MCP server named no endpoint within ${options.timeoutMs ?? 10_000}ms`)),
          options.timeoutMs ?? 10_000,
        );
        const event = (name: string, data: string) => {
          if (name === 'endpoint') {
            if (endpoint) return;
            const target = new URL(data.trim(), options.url);
            if (target.origin !== new URL(options.url).origin) {
              clearTimeout(timer);
              reject(new McpError(`The MCP server named an endpoint on another origin, ${target.origin}`));
              return;
            }
            endpoint = target.href;
            clearTimeout(timer);
            resolve();
          } else if (name === 'message') {
            try {
              onMessage(JSON.parse(data) as JsonRpcMessage);
            } catch {
              // A frame that is not JSON-RPC is skipped, not fatal.
            }
          }
        };
        void readEvents(reader, event).then(
          () => {
            clearTimeout(timer);
            reject(new McpError('The MCP event stream ended'));
            ended(own);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof McpError ? error : new McpError(`The MCP event stream failed: ${String(error)}`));
            ended(own);
          },
        );
      });
    } catch (error) {
      // A stream that never named its endpoint is over at once, so with `reopen` the next message tries again.
      own.abort();
      ended(own);
      throw error;
    }
  };

  /** Opens the stream once, for the first caller; later callers wait on the same opening. */
  const started = () => {
    // A stream that ended opens anew, when the transport reopens and was not closed on purpose.
    if (closed && options.reopen && !stopped) {
      closed = false;
      endpoint = undefined;
      opening = undefined;
    }
    opening ??= open();
    return opening;
  };

  return {
    start: started,
    async send(message) {
      await started();
      if (closed || !endpoint) throw new McpError('The MCP event stream is closed');
      const response = await fetchImplementation(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(message),
      });
      // The answer comes on the stream; the POST's own body says only that it was taken.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new McpError(`MCP SSE transport failed with ${response.status}`);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose.push(handler);
    },
    close() {
      stopped = true;
      stream.abort();
      ended(stream);
    },
  };
}

/** Reads Server-Sent Events, calling `event` with each one's name (`message` by default) and data. */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  event: (name: string, data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let name = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) event(name, data.join('\n'));
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function sseData(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}
