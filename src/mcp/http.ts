/**
 * MCP's streamable HTTP transport, as a server: a Web handler that serves an `McpServer` to every
 * client that connects, each in a session of its own. A request is answered as a stream of events
 * that carries what the server sends while it works, its progress and its own questions for the
 * client, then the answer; a `GET` holds a stream for what the server sends of its own accord; a
 * `DELETE` ends the session. Mount it on any server that speaks `Request` and `Response`.
 */
import {
  isNotification,
  isRequest,
  isResponse,
  JSON_RPC_ERRORS,
  type JsonRpcId,
  type JsonRpcMessage,
  MCP_PROTOCOL_VERSION,
  type McpTransport,
} from './protocol.js';
import type { McpServer } from './server.js';

/** The protocol revisions a client may name in its `MCP-Protocol-Version` header. */
const VERSIONS = new Set([MCP_PROTOCOL_VERSION, '2025-03-26']);

/** Options for `mcpHttpHandler()`. */
export interface McpHttpOptions {
  /**
   * Origins allowed to call it from a browser, beside the endpoint's own: a request whose `Origin`
   * header names any other is refused with 403, so a web page cannot reach a server on this machine
   * through the person's browser.
   */
  allowedOrigins?: readonly string[];
  /**
   * Answers each request as JSON, after the server finishes, rather than as a stream of events. What
   * the server sends meanwhile then waits for the session's `GET` stream.
   */
  json?: boolean;
  /** How long a session lasts without a request, in milliseconds. Defaults to 30 minutes. */
  sessionTtlMs?: number;
  /** The most sessions held at once: a new one past it is refused with 503. Defaults to 1,000. */
  maxSessions?: number;
  /** Makes a new session's id. Defaults to a random UUID. */
  sessionId?: () => string;
}

/** A Web handler serving an MCP server over streamable HTTP, and what it holds. */
export interface McpHttpHandler {
  /** Answers one HTTP request: a `POST` of a message, a `GET` stream, or a `DELETE` of a session. */
  (request: Request): Promise<Response>;
  /** How many sessions are open. */
  sessions(): number;
  /** Ends every session. */
  close(): Promise<void>;
}

/** Where one session's messages go: an open request's stream, its `GET` stream, or a queue until one opens. */
class HttpSession implements McpTransport {
  lastSeen = Date.now();
  /** Each open request's stream, by the request's id, in the order they opened. */
  readonly streams = new Map<JsonRpcId, EventWriter>();
  /** Requests answered as JSON, each waiting for its answer. */
  readonly waiting = new Map<JsonRpcId, (message: JsonRpcMessage) => void>();
  listener: EventWriter | undefined;
  /** What had nowhere to go, until a stream opens: the latest thousand. */
  readonly queue: JsonRpcMessage[] = [];
  private receive: (message: JsonRpcMessage) => void = () => undefined;
  private readonly closed: Array<() => void> = [];
  private ended = false;

  constructor(readonly id: string) {}

  send(message: JsonRpcMessage): void {
    if (this.ended) return;
    // An answer goes on its own request's stream, which it ends.
    if (isResponse(message)) {
      const waiter = this.waiting.get(message.id);
      if (waiter) {
        this.waiting.delete(message.id);
        waiter(message);
        return;
      }
      const stream = this.streams.get(message.id);
      if (stream) {
        this.streams.delete(message.id);
        stream.write(message);
        stream.close();
        return;
      }
    }
    // Anything else goes on the latest open request's stream, which is what the server is working on,
    // else the session's own stream, else waits for one.
    const latest = [...this.streams.values()].at(-1) ?? this.listener;
    if (latest) {
      latest.write(message);
      return;
    }
    this.queue.push(message);
    if (this.queue.length > 1_000) this.queue.shift();
  }

  deliver(message: JsonRpcMessage): void {
    this.lastSeen = Date.now();
    this.receive(message);
  }

  /** Opens the session's own stream, sending what waited for one. */
  listen(writer: EventWriter): void {
    this.listener?.close();
    this.listener = writer;
    for (const message of this.queue.splice(0)) writer.write(message);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.receive = handler;
  }

  onClose(handler: () => void): void {
    this.closed.push(handler);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.listener?.close();
    this.listener = undefined;
    for (const handler of this.closed) handler();
  }
}

/** A stream of Server-Sent Events, one MCP message each. */
class EventWriter {
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private done = false;
  readonly stream: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(onCancel: () => void) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.done = true;
        onCancel();
      },
    });
  }

  write(message: JsonRpcMessage): void {
    if (this.done) return;
    this.controller?.enqueue(this.encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    try {
      this.controller?.close();
    } catch {
      // Already closed by the reader going away.
    }
  }
}

/**
 * Serves an MCP server over streamable HTTP, MCP's transport since 2025-03-26: each client that sends
 * `initialize` gets a session, named in the `Mcp-Session-Id` header it sends from then on. A request is
 * answered as a stream of events, which carries the server's progress and its questions for the
 * client, such as a tool's `context.mcp.createMessage()`, before the answer; with `json`, as JSON. A
 * notification or an answer the client sends is taken with 202. A `GET` holds the session's own stream,
 * for what the server sends of its own accord, and a `DELETE` ends the session. A request from a web
 * page on another origin is refused, unless `allowedOrigins` names it.
 *
 * ```ts
 * const handle = mcpHttpHandler(new McpServer({ tools: [search] }));
 * Bun.serve({ fetch: handle }); // or any server that speaks Request and Response
 * ```
 */
export function mcpHttpHandler(server: McpServer, options: McpHttpOptions = {}): McpHttpHandler {
  const sessions = new Map<string, HttpSession>();
  const ttl = options.sessionTtlMs ?? 30 * 60_000;
  const newId = options.sessionId ?? (() => globalThis.crypto.randomUUID());

  /** Ends sessions idle past their time, unless a stream of theirs is still open. */
  const sweep = () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > ttl && session.streams.size === 0 && !session.listener) {
        sessions.delete(id);
        session.close();
      }
    }
  };
  const fail = (
    status: number,
    message: string,
    code: number = JSON_RPC_ERRORS.invalidRequest,
    id: JsonRpcId | null = null,
  ) => Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });

  const handler = async (request: Request): Promise<Response> => {
    sweep();
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin && !options.allowedOrigins?.includes(origin)) {
      return fail(403, `Requests from ${origin} are not allowed`);
    }
    const version = request.headers.get('mcp-protocol-version');
    if (version && !VERSIONS.has(version)) {
      return fail(400, `This server speaks MCP ${[...VERSIONS].join(' and ')}, not ${version}`);
    }
    const named = request.headers.get('mcp-session-id') ?? undefined;
    const found = named === undefined ? undefined : sessions.get(named);

    if (request.method === 'GET') {
      if (!(request.headers.get('accept') ?? '').includes('text/event-stream')) {
        return fail(406, 'A GET opens a stream of events: accept text/event-stream');
      }
      if (!named) return fail(400, 'A GET needs the Mcp-Session-Id of a session');
      if (!found) return fail(404, 'No such session', JSON_RPC_ERRORS.invalidRequest);
      found.lastSeen = Date.now();
      const writer = new EventWriter(() => {
        if (found.listener === writer) found.listener = undefined;
      });
      found.listen(writer);
      return new Response(writer.stream, { headers: eventHeaders(found.id) });
    }
    if (request.method === 'DELETE') {
      if (!named) return fail(400, 'A DELETE needs the Mcp-Session-Id of a session');
      if (!found) return fail(404, 'No such session');
      sessions.delete(found.id);
      found.close();
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') {
      return new Response('MCP speaks POST, GET, and DELETE here', {
        status: 405,
        headers: { allow: 'POST, GET, DELETE' },
      });
    }

    let message: JsonRpcMessage;
    try {
      message = (await request.json()) as JsonRpcMessage;
    } catch {
      return fail(400, 'The body is not JSON', JSON_RPC_ERRORS.parse);
    }
    // A batch, which 2025-06-18 dropped, is a list, and so names no `jsonrpc`.
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return fail(400, 'The body is not one JSON-RPC 2.0 message');
    }
    let session = found;
    if (isRequest(message) && message.method === 'initialize') {
      if (named) return fail(400, 'A session is initialized once', JSON_RPC_ERRORS.invalidRequest, message.id);
      if (sessions.size >= (options.maxSessions ?? 1_000)) {
        return fail(503, 'This server holds as many sessions as it may', JSON_RPC_ERRORS.internal, message.id);
      }
      session = new HttpSession(newId());
      sessions.set(session.id, session);
      const opened = session;
      session.onClose(() => sessions.delete(opened.id));
      await server.connect(session);
    } else if (!named) {
      return fail(400, 'A message after initialize needs the Mcp-Session-Id of its session');
    } else if (!session) {
      return fail(404, 'No such session: initialize a new one');
    }
    const current = session as HttpSession;

    if (!isRequest(message)) {
      // A notification, or an answer to something the server asked, is taken; nothing comes back on it.
      if (isNotification(message) || isResponse(message)) current.deliver(message);
      return new Response(null, { status: 202, headers: { 'mcp-session-id': current.id } });
    }
    const id = message.id;
    if (options.json) {
      const answered = new Promise<JsonRpcMessage>((resolve) => current.waiting.set(id, resolve));
      current.deliver(message);
      return Response.json(await answered, { headers: { 'mcp-session-id': current.id } });
    }
    const writer = new EventWriter(() => {
      // The client went away: its request is cancelled, and nothing more goes to it.
      if (current.streams.get(id) === writer) {
        current.streams.delete(id);
        current.deliver({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'The client went away' },
        });
      }
    });
    current.streams.set(id, writer);
    current.deliver(message);
    return new Response(writer.stream, { headers: eventHeaders(current.id) });
  };

  return Object.assign(handler, {
    sessions: () => sessions.size,
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) session.close();
    },
  });
}

function eventHeaders(sessionId: string): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'mcp-session-id': sessionId,
  };
}
