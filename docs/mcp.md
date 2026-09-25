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

## The client

`McpClient` takes a transport and `McpClientOptions`: the `clientInfo` name and version it reports,
and `timeoutMs`, how long a request waits before failing (30 seconds by default). `connect()`
performs the handshake, and the first request that needs it calls it for you. Then:

- `listTools()` returns each tool as an `McpToolDescriptor`: its name, description, and JSON Schema.
- `callTool()` runs one and returns an `McpToolResult`, a list of `McpContent` parts — text, or
  base64 data with a MIME type — and `isError` when the tool reported a failure. A tool that fails
  answers with `isError` rather than throwing; a protocol failure throws `McpError`.
- `listResources()` returns `McpResourceDescriptor` values — URI, name, description, and MIME type —
  and `readResource()` reads one as content parts.
- `listPrompts()` and `getPrompt()` list the server's prompts and render one into messages.
- `toNexusTools()` turns the tools into `ToolDefinition` values an agent or `ToolExecutor` can run. A
  `prefix` keeps two servers' `search` tools apart. Each tool's result is its text, and a failure
  throws, so the agent sees it as a failed tool call.
- `close()` closes the transport and rejects every request still waiting.

## Transports

`createStdioTransport()` starts a server as a child process and speaks to it over stdin and stdout.
`StdioClientOptions` gives the `command`, `args`, `env` (added to this process's environment), and
`cwd`. `node:child_process` is imported only when the transport starts, so a browser or edge build
that uses HTTP never reaches for it.

`createHttpTransport()` speaks to a remote server with one POST per message, carrying the
`mcp-session-id` the server assigns and reading either a JSON body or an event-stream reply.
`HttpClientOptions` gives the `url`, `headers` such as authorization, and a `fetch` to use instead of
the global one.

`McpTransport` is the whole contract, for a transport of your own: `send()` a message, `onMessage()`
to receive them, and optional `start()` and `onClose()` with `close()`. The messages are JSON-RPC:
`JsonRpcRequest` expects a `JsonRpcResponse` with the same id, carrying a result or an error, and a
`JsonRpcNotification` expects nothing; `JsonRpcMessage` is any of the three. `LineDecoder` splits a
byte stream into newline-delimited messages, holding a partial message until the rest arrives and
skipping a malformed line rather than losing the stream.

## The server

`McpServer` takes `McpServerOptions`: a `name` and `version` to report, the `tools` to expose, and
`resources`, each a URI with a name, description, MIME type, and a `read()` function. `register()`
adds a tool later. `connect()` starts serving over a transport, `close()` stops, and `handle()` takes
one message directly, for a host that carries messages itself.

It answers `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`.
A tool without an `execute` function is a schema for a model to call elsewhere, so the server
reports it as unknown when called. A tool that throws answers with `isError` and the message rather
than failing the request. `createStdioServerTransport()` serves over this process's stdin and stdout,
which is how an editor or desktop assistant launches it; nothing else may be written to stdout.

## Errors and versions

`McpError` carries a JSON-RPC error code, with `JSON_RPC_ERRORS` naming the standard ones: parse,
invalid request, method not found, invalid params, and internal. The server answers an unknown method
with method-not-found, so a client can tell an unsupported feature from a failure.
`MCP_PROTOCOL_VERSION` is the protocol revision both directions speak, `2025-06-18`.

## Limitations

- The HTTP transport covers request and response; server-initiated streaming is not implemented.
- The server exposes tools and resources. Prompts, sampling, and change notifications are not served.

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
