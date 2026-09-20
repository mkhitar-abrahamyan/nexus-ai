/**
 * The slice of Model Context Protocol this package speaks, implemented directly.
 *
 * MCP is JSON-RPC 2.0 with a handshake and a handful of methods. Implementing that slice is smaller
 * than the protocol SDK it would otherwise pull in, keeps these subpaths free of dependencies, and
 * leaves the transport injectable — which is what makes the client and the server testable against
 * each other in memory.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Carries a transport's messages in both directions. Anything implementing it can host MCP. */
export interface McpTransport {
  start?(): Promise<void> | void;
  send(message: JsonRpcMessage): Promise<void> | void;
  /** Registers the handler that receives every incoming message. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose?(handler: () => void): void;
  close(): Promise<void> | void;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code = -32_000,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

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
