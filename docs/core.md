# The client: requests, context, cost, and streaming

<!-- covers: . ./core ./config ./streaming ./capabilities ./context ./optimizer -->
<!-- sources: src/core src/types src/pipeline src/optimizer src/next src/utils -->

`NexusAI` is the client every other part plugs into: one request shape across providers, with context-window management, token optimization, cost checks, reasoning and prompt-caching controls, capability negotiation, and streaming. Import it from the root, or from `nexus-ai-pro/core` and `nexus-ai-pro/config` when you want the client without the rest of the root's re-exports.

```ts
import { createNexus } from 'nexus-ai-pro';

const ai = createNexus({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5.4-mini' });
const response = await ai.complete({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
```

## Creating a client

There are three ways in, and they produce the same `NexusAI`.

```ts
// 1. The shorthand: one provider, one model, credentials from the environment.
import { createNexus } from 'nexus-ai-pro';
const ai = createNexus({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5.4-mini' });

// 2. The typed builder, for several providers and a routing strategy.
import { createNexusConfig } from 'nexus-ai-pro';
const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY!)
  .anthropic(process.env.ANTHROPIC_API_KEY!)
  .auto('quality')
  .create();

// 3. The full configuration object, when it comes from a file or a secrets store.
import { NexusAI, defineNexusConfig } from 'nexus-ai-pro';
const ai = new NexusAI(defineNexusConfig({ providers: { openai: { apiKey } }, routing: { mode: 'auto' } }));
```

`CreateNexusOptions` is the shorthand's input — a `CreateNexusProvider` name, its key, a base URL,
the Azure endpoint and deployment, and a default model — and `normalizeCreateNexusConfig()` is the
function that turns it into a `NexusAIConfig`, exported so you can inspect what the shorthand
produced. `NexusConfigBuilder` is the builder's type, and `defineNexusConfig()` is an identity
function that types a plain object, so a configuration in its own file is checked where it is
written.

`NexusAIConfig` is the whole surface: `ProvidersConfig` with a typed entry per provider
(`OpenAIProviderConfig`, `AnthropicProviderConfig`, `GoogleProviderConfig`, `AzureOpenAIProviderConfig`,
`OllamaProviderConfig`, `GroqProviderConfig`, `MistralProviderConfig`, `CohereProviderConfig`,
`DeepSeekProviderConfig`, `LMStudioProviderConfig`, `LlamaCppProviderConfig`, and
`CustomProviderConfig` for your own), plus `RoutingConfig`, `RetryConfig`, `CacheConfig`,
`SecurityConfig`, `RateLimitConfig`, `BudgetConfig`, `CostBudgetConfig`, `CapabilityConfig`,
`TokenOptimizerConfig`, `ResponseFormatConfig`, `LoggerConfig`, `AuditLogConfig`, and
`PipelineConfig`. Each is documented in the guide for its feature; the reference below links every
name to its summary.

Routing is configured here and explained in the [providers guide](./providers.md): `RoutingConfig`
names a `RoutingStrategy` — `cost`, `speed`, `quality`, or `privacy` — for the auto-router, an
ordered list of `RoutingRule` values that send a matching request to a model, the models each
strategy prefers as `RoutingModelPreference` entries (a model name, or a model with a weight), and a
`FallbackConfig` that adds failover models, a first-attempt timeout, and rate-limit handling to every
route, including a request that names its model. `LoggerConfig` receives each `LogEvent` — a
`LogLevel` of `info`, `warn`, or `error`, a message, a timestamp, structured data, and the error when
there is one — in a sink of your own, on the console, or both.

## A request and its response

`CompletionRequest` is the request shape every provider takes: `model`, `messages`, and the settings
a provider may honour — `temperature`, `maxTokens`, `topP`, `topK`, penalties, `seed`, `stop`,
`timeoutMs`, `tools` with `ToolChoice`, `responseFormat`, `reasoning`, `cache`, `metadata`, and a
`signal`. Each tool is a `ToolDefinition`: a name, a description written for the model, a JSON Schema
for its arguments, an optional `execute` function for loops that run tools themselves, and an
optional cache breakpoint. A `Message` has a `MessageRole` and either text or `ContentPart` values: `TextContent`,
`ImageContent`, `AudioContent`, and `VideoContent`, with `BinaryBuffer` standing in for Node's
`Buffer` where the types must also compile in a browser.

`NexusResponse` comes back with the text, the `ToolCall` values the model made, a `finishReason`, and
`ResponseMeta`: which provider and model answered, the latency, `TokenUsage`, `ResponseCost`, whether
it was a cache hit, the guardrails applied, and the `PipelineTrace` when tracing is on. `ToolCallResult`
is what you send back after running a tool, and `NexusStream` and `StreamChunk` are the streaming
equivalents.

```ts
const response = await ai.complete({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
response.meta.providerUsed;     // who answered
response.meta.usage.totalTokens;
response.meta.cost.amount;      // a number, in USD
```

## Structured output

`responseFormat` asks for JSON, optionally against a schema, and the client validates what comes
back rather than trusting it: output that is not valid JSON, or does not match the schema, raises a
`ResponseFormatError` rather than reaching your code as if it were valid. `ResponseFormatConfig` sets the same thing for every request.

```ts
const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Extract the invoice' }],
  responseFormat: { type: 'json_schema', schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
});
```

## Context windows

Long chats can be compacted before token optimization and provider calls.

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  routing: { mode: 'direct' },
  defaultModel: 'openai/best',
  contextWindow: {
    strategy: 'last-messages-with-summary',
    lastMessages: 8,
    summary: {
      model: 'openai/fast',
      maxTokens: 500,
      fallbackToLocal: true,
    },
  },
});
```

Strategies:

- `last-messages` - keep system messages and the latest N conversation messages
- `last-tokens` - keep recent messages up to `maxInputTokens`
- `last-messages-with-summary` - summarize older messages, then keep the latest N
- `last-tokens-with-summary` - summarize older messages, then keep recent messages near the token limit
- `auto` - compact only when message or token limits are exceeded

Summaries can be local, provider-generated, or custom:

```ts
contextWindow: {
  strategy: 'auto',
  lastMessages: 12,
  maxInputTokens: 12000,
  summary: {
    mode: 'custom',
    summarizer: async ({ serializedMessages }) => {
      return myMemoryService.summarize(serializedMessages);
    },
  },
}
```

The result is visible in `response.meta.contextWindow` and `ai.plan(...).contextWindow`.

`ContextWindowConfig` is the whole setting: a `ContextWindowStrategy`, how many conversation
messages to keep (`lastMessages`, 20 by default), the token ceiling (`maxInputTokens`), the tokens
held back for a summary, and whether system messages always survive (they do by default).
`ContextSummaryConfig` decides how cut messages are summarized. Its `ContextSummaryMode` is `local`
for an extractive summary with no model call, `provider` to have a model write it through the client,
or `custom` for your own `ContextSummarizer`. It also sets the summary's length (512 tokens by
default), model, temperature, instructions, heading, and whether the summary is inserted as a system
or a user message. A `provider` summary that fails falls back to a local one unless
`fallbackToLocal` is `false`. A custom summarizer receives a `ContextSummaryInput`: the request, the
messages to fold, those messages as one text, the token limit, the model, and the instructions.

`ContextWindowManager` does the work, and you can use it on its own. `optimize()` trims a request,
calling the summarizer from a `ContextWindowRuntime` when one is given, and `preview()` reports what
trimming would do without calling it. Both return a `ContextWindowResult`: the trimmed request, the
techniques applied, warnings such as a summary that fell back to local, and a `ContextWindowUsage`
with the strategy `auto` resolved to, tokens and messages before and after, and how many messages
were kept, summarized, or dropped.

## Token optimization

Use `tokenOptimizer` when you want lightweight token estimation, prompt densification, and budget enforcement.

```ts
tokenOptimizer: {
  densification: { enabled: true, preserveCodeBlocks: true },
  budget: {
    enabled: true,
    maxInputTokens: 4000,
    warnAt: 0.8,
    onExceeded: 'truncate',
  },
}
```

Budget actions, the `BudgetExceededAction` values:

- `error` - throw `TokenBudgetError` (the default)
- `truncate` - remove or slice older prompt content
- `densify` - compact prompt text before checking budget
- `allow` - warn but send as-is

`DensificationConfig` picks the techniques — whitespace cleanup, phrase compression, and list
compaction, all three by default — and leaves fenced code blocks alone unless told otherwise. A
warning is recorded once a request reaches `warnAt` of the budget, 80% by default.

The three pieces are exported for use outside the client. `TokenOptimizer` runs both steps on a
request and returns an `OptimizationResult`: the request, the techniques applied, warnings, and a
`TokenUsageSnapshot` of estimated tokens before and after, saved, and the share saved.
`PromptDensifier` rewrites text on its own, and `BudgetEnforcer` checks a request against a budget
(`check()`) or applies the over-budget action (`enforce()`).

## Planning a request before sending it

```ts
const plan = ai.plan({
  model: 'auto',
  messages: [{ role: 'user', content: 'Compare the last 3 releases.' }],
  maxTokens: 800,
  maxEstimatedCost: 0.05,
});

console.log(plan.model);
console.log(plan.estimatedCost.formatted);
console.log(plan.fitsContext);
console.log(plan.warnings);
```

`plan()` does not call a provider. It estimates route, token use, context fit, cost, guardrail findings, and warnings, including any option the routed model cannot honor.

The `NexusPlan` it returns has the model asked for and the provider and model it would use, the full
routing decision with its fallbacks, what context-window trimming and token optimization would do,
the estimated cost, the model's context window and whether the request fits it, whether the response
cache could answer it, whether input guardrails would block it and what they found, and the
guardrails that would apply.

## Reasoning

```ts
const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Find the bug in this migration plan.' }],
  reasoning: { effort: 'high', summary: 'auto' },
});

console.log(response.meta.usage?.reasoningTokens);
```

`ReasoningConfig` has three fields, and leaving it unset keeps the model's own default. `effort` is
the portable control, a `ReasoningEffort` from `none` through `minimal`, `low`, `medium`, `high`, and
`xhigh` to `max`. It maps to OpenAI `reasoning_effort` and the Responses `reasoning` field, Anthropic
extended thinking, and Gemini `thinkingConfig`. Use `reasoning.maxTokens` when you want to set a
thinking budget directly instead of by level, and `summary` (`none`, `auto`, or `detailed`) to stream
reasoning summaries.

Requesting a summary emits `reasoning` stream chunks, which stay separate from visible output:

```ts
for await (const chunk of ai.stream({ model: 'auto', messages, reasoning: { summary: 'auto' } })) {
  if (chunk.type === 'reasoning') process.stderr.write(chunk.content ?? '');
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}
```

## Prompt caching

Providers charge far less for a prompt prefix they have already processed. `mode: 'auto'` is the
default and reports whatever the provider reused on its own. `mode: 'explicit'` sends caller-placed
breakpoints to providers that accept them, such as Anthropic:

```ts
const response = await ai.complete({
  model: 'anthropic/best',
  cache: { mode: 'explicit', ttl: '1h' },
  messages: [
    { role: 'system', content: longPolicyDocument, cache: true },
    { role: 'user', content: 'Does clause 14 apply here?' },
  ],
});

console.log(response.meta.usage?.cachedReadTokens);
console.log(response.meta.cost?.amount);
```

Mark the end of the stable prefix, not every message. A provider caps how many breakpoints it
accepts (Anthropic allows four); when there are more marks than slots, the deepest ones are kept,
because a deeper breakpoint caches strictly more of the prompt.

`PromptCacheConfig` is the request's `cache` field: the `mode`, a `ttl` for breakpoints that set none
of their own, and `maxBreakpoints` to send fewer than the provider allows. Messages and tools carry
the breakpoints themselves. `off` suppresses caller-placed breakpoints; it cannot turn off caching a
provider does on its own.

## Usage and cost

Every response carries a numeric cost and a full token breakdown:

```ts
const { usage, cost } = response.meta;

console.log(usage?.inputTokens);        // billed at the standard input rate
console.log(usage?.cachedReadTokens);   // served from the provider cache
console.log(usage?.cachedWriteTokens);  // written into the provider cache
console.log(usage?.reasoningTokens);    // share of output spent on reasoning
console.log(cost?.amount, cost?.currency, cost?.basis);
```

`meta.tokensInput` keeps its original meaning of every prompt token, cached or not.
`meta.estimatedCost` is deprecated in favor of `cost.amount`. Bundled prices are defaults, not
financial truth; override them with `models.registry`, or adjust cache rates with
`models.cachePricing`.

## Counting and pricing tokens

`Tokenizer` estimates tokens without a provider — `estimateTextTokens()`, `estimateMessageTokens()`,
and `estimateRequestTokens()` — which is what budgets, planning, and context-window trimming run on.

Pricing is separate and explicit. `estimateCost()` prices a `CostEstimateInput` against the model
registry and returns a `CostEstimate`; `priceUsage()` prices a `TokenUsage` that a provider actually
reported, with `PriceUsageOptions`; `buildUsage()` and `buildMeta()` are what an adapter uses to turn
raw provider counts into `TokenUsage` and `ResponseMeta`, with `UsageInput` and `BuildMetaOptions` as
their inputs. `ensureUsageAndCost()` fills both in on a response from a custom provider that predates
them, `costAmount()` reads the number back out, `formatCost()` renders it, and `DEFAULT_CURRENCY` and
`DEFAULT_CACHE_PRICING` are the defaults behind it. `assertWithinCostBudget()` throws
`CostBudgetError` when an estimate exceeds what you allow, which is how a request is stopped before
it is sent rather than after it is billed.

## Capability negotiation

Requests are reconciled against the routed model before the provider is called:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  capabilities: { policy: 'warn' }, // 'strict' | 'warn' (default) | 'off'
});

const response = await ai.complete({ model: 'auto', messages, seed: 7 });
console.log(response.meta.capabilityWarnings);
```

- `strict` throws a `NexusCapabilityError` before spending anything.
- `warn` drops or clamps the option and records it on `meta.capabilityWarnings`.
- `off` sends the request exactly as written.

Those are the three `CapabilityPolicy` values. Each `CapabilityWarning` names the option by its
dotted path, such as `reasoning.effort`, with the model and provider, the value requested, the
`CapabilityWarningAction` taken — `dropped`, or `adjusted` with the value actually sent — and why.

`negotiateCompletionRequest()` is the negotiation on its own, for a custom provider or a gateway that
checks requests before forwarding them. It takes a request, the model's capabilities, and
`NegotiateOptions` (the policy and the provider name for messages), and returns a
`NegotiationResult` with the adjusted request and its warnings. It checks only the options a request
sets and copies the request only when something changes, so an ordinary call allocates nothing.

An option a model does not declare is always passed through — absence means the registry does not
know, not that the provider refuses — so a model you register yourself is never restricted by fields
it omits. Set `capabilityPolicy: 'off'` on a single request to reach a provider feature that is
newer than the bundled registry.

Registry provenance is inspectable, and a release check can fail on stale data:

```ts
import { describeModel, assertRegistryFreshness } from 'nexus-ai-pro';

console.log(describeModel('anthropic/best'));
// { model: 'claude-opus-4-8', verifiedAt: '…', alias: { stage: 'stable', floating: true }, … }

assertRegistryFreshness({ maxAgeDays: 120 });
```

A `floating` alias resolves by intent rather than to a pinned model, so its target can change between
releases. Pin the resolved model when a run has to be reproducible.

## Streaming

```ts
const stream = ai.stream({
  model: 'auto',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text') process.stdout.write(chunk.content);
}
```

All providers normalize streaming chunks to `text`, `reasoning`, `tool_call`, `done`, or `error`.
Reasoning summaries only arrive when the request asks for them, so a consumer that switches on
`chunk.type` keeps receiving visible output only.

When security is enabled, output streams are correctness-first: Nexus buffers and validates the
complete output before yielding any chunk, up to 1 MiB or 100,000 chunks. This prevents secrets,
PII, and blocked phrases split across provider chunks from leaking partially, at the cost of
token-by-token latency. `security: 'off'` preserves immediate streaming when that trade-off is
explicitly acceptable for the application.

Three helpers work on any `NexusStream`. `collectStream()` reads one to the end and returns its text,
`mapStream()` transforms each chunk as it passes, and `createTextStream()` makes a stream that yields
one text chunk and finishes, for tests and for answering from a cache in the streaming shape.

## The request pipeline

Every request runs through the same stages — security, context window, optimization, routing, the
provider call, output checks, and caching — and `PipelineConfig` is where you step into them.
`PipelineHooksConfig` maps a `PipelineHookName` to your own function; `PipelineMiddleware` and
`PipelineStep` add a stage of your own; and `PipelineRunner` with `createPipelineContext()` runs the
whole thing, which is what the client itself uses. Every hook receives the `PipelineContext`: the
request as earlier stages rewrote it, the response once there is one, the routing decision, what
context-window trimming and optimization did, the security findings and guardrails so far, the
timings, and a `metadata` object hooks can share. A hook may return a new context, a replacement
request, a replacement response, or nothing. Each stage is timed into a `PipelineTrace` of
`PipelineTraceStep` values, named by `PipelineStepName`, and returned on `response.meta.pipeline`
unless `includeTraceInResponse` is off.

## Serving a request from a framework

`createNexusRouteHandler()` returns a Next.js route handler that completes the posted request, or
streams it as server-sent events when streaming is on:

```ts
// app/api/chat/route.ts
import { createNexusRouteHandler } from 'nexus-ai-pro';
export const POST = createNexusRouteHandler({ ai, stream: true });
```

For a full HTTP surface — threads, background runs, resumable streams — see the
[agent server guide](./server.md).

## In production

- Keep what adds latency off the routes that are sensitive to it: the semantic cache and the
  semantic injection check each embed the request, and every pipeline hook runs on every call.
- Turn `pipeline.includeTraceInResponse` off when responses leave your service, so stage timings stay
  internal.
- Replace process-memory caches, rate limits, circuit state, and stores with their shared adapters
  before running more than one process; the [resilience guide](./resilience.md) and the
  [Postgres guide](./postgres.md) list them.
- Bundled prices and context limits are defaults, not a pricing contract; see the
  [providers guide](./providers.md).
- Guardrails reduce risk; keep server-side authorization and provider moderation around high-impact
  actions, as the [security guide](./security.md) says.

## The registry, in passing

`KNOWN_MODELS`, `MODEL_ALIAS_METADATA`, `REGISTRY_PROVENANCE`, `resolveProvider()`,
`ModelCapabilities`, `ModelEndpoint`, `ModelStatus`, `Modality`, `AliasMetadata`, `AliasStage`,
`ProviderCapabilities`, `PromptCachingCapability`, `CacheTtl`, and `CacheHint` are re-exported from
the root for convenience. They belong to the model registry, and the
[providers guide](./providers.md) explains them.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/capabilities`

| Export | Kind | Summary |
| --- | --- | --- |
| `negotiateCompletionRequest` | function | Reconciles a completion request against the target model's declared capabilities. |
| `NegotiateOptions` | interface | Options for capability negotiation. |
| `NegotiationResult` | interface | A request after negotiation, with what was changed. |
| `NexusCapabilityError` | class | Thrown under the `strict` capability policy when a request asks for something the target model does not declare support for. |

### `nexus-ai-pro/config`

| Export | Kind | Summary |
| --- | --- | --- |
| `createNexusConfig` | function | Starts a fluent `NexusAIConfig` builder. |
| `defineNexusConfig` | function | Identity helper for users who prefer object literals but want type inference and validation in editors. |
| `NexusConfigBuilder` | class | Fluent, typed builder for `NexusAIConfig`. |

### `nexus-ai-pro/context`

| Export | Kind | Summary |
| --- | --- | --- |
| `ContextSummarizer` | type | Writes a summary of the messages cut from a conversation. |
| `ContextSummaryConfig` | interface | How cut messages are summarized. |
| `ContextSummaryInput` | interface | What a custom summarizer receives. |
| `ContextSummaryMode` | type | Who writes the summary of cut messages: a local extractive summary, the model through the client, or your own function. |
| `ContextWindowConfig` | interface | Keeps long conversations within a model's context window. |
| `ContextWindowManager` | class | Fits a conversation into a context window by keeping recent messages and trimming or summarizing earlier ones. |
| `ContextWindowResult` | interface | A trimmed value with what trimming did to it. |
| `ContextWindowRuntime` | interface | What context-window optimization can call on. |
| `ContextWindowStrategy` | type | How a long conversation is cut to fit: keep the last messages or the last tokens, optionally with a summary of what was cut, or `auto` to choose from the limits configured and whether summaries are on. |
| `ContextWindowUsage` | interface | What trimming did to a request. |

### `nexus-ai-pro/core`

| Export | Kind | Summary |
| --- | --- | --- |
| `NexusAI` | class | Main runtime facade for provider routing, security, optimization, evals, voice, jobs, and observability. |

### `nexus-ai-pro/optimizer`

| Export | Kind | Summary |
| --- | --- | --- |
| `BudgetEnforcer` | class | Checks requests against an input token budget and applies its over-budget strategy. |
| `PromptDensifier` | class | Rewrites prompts to use fewer tokens without changing what they say. |
| `TokenBudgetError` | class | Raised when a request exceeds its input token budget and `onExceeded` is `error`, the default. |
| `TokenOptimizer` | class | Applies densification and the token budget to a request, reporting what each did. |

### `nexus-ai-pro/streaming`

| Export | Kind | Summary |
| --- | --- | --- |
| `collectStream` | function | Reads a stream to the end and returns its text. |
| `createTextStream` | function | A stream that yields one text chunk and finishes, for tests and cached answers. |
| `mapStream` | function | Transforms each chunk of a stream. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `AliasMetadata` | interface | Where an alias stands and what it points to. |
| `AliasStage` | type | Publication stage of a model alias. |
| `AnthropicProviderConfig` | interface | Configuration for Anthropic, or an Anthropic-compatible endpoint through `baseUrl`. |
| `assertWithinCostBudget` | function | Throws `CostBudgetError` when an estimate exceeds the budget. |
| `AudioContent` | interface | An audio part of a message, for audio-capable models, or a transcript standing in for the audio. |
| `AuditLogConfig` | interface | What gets written to the audit log. |
| `AzureOpenAIProviderConfig` | interface | Configuration for Azure OpenAI deployment-scoped chat completions. |
| `BinaryBuffer` | type | Node's `Buffer` when Node's type definitions are loaded, and `Uint8Array` otherwise, so the message types compile in a browser project as well as on a server. |
| `BudgetConfig` | interface | A limit on how many input tokens a request may use. |
| `BudgetExceededAction` | type | What happens when a request exceeds its token budget: fail, truncate, densify, or send it anyway. |
| `buildMeta` | function | Builds a complete `ResponseMeta` from provider token counts. |
| `BuildMetaOptions` | interface | Options for `buildMeta()`: the provider's token counts plus the call's context. |
| `buildUsage` | function | Normalizes provider token counts into the portable `TokenUsage` shape. |
| `CacheHint` | type | Marks a message or tool definition as the end of a cacheable prefix. |
| `CacheTtl` | type | Lifetime of a provider-side prompt cache entry. |
| `CapabilityConfig` | interface | How capability negotiation behaves. |
| `CapabilityPolicy` | type | How the runtime reacts when a request asks for something the target model does not declare. |
| `CapabilityWarning` | interface | A request option that was dropped or adjusted because the model does not support it as written. |
| `CapabilityWarningAction` | type | What happened to a requested option that the model could not honor as written. |
| `CohereProviderConfig` | interface | Configuration for Cohere. |
| `CompletionRequest` | interface | A completion request: the model, the conversation, and every control over how it is answered. |
| `ContentPart` | type | One part of a multimodal message. |
| `costAmount` | function | Numeric cost for metrics and budgets, without parsing the formatted display string. |
| `CostBudgetConfig` | interface | Refuses or flags a request whose estimated cost exceeds a limit, before it is sent. |
| `CostBudgetError` | class | Raised when a request's estimated cost exceeds its budget. |
| `CostEstimate` | interface | What a request is estimated to cost, before it is sent. |
| `CostEstimateInput` | interface | Input for `estimateCost()`. |
| `createNexus` | function | Creates a `NexusAI` instance from either the full production config or a small beginner shorthand. |
| `CreateNexusOptions` | interface | Options for `createNexus()`: the full configuration, or a one-provider shorthand whose credentials fall back to the provider's usual environment variables. |
| `CreateNexusProvider` | type | Providers the `createNexus()` shorthand can configure by name. |
| `createNexusRouteHandler` | function | Creates a Next.js `POST` route handler that completes the posted request, or streams it as server-sent events when streaming is on. |
| `createPipelineContext` | function | A fresh pipeline context for a request. |
| `CustomProviderConfig` | interface | Configuration for user-owned OpenAI- or Anthropic-compatible endpoints. |
| `DeepSeekProviderConfig` | interface | Configuration for the DeepSeek OpenAI-compatible provider. |
| `DEFAULT_CACHE_PRICING` | constant | Fallback cache pricing as a multiple of the standard input rate, applied when a model does not declare `costPer1kCachedInput` or `costPer1kCacheWrite`. |
| `DEFAULT_CURRENCY` | constant | Currency and cost-budget enforcement, with no dependency on the model registry. |
| `DensificationConfig` | interface | Rewriting prompts to use fewer tokens without changing what they say. |
| `ensureUsageAndCost` | function | Guarantees `usage` and `cost` on a response built by a custom provider that predates them. |
| `estimateCost` | function | Prices a request from the model registry, with cached reads and writes on their own lines. |
| `FallbackConfig` | interface | Models tried when the route the router chose fails, applied to every request, including one that names its model. |
| `formatCost` | function | Formats an amount the way `ResponseMeta.estimatedCost` has always presented it. |
| `GoogleProviderConfig` | interface | Configuration for Google's Gemini API. |
| `GroqProviderConfig` | interface | Configuration for Groq. |
| `ImageContent` | interface | An image part of a message, for vision-capable models. |
| `KNOWN_MODELS` | constant | The bundled model registry: capabilities and prices for every model the package knows by name. |
| `LlamaCppProviderConfig` | interface | Configuration for a local llama.cpp OpenAI-compatible server. |
| `LMStudioProviderConfig` | interface | Configuration for a local LM Studio OpenAI-compatible server. |
| `LogEvent` | interface | One structured log event. |
| `LoggerConfig` | interface | Structured logger hook config. |
| `LogLevel` | type | Severity of a log event. |
| `Message` | interface | One message in a conversation. |
| `MessageRole` | type | Who a message is from: instructions, the user, the model, or a tool result. |
| `MistralProviderConfig` | interface | Configuration for Mistral. |
| `Modality` | type | What a model accepts as input: text, images, audio, video, generated images, or PDF documents. |
| `MODEL_ALIAS_METADATA` | constant | Stage and provenance for every bundled alias, derived from its target so the two cannot drift. |
| `ModelCapabilities` | interface | Declared model behavior. |
| `ModelEndpoint` | type | Which provider API a model is served through. |
| `ModelStatus` | type | Where a model is in its provider's lifecycle. |
| `NexusAIConfig` | interface | Everything a `NexusAI` client needs. |
| `NexusPlan` | interface | What `ai.plan()` says a request would do, without sending it: the route, the tokens, the cost, and whether guardrails would block it. |
| `NexusResponse` | interface | A completion. |
| `NexusStream` | interface | A streamed completion: iterate it for chunks, or abort it. |
| `normalizeCreateNexusConfig` | function | Converts the beginner shorthand accepted by `createNexus()` into a normal `NexusAIConfig`. |
| `OllamaProviderConfig` | interface | Configuration for a local Ollama server. |
| `OpenAIProviderConfig` | interface | Configuration for OpenAI, and for any OpenAI-compatible server — vLLM, a gateway, a proxy — through `baseUrl`. |
| `OptimizationResult` | interface | An optimized value with what optimization did to it. |
| `PipelineConfig` | interface | Hooks and tracing around every request. |
| `PipelineContext` | interface | The request as it moves through the pipeline, handed to every hook. |
| `PipelineHookName` | type | Points in a request's pipeline where application hooks run: before input processing, after security, around the provider call, and before the response returns. |
| `PipelineHooksConfig` | type | Hooks by point; several hooks at one point run in order. |
| `PipelineMiddleware` | type | A hook: inspects the context, and may return a new context, a replacement request, a replacement response, or nothing to leave it unchanged. |
| `PipelineRunner` | class | Runs the request pipeline's hooks and custom steps, and times each stage into the request's trace. |
| `PipelineStep` | interface | A custom stage appended to the pipeline. |
| `PipelineStepName` | type | A pipeline stage, as it appears in a trace: a hook point, one of the built-in stages, or a custom step's name. |
| `PipelineTrace` | interface | Every stage a request went through, with timings. |
| `PipelineTraceStep` | interface | One timed stage of a request. |
| `priceUsage` | function | Prices a normalized usage record, keeping each token class on its own line. |
| `PriceUsageOptions` | interface | Options for `priceUsage()`. |
| `PromptCacheConfig` | interface | Provider-side prompt caching. |
| `PromptCachingCapability` | interface | How a model supports prompt caching. |
| `ProviderCapabilities` | interface | A provider and the models it serves. |
| `ProvidersConfig` | interface | Provider configs that Nexus can register from the constructor. |
| `RateLimitConfig` | interface | Limits how many requests are allowed per window. |
| `ReasoningConfig` | interface | Requested reasoning behavior. |
| `ReasoningEffort` | type | Portable reasoning effort, from none to the most the model offers. |
| `REGISTRY_PROVENANCE` | constant | Default provenance for bundled registry entries that do not carry their own `verifiedAt`. |
| `resolveProvider` | function | The provider a model name belongs to, from its prefix, or `null` when the name gives no clue. |
| `ResponseCost` | interface | Numeric cost of one operation. |
| `ResponseFormatConfig` | interface | A response format applied to every request that does not set its own. |
| `ResponseFormatError` | class | Raised when a response does not match the requested format and cannot be repaired. |
| `ResponseMeta` | interface | How a completion was produced: provider, model, timing, tokens, cost, and every policy that touched it. |
| `RetryConfig` | interface | How a failed provider call is retried before failover moves on. |
| `RoutingConfig` | interface | How requests with `model: 'auto'` are routed. |
| `RoutingModelPreference` | type | A model the router should prefer, optionally weighted above others. |
| `RoutingRule` | interface | A routing rule: when a request matches, route it to a model. |
| `RoutingStrategy` | type | What the auto-router optimizes for: price, latency, quality, or keeping data on local models. |
| `StreamChunk` | interface | One streamed event. |
| `TextContent` | interface | A text part of a message. |
| `Tokenizer` | class | Estimates token counts without a model-specific tokenizer, for budgets, planning, and context windows. |
| `TokenOptimizerConfig` | interface | Token optimization applied before a request is sent. |
| `TokenUsage` | interface | Token accounting for one operation. |
| `TokenUsageSnapshot` | interface | Token counts before and after optimization. |
| `ToolCall` | interface | A tool call the model made. |
| `ToolCallResult` | interface | What a tool returned, correlated with the call that asked for it. |
| `ToolChoice` | type | How the model may use tools. |
| `ToolDefinition` | interface | A tool the model may call. |
| `UsageInput` | interface | Token counts as a provider reported them, for `buildUsage()`. |
| `VideoContent` | interface | A video part of a message. |
<!-- reference:end -->
