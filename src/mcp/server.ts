import type { ToolDefinition } from '../types/messages.js';
import {
  isNotification,
  isRequest,
  JSON_RPC_ERRORS,
  type JsonRpcMessage,
  type JsonRpcRequest,
  LineDecoder,
  MCP_PROTOCOL_VERSION,
  type McpTransport,
  textContent,
} from './protocol.js';

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools?: ToolDefinition[];
  /** Resources the server exposes, read by URI. */
  resources?: Array<{
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    read(): Promise<unknown> | unknown;
  }>;
}

/**
 * Exposes tools over MCP, so other assistants can call them.
 *
 * The other direction of the same bridge: the client borrows an ecosystem's tools, the server lends
 * this application's. A tool written once with `tool()` can serve an agent here and an editor
 * elsewhere.
 */
export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();
  private transport: McpTransport | undefined;

  constructor(private readonly options: McpServerOptions = {}) {
    for (const item of options.tools ?? []) this.tools.set(item.name, item);
  }

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  async connect(transport: McpTransport): Promise<void> {
    this.transport = transport;
    transport.onMessage((message) => void this.handle(message));
    await transport.start?.();
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.transport = undefined;
  }

  /** Handles one message. Exposed so a host can drive the server without a transport. */
  async handle(message: JsonRpcMessage): Promise<void> {
    if (isNotification(message)) return;
    if (!isRequest(message)) return;

    try {
      const result = await this.dispatch(message);
      await this.transport?.send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      await this.transport?.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: JSON_RPC_ERRORS.internal,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const params = (request.params ?? {}) as Record<string, unknown>;

    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            ...(this.options.resources?.length ? { resources: { listChanged: false } } : {}),
          },
          serverInfo: { name: this.options.name ?? 'nexus-ai-pro', version: this.options.version ?? '1.x' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((item) => ({
            name: item.name,
            description: item.description,
            inputSchema: item.parameters ?? { type: 'object', properties: {} },
          })),
        };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const tool = this.tools.get(name);
        // A tool definition without an implementation is a schema for a model to call elsewhere; this
        // server can only serve the ones it can actually run.
        if (!tool?.execute) return { content: textContent(`Unknown tool "${name}"`), isError: true };
        try {
          const output = await tool.execute((params.arguments ?? {}) as Record<string, unknown>);
          return { content: textContent(output) };
        } catch (error) {
          // A failing tool is a result the caller can reason about, not a transport error.
          return { content: textContent(error instanceof Error ? error.message : String(error)), isError: true };
        }
      }
      case 'resources/list':
        return {
          resources: (this.options.resources ?? []).map(({ uri, name, description, mimeType }) => ({
            uri,
            name,
            description,
            mimeType,
          })),
        };
      case 'resources/read': {
        const uri = String(params.uri ?? '');
        const resource = this.options.resources?.find((item) => item.uri === uri);
        if (!resource) throw new Error(`Unknown resource "${uri}"`);
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
      default:
        throw new Error(`Unknown method "${request.method}"`);
    }
  }
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
