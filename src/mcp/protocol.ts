/**
 * The slice of Model Context Protocol this package speaks, implemented directly.
 *
 * MCP is JSON-RPC 2.0 with a handshake and a handful of methods. Implementing that slice is smaller
 * than the protocol SDK it would otherwise pull in, keeps these subpaths free of dependencies, and
 * leaves the transport injectable — which is what makes the client and the server testable against
 * each other in memory.
 */

/** The MCP protocol revision this client and server speak, sent during `initialize`. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type JsonRpcId = string | number;

/** A JSON-RPC request, which expects a response with the same id. */
export interface JsonRpcRequest {
  /** Always `2.0`. */
  jsonrpc: '2.0';
  /** Correlates the response. */
  id: JsonRpcId;
  /** The method to call. */
  method: string;
  /** Its parameters. */
  params?: unknown;
}

/** A JSON-RPC notification, which expects no response. */
export interface JsonRpcNotification {
  /** Always `2.0`. */
  jsonrpc: '2.0';
  /** The method. */
  method: string;
  /** Its parameters. */
  params?: unknown;
}

/** A JSON-RPC response: a result or an error, for the request with the same id. */
export interface JsonRpcResponse {
  /** Always `2.0`. */
  jsonrpc: '2.0';
  /** The id of the request it answers. */
  id: JsonRpcId;
  /** The result, on success. */
  result?: unknown;
  /** The error, on failure. */
  error?: { code: number; message: string; data?: unknown };
}

/** Any JSON-RPC message. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Carries a transport's messages in both directions. Anything implementing it can host MCP. */
export interface McpTransport {
  /** Opens the transport, when it needs opening. */
  start?(): Promise<void> | void;
  /** Sends one message. */
  send(message: JsonRpcMessage): Promise<void> | void;
  /** Registers the handler that receives every incoming message. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Registers a handler called when the transport closes. */
  onClose?(handler: () => void): void;
  /** Closes the transport. */
  close(): Promise<void> | void;
}

/** An MCP protocol error, carrying a JSON-RPC error code. */
export class McpError extends Error {
  constructor(
    message: string,
    /** JSON-RPC error code. Defaults to -32000, the generic server error. */
    readonly code = -32_000,
    /** Error details from the other side. */
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

/** Standard JSON-RPC error codes. */
export const JSON_RPC_ERRORS = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
  internal: -32_603,
} as const;

/**
 * Splits a byte stream into newline-delimited JSON messages.
 *
 * Stdio transports frame one JSON object per line, and a chunk can end mid-message, so the parser
 * has to hold the remainder rather than assume chunk boundaries line up.
 */
export class LineDecoder {
  private buffer = '';

  /** Adds a chunk and returns every complete message it finished. */
  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // A malformed line is skipped: one bad frame must not desynchronise the whole stream.
        }
      }
      index = this.buffer.indexOf('\n');
    }
    return messages;
  }
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && 'id' in message;
}

// ── What a server asks of its client ──────────────────────────────

/** A sampled message's content: text, or an image or audio as base64. */
export type McpSamplingContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

/** One message of a conversation a server asks its client's model to continue. */
export interface McpSamplingMessage {
  /** Who said it. */
  role: 'user' | 'assistant';
  /** What was said. */
  content: McpSamplingContent;
}

/** Which model a server would like its client to use: hints by name, and how it weighs cost, speed, and intelligence. */
export interface McpModelPreferences {
  /** Model names, or parts of them, most preferred first. */
  hints?: Array<{ name?: string }>;
  /** How much cost matters, from 0 to 1. */
  costPriority?: number;
  /** How much speed matters, from 0 to 1. */
  speedPriority?: number;
  /** How much intelligence matters, from 0 to 1. */
  intelligencePriority?: number;
}

/** A server's `sampling/createMessage`: a conversation for the client's model to continue. */
export interface McpSamplingRequest {
  /** The conversation. */
  messages: McpSamplingMessage[];
  /** The model the server would like. The client chooses. */
  modelPreferences?: McpModelPreferences;
  /** A system prompt the server asks for. The client may change or ignore it. */
  systemPrompt?: string;
  /** Context from MCP servers the client may add: none, this server's, or every server's. */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  /** The sampling temperature. */
  temperature?: number;
  /** The most tokens to sample. */
  maxTokens: number;
  /** Where to stop. */
  stopSequences?: string[];
  /** Anything else, for the client's model provider. */
  metadata?: Record<string, unknown>;
}

/** What the client's model answered. */
export interface McpSamplingResult {
  /** Always `assistant`. */
  role: 'assistant';
  /** The answer. */
  content: McpSamplingContent;
  /** The model that answered. */
  model: string;
  /** Why it stopped: `endTurn`, `stopSequence`, `maxTokens`, or the provider's own reason. */
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | (string & {});
}

/** A server's `elicitation/create`: a question for the person using the client, with the form of its answer. */
export interface McpElicitationRequest {
  /** What to ask. */
  message: string;
  /** The answer's form: an object of flat fields, strings, numbers, booleans, or enums. */
  requestedSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

/** What the person answered: accepted with the fields, declined, or cancelled. */
export interface McpElicitationResult {
  /** `accept` with `content`, `decline`, or `cancel`. */
  action: 'accept' | 'decline' | 'cancel';
  /** The fields, when accepted. */
  content?: Record<string, string | number | boolean | string[]>;
}

/** A root the client lets a server work within: a `file://` URI, and a name for it. */
export interface McpRoot {
  /** The root's URI. */
  uri: string;
  /** A name for it. */
  name?: string;
}

/**
 * What a tool served over MCP may ask the client that called it, as `ToolContext.mcp`: its model
 * for a completion, its person for an answer, and its roots. Each fails with `McpError` when the
 * client did not declare it can.
 */
export interface McpCallerRequests {
  /** Asks the client's model to continue a conversation. */
  createMessage(request: McpSamplingRequest, options?: { signal?: AbortSignal }): Promise<McpSamplingResult>;
  /** Asks the client's person a question, with the form of its answer. */
  elicit(request: McpElicitationRequest, options?: { signal?: AbortSignal }): Promise<McpElicitationResult>;
  /** Lists the roots the client lets the server work within. */
  listRoots(options?: { signal?: AbortSignal }): Promise<McpRoot[]>;
}

/** Text content, the shape MCP tool results use for anything that is not an image or a resource. */
export function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return [{ type: 'text', text }];
}
