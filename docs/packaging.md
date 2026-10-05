# Packaging and install weight

<!-- covers:  -->

Every capability has its own entry point, and CI holds each one to a size budget. So an application
pays only for what it imports. This guide lists the entry points and what each one costs.

## Import Surface

The root import holds the core client and nothing else: the client, its config builders, its types,
the errors it throws, and the lifecycle every call runs through. Code written for 1.x imported
families from the root too; `nexus migrate` moves those imports to their subpaths, and the
[migration guide](../MIGRATING.md) has the details.

```ts
import { NexusAI, createNexus, createNexusConfig } from 'nexus-ai-pro';
```

Every family is on a subpath of its own:

```ts
import { NexusAI } from 'nexus-ai-pro/core';
import { createNexusConfig } from 'nexus-ai-pro/config';
import { budgetLedger } from 'nexus-ai-pro/lifecycle';
import { TokenOptimizer } from 'nexus-ai-pro/optimizer';
import { estimateCost } from 'nexus-ai-pro/optimizer/cost';
import { Router } from 'nexus-ai-pro/router';
import { PipelineRunner } from 'nexus-ai-pro/pipeline';
import { MetricsCollector, ProviderHealthMonitor } from 'nexus-ai-pro/ops';
import { withRagContext, completeVerified } from 'nexus-ai-pro/grounding';
import { ingestFilesAfterScan } from 'nexus-ai-pro/rag/files';
import { createFetchUrlTool } from 'nexus-ai-pro/connectors';
import { runProviderConformance } from 'nexus-ai-pro/testing';
import { createNexusRouteHandler } from 'nexus-ai-pro/next';
import { ContextWindowManager } from 'nexus-ai-pro/context';
import { negotiateCompletionRequest } from 'nexus-ai-pro/capabilities';
import { guardrailPolicy } from 'nexus-ai-pro/security';
import { RedisCacheAdapter } from 'nexus-ai-pro/cache';
import { DeepSeekProvider } from 'nexus-ai-pro/providers/deepseek';
import { OperationRunner } from 'nexus-ai-pro/operations';
import { RedisOperationStore } from 'nexus-ai-pro/operations/adapters';
import { verifyOperationWebhook } from 'nexus-ai-pro/operations/webhooks';
import { EmbeddingManager } from 'nexus-ai-pro/embeddings';
import { OpenAIEmbeddingProvider } from 'nexus-ai-pro/embeddings/adapters';
import { MockEmbeddingProvider } from 'nexus-ai-pro/embeddings/mock';
import { KNOWN_EMBEDDING_MODELS } from 'nexus-ai-pro/embeddings/models';
import { ImageManager } from 'nexus-ai-pro/images';
import { MemoryAssetStore } from 'nexus-ai-pro/images/assets';
import { MockImageProvider } from 'nexus-ai-pro/images/mock';
import { OpenAIImageProvider } from 'nexus-ai-pro/images/openai';
import { GoogleImageProvider } from 'nexus-ai-pro/images/google';
import { ComfyUIImageProvider } from 'nexus-ai-pro/images/comfyui';
import { PngMaskTransformer } from 'nexus-ai-pro/images/transform';
import { createImageInputResolver } from 'nexus-ai-pro/images/inputs';
import { createOpenAIVisualModeration } from 'nexus-ai-pro/images/moderation';
import { MediaEvalRunner } from 'nexus-ai-pro/images/evals';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { OpenAIWebRTCTransport } from 'nexus-ai-pro/realtime/openai-webrtc';
import { TelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
import { createTelephonyRealtimeBridge } from 'nexus-ai-pro/telephony/realtime-bridge';
```

| Fact | Detail |
| --- | --- |
| Required dependencies | None. |
| Provider SDKs | Optional peer dependencies. |
| Validators | `zod`, `ajv`, and `ajv-formats` are optional peers: a zod shape brings its own zod, and only a JSON Schema response format needs ajv. |
| Node's types | `@types/node` is an optional peer. A Node project installs it, as it would for any other code; the client, graphs, and the lifecycle compile without it. |
| Module formats | ESM and CommonJS builds. |
| Node.js | 22 or newer. |
| Tree shaking | Marked `sideEffects: false`. |
| Public surface | Only the entry points in the package's export map. Deep imports into `dist`, `dist-cjs`, or `src` are unsupported. |

### What each import actually costs

Importing one piece loads one piece. The table below measures each entry point's whole import graph.
`npm run size:check` generates it from the build, and fails CI when an entry point grows past its
budget. So the numbers stay true.

The last column is what a size table usually hides: what an entry point forces you to install.

No entry point forces one. The root, `/graph`, `/server`, `/images/*`, and the rest import no
third-party package, and the validators load only when a JSON Schema has to be checked.

A production install is about 5.3 MB of `node_modules`, and all of it is this package. Until 2.0 it
was 12.3 MB, because `zod`, `ajv`, and `@types/node` came with it. The clean-install test holds the
total to a ceiling, and checks that none of the optional peers is installed.

The package itself is most of what remains: an ESM and a CommonJS build, each with its type
declarations, which carry every doc comment to your editor.

<!-- size-table:start -->
| Import | Size | Share of root | Third-party install |
| --- | --- | --- | --- |
| `nexus-ai-pro` | 334 KB | 100% | none |
| `nexus-ai-pro/config` | 327 KB | 98% | none |
| `nexus-ai-pro/core` | 323 KB | 97% | none |
| `nexus-ai-pro/realtime` | 158 KB | 47% | none |
| `nexus-ai-pro/server` | 115 KB | 34% | none |
| `nexus-ai-pro/batch` | 113 KB | 34% | none |
| `nexus-ai-pro/realtime/session` | 96 KB | 29% | none |
| `nexus-ai-pro/agent` | 93 KB | 28% | none |
| `nexus-ai-pro/providers/azure-openai` | 82 KB | 25% | none |
| `nexus-ai-pro/providers/groq` | 82 KB | 25% | none |
| `nexus-ai-pro/providers/mistral` | 82 KB | 25% | none |
| `nexus-ai-pro/providers/deepseek` | 81 KB | 24% | none |
| `nexus-ai-pro/providers/llamacpp` | 81 KB | 24% | none |
| `nexus-ai-pro/providers/lmstudio` | 81 KB | 24% | none |
| `nexus-ai-pro/providers/openai` | 81 KB | 24% | none |
| `nexus-ai-pro/providers/openrouter` | 81 KB | 24% | none |
| `nexus-ai-pro/router` | 80 KB | 24% | none |
| `nexus-ai-pro/postgres` | 78 KB | 23% | none |
| `nexus-ai-pro/graph` | 77 KB | 23% | none |
| `nexus-ai-pro/providers/anthropic` | 74 KB | 22% | none |
| `nexus-ai-pro/providers/google` | 68 KB | 20% | none |
| `nexus-ai-pro/providers/cohere` | 58 KB | 17% | none |
| `nexus-ai-pro/providers/ollama` | 57 KB | 17% | none |
| `nexus-ai-pro/operations` | 56 KB | 17% | none |
| `nexus-ai-pro/security` | 53 KB | 16% | none |
| `nexus-ai-pro/images` | 53 KB | 16% | none |
| `nexus-ai-pro/batch/openai` | 50 KB | 15% | none |
| `nexus-ai-pro/batch/anthropic` | 50 KB | 15% | none |
| `nexus-ai-pro/batch/mock` | 46 KB | 14% | none |
| `nexus-ai-pro/realtime/openai-webrtc` | 46 KB | 14% | none |
| `nexus-ai-pro/sqlite` | 41 KB | 12% | none |
| `nexus-ai-pro/optimizer/cost` | 40 KB | 12% | none |
| `nexus-ai-pro/evaluate` | 38 KB | 11% | none |
| `nexus-ai-pro/prompts/registry` | 37 KB | 11% | none |
| `nexus-ai-pro/models` | 37 KB | 11% | none |
| `nexus-ai-pro/embeddings` | 36 KB | 11% | none |
| `nexus-ai-pro/ops` | 36 KB | 11% | none |
| `nexus-ai-pro/context-hub` | 32 KB | 10% | none |
| `nexus-ai-pro/voice` | 30 KB | 9% | none |
| `nexus-ai-pro/tracing` | 29 KB | 9% | none |
| `nexus-ai-pro/server/deployments` | 29 KB | 9% | none |
| `nexus-ai-pro/telephony` | 29 KB | 9% | none |
| `nexus-ai-pro/realtime/openai-websocket` | 28 KB | 8% | none |
| `nexus-ai-pro/images/inputs` | 27 KB | 8% | none |
| `nexus-ai-pro/evals` | 27 KB | 8% | none |
| `nexus-ai-pro/graph/functional` | 26 KB | 8% | none |
| `nexus-ai-pro/insights` | 25 KB | 7% | none |
| `nexus-ai-pro/testing` | 25 KB | 7% | none |
| `nexus-ai-pro/loaders/web` | 23 KB | 7% | none |
| `nexus-ai-pro/images/stores` | 21 KB | 6% | none |
| `nexus-ai-pro/telephony/twilio` | 21 KB | 6% | none |
| `nexus-ai-pro/images/transform` | 20 KB | 6% | none |
| `nexus-ai-pro/images/openai` | 19 KB | 6% | none |
| `nexus-ai-pro/operations/adapters` | 19 KB | 6% | none |
| `nexus-ai-pro/mcp/registry` | 18 KB | 5% | none |
| `nexus-ai-pro/connectors` | 18 KB | 5% | none |
| `nexus-ai-pro/realtime/mock` | 18 KB | 5% | none |
| `nexus-ai-pro/images/evals` | 17 KB | 5% | none |
| `nexus-ai-pro/server/tenancy` | 17 KB | 5% | none |
| `nexus-ai-pro/rag/retrievers` | 17 KB | 5% | none |
| `nexus-ai-pro/lifecycle` | 17 KB | 5% | none |
| `nexus-ai-pro/workflows` | 17 KB | 5% | none |
| `nexus-ai-pro/images/comfyui` | 16 KB | 5% | none |
| `nexus-ai-pro/embeddings/adapters` | 16 KB | 5% | none |
| `nexus-ai-pro/realtime/conversation` | 16 KB | 5% | none |
| `nexus-ai-pro/mcp` | 15 KB | 4% | none |
| `nexus-ai-pro/tracing/otlp` | 15 KB | 4% | none |
| `nexus-ai-pro/grounding` | 15 KB | 4% | none |
| `nexus-ai-pro/prompts/client` | 15 KB | 4% | none |
| `nexus-ai-pro/context` | 14 KB | 4% | none |
| `nexus-ai-pro/images/assets` | 14 KB | 4% | none |
| `nexus-ai-pro/images/google` | 14 KB | 4% | none |
| `nexus-ai-pro/sqlite/operations` | 14 KB | 4% | none |
| `nexus-ai-pro/postgres/operations` | 14 KB | 4% | none |
| `nexus-ai-pro/sqlite/vectors` | 13 KB | 4% | none |
| `nexus-ai-pro/realtime/tools` | 13 KB | 4% | none |
| `nexus-ai-pro/postgres/rollups` | 12 KB | 4% | none |
| `nexus-ai-pro/tenancy` | 12 KB | 4% | none |
| `nexus-ai-pro/rag/weaviate` | 12 KB | 4% | none |
| `nexus-ai-pro/optimizer` | 11 KB | 3% | none |
| `nexus-ai-pro/voice/session` | 11 KB | 3% | none |
| `nexus-ai-pro/images/mock` | 11 KB | 3% | none |
| `nexus-ai-pro/postgres/store` | 11 KB | 3% | none |
| `nexus-ai-pro/postgres/traces` | 11 KB | 3% | none |
| `nexus-ai-pro/testing/record` | 11 KB | 3% | none |
| `nexus-ai-pro/rag/qdrant` | 11 KB | 3% | none |
| `nexus-ai-pro/rag/redis` | 11 KB | 3% | none |
| `nexus-ai-pro/providers` | 10 KB | 3% | none |
| `nexus-ai-pro/providers/base` | 10 KB | 3% | none |
| `nexus-ai-pro/sqlite/store` | 10 KB | 3% | none |
| `nexus-ai-pro/postgres/vectors` | 10 KB | 3% | none |
| `nexus-ai-pro/postgres/migrations` | 10 KB | 3% | none |
| `nexus-ai-pro/rag/files` | 10 KB | 3% | none |
| `nexus-ai-pro/prompts` | 10 KB | 3% | none |
| `nexus-ai-pro/rag/pinecone` | 10 KB | 3% | none |
| `nexus-ai-pro/rag/chroma` | 10 KB | 3% | none |
| `nexus-ai-pro/voice/openai` | 9 KB | 3% | none |
| `nexus-ai-pro/images/moderation` | 9 KB | 3% | none |
| `nexus-ai-pro/sqlite/migrations` | 9 KB | 3% | none |
| `nexus-ai-pro/graph/visualize` | 9 KB | 3% | none |
| `nexus-ai-pro/ops/circuit-breaker` | 9 KB | 3% | none |
| `nexus-ai-pro/embeddings/models` | 8 KB | 2% | none |
| `nexus-ai-pro/realtime/openai-server` | 8 KB | 2% | none |
| `nexus-ai-pro/capabilities` | 8 KB | 2% | none |
| `nexus-ai-pro/loaders` | 7 KB | 2% | none |
| `nexus-ai-pro/evals/judge` | 7 KB | 2% | none |
| `nexus-ai-pro/graph/lint` | 6 KB | 2% | none |
| `nexus-ai-pro/store` | 6 KB | 2% | none |
| `nexus-ai-pro/store/redis` | 6 KB | 2% | none |
| `nexus-ai-pro/postgres/evaluate` | 6 KB | 2% | none |
| `nexus-ai-pro/server/remote` | 6 KB | 2% | none |
| `nexus-ai-pro/postgres/prompts` | 6 KB | 2% | none |
| `nexus-ai-pro/postgres/circuits` | 6 KB | 2% | none |
| `nexus-ai-pro/ops/circuit-store` | 6 KB | 2% | none |
| `nexus-ai-pro/ops/rate-limit-adapters` | 6 KB | 2% | none |
| `nexus-ai-pro/telephony/realtime-bridge` | 6 KB | 2% | none |
| `nexus-ai-pro/providers/errors` | 5 KB | 1% | none |
| `nexus-ai-pro/embeddings/mock` | 5 KB | 1% | none |
| `nexus-ai-pro/tracing/rollups` | 5 KB | 1% | none |
| `nexus-ai-pro/cache/semantic-cache` | 5 KB | 1% | none |
| `nexus-ai-pro/rag` | 5 KB | 1% | none |
| `nexus-ai-pro/loaders/html` | 5 KB | 1% | none |
| `nexus-ai-pro/pipeline` | 4 KB | 1% | none |
| `nexus-ai-pro/prompts/file` | 4 KB | 1% | none |
| `nexus-ai-pro/prompts/redis` | 4 KB | 1% | none |
| `nexus-ai-pro/loaders/csv` | 4 KB | 1% | none |
| `nexus-ai-pro/operations/webhooks` | 3 KB | 0.9% | none |
| `nexus-ai-pro/cache/memory-cache` | 3 KB | 0.9% | none |
| `nexus-ai-pro/loaders/text` | 3 KB | 0.9% | none |
| `nexus-ai-pro/loaders/markdown` | 3 KB | 0.9% | none |
| `nexus-ai-pro/loaders/json` | 3 KB | 0.9% | none |
| `nexus-ai-pro/loaders/pdf` | 3 KB | 0.9% | none |
| `nexus-ai-pro/loaders/git` | 3 KB | 0.9% | none |
| `nexus-ai-pro/cache` | 2 KB | 0.6% | none |
| `nexus-ai-pro/cache/adapters` | 2 KB | 0.6% | none |
| `nexus-ai-pro/jobs` | 2 KB | 0.6% | none |
| `nexus-ai-pro/jobs/durable-adapters` | 2 KB | 0.6% | none |
| `nexus-ai-pro/jobs/queue` | 2 KB | 0.6% | none |
| `nexus-ai-pro/streaming` | 1 KB | 0.3% | none |
| `nexus-ai-pro/providers/type-guards` | 1 KB | 0.3% | none |
| `nexus-ai-pro/next` | 1 KB | 0.3% | none |
| `nexus-ai-pro/jobs/batch` | 1 KB | 0.3% | none |
<!-- size-table:end -->

A capability that only works by importing the whole runtime is treated as a design problem, not an
acceptable cost.
