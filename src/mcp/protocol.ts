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

/** Text content, the shape MCP tool results use for anything that is not an image or a resource. */
export function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return [{ type: 'text', text }];
}
