import { parseCapability } from '../agent/capabilities.js';
import type { ToolContext, ToolDefinition } from '../types/messages.js';
import type { McpToolAnnotations } from './client.js';
import {
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC_ERRORS,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  LineDecoder,
  type McpCallerRequests,
  type McpElicitationRequest,
  type McpElicitationResult,
  MCP_PROTOCOL_VERSION,
  McpError,
  type McpRoot,
  type McpSamplingContent,
  type McpSamplingRequest,
  type McpSamplingResult,
  type McpTransport,
  textContent,
} from './protocol.js';

/** A resource a server exposes, read by its URI. */
export interface McpServerResource {
  /** Its URI. */
  uri: string;
  /** A name for it. */
  name?: string;
  /** What it holds. */
  description?: string;
  /** Its MIME type. Defaults to `text/plain`. */
  mimeType?: string;
  /** Reads it: text as it is, anything else as JSON. */
  read(): Promise<unknown> | unknown;
}

/** One argument a prompt takes. */
export interface McpPromptArgument {
  /** Its name. */
  name: string;
  /** What it is for. */
  description?: string;
  /** Whether \`prompts/get\` must give it. */
  required?: boolean;
}

/** One message of a rendered prompt. */
export interface McpPromptMessage {
  /** Who says it. */
  role: 'user' | 'assistant';
  /** What is said. */
  content: McpSamplingContent;
}

/** A prompt a server offers: a template a client renders with its arguments. */
export interface McpServerPrompt {
  /** Its name. */
  name: string;
  /** A title for people. */
  title?: string;
  /** What it does. */
  description?: string;
  /** The arguments it takes. */
  arguments?: McpPromptArgument[];
  /** Renders it: text, which is one user message, or the messages themselves. */
  get(args: Record<string, string>): string | McpPromptMessage[] | Promise<string | McpPromptMessage[]>;
}

/** Options for an MCP server. */
export interface McpServerOptions {
  /** Server name reported to clients. Defaults to `nexus-ai-pro`. */
  name?: string;
  /** Server version reported to clients. Defaults to `1.x`. */
  version?: string;
  /** Tools the server exposes. */
  tools?: ToolDefinition[];
  /** Resources the server exposes, read by URI. */
  resources?: McpServerResource[];
  /** Prompts the server offers. */
  prompts?: McpServerPrompt[];
  /** How long a request this server sends a client waits for its answer, in milliseconds. Defaults to 60 seconds. */
  timeoutMs?: number;
}

/** Kinds of capability that stay within what the tool was given, without reaching beyond it. */
const CLOSED = new Set(['filesystem', 'mcp.read', 'mcp.write', 'mcp.destructive']);

/**
 * The annotations a tool is served with, from the capabilities it declares, read so a client is never
 * told less than the tool may do:
 * - read-only only when every capability reads, `filesystem:read` or `mcp.read`, or there are none;
 * - not destructive only when everything else it does is `mcp.write`;
 * - closed to the world only when every capability is the filesystem's or an MCP tool's effect.
 *
 * A tool whose capabilities depend on its arguments, or that declares none, is served without
 * annotations, which a client reads as the specification's defaults: it may do anything.
 */
export function mcpToolAnnotations(tool: Pick<ToolDefinition, 'capabilities'>): McpToolAnnotations | undefined {
  const declared = tool.capabilities;
  if (!declared || typeof declared === 'function') return undefined;
  const parsed = declared.map((capability) => parseCapability(capability));
  const reads = (item: (typeof parsed)[number]) =>
    (item.kind === 'filesystem' && item.access === 'read') || item.kind === 'mcp.read';
  const readOnly = parsed.every(reads);
  return {
    readOnlyHint: readOnly,
    ...(readOnly ? {} : { destructiveHint: !parsed.every((item) => reads(item) || item.kind === 'mcp.write') }),
    openWorldHint: !parsed.every((item) => CLOSED.has(item.kind)),
  };
}

/** One connected client: its transport, what it declared it answers, and what it is subscribed to. */
interface Session {
  transport?: McpTransport;
  /** The capabilities the client declared at \`initialize\`. */
  capabilities: Record<string, unknown>;
  /** Resource URIs it asked to hear about. */
  subscriptions: Set<string>;
  /** Requests this server sent it, waiting for its answer. */
  pending: Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >;
  /** Tool calls it made that are still running, so a cancellation stops them. */
  running: Map<JsonRpcId, AbortController>;
  nextId: number;
}

/**
 * Exposes tools, resources, and prompts over MCP, so other assistants can use them.
 *
 * The other direction of the same bridge: the client borrows an ecosystem's tools, the server lends
 * this application's. A tool written once with `tool()` can serve an agent here and an editor
 * elsewhere, and while it runs, ask the client that called it for a completion from its model or an
 * answer from its person, through `context.mcp`. One server serves every client connected to it, each
 * on its own transport, such as each session of `mcpHttpHandler()`.
 */
export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly resources = new Map<string, McpServerResource>();
  private readonly prompts = new Map<string, McpServerPrompt>();
  private readonly sessions = new Set<Session>();
  /** The session \`handle()\` answers on, when a host drives the server itself. */
  private latest: Session | undefined;
  private readonly rootsListeners = new Set<() => void>();

  constructor(private readonly options: McpServerOptions = {}) {
    for (const item of options.tools ?? []) this.tools.set(item.name, item);
    for (const item of options.resources ?? []) this.resources.set(item.uri, item);
    for (const item of options.prompts ?? []) this.prompts.set(item.name, item);
  }

  /** Adds a tool, and tells every connected client its tools changed. Returns the server, for chaining. */
  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    this.broadcast('notifications/tools/list_changed');
    return this;
  }

  /** Adds a prompt, and tells every connected client its prompts changed. Returns the server, for chaining. */
  registerPrompt(prompt: McpServerPrompt): this {
    this.prompts.set(prompt.name, prompt);
    this.broadcast('notifications/prompts/list_changed');
    return this;
  }

  /** Adds a resource, and tells every connected client its resources changed. Returns the server, for chaining. */
  registerResource(resource: McpServerResource): this {
    this.resources.set(resource.uri, resource);
    this.broadcast('notifications/resources/list_changed');
    return this;
  }

  /** Tells each client subscribed to a resource that it changed, so it reads it again. */
  resourceUpdated(uri: string): void {
    for (const session of this.sessions) {
      if (session.subscriptions.has(uri))
        this.send(session, { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
    }
  }

  /** Hears each client's \`notifications/roots/list_changed\`. Returns a function that stops hearing. */
  onRootsChanged(handler: () => void): () => void {
    this.rootsListeners.add(handler);
    return () => {
      this.rootsListeners.delete(handler);
    };
  }

  /**
   * Asks the connected client's model to continue a conversation. With several clients connected,
   * ask through a tool's \`context.mcp\`, which names the client that called it.
   */
  async createMessage(request: McpSamplingRequest, options: { signal?: AbortSignal } = {}): Promise<McpSamplingResult> {
    return this.callerOf(this.only()).createMessage(request, options);
  }

  /** Asks the connected client's person a question, with the form of its answer. */
  async elicit(request: McpElicitationRequest, options: { signal?: AbortSignal } = {}): Promise<McpElicitationResult> {
    return this.callerOf(this.only()).elicit(request, options);
  }

  /** Lists the roots the connected client lets this server work within. */
  async listRoots(options: { signal?: AbortSignal } = {}): Promise<McpRoot[]> {
    return this.callerOf(this.only()).listRoots(options);
  }

  /** Starts serving a client over a transport. Each transport is one client; several may be connected at once. */
  async connect(transport: McpTransport): Promise<void> {
    const session: Session = {
      transport,
      capabilities: {},
      subscriptions: new Set(),
      pending: new Map(),
      running: new Map(),
      nextId: 1,
    };
    this.sessions.add(session);
    this.latest = session;
    transport.onMessage((message) => void this.receive(message, session));
    transport.onClose?.(() => this.drop(session));
    await transport.start?.();
  }

  /** Closes every client's transport. */
  async close(): Promise<void> {
    const sessions = [...this.sessions];
    for (const session of sessions) this.drop(session);
    await Promise.all(sessions.map((session) => session.transport?.close()));
  }

  /** Handles one message. Exposed so a host can drive the server without a transport. */
  async handle(message: JsonRpcMessage): Promise<void> {
    this.latest ??= { capabilities: {}, subscriptions: new Set(), pending: new Map(), running: new Map(), nextId: 1 };
    await this.receive(message, this.latest);
  }

  private async receive(message: JsonRpcMessage, session: Session): Promise<void> {
    if (isResponse(message)) {
      const waiting = session.pending.get(message.id);
      if (!waiting) return;
      session.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new McpError(message.error.message, message.error.code, message.error.data));
      else waiting.resolve(message.result);
      return;
    }
    if (isNotification(message)) {
      if (message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
        if (requestId !== undefined)
          session.running.get(requestId)?.abort(new McpError('The client cancelled the call'));
      } else if (message.method === 'notifications/roots/list_changed') {
        for (const handler of this.rootsListeners) {
          try {
            handler();
          } catch {
            // One listener's failure does not keep the others from hearing it.
          }
        }
      }
      return;
    }
    // A request is a notification with an id, as the types see it, so it is named again here.
    const request = message as JsonRpcMessage;
    if (!isRequest(request)) return;

    try {
      const result = await this.dispatch(request, session);
      this.send(session, { jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      this.send(session, {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: error instanceof McpError ? error.code : JSON_RPC_ERRORS.internal,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatch(request: JsonRpcRequest, session: Session): Promise<unknown> {
    const params = (request.params ?? {}) as Record<string, unknown>;

    switch (request.method) {
      case 'initialize':
        session.capabilities = isObject(params.capabilities) ? params.capabilities : {};
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: { name: this.options.name ?? 'nexus-ai-pro', version: this.options.version ?? '1.x' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((item) => {
            const annotations = mcpToolAnnotations(item);
            return {
              name: item.name,
              description: item.description,
              inputSchema: item.parameters ?? { type: 'object', properties: {} },
              ...(annotations ? { annotations } : {}),
            };
          }),
        };
      case 'tools/call':
        return this.callTool(request, params, session);
      case 'resources/list':
        return {
          resources: [...this.resources.values()].map(({ uri, name, description, mimeType }) => ({
            uri,
            name,
            description,
            mimeType,
          })),
        };
      case 'resources/read': {
        const uri = String(params.uri ?? '');
        const resource = this.resources.get(uri);
        if (!resource) throw new McpError(`Unknown resource "${uri}"`, JSON_RPC_ERRORS.invalidParams);
        const value = await resource.read();
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType ?? 'text/plain',
              text: typeof value === 'string' ? value : JSON.stringify(value),
            },
          ],
        };
      }
      case 'resources/subscribe':
      case 'resources/unsubscribe': {
        const uri = String(params.uri ?? '');
        if (!this.resources.has(uri)) throw new McpError(`Unknown resource "${uri}"`, JSON_RPC_ERRORS.invalidParams);
        if (request.method === 'resources/subscribe') session.subscriptions.add(uri);
        else session.subscriptions.delete(uri);
        return {};
      }
      case 'prompts/list':
        return {
          prompts: [...this.prompts.values()].map(({ name, title, description, arguments: args }) => ({
            name,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(args?.length ? { arguments: args } : {}),
          })),
        };
      case 'prompts/get': {
        const name = String(params.name ?? '');
        const prompt = this.prompts.get(name);
        if (!prompt) throw new McpError(`Unknown prompt "${name}"`, JSON_RPC_ERRORS.invalidParams);
        const given = isObject(params.arguments) ? params.arguments : {};
        const args: Record<string, string> = {};
        for (const argument of prompt.arguments ?? []) {
          const value = given[argument.name];
          if (value === undefined || value === null) {
            if (argument.required) {
              throw new McpError(
                `Prompt "${name}" needs the argument "${argument.name}"`,
                JSON_RPC_ERRORS.invalidParams,
              );
            }
            continue;
          }
          args[argument.name] = String(value);
        }
        const rendered = await prompt.get(args);
        return {
          ...(prompt.description ? { description: prompt.description } : {}),
          messages:
            typeof rendered === 'string' ? [{ role: 'user', content: { type: 'text', text: rendered } }] : rendered,
        };
      }
      default:
        throw new McpError(`Unknown method "${request.method}"`, JSON_RPC_ERRORS.methodNotFound);
    }
  }

  private async callTool(request: JsonRpcRequest, params: Record<string, unknown>, session: Session) {
    const name = String(params.name ?? '');
    const tool = this.tools.get(name);
    // A tool definition without an implementation is a schema for a model to call elsewhere; this
    // server can only serve the ones it can actually run.
    if (!tool?.execute && !tool?.stream) return { content: textContent(`Unknown tool "${name}"`), isError: true };
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // A client that asks for progress names a token; each report goes back as notifications/progress.
    const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken;
    let reports = 0;
    const progress =
      typeof token === 'string' || typeof token === 'number'
        ? (value: unknown) => {
            reports += 1;
            this.send(session, {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken: token, ...progressParams(value, reports) },
            });
          }
        : undefined;
    // The call stops when its client cancels it, and may ask that client for what it needs meanwhile.
    const controller = new AbortController();
    session.running.set(request.id, controller);
    const context: ToolContext = {
      signal: controller.signal,
      mcp: this.callerOf(session, controller.signal),
      ...(progress ? { progress } : {}),
    };
    try {
      let output: unknown;
      if (tool.stream) {
        const generator = tool.stream(args, context);
        for (;;) {
          const step = await generator.next();
          if (step.done) {
            output = step.value;
            break;
          }
          progress?.(step.value);
        }
      } else {
        output = await (tool.execute as NonNullable<ToolDefinition['execute']>)(args, context);
      }
      return { content: textContent(output) };
    } catch (error) {
      // A failing tool is a result the caller can reason about, not a transport error.
      return { content: textContent(error instanceof Error ? error.message : String(error)), isError: true };
    } finally {
      session.running.delete(request.id);
    }
  }

  /** What may be asked of one client, each request stopped by \`signal\` as well as its own. */
  private callerOf(session: Session, signal?: AbortSignal): McpCallerRequests {
    const ask = (method: string, capability: string, request: unknown, own?: AbortSignal) =>
      this.ask(session, method, capability, request, [signal, own]);
    return {
      createMessage: (request, options = {}) =>
        ask('sampling/createMessage', 'sampling', request, options.signal) as Promise<McpSamplingResult>,
      elicit: (request, options = {}) =>
        ask('elicitation/create', 'elicitation', request, options.signal) as Promise<McpElicitationResult>,
      listRoots: async (options = {}) => {
        const result = (await ask('roots/list', 'roots', undefined, options.signal)) as { roots?: McpRoot[] };
        return result?.roots ?? [];
      },
    };
  }

  /** Sends a client a request and waits for its answer, if it declared it answers that kind. */
  private ask(
    session: Session,
    method: string,
    capability: string,
    params: unknown,
    signals: Array<AbortSignal | undefined>,
  ): Promise<unknown> {
    if (!session.transport || !this.sessions.has(session)) {
      return Promise.reject(new McpError('No MCP client is connected to ask'));
    }
    if (session.capabilities[capability] === undefined) {
      return Promise.reject(
        new McpError(`The MCP client did not declare ${capability}`, JSON_RPC_ERRORS.methodNotFound),
      );
    }
    const stopped = signals.find((item) => item?.aborted);
    if (stopped) return Promise.reject(stopped.reason ?? new McpError(`"${method}" was stopped`));
    const id = `server-${session.nextId++}`;
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const stop = (reason: unknown) => {
        if (!session.pending.has(id)) return;
        session.pending.delete(id);
        clearTimeout(timer);
        this.send(session, {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: String(reason) },
        });
        reject(reason instanceof Error ? reason : new McpError(String(reason)));
      };
      const timer = setTimeout(() => stop(new McpError(`"${method}" got no answer within ${timeoutMs}ms`)), timeoutMs);
      for (const item of signals)
        item?.addEventListener('abort', () => stop(item.reason ?? new McpError(`"${method}" was stopped`)), {
          once: true,
        });
      session.pending.set(id, { resolve, reject, timer });
      this.send(session, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** The only connected client; asking without naming one needs exactly one. */
  private only(): Session {
    if (this.sessions.size === 1) return [...this.sessions][0] as Session;
    throw new McpError(
      this.sessions.size === 0
        ? 'No MCP client is connected to ask'
        : `${this.sessions.size} MCP clients are connected: ask through the tool's context.mcp, which names its own`,
    );
  }

  private broadcast(method: string): void {
    for (const session of this.sessions) this.send(session, { jsonrpc: '2.0', method });
  }

  private send(session: Session, message: JsonRpcMessage): void {
    if (!session.transport) return;
    void Promise.resolve(session.transport.send(message)).catch(() => undefined);
  }

  /** Forgets a client whose transport closed: its waiting requests fail, and its running calls stop. */
  private drop(session: Session): void {
    if (!this.sessions.delete(session)) return;
    if (this.latest === session) this.latest = undefined;
    for (const [id, waiting] of session.pending) {
      session.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new McpError('The MCP client disconnected'));
    }
    for (const controller of session.running.values()) controller.abort(new McpError('The MCP client disconnected'));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Serves MCP over this process's stdin and stdout.
 *
 * The transport an editor or desktop assistant launches: it runs the process and speaks JSON-RPC to
 * it, so nothing may be written to stdout except protocol messages.
 */
export function createStdioServerTransport(streams?: {
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): void };
}): McpTransport {
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;
  const decoder = new LineDecoder();
  let onMessage: (message: JsonRpcMessage) => void = () => undefined;
  let onClose: () => void = () => undefined;

  return {
    start() {
      input.setEncoding?.('utf8');
      input.on('data', (chunk: string | Buffer) => {
        for (const message of decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
          onMessage(message);
        }
      });
      input.on('close', () => onClose());
    },
    send(message) {
      output.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose();
    },
  };
}

/**
 * A progress report in MCP's shape: a number is the progress itself, an object may carry `progress`,
 * `total`, and `message`, and anything else is the message, counted by its position.
 */
function progressParams(value: unknown, position: number): { progress: number; total?: number; message?: string } {
  if (typeof value === 'number') return { progress: value };
  if (value && typeof value === 'object') {
    const report = value as { progress?: unknown; total?: unknown; message?: unknown };
    return {
      progress: typeof report.progress === 'number' ? report.progress : position,
      ...(typeof report.total === 'number' ? { total: report.total } : {}),
      message: typeof report.message === 'string' ? report.message : JSON.stringify(value),
    };
  }
  return { progress: position, message: String(value) };
}
