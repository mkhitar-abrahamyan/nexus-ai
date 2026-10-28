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

Stdio, streamable HTTP, and SSE transports are included, both ways, and the transport is an
interface, so a test can wire a client to a server in memory.

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
| `onToolsChanged()`, `onPromptsChanged()`, `onResourcesChanged()` | Hears each time the server says that list changed; each returns a function that stops hearing. |
| `subscribeResource()`, `unsubscribeResource()`, `onResourceUpdated()` | Asks to hear when a resource changes, stops, and hears its URI each time it does. |
| `rootsChanged()` | Tells the server this client's roots changed. |
| `close()` | Closes the transport, rejecting requests still waiting. |

### What a server asks of the client

A server may ask its client for things while it works: a completion from the client's model, an
answer from the person using it, or the roots it may work within. `McpClientOptions` answers each it
is given, and declares it to the server at the handshake:
- `sampling` answers `sampling/createMessage`, an `McpSamplingRequest` of `McpSamplingMessage` values,
  each `McpSamplingContent` text, an image, or audio, with `McpModelPreferences`, with an
  `McpSamplingResult`. `samplingFrom()` is one, from any `McpSamplingClient`, such as `NexusAI`, so
  each request is routed, budgeted, traced, and priced as every completion is. `McpSamplingOptions`
  set the `model`, the `models` a server's hints pick from, a `maxTokens` cap, whether to keep its
  `systemPrompt`, and `approve`, which sees each request first, as MCP expects a person to;
- `elicitation` answers `elicitation/create`, an `McpElicitationRequest` with the form of its answer,
  with an `McpElicitationResult`: accepted with its fields, declined, or cancelled;
- `roots` answers `roots/list` with each `McpRoot`.

```ts
const client = new McpClient(createHttpTransport({ url }), {
  sampling: samplingFrom(ai, { model: 'gpt-5-mini', maxTokens: 1_000, approve: (request) => confirm(request) }),
  roots: () => [{ uri: 'file:///work/acme', name: 'acme' }],
});
```

A request it was not given is refused with method-not-found, as is anything else a server asks but
`ping`, which it answers. A request the server cancels stops its handler, through the `signal` it is
given, and is not answered.

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

`createHttpTransport()` speaks streamable HTTP, MCP's transport since 2025-03-26: one POST per
message, carrying the `mcp-session-id` the server assigns and the protocol version, answered as JSON
or as a stream of events. A stream is read as it comes, so the server's progress, and a question it
asks the client in the middle of a call, arrive while the call runs. With `listen`, a `GET` stream
carries what the server sends of its own accord, such as its tools changing; a server that answers it
with 405 offers none. `close()` ends the session with a `DELETE`. `HttpClientOptions` gives the
`url`, `headers` such as authorization, `listen`, and a `fetch` to use instead of the global one.

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

`McpServer` takes `McpServerOptions`: a `name` and `version` to report, the `tools` to expose, its
`resources`, each an `McpServerResource`, a URI with a name, description, MIME type, and a `read()`
function, its `prompts`, and `timeoutMs`, how long a question it asks a client waits (60 seconds).
`register()`, `registerPrompt()`, and `registerResource()` add one later and tell every connected
client that list changed. `connect()` starts serving a client over a transport, and serves each
client connected to it at once; `close()` stops, and `handle()` takes one message directly, for a
host that carries messages itself.

An `McpServerPrompt` has a name, a title and description, the `McpPromptArgument` values it takes,
and `get()`, which renders it: text, which is one user message, or each `McpPromptMessage`. A
required argument a client leaves out is refused with invalid-params. A client may subscribe to a
resource; `resourceUpdated()` tells each subscribed client it changed, and only those.

A tool the server runs may ask the client that called it for what it needs, through `context.mcp`, the
`McpCallerRequests` of that call: `createMessage()` asks its model, `elicit()` asks its person, and
`listRoots()` its roots. Each is refused before it is sent when the client did not declare it, waits
`timeoutMs`, and is cancelled, and the client told, when the call is. `createMessage()`, `elicit()`,
and `listRoots()` on the server itself ask the one client connected, and refuse when several are,
since only a tool's context knows which called. `onRootsChanged()` hears a client's roots change.

```ts
const summarize = tool({
  name: 'summarize',
  description: 'Summarizes a document with the caller’s own model',
  parameters: { type: 'object', properties: { id: { type: 'string' } } },
  execute: async ({ id }, context) => {
    const answer = await context?.mcp?.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${await read(String(id))}` } }],
      maxTokens: 300,
    });
    return answer?.content.type === 'text' ? answer.content.text : '';
  },
});
```

Each tool is listed with the annotations its capabilities give it, from `mcpToolAnnotations()`, read
so a client is never told less than the tool may do. It is read-only only when every capability reads
files or is `mcp.read`, or there are none. It is not destructive only when everything else it does is
`mcp.write`. It stays within itself only when every capability is the filesystem's or an MCP tool's.
A tool whose capabilities depend on its arguments, or that declares none, is listed without
annotations, which a client reads as able to do anything.

It answers `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`,
`resources/subscribe`, `resources/unsubscribe`, `prompts/list`, and `prompts/get`, and stops a tool's
call when its client cancels it, through the call's `signal`.
A tool with neither `execute` nor `stream` is a schema for a model to call elsewhere, so the server
reports it as unknown when called. A `stream` tool runs too, and when the call names a
`progressToken`, each report goes back as `notifications/progress`: a number is the progress, an
object's `progress`, `total`, and `message` are used, and anything else is the message. A tool that throws answers with `isError` and the message rather
than failing the request. `createStdioServerTransport()` serves over this process's stdin and stdout,
which is how an editor or desktop assistant launches it; nothing else may be written to stdout.

### Serving over HTTP

`mcpHttpHandler()` serves an `McpServer` over streamable HTTP as a Web handler, an `McpHttpHandler`,
for any server that speaks `Request` and `Response`. Each client that sends `initialize` gets a
session of its own, named in the `Mcp-Session-Id` header it sends from then on. A request is answered
as a stream of events that carries the server's progress, and its questions for the client, before
the answer; two requests in flight are each answered on their own stream. A notification, or an
answer to the server's question, is taken with 202. A `GET` holds the session's own stream, for what
the server sends of its own accord, and a `DELETE` ends it.

```ts
const handle = mcpHttpHandler(new McpServer({ tools: [summarize], prompts: [triage] }));
Bun.serve({ port: 3001, fetch: handle });
```

`McpHttpOptions` sets `allowedOrigins`: a request from a web page on any other origin than the
endpoint's own is refused with 403, so a page cannot reach a server on the person's machine through
their browser. `json` answers each request as JSON, once the server finishes. `sessionTtlMs` ends a
session idle that long (30 minutes), unless a stream of it is open; `maxSessions` refuses more than
that many at once with 503 (1,000); and `sessionId` makes the ids. A message without a session, or
naming one that has ended, is refused with 400 or 404, a protocol version it does not speak with 400,
and a batch, which 2025-06-18 dropped, with 400.

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

- A stream that drops is not resumed from where it was: the HTTP handler numbers no events, and a
  client reads a dropped answer's request as failed.
- A request in flight when a connection drops fails, rather than being sent again, since it may have
  run. A registry's tool lists are read again only after `refresh()`.
- A tool's capabilities from its annotations are only as true as its server is honest.
- The server offers no resource templates and no completions, and a client's sampling handler is
  given no other server's context: `includeContext` is the server's request, not a promise.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/mcp`

| Export | Kind | Summary |
| --- | --- | --- |
| `createHttpTransport` | function | Speaks to an MCP server over streamable HTTP, MCP's transport since 2025-03-26: a `POST` per message, answered as JSON or as a stream of events the transport reads as they come, so a server may report progress and ask this client for something in the middle of a call. |
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
| `McpCallerRequests` | interface | What a tool served over MCP may ask the client that called it, as `ToolContext.mcp`: its model for a completion, its person for an answer, and its roots. |
| `McpClient` | class | Talks to an MCP server. |
| `McpClientOptions` | interface | Options for an MCP client. |
| `McpContent` | interface | One piece of content from an MCP server: text, or base64 data with a MIME type. |
| `McpElicitationRequest` | interface | A server's `elicitation/create`: a question for the person using the client, with the form of its answer. |
| `McpElicitationResult` | interface | What the person answered: accepted with the fields, declined, or cancelled. |
| `McpError` | class | An MCP protocol error, carrying a JSON-RPC error code. |
| `mcpHttpHandler` | function | Serves an MCP server over streamable HTTP, MCP's transport since 2025-03-26: each client that sends `initialize` gets a session, named in the `Mcp-Session-Id` header it sends from then on. |
| `McpHttpHandler` | interface | A Web handler serving an MCP server over streamable HTTP, and what it holds. |
| `McpHttpOptions` | interface | Options for `mcpHttpHandler()`. |
| `McpModelPreferences` | interface | Which model a server would like its client to use: hints by name, and how it weighs cost, speed, and intelligence. |
| `McpPromptArgument` | interface | One argument a prompt takes. |
| `McpPromptMessage` | interface | One message of a rendered prompt. |
| `McpResourceDescriptor` | interface | A resource an MCP server offers. |
| `McpRoot` | interface | A root the client lets a server work within: a `file://` URI, and a name for it. |
| `McpSamplingClient` | interface | Anything that completes a request, such as a `NexusAI` client. |
| `McpSamplingContent` | type | A sampled message's content: text, or an image or audio as base64. |
| `McpSamplingMessage` | interface | One message of a conversation a server asks its client's model to continue. |
| `McpSamplingOptions` | interface | Options for `samplingFrom()`. |
| `McpSamplingRequest` | interface | A server's `sampling/createMessage`: a conversation for the client's model to continue. |
| `McpSamplingResult` | interface | What the client's model answered. |
| `McpServer` | class | Exposes tools, resources, and prompts over MCP, so other assistants can use them. |
| `McpServerOptions` | interface | Options for an MCP server. |
| `McpServerPrompt` | interface | A prompt a server offers: a template a client renders with its arguments. |
| `McpServerResource` | interface | A resource a server exposes, read by its URI. |
| `mcpToolAnnotations` | function | The annotations a tool is served with, from the capabilities it declares, read so a client is never told less than the tool may do: - read-only only when every capability reads, `filesystem:read` or `mcp.read`, or there are none; - not destructive only when everything else it does is `mcp.write`; - closed to the world only when every capability is the filesystem's or an MCP tool's effect. |
| `McpToolAnnotations` | interface | What a server says a tool does, as MCP's tool annotations: hints, which a client trusts only as far as it trusts the server. |
| `mcpToolCapabilities` | function | The capabilities an MCP tool declares, from what its server says of it in its annotations, so a permission policy decides it as it decides any tool: - `mcp.read:<server>/<tool>` for a tool that only reads; - `mcp.write:<server>/<tool>` for one that changes things but destroys nothing; - `mcp.destructive:<server>/<tool>` for one that may destroy or overwrite; - and `network`, beside it, for one that reaches beyond its server. |
| `McpToolDescriptor` | interface | A tool an MCP server offers. |
| `McpToolResult` | interface | What a tool call returned. |
| `McpToolsOptions` | interface | Options for `McpClient.toNexusTools()`. |
| `McpTransport` | interface | Carries a transport's messages in both directions. |
| `samplingFrom` | function | A sampling handler for \`McpClientOptions.sampling\`, answering a server's requests with a client's own completions: the conversation as messages, an image or audio as a part, the server's system prompt, temperature, stop sequences, and token limit, the model chosen by its hints. |
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
