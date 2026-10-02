# The client: requests, context, cost, and streaming

<!-- covers: . ./core ./config ./streaming ./capabilities ./context ./optimizer ./optimizer/cost ./pipeline ./next -->
<!-- sources: src/core src/types src/pipeline src/optimizer src/next src/utils -->

`NexusAI` is the client every other part plugs into. It gives you one request shape across providers,
and handles what sits around each call: long conversations, token budgets, cost checks, reasoning and
prompt-caching controls, options a model cannot honour, and streaming.

Import it from the root. In 2.0 the root holds the client and nothing else: its config builders, its
types, the errors it throws, and the lifecycle every call runs through. Every family is on a subpath
of its own.

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

The shorthand takes `CreateNexusOptions`: a `CreateNexusProvider` name, its key, a base URL, the
Azure endpoint and deployment, and a default model. `normalizeCreateNexusConfig()` turns those into a
full `NexusAIConfig`, so you can see what the shorthand produced. `NexusConfigBuilder` is the
builder's type. `defineNexusConfig()` does nothing at run time; it types a plain object, so a
configuration kept in its own file is checked where it is written.

### The configuration

`NexusAIConfig` is the whole surface. Each part is explained in the guide for its feature, and the
reference below links every name to its summary.

| Part | Type | Guide |
| --- | --- | --- |
| Providers | `ProvidersConfig` | [Providers](./providers.md) |
| Routing | `RoutingConfig` | [Providers](./providers.md) |
| Retries | `RetryConfig` | [Resilience](./resilience.md) |
| Response cache | `CacheConfig` | [Caching](./caching.md) |
| Guardrails | `SecurityConfig` | [Security](./security.md) |
| Rate limits | `RateLimitConfig` | [Resilience](./resilience.md) |
| Token and cost budgets | `BudgetConfig`, `CostBudgetConfig` | this guide |
| Capability checks | `CapabilityConfig` | this guide |
| Token optimization | `TokenOptimizerConfig` | this guide |
| Structured output | `ResponseFormatConfig` | this guide |
| Logging and audit | `LoggerConfig`, `AuditLogConfig` | below, and [Security](./security.md) |
| Pipeline hooks | `PipelineConfig` | this guide |
| Authorization, a shared budget, and hooks for every call | `LifecycleConfig` | [Lifecycle](./lifecycle.md) |

`ProvidersConfig` has one typed entry per provider: `OpenAIProviderConfig`, `AnthropicProviderConfig`,
`GoogleProviderConfig`, `AzureOpenAIProviderConfig`, `OllamaProviderConfig`, `GroqProviderConfig`,
`MistralProviderConfig`, `CohereProviderConfig`, `DeepSeekProviderConfig`, `LMStudioProviderConfig`,
`LlamaCppProviderConfig`, and `CustomProviderConfig` for your own.

`RoutingConfig` has four parts:

- a `RoutingStrategy` for the auto-router: `cost`, `speed`, `quality`, or `privacy`;
- an ordered list of `RoutingRule` values, each sending matching requests to a model;
- the models each strategy prefers, as `RoutingModelPreference` entries (a name, or a name with a
  weight);
- a `FallbackConfig`, which adds failover models, a first-attempt timeout, and rate-limit handling to
  every route — even a request that names its model.

`LoggerConfig` receives each `LogEvent`: a `LogLevel` (`info`, `warn`, or `error`), a message, a
timestamp, structured data, and the error when there is one. Send them to your own sink, the console,
or both.

`AuditLogConfig` sends each `AuditLogEvent` to your sink. Every operation, in every family, writes a
`request` event when it is admitted. It then writes a `response`, a `blocked` when a check refused
it, or an `error`. Each event carries the operation's family, its name, and its request id.

## A request and its response

`CompletionRequest` is the request every provider takes. It needs a `model` and `messages`; the rest
is what a provider may honour:

| Settings | Fields |
| --- | --- |
| Sampling | `temperature`, `topP`, `topK`, penalties, `seed`, `stop` |
| Length and time | `maxTokens`, `timeoutMs`, `signal` |
| Tools | `tools`, and a `ToolChoice` |
| Output | `responseFormat`, `reasoning`, `cache` |
| Identity | `requestId`, `userId`, `tenantId`, `idempotencyKey` |
| Application data | `metadata` |

The identity fields follow the call everywhere. `requestId` is on the audit log, the provider call,
and `response.meta.requestId`; one is generated when you set none. `tenantId` decides which budget
the call is charged to. `idempotencyKey` goes to providers that deduplicate retried requests.

Each tool is a `ToolDefinition`: a name, a description written for the model, and a JSON Schema for
its arguments. It can also carry an `execute` function, for loops that run tools themselves, and a
cache breakpoint.

A `Message` has a `MessageRole`, and either text or a list of `ContentPart` values:

| Part | What it carries |
| --- | --- |
| `TextContent` | Text. |
| `ImageContent` | An image from a path, a URL, bytes, base64 text, or an asset. |
| `AudioContent`, `VideoContent` | Audio or video, or a transcript standing in for the audio. |
| `AssetContent` | An asset by reference: an image or file named by where it lives, never its bytes. |

`AssetContent` is how a tool's image reaches the model without base64 text. Every adapter writes it
as one short reference line, which the model can pass back to another tool. Use an image part when
the model should see the image itself. A tool returns either kind as a `ToolOutput`, built with
`toolOutput()`; the [agents guide](./agents.md) shows it. `BinaryBuffer` stands in for Node's `Buffer`,
so the types also compile for a browser.

`NexusResponse` comes back with:

- the text, the `ToolCall` values the model made, and a `finishReason`;
- `assets`, when a model whose output includes images returned some, as bytes;
- `ResponseMeta`: which provider and model answered, the latency, `TokenUsage`, `ResponseCost`,
  whether it was a cache hit, the guardrails applied, and the `PipelineTrace` when tracing is on.

After running a tool, you send back a `ToolCallResult`. `NexusStream` and `StreamChunk` are the
streaming equivalents.

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

The schema can be written two ways, and neither validator is installed with the package:

| Schema | What checks it | What to install |
| --- | --- | --- |
| A zod shape, such as `{ total: z.number() }` | Each field's own `safeParse` | Nothing beyond the zod you wrote it with |
| A JSON Schema object | ajv, loaded on the first check | `npm install ajv ajv-formats` |

A JSON Schema without ajv installed fails with a `ResponseFormatError` that says what to install.

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

`ContextWindowConfig` is the whole setting:

| Option | Default | What it sets |
| --- | --- | --- |
| `strategy` | — | A `ContextWindowStrategy`, from the list above. |
| `lastMessages` | 20 | Conversation messages kept. |
| `maxInputTokens` | — | The token ceiling. |
| summary reserve | — | Tokens held back for the summary. |
| keep system messages | on | System messages always survive. |
| `summary` | — | A `ContextSummaryConfig`, below. |

`ContextSummaryConfig` decides how cut messages are summarized. Its `ContextSummaryMode` is one of:

- `local`: an extractive summary, with no model call;
- `provider`: a model writes it, through the client. If that fails, it falls back to `local` unless
  `fallbackToLocal` is `false`;
- `custom`: your own `ContextSummarizer`, which receives a `ContextSummaryInput` — the request, the
  messages to fold, those messages as one text, the token limit, the model, and the instructions.

It also sets the summary's length (512 tokens), model, temperature, instructions, heading, and whether
it goes in as a system or a user message.

`ContextWindowManager` does the work, and you can use it on its own. `optimize()` trims a request,
calling the summarizer from a `ContextWindowRuntime` when given one. `preview()` reports what trimming
would do, without calling anything.

Both return a `ContextWindowResult`: the trimmed request, the techniques applied, and warnings (such as
a summary that fell back to local). Its `ContextWindowUsage` shows the strategy `auto` chose, tokens
and messages before and after, and how many messages were kept, summarized, or dropped.

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

The `NexusPlan` it returns answers the questions you would ask before paying for a call:

| Question | Field |
| --- | --- |
| Which provider and model would answer? | The model asked for, the one chosen, and the full routing decision with fallbacks. |
| Will it fit? | The model's context window, and whether the request fits it. |
| What would trimming do? | The context-window and token-optimization results. |
| What will it cost? | The estimated cost. |
| Could the cache answer it? | Whether the response cache has it. |
| Would guardrails block it? | What the input checks found, and which guardrails would apply. |

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
`xhigh` to `max`. It maps to OpenAI `reasoning_effort` and the Responses `reasoning` field, Claude
thinking, and Gemini `thinkingConfig`. Use `reasoning.maxTokens` when you want to set a thinking
budget directly instead of by level, and `summary` (`none`, `auto`, or `detailed`) to stream
reasoning summaries.

Claude takes reasoning two ways, and the Anthropic adapter picks by model:

| Claude models | What is sent | `effort: 'none'` |
| --- | --- | --- |
| 4.6 onward | Adaptive thinking and `output_config.effort`. A `maxTokens` becomes the smallest effort whose budget covers it. | Turns thinking off. Sonnet 5.5 can only skip up-front thinking. Opus 5.5 and Fable always think, so they get effort `low`. |
| Before 4.6 | A thinking budget, from `maxTokens` or the effort. | Sends no thinking. |

Thinking counts toward the output limit. When you set no `maxTokens`, the adapter leaves room for
the thinking the effort asks for. Your own `maxTokens` is always kept as the hard cap. The newest
Claude models hide thinking text unless asked, so a `summary` also asks them to show it.

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

`meta.tokensInput` keeps its original meaning of every prompt token, cached or not. Bundled prices
are defaults, not financial truth; override them with `models.registry`, or adjust cache rates with
`models.cachePricing`.

The client prices each response on the model it routed the request to, as the registry names it.
Providers often answer with another name, such as a dated snapshot of the model, which the registry
does not file. Pricing on that echo would cost the call nothing. A charge the provider reports
itself, with `basis: 'reported'`, is kept as it is.

## Counting and pricing tokens

`Tokenizer` estimates tokens without a provider — `estimateTextTokens()`, `estimateMessageTokens()`,
and `estimateRequestTokens()` — which is what budgets, planning, and context-window trimming run on.

Pricing is separate and explicit:

| Function | What it does |
| --- | --- |
| `estimateCost()` | Prices a `CostEstimateInput` against the model registry, returning a `CostEstimate`. |
| `priceUsage()` | Prices a `TokenUsage` a provider actually reported, with `PriceUsageOptions`. |
| `buildUsage()`, `buildMeta()` | Turn raw provider counts into `TokenUsage` and `ResponseMeta`, from `UsageInput` and `BuildMetaOptions`. For adapter authors. |
| `ensureUsageAndCost()` | Fills both in on a response from an older custom provider. |
| `costAmount()`, `formatCost()` | Read the number out, and render it. |
| `assertWithinCostBudget()` | Throws `CostBudgetError` when an estimate exceeds what you allow, so a request is stopped before it is sent, not after it is billed. |

`DEFAULT_CURRENCY` and `DEFAULT_CACHE_PRICING` are the defaults behind them.

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

Some models take only part of an option. Claude 4.7 and later accept only the default temperature
and top-p (`sampling: false`), so a `temperature` sent to them is dropped. Opus 5.5, Sonnet 5.5, and
Fable 5.1 cannot be forced to call a tool (`toolChoice: false`). For them, `required` or a named tool
is dropped, while `auto` and `none` still pass.

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
import { describeModel, assertRegistryFreshness } from 'nexus-ai-pro/models';

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

A stream is an operation like a completion. It opens when you first read it: authorization, the rate
limit, guardrails, routing, and the budget run then. So an error from any of them comes out of the
`for await` loop, not out of the `stream()` call. The `done` chunk carries the request id and the
cost of the usage the provider reported. The operation finishes with the stream; one you stop reading
early finishes as cancelled.

When security is enabled, output streams are correctness-first: Nexus buffers and validates the
complete output before yielding any chunk, up to 1 MiB or 100,000 chunks. This prevents secrets,
PII, and blocked phrases split across provider chunks from leaking partially, at the cost of
token-by-token latency. `security: 'off'` preserves immediate streaming when that trade-off is
explicitly acceptable for the application.

Three helpers work on any `NexusStream`. `collectStream()` reads one to the end and returns its text,
`mapStream()` transforms each chunk as it passes, and `createTextStream()` makes a stream that yields
one text chunk and finishes, for tests and for answering from a cache in the streaming shape.

## The request pipeline

Every request runs through the same stages: security, context window, optimization, routing, the
provider call, output checks, and caching. `PipelineConfig` is where you step into them.

| Piece | Use it to |
| --- | --- |
| `PipelineHooksConfig` | Run your function at a stage, named by a `PipelineHookName`. |
| `PipelineMiddleware`, `PipelineStep` | Add a stage of your own. |
| `PipelineRunner`, `createPipelineContext()` | Run the whole pipeline yourself, as the client does. From `nexus-ai-pro/pipeline`. |

Every hook receives the `PipelineContext`:

- the request, as earlier stages rewrote it, and the response once there is one;
- the routing decision, and what trimming and optimization did;
- the security findings and guardrails so far;
- the timings, and a `metadata` object hooks can share.

A hook may return a new context, a replacement request, a replacement response, or nothing.

`PipelineContext` is generic over the request and the response, and both default to a completion's.
That lets you run the same hooks over another family's types. Give `PipelineRunner` a
`PipelineShapes` that says how to tell your request and response apart from a returned context.

Each stage is timed into a `PipelineTrace` of `PipelineTraceStep` values. `PipelineStepName` names
the stage, and the list is closed, so a `switch` over it can be exhaustive. It holds the hook points,
the built-in stages, and the lifecycle's `authorize`, `reserveBudget`, `reconcileCost`, and `audit`.
A step you add with `use()` is recorded as `customStep`, with its own name in the step's `custom`
field. The trace is returned on `response.meta.pipeline` unless `includeTraceInResponse` is off.

The pipeline is a completion's own stages. The [lifecycle](./lifecycle.md) around it is shared by
every family: authorization, the budget, audit, metrics, and hooks that see every call.

## Serving a request from a framework

`createNexusRouteHandler()`, from `nexus-ai-pro/next`, returns a Next.js route handler. It completes the
posted request, or streams it as server-sent events when `NexusRouteHandlerOptions.stream` is on:

```ts
// app/api/chat/route.ts
import { createNexusRouteHandler } from 'nexus-ai-pro/next';
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

## The registry's types, in passing

The root keeps the types a model entry is made of, which the [providers guide](./providers.md)
explains: `ModelCapabilities`, `InputModality`, `OutputModality`, `ModelEndpoint`, `ModelStatus`,
`AliasMetadata`, `AliasStage`, `ProviderCapabilities`, `PromptCachingCapability`, `CacheTtl`, and
`CacheHint`. The registry data and its lookups are on `nexus-ai-pro/models`.

## The root import

The root import is the core client and nothing else:

| On the root | Examples |
| --- | --- |
| The client and its config builders | `NexusAI`, `createNexus`, `createNexusConfig` |
| Request helpers | `tool()`, `toolOutput()`, the streaming helpers, the usage and pricing helpers |
| The lifecycle | `OperationLifecycle`, its errors, and its types |
| Types of configuration, requests, and responses | `NexusAIConfig`, `CompletionRequest`, `NexusResponse` |
| Errors the client throws | `NexusProviderError`, `NexusSecurityError`, `CostBudgetError` |

Importing it costs about 323 KB, against 572 KB when the root re-exported most of the package.
Provider adapters load on their first call, and so do the features that answer asynchronously: agents,
evals, verification, the semantic cache, and the image and embedding engines.

Code written for 1.x imported families from the root. The command line moves those imports to their
subpaths:

```bash
npx nexus migrate src --write
```

The [migration guide](../MIGRATING.md) lists every change 2.0 makes, with before-and-after code.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/capabilities`

| Export | Kind | Summary |
| --- | --- | --- |
| `CapabilityConfig` | interface | How capability negotiation behaves. |
| `CapabilityPolicy` | type | How the runtime reacts when a request asks for something the target model does not declare. |
| `CapabilityWarning` | interface | A request option that was dropped or adjusted because the model does not support it as written. |
| `CapabilityWarningAction` | type | What happened to a requested option that the model could not honor as written. |
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

### `nexus-ai-pro/next`

| Export | Kind | Summary |
| --- | --- | --- |
| `createNexusRouteHandler` | function | Creates a Next.js `POST` route handler that completes the posted request, or streams it as server-sent events when streaming is on. |
| `NexusRouteHandlerOptions` | interface | Options for `createNexusRouteHandler()`. |

### `nexus-ai-pro/optimizer`

| Export | Kind | Summary |
| --- | --- | --- |
| `BudgetEnforcer` | class | Checks requests against an input token budget and applies its over-budget strategy. |
| `PromptDensifier` | class | Rewrites prompts to use fewer tokens without changing what they say. |
| `TokenBudgetError` | class | Raised when a request exceeds its input token budget and `onExceeded` is `error`, the default. |
| `Tokenizer` | class | Estimates token counts without a model-specific tokenizer, for budgets, planning, and context windows. |
| `TokenOptimizer` | class | Applies densification and the token budget to a request, reporting what each did. |

### `nexus-ai-pro/optimizer/cost`

| Export | Kind | Summary |
| --- | --- | --- |
| `assertWithinCostBudget` | function | Throws `CostBudgetError` when an estimate exceeds the budget. |
| `CostBudgetError` | class | Raised when a request's estimated cost exceeds its budget. |
| `CostEstimateInput` | interface | Input for `estimateCost()`. |
| `DEFAULT_CURRENCY` | constant | Currency and cost-budget enforcement, with no dependency on the model registry. |
| `estimateCost` | function | Prices a request from the model registry, with cached reads and writes on their own lines. |
| `formatCost` | function | Formats an amount the way `ResponseMeta.estimatedCost` has always presented it. |

### `nexus-ai-pro/pipeline`

| Export | Kind | Summary |
| --- | --- | --- |
| `createPipelineContext` | function | A fresh pipeline context for a request. |
| `PipelineConfig` | interface | Hooks and tracing around every request. |
| `PipelineContext` | interface | The request as it moves through the pipeline, handed to every hook. |
| `PipelineHookName` | type | Points in a request's pipeline where application hooks run: before input processing, after security, around the provider call, and before the response returns. |
| `PipelineHooksConfig` | type | Hooks by point; several hooks at one point run in order. |
| `PipelineMiddleware` | type | A hook: inspects the context, and may return a new context, a replacement request, a replacement response, or nothing to leave it unchanged. |
| `PipelineRunner` | class | Runs the request pipeline's hooks and custom steps, and times each stage into the request's trace. |
| `PipelineShapes` | interface | How a runner tells what a hook returned, for a family other than completions: a replacement request, a replacement response, or anything else, which is taken as a new context. |
| `PipelineStep` | interface | A custom stage appended to the pipeline. |
| `PipelineStepName` | type | A pipeline stage, as it appears in a trace: a hook point, a built-in stage, a lifecycle stage, or `customStep` for a step added with `use()`, whose own name is in `PipelineTraceStep.custom`. |
| `PipelineTrace` | interface | Every stage a request went through, with timings. |
| `PipelineTraceStep` | interface | One timed stage of a request. |

### `nexus-ai-pro/streaming`

| Export | Kind | Summary |
| --- | --- | --- |
| `collectStream` | function | Reads a stream to the end and returns its text. |
| `createTextStream` | function | A stream that yields one text chunk and finishes, for tests and cached answers. |
| `mapStream` | function | Transforms each chunk of a stream. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnthropicProviderConfig` | interface | Configuration for Anthropic, or an Anthropic-compatible endpoint through `baseUrl`. |
| `AssetContent` | interface | An asset passed by reference: an image or file a tool made or stored, named in the conversation by where it lives rather than carried as base64 text. |
| `AudioContent` | interface | An audio part of a message, for audio-capable models, or a transcript standing in for the audio. |
| `AuditLogConfig` | interface | What gets written to the audit log. |
| `AuditLogEvent` | interface | One audit record. |
| `AzureOpenAIProviderConfig` | interface | Configuration for Azure OpenAI deployment-scoped chat completions. |
| `BinaryBuffer` | type | Node's `Buffer` when Node's type definitions are loaded, and `Uint8Array` otherwise, so the message types compile in a browser project as well as on a server. |
| `BudgetConfig` | interface | A limit on how many input tokens a request may use. |
| `BudgetExceededAction` | type | What happens when a request exceeds its token budget: fail, truncate, densify, or send it anyway. |
| `buildMeta` | function | Builds a complete `ResponseMeta` from provider token counts. |
| `BuildMetaOptions` | interface | Options for `buildMeta()`: the provider's token counts plus the call's context. |
| `buildUsage` | function | Normalizes provider token counts into the portable `TokenUsage` shape. |
| `CacheHint` | type | Marks a message or tool definition as the end of a cacheable prefix. |
| `CohereProviderConfig` | interface | Configuration for Cohere. |
| `CompletionRequest` | interface | A completion request: the model, the conversation, and every control over how it is answered. |
| `ContentPart` | type | One part of a multimodal message. |
| `costAmount` | function | Numeric cost for metrics and budgets: the priced amount, or 0 when nothing priced the call. |
| `CostBudgetConfig` | interface | Refuses or flags a request whose estimated cost exceeds a limit, before it is sent. |
| `CostEstimate` | interface | What a request is estimated to cost, before it is sent. |
| `createNexus` | function | Creates a `NexusAI` instance from either the full production config or a small beginner shorthand. |
| `CreateNexusOptions` | interface | Options for `createNexus()`: the full configuration, or a one-provider shorthand whose credentials fall back to the provider's usual environment variables. |
| `CreateNexusProvider` | type | Providers the `createNexus()` shorthand can configure by name. |
| `CustomProviderConfig` | interface | Configuration for user-owned OpenAI- or Anthropic-compatible endpoints. |
| `DeepSeekProviderConfig` | interface | Configuration for the DeepSeek OpenAI-compatible provider. |
| `DensificationConfig` | interface | Rewriting prompts to use fewer tokens without changing what they say. |
| `ensureUsageAndCost` | function | Guarantees `usage` and `cost` on a response built by a custom provider that predates them. |
| `FallbackConfig` | interface | Models tried when the route the router chose fails, applied to every request, including one that names its model. |
| `GoogleProviderConfig` | interface | Configuration for Google's Gemini API. |
| `GroqProviderConfig` | interface | Configuration for Groq. |
| `ImageContent` | interface | An image part of a message, for vision-capable models. |
| `LlamaCppProviderConfig` | interface | Configuration for a local llama.cpp OpenAI-compatible server. |
| `LMStudioProviderConfig` | interface | Configuration for a local LM Studio OpenAI-compatible server. |
| `LogEvent` | interface | One structured log event. |
| `LoggerConfig` | interface | Structured logger hook config. |
| `LogLevel` | type | Severity of a log event. |
| `Message` | interface | One message in a conversation. |
| `MessageRole` | type | Who a message is from: instructions, the user, the model, or a tool result. |
| `MistralProviderConfig` | interface | Configuration for Mistral. |
| `NexusAIConfig` | interface | Everything a `NexusAI` client needs. |
| `NexusPlan` | interface | What `ai.plan()` says a request would do, without sending it: the route, the tokens, the cost, and whether guardrails would block it. |
| `NexusResponse` | interface | A completion. |
| `NexusStream` | interface | A streamed completion: iterate it for chunks, or abort it. |
| `normalizeCreateNexusConfig` | function | Converts the beginner shorthand accepted by `createNexus()` into a normal `NexusAIConfig`. |
| `OllamaProviderConfig` | interface | Configuration for a local Ollama server. |
| `OpenAIProviderConfig` | interface | Configuration for OpenAI, and for any OpenAI-compatible server — vLLM, a gateway, a proxy — through `baseUrl`. |
| `OptimizationResult` | interface | An optimized value with what optimization did to it. |
| `priceUsage` | function | Prices a normalized usage record, keeping each token class on its own line. |
| `PriceUsageOptions` | interface | Options for `priceUsage()`. |
| `PromptCacheConfig` | interface | Provider-side prompt caching. |
| `ProvidersConfig` | interface | Provider configs that Nexus can register from the constructor. |
| `RateLimitConfig` | interface | Limits how many requests are allowed per window. |
| `ReasoningConfig` | interface | Requested reasoning behavior. |
| `ResponseCost` | interface | Numeric cost of one operation. |
| `ResponseFormatConfig` | interface | A response format applied to every request that does not set its own. |
| `ResponseFormatError` | class | Raised when a response does not match the requested format and cannot be repaired. |
| `ResponseMeta` | interface | How a completion was produced: provider, model, timing, tokens, cost, and every policy that touched it. |
| `RetryConfig` | interface | How a failed provider call is retried before failover moves on. |
| `RoutingConfig` | interface | How requests with `model: 'auto'` are routed. |
| `RoutingRule` | interface | A routing rule: when a request matches, route it to a model. |
| `RoutingStrategy` | type | What the auto-router optimizes for: price, latency, quality, or keeping data on local models. |
| `StreamChunk` | interface | One streamed event. |
| `TextContent` | interface | A text part of a message. |
| `TokenOptimizerConfig` | interface | Token optimization applied before a request is sent. |
| `TokenUsage` | interface | Token accounting for one operation. |
| `TokenUsageSnapshot` | interface | Token counts before and after optimization. |
| `ToolCall` | interface | A tool call the model made. |
| `ToolCallResult` | interface | What a tool returned, correlated with the call that asked for it. |
| `ToolChoice` | type | How the model may use tools. |
| `ToolDefinition` | interface | A tool the model may call. |
| `ToolOutput` | interface | What a tool returns when its result is content rather than a value to serialize: text, images, and asset references, in order. |
| `UsageInput` | interface | Token counts as a provider reported them, for `buildUsage()`. |
| `VideoContent` | interface | A video part of a message. |
<!-- reference:end -->
