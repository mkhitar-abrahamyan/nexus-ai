# Packaging and install weight

<!-- covers:  -->

Every capability has its own entry point, and CI holds each one to a size budget. So an application
pays only for what it imports. This guide lists the entry points and what each one costs.

## Import Surface

The root import is convenient:

```ts
import { NexusAI, createNexus, createNexusConfig } from 'nexus-ai-pro';
```

Focused subpaths are available for smaller imports:

```ts
import { NexusAI } from 'nexus-ai-pro/core';
import { createNexusConfig } from 'nexus-ai-pro/config';
import { TokenOptimizer } from 'nexus-ai-pro/optimizer';
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
| Provider SDKs | Optional peer dependencies. |
| Module formats | ESM and CommonJS builds. |
| Node.js | 22 or newer. |
| Tree shaking | Marked `sideEffects: false`. |
| Public surface | Only the entry points in the package's export map. Deep imports into `dist`, `dist-cjs`, or `src` are unsupported. |

### What each import actually costs

Importing one piece loads one piece. The table below measures each entry point's whole import graph.
`npm run size:check` generates it from the build, and fails CI when an entry point grows past its
budget. So the numbers stay true.

The last column is what a size table usually hides: what an entry point forces you to install.

- Most entry points force nothing. `/graph`, `/operations`, `/server`, `/images/*`, `/batch`,
  `/embeddings`, and the rest import no third-party package.
- The root import, `/core`, `/config`, and `/security` do, because JSON-schema and Zod validation
  live there.

A production install is about 12.1 MB of `node_modules`, of which about 5.1 MB is this package. The
clean-install test holds that total to a ceiling too. `@types/node` adds 2.4 MB at install time, but
it is types only, so it never appears in an import graph.

<!-- size-table:start -->
| Import | Size | Share of root | Third-party install |
| --- | --- | --- | --- |
| `nexus-ai-pro` | 584 KB | 100% | +4.7 MB |
| `nexus-ai-pro/config` | 457 KB | 78% | +4.7 MB |
| `nexus-ai-pro/core` | 453 KB | 78% | +4.7 MB |
| `nexus-ai-pro/realtime` | 156 KB | 27% | none |
| `nexus-ai-pro/server` | 109 KB | 19% | none |
| `nexus-ai-pro/batch` | 108 KB | 18% | none |
| `nexus-ai-pro/realtime/session` | 94 KB | 16% | none |
| `nexus-ai-pro/embeddings` | 82 KB | 14% | none |
| `nexus-ai-pro/providers/groq` | 72 KB | 12% | none |
| `nexus-ai-pro/providers/mistral` | 72 KB | 12% | none |
| `nexus-ai-pro/providers/azure-openai` | 71 KB | 12% | none |
| `nexus-ai-pro/providers/openrouter` | 71 KB | 12% | none |
| `nexus-ai-pro/providers/deepseek` | 70 KB | 12% | none |
| `nexus-ai-pro/providers/llamacpp` | 70 KB | 12% | none |
| `nexus-ai-pro/providers/lmstudio` | 70 KB | 12% | none |
| `nexus-ai-pro/providers/openai` | 70 KB | 12% | none |
| `nexus-ai-pro/agent` | 63 KB | 11% | none |
| `nexus-ai-pro/providers/anthropic` | 62 KB | 11% | none |
| `nexus-ai-pro/providers/google` | 60 KB | 10% | none |
| `nexus-ai-pro/images` | 59 KB | 10% | none |
| `nexus-ai-pro/providers/ollama` | 54 KB | 9% | none |
| `nexus-ai-pro/postgres` | 51 KB | 9% | none |
| `nexus-ai-pro/security` | 49 KB | 8% | +3.4 MB |
| `nexus-ai-pro/graph` | 49 KB | 8% | none |
| `nexus-ai-pro/operations` | 47 KB | 8% | none |
| `nexus-ai-pro/batch/openai` | 46 KB | 8% | none |
| `nexus-ai-pro/batch/anthropic` | 46 KB | 8% | none |
| `nexus-ai-pro/realtime/openai-webrtc` | 46 KB | 8% | none |
| `nexus-ai-pro/providers/cohere` | 44 KB | 8% | none |
| `nexus-ai-pro/batch/mock` | 41 KB | 7% | none |
| `nexus-ai-pro/evaluate` | 37 KB | 6% | none |
| `nexus-ai-pro/prompts/registry` | 37 KB | 6% | none |
| `nexus-ai-pro/context-hub` | 32 KB | 5% | none |
| `nexus-ai-pro/models` | 32 KB | 5% | none |
| `nexus-ai-pro/sqlite` | 31 KB | 5% | none |
| `nexus-ai-pro/server/deployments` | 29 KB | 5% | none |
| `nexus-ai-pro/realtime/openai-websocket` | 28 KB | 5% | none |
| `nexus-ai-pro/images/inputs` | 27 KB | 5% | none |
| `nexus-ai-pro/evals` | 26 KB | 4% | none |
| `nexus-ai-pro/insights` | 25 KB | 4% | none |
| `nexus-ai-pro/graph/functional` | 24 KB | 4% | none |
| `nexus-ai-pro/tracing` | 23 KB | 4% | none |
| `nexus-ai-pro/loaders/web` | 23 KB | 4% | none |
| `nexus-ai-pro/images/stores` | 21 KB | 4% | none |
| `nexus-ai-pro/telephony/twilio` | 21 KB | 4% | none |
| `nexus-ai-pro/images/transform` | 20 KB | 3% | none |
| `nexus-ai-pro/images/openai` | 19 KB | 3% | none |
| `nexus-ai-pro/voice` | 18 KB | 3% | none |
| `nexus-ai-pro/mcp/registry` | 18 KB | 3% | none |
| `nexus-ai-pro/realtime/mock` | 18 KB | 3% | none |
| `nexus-ai-pro/telephony` | 18 KB | 3% | none |
| `nexus-ai-pro/images/evals` | 17 KB | 3% | none |
| `nexus-ai-pro/rag/retrievers` | 17 KB | 3% | none |
| `nexus-ai-pro/workflows` | 17 KB | 3% | none |
| `nexus-ai-pro/images/comfyui` | 16 KB | 3% | none |
| `nexus-ai-pro/embeddings/adapters` | 16 KB | 3% | none |
| `nexus-ai-pro/realtime/conversation` | 16 KB | 3% | none |
| `nexus-ai-pro/mcp` | 15 KB | 3% | none |
| `nexus-ai-pro/prompts/client` | 15 KB | 3% | none |
| `nexus-ai-pro/images/assets` | 14 KB | 2% | none |
| `nexus-ai-pro/images/google` | 14 KB | 2% | none |
| `nexus-ai-pro/context` | 13 KB | 2% | none |
| `nexus-ai-pro/sqlite/operations` | 13 KB | 2% | none |
| `nexus-ai-pro/postgres/operations` | 13 KB | 2% | none |
| `nexus-ai-pro/realtime/tools` | 13 KB | 2% | none |
| `nexus-ai-pro/sqlite/vectors` | 12 KB | 2% | none |
| `nexus-ai-pro/server/tenancy` | 12 KB | 2% | none |
| `nexus-ai-pro/rag/weaviate` | 12 KB | 2% | none |
| `nexus-ai-pro/optimizer` | 11 KB | 2% | none |
| `nexus-ai-pro/voice/session` | 11 KB | 2% | none |
| `nexus-ai-pro/images/mock` | 11 KB | 2% | none |
| `nexus-ai-pro/operations/adapters` | 11 KB | 2% | none |
| `nexus-ai-pro/postgres/store` | 11 KB | 2% | none |
| `nexus-ai-pro/rag/qdrant` | 11 KB | 2% | none |
| `nexus-ai-pro/rag/redis` | 11 KB | 2% | none |
| `nexus-ai-pro/providers` | 10 KB | 2% | none |
| `nexus-ai-pro/providers/base` | 10 KB | 2% | none |
| `nexus-ai-pro/postgres/vectors` | 10 KB | 2% | none |
| `nexus-ai-pro/postgres/traces` | 10 KB | 2% | none |
| `nexus-ai-pro/prompts` | 10 KB | 2% | none |
| `nexus-ai-pro/rag/pinecone` | 10 KB | 2% | none |
| `nexus-ai-pro/rag/chroma` | 10 KB | 2% | none |
| `nexus-ai-pro/voice/openai` | 9 KB | 2% | none |
| `nexus-ai-pro/images/moderation` | 9 KB | 2% | none |
| `nexus-ai-pro/sqlite/store` | 9 KB | 2% | none |
| `nexus-ai-pro/graph/visualize` | 9 KB | 2% | none |
| `nexus-ai-pro/testing/record` | 9 KB | 2% | none |
| `nexus-ai-pro/ops/circuit-breaker` | 9 KB | 2% | none |
| `nexus-ai-pro/embeddings/models` | 8 KB | 1% | none |
| `nexus-ai-pro/realtime/openai-server` | 8 KB | 1% | none |
| `nexus-ai-pro/capabilities` | 8 KB | 1% | none |
| `nexus-ai-pro/loaders` | 7 KB | 1% | none |
| `nexus-ai-pro/store` | 6 KB | 1% | none |
| `nexus-ai-pro/store/redis` | 6 KB | 1% | none |
| `nexus-ai-pro/server/remote` | 6 KB | 1% | none |
| `nexus-ai-pro/postgres/prompts` | 6 KB | 1% | none |
| `nexus-ai-pro/telephony/realtime-bridge` | 6 KB | 1% | none |
| `nexus-ai-pro/providers/errors` | 5 KB | 0.9% | none |
| `nexus-ai-pro/embeddings/mock` | 5 KB | 0.9% | none |
| `nexus-ai-pro/postgres/evaluate` | 5 KB | 0.9% | none |
| `nexus-ai-pro/cache/semantic-cache` | 5 KB | 0.9% | none |
| `nexus-ai-pro/rag` | 5 KB | 0.9% | none |
| `nexus-ai-pro/loaders/html` | 5 KB | 0.9% | none |
| `nexus-ai-pro/evals/judge` | 5 KB | 0.9% | none |
| `nexus-ai-pro/prompts/file` | 4 KB | 0.7% | none |
| `nexus-ai-pro/prompts/redis` | 4 KB | 0.7% | none |
| `nexus-ai-pro/loaders/csv` | 4 KB | 0.7% | none |
| `nexus-ai-pro/operations/webhooks` | 3 KB | 0.5% | none |
| `nexus-ai-pro/postgres/circuits` | 3 KB | 0.5% | none |
| `nexus-ai-pro/ops/circuit-store` | 3 KB | 0.5% | none |
| `nexus-ai-pro/cache/memory-cache` | 3 KB | 0.5% | none |
| `nexus-ai-pro/loaders/text` | 3 KB | 0.5% | none |
| `nexus-ai-pro/loaders/markdown` | 3 KB | 0.5% | none |
| `nexus-ai-pro/loaders/json` | 3 KB | 0.5% | none |
| `nexus-ai-pro/loaders/pdf` | 3 KB | 0.5% | none |
| `nexus-ai-pro/loaders/git` | 3 KB | 0.5% | none |
| `nexus-ai-pro/ops/rate-limit-adapters` | 2 KB | 0.3% | none |
| `nexus-ai-pro/cache` | 2 KB | 0.3% | none |
| `nexus-ai-pro/cache/adapters` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs/durable-adapters` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs/queue` | 2 KB | 0.3% | none |
| `nexus-ai-pro/streaming` | 1 KB | 0.2% | none |
| `nexus-ai-pro/providers/type-guards` | 1 KB | 0.2% | none |
| `nexus-ai-pro/jobs/batch` | 1 KB | 0.2% | none |
<!-- size-table:end -->

A capability that only works by importing the whole runtime is treated as a design problem, not an
acceptable cost.
