# Runtimes

<!-- covers: ./runtime -->

Most of this package runs on any JavaScript runtime: Node.js, Deno, Bun, edge runtimes such as
Cloudflare Workers and Vercel's, and browsers. That includes:
- the client;
- every provider adapter;
- graphs and agents;
- the agent protocols.

What needs Node.js is what needs a file system, a socket, a child process, or Node's crypto: file
stores, the server, operations, telephony, and the sandbox. The table at the end lists each of
those entry points and exactly what it needs.

## The kernel

`nexus-ai-pro/runtime` gathers the contracts every model call and tool call is built on into one
small import. Nothing it reaches uses `fs`, `net`, `child_process`, Node's `crypto`, or Node's
globals. The check that guards this fails the build if that ever changes. `runtimeInfo()` reports
which runtime the code is on, as a `RuntimeInfo` with a `RuntimeName` and a version.

```ts
import { runtimeInfo, tool, collectStream } from 'nexus-ai-pro/runtime';
import { GoogleProvider } from 'nexus-ai-pro/providers/google';

export default {
  async fetch(request: Request, env: { GEMINI_KEY: string }): Promise<Response> {
    const provider = new GoogleProvider({ apiKey: env.GEMINI_KEY });
    const stream = provider.stream({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: await request.text() }] });
    return new Response(`${await collectStream(stream)} (${runtimeInfo().name})`);
  },
};
```

The kernel holds these.

**Messages.** A `Message` has a `MessageRole` and content made of `ContentPart` values:
- `TextContent`;
- `ImageContent`, `AudioContent`, and `VideoContent`, whose bytes are a `BinaryBuffer`;
- `AssetContent`, for media held in an asset store.

A `CacheHint` marks where a cacheable prefix ends, and `PromptCacheConfig` sets how a request
caches. A `CompletionRequest` carries the messages, the tools, a `ToolChoice`, and a
`ReasoningConfig`.

**Responses.** A `NexusResponse` has content, any `ToolCall` values, and its `ResponseMeta`:
- `TokenUsage`;
- `ResponseCost`;
- the `CacheOutcome`.

A stream is a `NexusStream` of `StreamChunk` values. `collectStream()` reads one to its text, and
`mapStream()` transforms each chunk. `createTextStream()` makes a stream from text, for tests and
cached answers.

**The provider contract.** An adapter extends `BaseProvider`: it states its `ProviderInfo`, then
completes and streams. Each call receives a `ProviderCallContext` with the operation's id, deadline,
trace headers, and idempotency key.

Failures are a `NexusProviderError` with a `NexusProviderErrorCategory`, built from
`NexusProviderErrorOptions`:
- `createProviderHttpError()` turns a failed HTTP response into one;
- `toNexusProviderError()` turns anything thrown into one;
- `categorizeProviderError()` reads the category;
- `isRetryableProviderError()` says whether trying again can help;
- `isAbortError()` recognizes a cancelled request.

**The tool contract.** A `ToolDefinition` names a tool, describes it for the model, and declares
its JSON Schema. `tool()` defines one with typed arguments. When an agent runs it, the tool
receives a `ToolContext`. A tool returns any value, or a `ToolOutput` from `toolOutput()` that
carries images back to the model. `isToolOutput()` recognizes one, and `toolMessageContent()` turns
a result into the message the model reads. `ToolExecutor` runs tools by name outside an agent, and
a `ToolCallResult` pairs a result with the call it answers.

**Capabilities.** A tool declares what it does to the world as capabilities, read by
`parseCapability()` into a `ParsedCapability`. `capabilitiesOf()` resolves the capabilities of a
call. `isSensitiveCapability()` says which need a person's approval by default: anything but a read.

Models have capabilities too. `negotiateCompletionRequest()` fits a request to what the routed
model supports, by `NegotiateOptions`. It returns a `NegotiationResult` with each change it made,
or raises a `NexusCapabilityError` under a strict policy.

## Provider adapters on any runtime

Each provider adapter keeps its own entry point, so an application loads only the providers it
uses. The OpenAI, Anthropic, Google, and Cohere adapters take a `fetch` option. Every request then
goes through it, for:
- a platform's bound fetch;
- a proxy that adds credentials;
- a stub in a test.

The OpenAI and Anthropic adapters call their official SDKs, which run on every runtime. Each SDK
is an optional peer, loaded only when a request is sent.

```ts
import { OpenAIProvider } from 'nexus-ai-pro/providers/openai';

const provider = new OpenAIProvider({
  apiKey: env.OPENAI_KEY,
  fetch: (input, init) => env.EGRESS.fetch(input, init),
});
```

The client, graphs, agents, and the agent protocols need nothing more. A graph's node cache keys
its entries with SHA-256 in plain JavaScript. It uses the runtime's native digest where one is
available synchronously, and the digest is the same either way. Ids come from Web Crypto.

## Proof

The kernel's tests are written against web-standard APIs only, with no test framework and nothing
of Node's. One file, `tests/portable/kernel.mjs`, runs on four runtimes against the built package:
- **Node.js and an edge runtime** run on every build. The edge runtime is Vercel's, which exposes
  no `process`, `Buffer`, or `require`, and the tests are bundled first, as a platform's build would
  bundle them.
- **Deno and Bun** run in CI beside it.

On each runtime, the tests check the following:
- tools and capabilities;
- streams;
- a provider over `fetch`, completing and streaming against a stub that splits the stream mid-frame;
- the client routing a request to a provider;
- a graph with a cached node;
- an agent calling a tool;
- an agent answering over A2A and rendering over AG-UI.

`scripts/check-portability.mjs` walks every entry point's imports, static and dynamic, and fails
the build in two cases:
- the client, the kernel, a provider adapter, graphs, agents, or a protocol reaches anything
  Node-only;
- the table below falls out of date.

## Limitations

- **Browsers are covered by the checks, not by a browser run.** The import check holds for them,
  and the edge runtime has only the web platform's globals, but CI does not open a browser.
- **A provider key in a browser is visible to every user.** Call providers from a server or an edge
  function, or through a proxy that holds the key. Some providers also refuse cross-origin requests.
- **SHA-256 in plain JavaScript is slower on large inputs.** It takes about 7 µs for a typical
  cache key, and about ten times native time for megabytes of image bytes. It is used only where
  the runtime has no synchronous native digest.

## What needs Node.js

The table is generated from the built package's import graph, so it is exact. A runtime with Node
compatibility, such as Deno or Bun, or Workers with Node compatibility enabled, runs these too.

<!-- runtimes:start -->

Of 158 entry points, 126 run on any runtime. These need Node.js, or a runtime with Node compatibility, and what they need:

| Entry point | Needs |
| --- | --- |
| `nexus-ai-pro/voice/openai` | the `Buffer` global |
| `nexus-ai-pro/images` | `node:fs/promises`, `node:path` |
| `nexus-ai-pro/images/openai` | the `Buffer` global |
| `nexus-ai-pro/images/google` | the `Buffer` global |
| `nexus-ai-pro/images/comfyui` | the `Buffer` global |
| `nexus-ai-pro/images/transform` | `node:zlib`; the `Buffer` global |
| `nexus-ai-pro/images/inputs` | `node:dns/promises`, `node:http`, `node:https`, `node:net`; the `Buffer` global |
| `nexus-ai-pro/images/moderation` | the `Buffer` global |
| `nexus-ai-pro/operations` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/operations/webhooks` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/agent/sandbox` | the `process` global |
| `nexus-ai-pro/deep-agent` | the `process` global |
| `nexus-ai-pro/mcp` | the `process` global |
| `nexus-ai-pro/mcp/registry` | the `process` global |
| `nexus-ai-pro/tracing` | `node:fs/promises`, `node:path`, `node:async_hooks` |
| `nexus-ai-pro/tracing/otlp` | `node:async_hooks` |
| `nexus-ai-pro/evaluate` | `node:fs/promises`, `node:path`; the `process` global |
| `nexus-ai-pro/insights` | the `process` global |
| `nexus-ai-pro/connectors` | `node:dns/promises`, `node:http`, `node:https`, `node:net`; the `Buffer` global |
| `nexus-ai-pro/server` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/doctor` | `node:module`, `node:path`; the `process` global |
| `nexus-ai-pro/prompts/registry` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/prompts/file` | `node:fs/promises`, `node:path`; the `process` global |
| `nexus-ai-pro/testing/record` | `node:fs/promises`, `node:path`; the `Buffer` global, the `process` global |
| `nexus-ai-pro/batch` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/images/stores` | `node:fs/promises`, `node:path` |
| `nexus-ai-pro/telephony` | the `Buffer` global |
| `nexus-ai-pro/telephony/realtime-bridge` | the `Buffer` global |
| `nexus-ai-pro/telephony/twilio` | `node:crypto`; the `Buffer` global |
| `nexus-ai-pro/loaders/web` | `node:dns/promises`, `node:http`, `node:https`, `node:net`; the `Buffer` global |
| `nexus-ai-pro/loaders/git` | the `process` global |
| `nexus-ai-pro/rag/redis` | the `Buffer` global |

These run anywhere, and load a Node module only when a feature that needs it is used:

| Entry point | Loads, when used |
| --- | --- |
| `nexus-ai-pro/images/evals` | `node:zlib`; the `Buffer` global |
| `nexus-ai-pro/loaders/text` | `node:fs/promises`, `node:path` |
| `nexus-ai-pro/loaders/markdown` | `node:fs/promises` |
| `nexus-ai-pro/loaders/html` | `node:fs/promises` |
| `nexus-ai-pro/loaders/csv` | `node:fs/promises` |
| `nexus-ai-pro/loaders/json` | `node:fs/promises` |
| `nexus-ai-pro/loaders/pdf` | `node:fs/promises` |

<!-- runtimes:end -->

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/runtime`

| Export | Kind | Summary |
| --- | --- | --- |
| `AssetContent` | interface | An asset passed by reference: an image or file a tool made or stored, named in the conversation by where it lives rather than carried as base64 text. |
| `AudioContent` | interface | An audio part of a message, for audio-capable models, or a transcript standing in for the audio. |
| `BinaryBuffer` | type | Node's `Buffer` when Node's type definitions are loaded, and `Uint8Array` otherwise, so the message types compile in a browser project as well as on a server. |
| `CacheHint` | type | Marks a message or tool definition as the end of a cacheable prefix. |
| `CacheOutcome` | interface | What the response cache did for one request: `hit` (answered from it), `miss` (looked, found nothing), `stale` (found an entry that had expired), `bypass` (the request skipped the lookup), or `error` (the cache failed, and the request went to the provider as on a miss). |
| `CompletionRequest` | interface | A completion request: the model, the conversation, and every control over how it is answered. |
| `ContentPart` | type | One part of a multimodal message. |
| `ImageContent` | interface | An image part of a message, for vision-capable models. |
| `isToolOutput` | function | True for a result built with `toolOutput()`. |
| `Message` | interface | One message in a conversation. |
| `MessageRole` | type | Who a message is from: instructions, the user, the model, or a tool result. |
| `NexusResponse` | interface | A completion. |
| `NexusStream` | interface | A streamed completion: iterate it for chunks, or abort it. |
| `PromptCacheConfig` | interface | Provider-side prompt caching. |
| `ReasoningConfig` | interface | Requested reasoning behavior. |
| `ResponseCost` | interface | Numeric cost of one operation. |
| `ResponseMeta` | interface | How a completion was produced: provider, model, timing, tokens, cost, and every policy that touched it. |
| `runtimeInfo` | function | Which runtime the code is running on, from what each one reliably exposes. |
| `RuntimeInfo` | interface | Which runtime the code is running on. |
| `RuntimeName` | type | A JavaScript runtime this package recognizes. |
| `StreamChunk` | interface | One streamed event. |
| `TextContent` | interface | A text part of a message. |
| `TokenUsage` | interface | Token accounting for one operation. |
| `tool` | function | Defines a tool the model can call, typing its arguments. |
| `ToolCall` | interface | A tool call the model made. |
| `ToolCallResult` | interface | What a tool returned, correlated with the call that asked for it. |
| `ToolChoice` | type | How the model may use tools. |
| `ToolContext` | interface | What a tool receives besides its arguments when an agent runs it. |
| `ToolDefinition` | interface | A tool the model may call. |
| `ToolExecutor` | class | Runs tool calls by name, reporting failures as results rather than throwing. |
| `toolMessageContent` | function | What the model reads for a tool's result: the parts of a `toolOutput()`, or anything else as JSON. |
| `toolOutput` | function | Builds a tool's result as content: text, images, and asset references, in order. |
| `ToolOutput` | interface | What a tool returns when its result is content rather than a value to serialize: text, images, and asset references, in order. |
| `VideoContent` | interface | A video part of a message. |
<!-- reference:end -->
