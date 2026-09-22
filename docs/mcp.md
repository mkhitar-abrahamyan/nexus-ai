# MCP

<!-- covers: ./mcp -->

The Model Context Protocol in both directions, from `nexus-ai-pro/mcp`: `McpClient` borrows another server's tools as ordinary tool definitions, and `McpServer` lends this application's tools to other assistants, over stdio or any transport you supply.

## Overview

The Model Context Protocol, both directions, implemented directly rather than through an SDK:

```ts
import { McpClient, createStdioTransport } from 'nexus-ai-pro/mcp';

const client = new McpClient(createStdioTransport({ command: 'npx', args: ['-y', 'some-mcp-server'] }));
const agent = createAgent({ client: ai, tools: await client.toNexusTools({ prefix: 'files' }) });
```

That is how this package reaches a broad tool ecosystem without maintaining a catalogue of
integrations: anything exposed over MCP becomes tools an agent can call. The server direction lends
your tools out the same way, so a tool written once with `tool()` serves an agent here and an editor
elsewhere:

```ts
import { McpServer, createStdioServerTransport } from 'nexus-ai-pro/mcp';

await new McpServer({ name: 'my-app', tools: [refundTool] }).connect(createStdioServerTransport());
```

Stdio and HTTP transports are included, and the transport is an interface, so a test can wire a
client to a server in memory.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/mcp`

| Export | Kind | Summary |
| --- | --- | --- |
| `createHttpTransport` | function | Speaks to an MCP server over HTTP, one POST per message. |
| `createStdioServerTransport` | function | Serves MCP over this process's stdin and stdout. |
| `createStdioTransport` | function | Runs an MCP server as a child process and speaks to it over its stdin and stdout. |
| `HttpClientOptions` | interface | Connects to a remote MCP server over HTTP. |
| `JSON_RPC_ERRORS` | constant | Standard JSON-RPC error codes. |
| `JsonRpcMessage` | type | Any JSON-RPC message. |
| `JsonRpcNotification` | interface | A JSON-RPC notification, which expects no response. |
| `JsonRpcRequest` | interface | A JSON-RPC request, which expects a response with the same id. |
| `JsonRpcResponse` | interface | A JSON-RPC response: a result or an error, for the request with the same id. |
| `LineDecoder` | class | Splits a byte stream into newline-delimited JSON messages. |
| `MCP_PROTOCOL_VERSION` | constant | The MCP protocol revision this client and server speak, sent during `initialize`. |
| `McpClient` | class | Talks to an MCP server. |
| `McpClientOptions` | interface | Options for an MCP client. |
| `McpContent` | interface | One piece of content from an MCP server: text, or base64 data with a MIME type. |
| `McpError` | class | An MCP protocol error, carrying a JSON-RPC error code. |
| `McpResourceDescriptor` | interface | A resource an MCP server offers. |
| `McpServer` | class | Exposes tools over MCP, so other assistants can call them. |
| `McpServerOptions` | interface | Options for an MCP server. |
| `McpToolDescriptor` | interface | A tool an MCP server offers. |
| `McpToolResult` | interface | What a tool call returned. |
| `McpTransport` | interface | Carries a transport's messages in both directions. |
| `StdioClientOptions` | interface | Launches a local MCP server as a child process and talks to it over stdin and stdout. |
<!-- reference:end -->
