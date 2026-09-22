# The client: requests, context, cost, and streaming

<!-- covers: . ./core ./config ./streaming ./capabilities ./context ./optimizer -->

`NexusAI` is the client every other part plugs into: one request shape across providers, with context-window management, token optimization, cost checks, reasoning and prompt-caching controls, capability negotiation, and streaming. Import it from the root, or from `nexus-ai-pro/core` and `nexus-ai-pro/config` when you want the client without the rest of the root's re-exports.

```ts
import { createNexus } from 'nexus-ai-pro';

const ai = createNexus({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5.4-mini' });
const response = await ai.complete({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
```

## Context Windows

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

## Token Optimizer

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

Budget actions:

- `error` - throw `TokenBudgetError`
- `truncate` - remove or slice older prompt content
- `densify` - compact prompt text before checking budget
- `allow` - warn but send as-is

## Planning and Cost Checks

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

## Reasoning

```ts
const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Find the bug in this migration plan.' }],
  reasoning: { effort: 'high', summary: 'auto' },
});

console.log(response.meta.usage?.reasoningTokens);
```

`effort` is the portable control. It maps to OpenAI `reasoning_effort` and the Responses `reasoning`
field, Anthropic extended thinking, and Gemini `thinkingConfig`. Use `reasoning.maxTokens` when you
want to set a thinking budget directly instead of by level.

Requesting a summary emits `reasoning` stream chunks, which stay separate from visible output:

```ts
for await (const chunk of ai.stream({ model: 'auto', messages, reasoning: { summary: 'auto' } })) {
  if (chunk.type === 'reasoning') process.stderr.write(chunk.content ?? '');
  if (chunk.type === 'text') process.stdout.write(chunk.content ?? '');
}
```

## Prompt Caching

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

## Usage and Cost

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

## Capability Negotiation

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

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgentModelClient` | interface | The part of a client the agent loop needs. |
| `AliasMetadata` | interface | Where an alias stands and what it points to. |
| `AliasStage` | type | Publication stage of a model alias. |
| `AnthropicProviderConfig` | interface | Configuration for Anthropic, or an Anthropic-compatible endpoint through `baseUrl`. |
| `asJsonOnly` | function | Adds a system message asking for JSON only, with low sampling defaults. |
| `assertWithinCostBudget` | function | Throws `CostBudgetError` when an estimate exceeds the budget. |
| `AudioContent` | interface | An audio part of a message, for audio-capable models, or a transcript standing in for the audio. |
| `AuditLogConfig` | interface | What gets written to the audit log. |
| `AuditLogger` | class | Writes audit events to the configured sink, redacting sensitive data unless told otherwise. |
| `AzureOpenAIProviderConfig` | interface | Configuration for Azure OpenAI deployment-scoped chat completions. |
| `BinaryBuffer` | type | Node's `Buffer` when Node's type definitions are loaded, and `Uint8Array` otherwise, so the message types compile in a browser project as well as on a server. |
| `BudgetConfig` | interface | A limit on how many input tokens a request may use. |
| `BudgetExceededAction` | type | What happens when a request exceeds its token budget: fail, truncate, densify, or send it anyway. |
| `buildMeta` | function | Builds a complete `ResponseMeta` from provider token counts. |
| `BuildMetaOptions` | interface | Options for `buildMeta()`: the provider's token counts plus the call's context. |
| `buildUsage` | function | Normalizes provider token counts into the portable `TokenUsage` shape. |
| `CacheHint` | type | Marks a message or tool definition as the end of a cacheable prefix. |
| `CacheTtl` | type | Lifetime of a provider-side prompt cache entry. |
| `calibrateSemanticInjectionClassifier` | function | Scores the semantic injection classifier at several thresholds, so you can pick one for your own traffic. |
| `CapabilityConfig` | interface | How capability negotiation behaves. |
| `CapabilityPolicy` | type | How the runtime reacts when a request asks for something the target model does not declare. |
| `CapabilityWarning` | interface | A request option that was dropped or adjusted because the model does not support it as written. |
| `CapabilityWarningAction` | type | What happened to a requested option that the model could not honor as written. |
| `codeReviewWorkflow` | function | Reviews code for bugs, security risks, performance issues, and missing tests, as JSON findings ordered by severity. |
| `CodeReviewWorkflowOptions` | interface | Options for `codeReviewWorkflow()`. |
| `CohereProviderConfig` | interface | Configuration for Cohere. |
| `completeVerified` | function | Completes a request, checks each claim in the answer against the context, and asks for one revision when claims are unsupported. |
| `completeWithSelfConsistency` | function | Samples several answers and returns the one they agree with most. |
| `CompletionRequest` | interface | A completion request: the model, the conversation, and every control over how it is answered. |
| `ConsistencyClient` | interface | The part of a client that self-consistency needs. |
| `ContentPart` | type | One part of a multimodal message. |
| `cosineSimilarity` | function | Cosine similarity of two unit-length vectors, as their dot product. |
| `costAmount` | function | Numeric cost for metrics and budgets, without parsing the formatted display string. |
| `CostBudgetConfig` | interface | Refuses or flags a request whose estimated cost exceeds a limit, before it is sent. |
| `CostBudgetError` | class | Raised when a request's estimated cost exceeds its budget. |
| `CostEstimate` | interface | What a request is estimated to cost, before it is sent. |
| `CostEstimateInput` | interface | Input for `estimateCost()`. |
| `createFetchUrlTool` | function | A `fetch_url` tool that reads text from public URLs allowed by the policy, refusing private addresses. |
| `createHashEmbeddings` | function | Hashed term-count vectors, normalized to unit length. |
| `createNexus` | function | Creates a `NexusAI` instance from either the full production config or a small beginner shorthand. |
| `CreateNexusOptions` | interface | Options for `createNexus()`: the full configuration, or a one-provider shorthand whose credentials fall back to the provider's usual environment variables. |
| `CreateNexusProvider` | type | Providers the `createNexus()` shorthand can configure by name. |
| `createNexusRouteHandler` | function | Creates a Next.js `POST` route handler that completes the posted request, or streams it as server-sent events when streaming is on. |
| `createOcrExtractor` | function | An extractor for images, around your own OCR function. |
| `createPdfExtractor` | function | An extractor for PDF files, around your own PDF-to-text function. |
| `createPipelineContext` | function | A fresh pipeline context for a request. |
| `createSearchTool` | function | A search tool around your own search function. |
| `CustomProviderConfig` | interface | Configuration for user-owned OpenAI- or Anthropic-compatible endpoints. |
| `DeepSeekProviderConfig` | interface | Configuration for the DeepSeek OpenAI-compatible provider. |
| `DEFAULT_CACHE_PRICING` | constant | Fallback cache pricing as a multiple of the standard input rate, applied when a model does not declare `costPer1kCachedInput` or `costPer1kCacheWrite`. |
| `DEFAULT_CURRENCY` | constant | Currency and cost-budget enforcement, with no dependency on the model registry. |
| `DensificationConfig` | interface | Rewriting prompts to use fewer tokens without changing what they say. |
| `DomainWorkflowOptions` | interface | What every domain workflow takes. |
| `EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES` | constant | The default embeddings conformance cases: a single input, a batch, and a query-typed input. |
| `EmbeddingProvider` | type | Turns texts into vectors, one per text, in order. |
| `EmbeddingProviderConformanceCase` | interface | One embeddings conformance case. |
| `EmbeddingProviderConformanceOptions` | interface | Options for `runEmbeddingProviderConformance()`. |
| `EmbeddingProviderConformanceResult` | interface | The outcome of one embeddings conformance case. |
| `ensureUsageAndCost` | function | Guarantees `usage` and `cost` on a response built by a custom provider that predates them. |
| `estimateCost` | function | Prices a request from the model registry, with cached reads and writes on their own lines. |
| `extractCitations` | function | Every distinct bracketed citation in a text. |
| `extractFacts` | function | Splits an answer into sentence-level claims, dropping "I don't know" style answers. |
| `FactualOptions` | interface | Options for `withFactualDefaults()`. |
| `FailoverExecutor` | class | Runs a routing decision: the primary provider, then each fallback, honouring per-attempt timeouts, rate limits, and circuits. |
| `FallbackConfig` | interface | Models tried when the route the router chose fails, applied to every request, including one that names its model. |
| `FamilyCallDescriptor` | interface | What one family call is, for metrics labels, the audit log, and the rate limit. |
| `FamilyRuntime` | interface | Shared observability wiring handed to an operation family. |
| `FamilyTelemetry` | class | Wraps one family call in the platform's rate limit, audit log, and metrics. |
| `FileIngestionOptions` | interface | Options for `ingestFilesAfterScan()`. |
| `FileIngestionResult` | interface | The chunks produced from a set of files, and the files that could not be read. |
| `FileTextExtractor` | interface | Turns one kind of file into text, such as PDF or an image through OCR. |
| `FileUpload` | interface | A file offered for upload. |
| `formatCost` | function | Formats an amount the way `ResponseMeta.estimatedCost` has always presented it. |
| `GoogleProviderConfig` | interface | Configuration for Google's Gemini API. |
| `GroqProviderConfig` | interface | Configuration for Groq. |
| `GUARDRAIL_POLICIES` | constant | The bundled guardrail presets, as security configurations. |
| `guardrailPolicy` | function | A bundled guardrail preset, with your overrides merged over it. |
| `GuardrailPolicyName` | type | Names of the bundled guardrail presets. |
| `hardenPrompt` | function | Wraps user content in delimiters and adds a system instruction to treat it as data, not instructions. |
| `HealthConfig` | interface | Health tracking for providers, used to route around unhealthy ones. |
| `IMAGE_PROVIDER_CONFORMANCE_FIXTURES` | constant | The default image conformance cases: one generation, one edit, and one masked edit. |
| `ImageContent` | interface | An image part of a message, for vision-capable models. |
| `ImageEditProviderConformanceCase` | interface | A conformance case that edits an image. |
| `ImageGenerateProviderConformanceCase` | interface | A conformance case that generates an image. |
| `ImageProviderConformanceCase` | type | One image conformance case: a generation or an edit. |
| `ImageProviderConformanceOptions` | interface | Options for `runImageProviderConformance()`. |
| `ImageProviderConformanceResult` | interface | The outcome of one image conformance case. |
| `ingestFilesAfterScan` | function | Scans uploads, extracts their text, and splits it into chunks. |
| `InjectionCalibrationExample` | interface | One labelled prompt for calibrating the injection classifier. |
| `InjectionCalibrationResult` | interface | How the classifier performed at one threshold. |
| `InjectionDetectionConfig` | interface | Prompt-injection detection on input. |
| `InMemoryMetrics` | class | Keeps metrics in memory, for a snapshot or a Prometheus scrape. |
| `KnowledgeGraph` | interface | Entities and the relationships between them. |
| `KnowledgeGraphEdge` | interface | A relationship between two entities. |
| `KnowledgeGraphNode` | interface | An entity in a knowledge graph. |
| `KnowledgeGraphOptions` | interface | Options for `withKnowledgeGraphContext()`. |
| `KNOWN_MODELS` | constant | The bundled model registry: capabilities and prices for every model the package knows by name. |
| `legalReviewWorkflow` | function | Flags legal risks, missing clauses, and questions to ask, as JSON, with an explicit fallback when the text is not enough. |
| `LegalReviewWorkflowOptions` | interface | Options for `legalReviewWorkflow()`. |
| `lexicalEntailment` | function | Whether a context supports a claim by term overlap: at least 72% of its significant terms, or the claim appearing verbatim. |
| `LlamaCppProviderConfig` | interface | Configuration for a local llama.cpp OpenAI-compatible server. |
| `LMStudioProviderConfig` | interface | Configuration for a local LM Studio OpenAI-compatible server. |
| `LogEvent` | interface | One structured log event. |
| `LoggerConfig` | interface | Structured logger hook config. |
| `LogLevel` | type | Severity of a log event. |
| `MemoryVectorStore` | class | Chunks and their vectors in process memory, searched by cosine similarity. |
| `Message` | interface | One message in a conversation. |
| `MessageRole` | type | Who a message is from: instructions, the user, the model, or a tool result. |
| `MetricsCollector` | class | Records request, response, error, and pipeline-step metrics for a client, when metrics are enabled. |
| `MetricsConfig` | interface | Metrics collection for a client. |
| `MetricsSink` | interface | Where metrics go: counters, histograms, and gauges, labelled. |
| `MistralProviderConfig` | interface | Configuration for Mistral. |
| `Modality` | type | What a model accepts as input: text, images, audio, video, generated images, or PDF documents. |
| `MODEL_ALIAS_METADATA` | constant | Stage and provenance for every bundled alias, derived from its target so the two cannot drift. |
| `ModelCapabilities` | interface | Declared model behavior. |
| `ModelEndpoint` | type | Which provider API a model is served through. |
| `ModelStatus` | type | Where a model is in its provider's lifecycle. |
| `NexusAIConfig` | interface | Everything a `NexusAI` client needs. |
| `NexusPlan` | interface | What `ai.plan()` says a request would do, without sending it: the route, the tokens, the cost, and whether guardrails would block it. |
| `NexusRateLimitError` | class | Raised when a caller exceeds its rate limit. |
| `NexusResponse` | interface | A completion. |
| `NexusStream` | interface | A streamed completion: iterate it for chunks, or abort it. |
| `NliVerifier` | interface | A natural-language-inference model that judges whether a context entails a claim. |
| `normalizeCreateNexusConfig` | function | Converts the beginner shorthand accepted by `createNexus()` into a normal `NexusAIConfig`. |
| `OllamaProviderConfig` | interface | Configuration for a local Ollama server. |
| `OpenAIProviderConfig` | interface | Configuration for OpenAI, and for any OpenAI-compatible server — vLLM, a gateway, a proxy — through `baseUrl`. |
| `OpenTelemetryLikeMeter` | interface | The part of an OpenTelemetry meter the metrics sink uses. |
| `OpenTelemetryLikeSpan` | interface | The part of an OpenTelemetry span the exporter uses. |
| `OpenTelemetryLikeTracer` | interface | The part of an OpenTelemetry tracer the exporter uses. |
| `OpenTelemetryMetricsSink` | class | Sends metrics to OpenTelemetry through a meter. |
| `OpenTelemetryTraceExporter` | class | Exports pipeline traces as OpenTelemetry spans: one for the pipeline and one per step. |
| `OptimizationResult` | interface | An optimized value with what optimization did to it. |
| `PIIConfig` | interface | Detection of personal data in input. |
| `PIIType` | type | Kinds of personal data and secrets the PII detector recognizes. |
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
| `PROVIDER_CONFORMANCE_FIXTURES` | constant | Default conformance cases for each bundled chat provider, keyed by provider name. |
| `ProviderCapabilities` | interface | A provider and the models it serves. |
| `ProviderConformanceCase` | interface | One chat-provider conformance case: a request and a check on its response. |
| `ProviderConformanceOptions` | interface | Options for `runProviderConformance()`. |
| `ProviderConformanceResult` | interface | The outcome of one chat-provider conformance case. |
| `ProviderHealthMonitor` | class | Tracks provider health from call outcomes and scores each provider for routing. |
| `ProviderHealthSnapshot` | interface | One provider's health, as tracked from real calls. |
| `ProvidersConfig` | interface | Provider configs that Nexus can register from the constructor. |
| `RagChunk` | interface | A passage of retrieved context. |
| `RagOptions` | interface | Options for `withRagContext()`. |
| `RateLimitConfig` | interface | Limits how many requests are allowed per window. |
| `RateLimitedRequest` | interface | The parts of a request the limiter buckets on. |
| `RateLimiter` | class | Fixed-window rate limiting, per user, per model, or globally, in memory or through a shared store. |
| `ReasoningConfig` | interface | Requested reasoning behavior. |
| `ReasoningEffort` | type | Portable reasoning effort, from none to the most the model offers. |
| `REGISTRY_PROVENANCE` | constant | Default provenance for bundled registry entries that do not carry their own `verifiedAt`. |
| `resolveProvider` | function | The provider a model name belongs to, from its prefix, or `null` when the name gives no clue. |
| `ResponseCost` | interface | Numeric cost of one operation. |
| `ResponseFormatConfig` | interface | A response format applied to every request that does not set its own. |
| `ResponseFormatError` | class | Raised when a response does not match the requested format and cannot be repaired. |
| `ResponseMeta` | interface | How a completion was produced: provider, model, timing, tokens, cost, and every policy that touched it. |
| `RetryConfig` | interface | How a failed provider call is retried before failover moves on. |
| `RouteDecision` | interface | Where a request goes: the provider and model to try first, and what to try if they fail. |
| `Router` | class | Chooses where a request goes: a direct model, a matching rule, or the auto-router's ranking, with the fallbacks `routing.fallback` adds on top. |
| `RouterContext` | interface | What a routing strategy sees when it picks a provider. |
| `RoutingConfig` | interface | How requests with `model: 'auto'` are routed. |
| `RoutingModelPreference` | type | A model the router should prefer, optionally weighted above others. |
| `RoutingRule` | interface | A routing rule: when a request matches, route it to a model. |
| `RoutingStrategy` | type | What the auto-router optimizes for: price, latency, quality, or keeping data on local models. |
| `runEmbeddingProviderConformance` | function | Checks an embeddings adapter against the neutral contract. |
| `runImageProviderConformance` | function | Checks an image adapter against the neutral contract: the results it returns, the operations it declares, and optionally how it handles an aborted signal. |
| `runProviderConformance` | function | Checks a chat provider against the neutral contract: completion, and optionally streaming, health, JSON output, and tool calls. |
| `salesQualificationWorkflow` | function | Qualifies a sales lead into a fit score, pain points, a recommended offer, and a follow-up email, as JSON. |
| `SalesWorkflowOptions` | interface | Options for `salesQualificationWorkflow()`. |
| `scanUploads` | function | Scans a set of files with a one-off scanner. |
| `SecurityAction` | type | What a guardrail does with a match: let it through, block the request, mask the match, or record it. |
| `SecurityConfig` | interface | Guardrails for input and output, from a preset, a level, or detailed settings. |
| `SecurityFinding` | interface | One thing a guardrail found. |
| `SecurityLevel` | type | How much protection a client applies, from none to maximal. |
| `SecurityResult` | interface | The outcome of running guardrails on a value. |
| `selectGraphFacts` | function | Ranks a graph's relationships by how many terms they share with the query and states the best as fact lines. |
| `selectMostConsistent` | function | The response whose text is most similar to the others'. |
| `SelfConsistencyOptions` | interface | Options for `completeWithSelfConsistency()`. |
| `SEMANTIC_INJECTION_CALIBRATION_SET` | constant | A small built-in calibration set: five attacks and five safe prompts that look like them. |
| `StreamChunk` | interface | One streamed event. |
| `supportTriageWorkflow` | function | Triages a support request into severity, category, next action, and a customer-safe reply, as JSON. |
| `SupportWorkflowOptions` | interface | Options for `supportTriageWorkflow()`. |
| `TextContent` | interface | A text part of a message. |
| `textSimilarity` | function | Jaccard similarity of two texts' terms, from 0 to 1. |
| `Tokenizer` | class | Estimates token counts without a model-specific tokenizer, for budgets, planning, and context windows. |
| `TokenOptimizerConfig` | interface | Token optimization applied before a request is sent. |
| `TokenUsage` | interface | Token accounting for one operation. |
| `TokenUsageSnapshot` | interface | Token counts before and after optimization. |
| `ToolCall` | interface | A tool call the model made. |
| `ToolCallResult` | interface | What a tool returned, correlated with the call that asked for it. |
| `ToolChoice` | type | How the model may use tools. |
| `ToolDefinition` | interface | A tool the model may call. |
| `UploadScanFinding` | interface | One problem found in an upload. |
| `UploadScanner` | class | Checks uploads for size, extension, MIME type, and forbidden content before they reach a model or a store. |
| `UploadScannerOptions` | interface | Options for scanning uploads. |
| `UploadScanResult` | interface | The outcome of scanning uploads. |
| `UsageInput` | interface | Token counts as a provider reported them, for `buildUsage()`. |
| `validateCitations` | function | Checks that every bracketed citation in a response names a known chunk. |
| `VectorDocument` | interface | A chunk to store, with its vector when already computed. |
| `VectorSearchOptions` | interface | Options for a vector search. |
| `VectorSearchResult` | interface | A stored chunk returned by a search. |
| `VerificationClient` | interface | The part of a client that verified completion needs. |
| `VerificationFact` | interface | One claim from an answer and whether the context supports it. |
| `VerificationOptions` | interface | Options for checking an answer against its context. |
| `VerificationReport` | interface | How well an answer is supported by its context. |
| `verifyAgainstContext` | function | Checks every claim in an answer against the context. |
| `VideoContent` | interface | A video part of a message. |
| `WebConnectorOptions` | interface | Options for the fetch-URL tool, including its SSRF policy. |
| `withFactualDefaults` | function | Adds a system message that asks for factual, conservative answers, with low sampling defaults. |
| `withKnowledgeGraphContext` | function | Adds the graph facts most relevant to the request as a system message, telling the model not to infer relationships the graph lacks. |
| `withRagContext` | function | Adds retrieved passages as a system message, telling the model to answer only from them and cite them. |

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
<!-- reference:end -->
