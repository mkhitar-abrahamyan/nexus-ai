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
`timeoutMs`, how long a request waits (30 seconds), and `reconnect`. `connect()` performs the
handshake; the first request that needs it calls it for you.

| Method | Returns |
| --- | --- |
| `listTools()` | Each tool as an `McpToolDescriptor`: name, description, and JSON Schema. |
| `callTool()` | An `McpToolResult`: a list of `McpContent` parts (text, or base64 data with a MIME type), and `isError` when the tool reported a failure. |
| `listResources()` | `McpResourceDescriptor` values: URI, name, description, and MIME type. |
| `readResource()` | One resource, as content parts. |
| `listPrompts()`, `getPrompt()` | The server's prompts, and one rendered into messages. |
| `toNexusTools()` | The tools as `ToolDefinition` values an agent or `ToolExecutor` can run. |
| `onToolsChanged()` | Hears each time the server says its tools changed; returns a function that stops hearing. |
| `close()` | Closes the transport, rejecting requests still waiting. |

Two kinds of failure are kept apart. A tool that fails answers with `isError`; it does not throw. A
protocol failure throws `McpError`.

With `toNexusTools()`, a `prefix` keeps two servers' `search` tools apart. Each tool returns its text,
and a failure throws, so the agent sees a failed tool call.

### What a server says its tools do

A server describes each tool with `McpToolAnnotations`: whether it only reads (`readOnlyHint`), may
destroy what it changes (`destructiveHint`), repeats safely (`idempotentHint`), and reaches beyond the
server (`openWorldHint`). `McpToolsOptions.capabilities: true` turns them into the capabilities each
tool declares, so a permission policy decides a server's tools as it decides the agent's own:

```ts
const tools = await client.toNexusTools({ prefix: 'github', capabilities: true });
const agent = createAgent({
  client: ai,
  tools,
  permissions: permissionPolicy({ custom: { 'mcp.read': 'allow', 'mcp.write': 'ask' }, network: { allow: ['*'] } }),
});
```

`mcpToolCapabilities()` gives each tool, under the server's name (the `server` option, then the
prefix, then the name the server reports):
- `mcp.read:<server>/<tool>` when it only reads;
- `mcp.write:<server>/<tool>` when it changes things but destroys nothing;
- `mcp.destructive:<server>/<tool>` when it may destroy or overwrite;
- and `network` beside it, unless the server says it stays within itself.

A hint left out takes the specification's default: not read-only, destructive, and reaching out. A
tool with no annotations declares nothing, and a policy decides it as undeclared. A function as
`capabilities` decides per tool instead. Annotations are the server's word, so give `true` for
servers you trust, and decide the others yourself.

`callTool()` takes a `progress` listener. The call then names a progress token, and each
`notifications/progress` the server sends for it arrives there, with its progress, total, and
message. A tool from `toNexusTools()` passes them to the agent's `context.progress`, so a remote
tool's progress reaches the agent's events like a local one's.

### When the connection drops, or the tools change

With `reconnect`, a client whose transport closed opens it again at the next request and greets the
server again, since the server's session went with the connection:
- an SSE stream that ends, as a proxy's timeout or a server's restart ends it, is opened anew by
  `createSseTransport({ reopen: true })`;
- a stdio server that exits is started again, as a new process.

A request in flight when the connection drops still fails, since it may have run. A client closed with
`close()` stays closed. Without `reconnect`, a closed transport stays closed, as before 2.18.

```ts
const client = new McpClient(createSseTransport({ url, reopen: true }), { reconnect: true });
const stop = client.onToolsChanged(() => {
  tools = undefined; // list them again before the next turn
});
```

A server that says its tools change sends `notifications/tools/list_changed` when they do, and
`onToolsChanged()` hears each one. What `listTools()` returned is then out of date; the client keeps
no list of its own, so the next `listTools()` or `toNexusTools()` reads the new one. A listener that
throws keeps no other from hearing.

## Transports

`createStdioTransport()` starts a server as a child process and speaks to it over stdin and stdout.
`StdioClientOptions` gives the `command`, `args`, `env`, `cwd`, and `inheritEnv`. `node:child_process`
is imported only when the transport starts, so a browser or edge build that uses HTTP never reaches
for it. When the process exits, the transport closes; started again, it runs a new process, which
reads its own output from the start.

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

`createSseTransport()` speaks to a server over HTTP with Server-Sent Events, the transport before
streamable HTTP that many servers still serve. It opens one `GET` on the server's event stream, posts
each message to the endpoint the stream names, and reads every answer from the stream.
`SseClientOptions` gives the `url`, `headers` for the stream and every message, a `fetch`, and
`timeoutMs`, how long to wait for the endpoint (10 seconds). The endpoint must be on the stream's
origin, so a server cannot send the messages, and their headers, anywhere else. When the stream ends,
the transport closes and the requests waiting on it fail. So does a stream that cannot open, or names
no endpoint in time: the transport lets it go and closes at once. With `reopen`, the next message
after that opens a new stream; only the current stream's end closes the transport, never one it
replaced. `close()` closes it at once and for good.

`McpTransport` is the whole contract, for a transport of your own: `send()` a message, `onMessage()`
to receive them, and optional `start()` and `onClose()` with `close()`. The messages are JSON-RPC:
`JsonRpcRequest` expects a `JsonRpcResponse` with the same id, carrying a result or an error, and a
`JsonRpcNotification` expects nothing; `JsonRpcMessage` is any of the three. `LineDecoder` splits a
byte stream into newline-delimited messages, holding a partial message until the rest arrives and
skipping a malformed line rather than losing the stream.

## The server

`McpServer` takes `McpServerOptions`: a `name` and `version` to report, the `tools` to expose, and
`resources`, each a URI with a name, description, MIME type, and a `read()` function. `register()`
adds a tool later, and tells a connected client with `notifications/tools/list_changed`, as the
server's `tools.listChanged` capability promises. `connect()` starts serving over a transport,
`close()` stops, and `handle()` takes one message directly, for a host that carries messages itself.

Each tool is listed with the annotations its capabilities give it, from `mcpToolAnnotations()`, read
so a client is never told less than the tool may do. It is read-only only when every capability reads
files or is `mcp.read`, or there are none. It is not destructive only when everything else it does is
`mcp.write`. It stays within itself only when every capability is the filesystem's or an MCP tool's.
A tool whose capabilities depend on its arguments, or that declares none, is listed without
annotations, which a client reads as able to do anything.

It answers `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`.
A tool with neither `execute` nor `stream` is a schema for a model to call elsewhere, so the server
reports it as unknown when called. A `stream` tool runs too, and when the call names a
`progressToken`, each report goes back as `notifications/progress`: a number is the progress, an
object's `progress`, `total`, and `message` are used, and anything else is the message. A tool that throws answers with `isError` and the message rather
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
- A request in flight when a connection drops fails, rather than being sent again, since it may have
  run. A registry's tool lists are read again only after `refresh()`.
- A tool's capabilities from its annotations are only as true as its server is honest.
- The server exposes tools and resources. Prompts and sampling are not served, and of change
  notifications only its tools' are sent.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/mcp`

| Export | Kind | Summary |
| --- | --- | --- |
| `createHttpTransport` | function | Speaks to an MCP server over HTTP, one POST per message. |
| `createSseTransport` | function | Speaks to an MCP server over HTTP with Server-Sent Events, as MCP's 2024-11-05 transport: one long `GET` the server answers on, and a `POST` per message to the endpoint the stream names first. |
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
| `mcpToolAnnotations` | function | The annotations a tool is served with, from the capabilities it declares, read so a client is never told less than the tool may do: - read-only only when every capability reads, `filesystem:read` or `mcp.read`, or there are none; - not destructive only when everything else it does is `mcp.write`; - closed to the world only when every capability is the filesystem's or an MCP tool's effect. |
| `McpToolAnnotations` | interface | What a server says a tool does, as MCP's tool annotations: hints, which a client trusts only as far as it trusts the server. |
| `mcpToolCapabilities` | function | The capabilities an MCP tool declares, from what its server says of it in its annotations, so a permission policy decides it as it decides any tool: - `mcp.read:<server>/<tool>` for a tool that only reads; - `mcp.write:<server>/<tool>` for one that changes things but destroys nothing; - `mcp.destructive:<server>/<tool>` for one that may destroy or overwrite; - and `network`, beside it, for one that reaches beyond its server. |
| `McpToolDescriptor` | interface | A tool an MCP server offers. |
| `McpToolResult` | interface | What a tool call returned. |
| `McpToolsOptions` | interface | Options for `McpClient.toNexusTools()`. |
| `McpTransport` | interface | Carries a transport's messages in both directions. |
| `SseClientOptions` | interface | Connects to a remote MCP server over HTTP with Server-Sent Events, the transport before streamable HTTP. |
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
