# Nexus AI Testing and Problem Guide

Package: `nexus-ai-pro`

NPM: https://www.npmjs.com/package/nexus-ai-pro

GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai

## What Problem This Package Solves

Building production AI apps usually requires wiring many unrelated packages together:

- provider SDKs (`openai`, `@anthropic-ai/sdk`, `ollama`)
- routing and fallback logic
- streaming normalization
- input validation
- prompt-injection checks
- PII masking/redaction
- token counting and budget enforcement
- tool calling and agent loops

Without `nexus-ai-pro`, every app repeats this plumbing and usually ships with inconsistent defaults. The common problems are:

- **Provider lock-in** — code is tied to one SDK and response shape.
- **Weak security defaults** — user input often goes directly to the model.
- **PII leakage** — emails, keys, cards, and private keys can be sent to cloud LLMs.
- **Prompt injection** — malicious user text can override intended behavior.
- **Token waste** — verbose prompts increase cost and latency.
- **No routing strategy** — apps cannot easily choose local vs cloud, cheap vs quality.
- **Tool execution risk** — tools are often executed without a structured loop or caps.

`nexus-ai-pro` solves these with one composable TypeScript API.

## Requested Platform Feature Checklist

The original requested platform features are implemented. Newer advanced items are tracked separately in the "Current Advanced Feature Status" section.

| Feature | Status |
| --- | --- |
| Pipeline middleware/hooks: `beforeInput`, `afterSecurity`, `beforeProvider`, `afterProvider`, `beforeReturn` | Done |
| Custom pipeline steps | Done |
| Per-step tracing and timing | Done |
| OpenTelemetry metrics sink | Done |
| Prometheus metrics export | Done |
| Streaming failover and streaming retries | Done |
| Semantic cache | Done |
| Redis cache adapter | Done |
| SQLite cache adapter | Done |
| Provider health checks | Done |
| Automatic fallback using live latency/error health | Done |
| Built-in eval/test runner for prompts | Done |
| Optional quality/RAG/safety eval metrics | Done |
| Reusable guardrail policy packs | Done |
| File/document ingestion for RAG | Done |
| Workflow chain: summarize -> verify -> format -> return | Done |
| Batch processing API | Done |
| Queue support for long-running jobs | Done |
| Web/search/tool connectors | Done |
| Typed pipeline result objects showing steps applied | Done |
| Provider conformance fixtures for OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Groq, Mistral, and Cohere | Done |
| Full OpenTelemetry traces/spans adapter | Done |
| Durable queue adapters such as Redis/BullMQ | Done |
| File upload scanning for documents/images before multimodal calls | Done |
| Real embedding provider helpers for OpenAI/Gemini/Cohere embeddings | Done |
| Semantic prompt-injection classifier | Done |
| More workflow templates for common AI app patterns | Done |
| CI integration for conformance tests with real and mocked providers | Done |
| Native OpenTelemetry SDK example files for common Node runtimes | Done |
| BullMQ worker example files | Done |
| OCR/PDF parsing integrations after upload scanning | Done |
| Persisted vector store examples | Done |
| Classifier calibration datasets | Done |
| Domain workflow templates for support, sales, legal review, and code review | Done |
| Groq provider adapter | Done |
| Mistral provider adapter | Done |
| Cohere provider adapter | Done |
| Latest official model aliases for OpenAI, Anthropic, Google, Groq, Mistral, and Cohere | Done |

## Implemented Capabilities

### Core Runtime

- `NexusAI.complete()` for non-streaming completions
- `NexusAI.stream()` for streaming completions
- `NexusAI.agent()` for tool-using agents
- Unified message and response types
- ESM TypeScript package

### Providers

Implemented provider adapters:

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenRouter
- Groq
- Mistral
- Cohere

Provider SDKs are optional peer dependencies. Install only what you use.

### Built-In Model Registry

The bundled registry is a convenience layer for routing, cost estimates, and capability filtering. It is verified from official provider docs as of **2026-05-02**, but production apps should still override `models.registry` for exact pricing, regional availability, or private deployments.

Current high-level aliases:

| Alias | Resolves to |
| --- | --- |
| `openai/best` | `gpt-5.5` |
| `openai/fast` | `gpt-5.4-mini` |
| `openai/cheap` | `gpt-5.4-nano` |
| `anthropic/best` | `claude-opus-4-7` |
| `anthropic/balanced` | `claude-sonnet-4-6` |
| `anthropic/fast` | `claude-haiku-4-5-20251001` |
| `google/best` | `gemini-3.1-pro-preview` |
| `google/fast` | `gemini-3-flash-preview` |
| `groq/best` | `groq/openai/gpt-oss-120b` |
| `groq/fast` | `groq/openai/gpt-oss-20b` |
| `mistral/best` | `mistral/mistral-medium-3-5` |
| `mistral/coding` | `mistral/devstral-2` |
| `cohere/best` | `cohere/command-a-03-2025` |
| `cohere/reasoning` | `cohere/command-a-reasoning-08-2025` |

Important provider notes:

- Anthropic's current documented Claude lineup is Opus 4.7, Sonnet 4.6, and Haiku 4.5.
- The registry also includes Opus 4.6 (`claude-opus-4-6`) and Opus 4.5 (`claude-opus-4-5-20251101`) because Anthropic docs reference them in Claude Code/Bedrock and batch contexts. Verify account/platform availability before using those in production.
- Google's current Gemini 3 docs list Gemini 3.1 Pro Preview and Gemini 3.1 Flash-Lite Preview; Gemini 3 Pro Preview is documented as deprecated/shut down.
- Groq and Mistral are exposed through OpenAI-compatible adapters.
- Cohere is exposed through a native `/v2/chat` adapter. It supports non-streaming completions; `stream()` currently emits the completed response as a single text chunk.

## User Use Cases and APIs

Use this table as the fastest way to decide which part of the package to use.

| User goal | Main API | Notes |
| --- | --- | --- |
| One normal answer | `ai.complete(...)` | Unified response shape across providers. |
| Streaming answer | `ai.stream(...)` | Normalized `text`, `tool_call`, `done`, and `error` chunks. |
| Pick best available model | `model: 'auto'` plus `routing` | Works with quality, speed, cost, and privacy strategies. |
| Force a specific provider/model | `model: 'gpt-5.5'`, `claude-opus-4.7`, `groq/fast` | Aliases resolve through the model registry. |
| Avoid hallucinations | `withRagContext(...)`, `completeVerified(...)` | Add retrieved facts and verify generated claims. |
| Require citations | `withRagContext(..., { requireCitations: true })` | Use with retrieved chunks that have source IDs. |
| Use a knowledge graph | `withKnowledgeGraphContext(...)` | Adds structured relationship facts. |
| Generate strict JSON | `responseFormat: { type: 'json_schema', schema }` | Provider JSON mode is used when available, then output is validated. |
| Add tools | `tool(...)`, `ai.agent(...)` | Supports tool execution loops and max iteration caps. |
| Connect to web/search | `createFetchUrlTool(...)`, `createSearchTool(...)` | Bring your own search function or safe fetch policy. |
| Protect inputs | `security: 'standard'` or `guardrailPolicy(...)` | Prompt injection, secrets, PII, URLs, schema, and tools. |
| Protect outputs | `security.output` | Redacts secrets/PII in model output. |
| Reduce prompt size | `TokenOptimizer`, `tokenOptimizer` config | Densify, truncate, warn, or block by budget. |
| Estimate cost before calling | `ai.plan(...)` | Shows route, cost estimate, context fit, and warnings. |
| Cache repeat prompts | `cache.strategy: 'exact'` | Uses memory or optional adapter. |
| Cache similar prompts | `cache.strategy: 'semantic'` or `'hybrid'` | Uses semantic cache with configurable similarity. |
| Add custom business logic | `pipeline.hooks`, `ai.use(...)` | Hooks run around security and provider calls. |
| Inspect what happened | `response.meta.pipeline.steps` | Per-step trace and timing. |
| Export metrics | `ai.getPrometheusMetrics()` | Optional OpenTelemetry sink is also supported. |
| Check provider health | `ai.checkProviders()` | Health can influence future routing. |
| Run many requests | `ai.batchComplete(...)` | Concurrency-limited batch API. |
| Queue long jobs | `ai.createQueue(...)` | In-memory queue plus Redis/BullMQ adapter wrappers. |
| Ingest documents for RAG | `ingestText(...)`, `ingestDocuments(...)` | Chunk documents before embedding/search. |
| Scan uploaded files | `scanUploads(...)`, `ingestFilesAfterScan(...)` | Safe pre-scan plus OCR/PDF extractor hooks. |
| Evaluate prompts | `ai.runEvals(...)`, `calculateEvalMetrics(...)` | Quality, operational, RAG, and safety metrics. |
| Validate providers | `runProviderConformance(...)` | Mocked and real provider test paths. |
| Use app workflows | `supportTriageWorkflow(...)`, `salesQualificationWorkflow(...)`, `legalReviewWorkflow(...)`, `codeReviewWorkflow(...)` | Ready patterns for common AI products. |

### Complete App Configuration Example

```ts
import {
  NexusAI,
  RedisCacheAdapter,
  guardrailPolicy,
} from 'nexus-ai-pro';

const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    google: { apiKey: process.env.GOOGLE_API_KEY! },
    groq: { apiKey: process.env.GROQ_API_KEY! },
    mistral: { apiKey: process.env.MISTRAL_API_KEY! },
    cohere: { apiKey: process.env.COHERE_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  routing: {
    mode: 'hybrid',
    strategy: 'quality',
    candidateModels: ['openai/best', 'anthropic/best', 'google/best', 'groq/fast'],
    fallback: { onError: ['anthropic/balanced', 'openai/fast'] },
  },
  security: guardrailPolicy('owasp-llm'),
  tokenOptimizer: {
    densification: { enabled: true },
    budget: { enabled: true, maxInputTokens: 12000, onExceeded: 'densify' },
  },
  cache: {
    enabled: true,
    strategy: 'hybrid',
    ttlSeconds: 600,
    semantic: { enabled: true, similarityThreshold: 0.86 },
    // adapter: new RedisCacheAdapter(redisClient),
  },
  health: { enabled: true },
  metrics: { enabled: true },
  pipeline: { includeTraceInResponse: true },
});
```

### Common Request Shapes

```ts
await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Summarize this customer conversation.' }],
  metadata: { tenant: 'acme', taskType: 'support' },
});
```

```ts
await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Return {"risk": "low|medium|high"} for this contract.' }],
  temperature: 0,
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      required: ['risk'],
      properties: { risk: { type: 'string', enum: ['low', 'medium', 'high'] } },
    },
  },
});
```

```ts
for await (const chunk of ai.stream({
  model: 'auto',
  messages: [{ role: 'user', content: 'Draft a short welcome email.' }],
})) {
  if (chunk.type === 'text') process.stdout.write(chunk.content);
}
```

### Flexible Routing

Supported routing modes:

- `auto`
- `rules`
- `direct`
- `hybrid`

Auto routing supports strategies:

- `quality`
- `cost`
- `speed`
- `privacy`

Flexible candidate model override:

```ts
const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  routing: {
    mode: 'auto',
    strategy: 'privacy',
    candidateModels: ['ollama/llama3.2', 'gpt-4o-mini'],
  },
});
```

Additional routing controls now include:

- model allow/deny patterns
- required model capabilities
- weighted model preferences
- health-aware provider scoring

### Pipeline and Observability

Implemented:

- explicit pipeline hooks: `beforeInput`, `afterSecurity`, `beforeProvider`, `afterProvider`, `beforeReturn`
- custom pipeline steps with `ai.use()`
- typed per-step tracing and timing
- metrics snapshots
- Prometheus-format metrics export
- OpenTelemetry metrics sink
- provider health tracking
- explicit provider health checks
- health-aware auto routing

### Runtime Reliability

Implemented:

- provider timeout support
- retry support for timeout, rate limit, server error, and network failures
- streaming failover/retry before chunks are emitted
- cost planning with `ai.plan()`
- estimated-cost budget enforcement

### Caching

Implemented:

- exact in-memory cache
- semantic cache
- hybrid exact/semantic strategy
- Redis cache adapter wrapper
- SQLite cache adapter wrapper
- cache stats and cleanup helpers

### Security Protection

Implemented security layers:

- Zod request schema validation
- prompt-injection pattern detection
- optional prompt-injection neutralization
- max input length checks
- PII detection
- PII masking
- secret/token detection before provider calls
- suspicious URL detection
- tool allowlist enforcement
- output PII/secret redaction
- output max length limiting

Security levels:

- `off`
- `basic`
- `standard`
- `strict`
- `paranoid`

Recommended production baseline:

```ts
security: {
  preset: 'enterprise',
  input: {
    maxContentLength: 4000,
    injectionDetection: { enabled: true, onDetection: 'block' },
    pii: {
      enabled: true,
      action: 'mask',
      detect: ['email', 'phone', 'credit-card', 'aws-key', 'private-key'],
      preserveFormat: true,
    },
    secrets: { enabled: true, action: 'block' },
    urls: { enabled: true, action: 'block' },
    tools: { allowedNames: ['get_current_time'] },
  },
  output: {
    piiRedaction: true,
    maxContentLength: 8000,
  },
}
```

### Token Optimization

Implemented:

- lightweight token estimation
- prompt densification
- whitespace cleanup
- phrase compression
- list compaction
- token budget enforcement
- budget actions: `error`, `truncate`, `densify`, `allow`

### Agents and Tools

Implemented:

- `tool()` helper
- `ToolExecutor`
- `AgentLoop`
- iteration cap
- tool call parsing
- tool result injection back into conversation
- `onStep` and `onToolCall` callbacks

### RAG, Evals, Workflows, and Jobs

Implemented:

- RAG context helpers
- vector search
- document ingestion/chunking for RAG
- citation extraction and validation
- Chain of Verification
- self-consistency helper
- reusable guardrail policy packs
- built-in eval runner
- optional eval metrics: exact match, F1, semantic similarity, pass@k, perplexity, TPS, TTFT, faithfulness, contextual precision/recall, answer relevancy, hallucination rate, toxicity/bias heuristics, policy adherence, refusal rate
- summarize -> verify -> format workflow chain
- batch completion API
- in-memory queue for long-running jobs
- web/search connector tools
- provider conformance fixtures
- OpenTelemetry trace/span exporter
- Redis and BullMQ durable queue wrappers
- upload scanner for documents/images
- OpenAI, Gemini, and Cohere embedding provider helpers
- semantic prompt-injection classifier
- extra workflow templates: RAG answer, structured extraction, classification, compare-and-decide
- CI conformance workflow and test scripts
- native OpenTelemetry SDK examples
- BullMQ worker example
- OCR/PDF extraction hooks after upload scanning
- persisted vector store example
- classifier calibration dataset and evaluator
- domain workflows for support, sales, legal review, and code review