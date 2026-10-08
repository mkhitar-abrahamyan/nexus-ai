# MCP

<!-- covers: ./mcp ./mcp/registry -->

The Model Context Protocol, in both directions, from `nexus-ai-pro/mcp`. `McpClient` borrows another
server's tools as ordinary tool definitions. `McpServer` lends your tools to other assistants. Both run
over stdio, HTTP, or any transport you supply, and `McpRegistry` manages many servers from one file.

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
and `timeoutMs`, how long a request waits (30 seconds). `connect()` performs the handshake; the first
request that needs it calls it for you.

| Method | Returns |
| --- | --- |
| `listTools()` | Each tool as an `McpToolDescriptor`: name, description, and JSON Schema. |
| `callTool()` | An `McpToolResult`: a list of `McpContent` parts (text, or base64 data with a MIME type), and `isError` when the tool reported a failure. |
| `listResources()` | `McpResourceDescriptor` values: URI, name, description, and MIME type. |
| `readResource()` | One resource, as content parts. |
| `listPrompts()`, `getPrompt()` | The server's prompts, and one rendered into messages. |
| `toNexusTools()` | The tools as `ToolDefinition` values an agent or `ToolExecutor` can run. |
| `close()` | Closes the transport, rejecting requests still waiting. |

Two kinds of failure are kept apart. A tool that fails answers with `isError`; it does not throw. A
protocol failure throws `McpError`.

With `toNexusTools()`, a `prefix` keeps two servers' `search` tools apart. Each tool returns its text,
and a failure throws, so the agent sees a failed tool call.

## Transports

`createStdioTransport()` starts a server as a child process and speaks to it over stdin and stdout.
`StdioClientOptions` gives the `command`, `args`, `env`, `cwd`, and `inheritEnv`. `node:child_process`
is imported only when the transport starts, so a browser or edge build that uses HTTP never reaches
for it.

A server is often third-party code, so it does not inherit this process's environment. It starts
with `env` and only what a process needs to run:
- the path, and the home and temporary directories;
- the user, the locale, and the terminal;
- the Windows system variables;
- proxy and certificate settings.

An API key or a database URL reaches a server only when `env` names it. `inheritEnv` widens this: a
list adds variables by name, `true` passes the whole environment, as releases before 2.4 did, and
`false` passes nothing but `env`.

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

## A registry of servers

`McpRegistry`, on `nexus-ai-pro/mcp/registry`, runs many MCP servers from one configuration. It is the
package's integration catalogue: whatever an MCP server exposes, under your policy.

An `McpRegistryConfig` lists the `servers` and named `bundles` of their tools. It also accepts
`mcpServers`, so the file desktop MCP clients use works as it is. `McpRegistry.fromFile()` reads one
from JSON. `validateMcpConfig()` checks one, and an `McpRegistryError` names the server and field at
fault.

```json
{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "allowTools": ["list_*", "get_*", "create_issue"],
      "denyTools": ["delete_*"]
    },
    "docs": { "url": "https://docs.example.com/mcp", "headers": { "authorization": "Bearer ${DOCS_KEY}" } }
  },
  "bundles": { "support": ["github/create_issue", "docs"] }
}
```

```ts
import { McpRegistry } from 'nexus-ai-pro/mcp/registry';

const registry = await McpRegistry.fromFile('mcp.json');
const agent = createAgent({ client: ai, model: 'gpt-5.4', tools: await registry.tools('support') });
```

An `McpServerConfig` describes one server:

| Field | What it sets |
| --- | --- |
| `command`, `args`, `env`, `cwd`, `inheritEnv` | A local server, run over stdio, with what it inherits from this process's environment. |
| `url`, `headers` | A remote server, reached over HTTP. |
| `allowTools`, `denyTools` | Which tools agents see. `*` matches any run of characters, and deny wins. |
| `prefix` | The prefix of tool names agents see. Defaults to the server's name, so two servers' `search` stay apart; `false` keeps names as they are. |
| `timeoutMs` | How long each request may take. |
| `enabled` | `false` keeps the server in the file but out of the registry. |

Any string may hold `${NAME}` placeholders, filled from the environment when the server connects. So
the file names credentials without containing them. A missing variable is named in the error, never
its value.

Servers connect on first use and stay connected.

| Method | What it does |
| --- | --- |
| `tools()` | Tools for an agent, from bundles or server names; every server's tools when given none. Each tool appears once. A bundle entry is a server, or `server/tool` with a pattern such as `github/list_*`. |
| `client()` | One server's `McpClient`. |
| `serverNames()`, `bundleNames()` | What is configured. |
| `refresh()` | Forgets the tool lists read so far. |
| `health()` | Connects to every server in parallel and reports each as an `McpServerHealth`: whether it answered, how long it took, and how many tools it offers. One failure does not fail the check. |
| `close()` | Closes every connection. |

`McpRegistryOptions` sets where placeholders are read from (`process.env`), the handshake's
`clientInfo`, a `fetch` for HTTP servers, and a `transport` factory for custom transports and tests.

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

### `nexus-ai-pro/mcp/registry`

| Export | Kind | Summary |
| --- | --- | --- |
| `McpRegistry` | class | Many MCP servers behind one configuration. |
| `McpRegistryConfig` | interface | A registry's configuration: the servers by name, and named bundles of their tools. |
| `McpRegistryError` | class | Raised for a configuration the registry cannot use, or a server or bundle it does not know. |
| `McpRegistryOptions` | interface | Options for an `McpRegistry`. |
| `McpServerConfig` | interface | One MCP server in a registry: a `command` to run over stdio, or a `url` to reach over HTTP. |
| `McpServerHealth` | interface | One server's health, from `McpRegistry.health()`. |
| `validateMcpConfig` | function | Checks a registry configuration and returns it, or throws an `McpRegistryError` that names the server and the field at fault. |
<!-- reference:end -->
