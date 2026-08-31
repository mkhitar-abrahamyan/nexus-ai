# nexus-ai-pro

The Universal AI Pipeline for Node.js: one typed API for routing, guardrails, caching, context-window management, tools, RAG, evals, jobs, and provider failover.

Use the whole pipeline for production AI features, or turn pieces off when you only need a thin provider wrapper.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Full technical notes and manual test cases: [NEXUS.md](./NEXUS.md)
- Image generation status and remaining infrastructure work: [ROADMAP.md](./ROADMAP.md)

## Install

```bash
npm install nexus-ai-pro
```

Requires Node.js 22 or newer. The package is authored as ESM and ships both an ESM and a CommonJS build,
so `import` and `require()` both work — including from NestJS and other apps compiled with
`"module": "commonjs"`. Types are shared between both builds.
The main Nexus pipeline is Node-oriented; the isolated realtime subpaths use portable structural
interfaces and can be bundled for modern browsers.

Install only the provider SDKs your app uses. The OpenAI SDK also powers OpenAI-compatible adapters such as OpenRouter, Groq, Mistral, DeepSeek, Azure OpenAI, LM Studio, and llama.cpp.

```bash
npm install openai @anthropic-ai/sdk ollama
```

The Google Gemini provider uses Node.js `fetch`, so it does not need an extra SDK.
Realtime transports use injected or platform WebRTC, WebSocket, and `fetch` interfaces and do not
require the OpenAI SDK.

## Quick Start

```ts
import { createNexus } from 'nexus-ai-pro';

const ai = createNexus({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-5.4-mini',
  security: 'standard',
});

const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Explain RAG in 3 bullet points.' }],
});

console.log(response.content);
console.log(response.meta.providerUsed);
console.log(response.meta.modelUsed);
```

For a fuller typed config, use the builder:

```ts
import { createNexusConfig } from 'nexus-ai-pro';

const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY!)
  .anthropic(process.env.ANTHROPIC_API_KEY!)
  .deepseek(process.env.DEEPSEEK_API_KEY!)
  .lmstudio({ baseUrl: 'http://localhost:1234/v1' })
  .auto('quality')
  .security('standard')
  .retry({ enabled: true, maxRetries: 2 })
  .create();
```

You can still pass a plain `NexusAIConfig` to `new NexusAI(...)` when you want full object-literal control.

## Why Use It

`nexus-ai-pro` is useful when an app needs more than a direct SDK call:

- route across multiple providers and model aliases
- fail over on provider errors, timeouts, or unhealthy providers
- stream through one normalized interface
- protect inputs and outputs with guardrails
- compact long conversations before they hit model limits
- estimate tokens and cost before provider calls
- cache exact or semantically similar prompts
- add tools, agents, RAG context, evals, batch jobs, and queues
- embed text through the same routing, caching, batching, budget, retry, and metrics as a completion
- run long operations that survive a restart, with leases, retries, dead-lettering, and signed webhooks
- build persistent realtime voice agents with interruption, live tools, and normalized conversation state
- keep TypeScript types around every request and response

## CLI

The package installs a `nexus` command:

```bash
nexus scan src --json
nexus models --provider deepseek
nexus optimize prompt.txt --model gpt-5.4-mini --max-input-tokens 4000
nexus eval examples/cli-eval.json
```

CLI commands are intentionally thin wrappers around library modules:

- `nexus scan` checks files for secrets, PII, and prompt-injection patterns.
- `nexus models` lists the bundled model registry.
- `nexus eval` runs JSON or JS eval cases.
- `nexus optimize` previews token optimization for a request or prompt file.

## Core Concepts

### Providers and Routing

```ts
const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    groq: { apiKey: process.env.GROQ_API_KEY! },
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY! },
    openrouter: { apiKey: process.env.OPENROUTER_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
    lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  },
  routing: {
    mode: 'auto',
    strategy: 'quality',
    requiredCapabilities: {
      streaming: true,
      minContextTokens: 128000,
    },
  },
});
```

First-class provider adapters:

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenRouter
- Groq
- Mistral
- Cohere
- DeepSeek
- Azure OpenAI
- LM Studio
- llama.cpp
- custom OpenAI- or Anthropic-compatible endpoints through `providers.custom` or `registerProvider(...)`

Routing modes:

- `direct` - always use the requested model or `defaultModel`
- `auto` - choose from available providers by cost, speed, quality, or privacy
- `rules` - route from request metadata
- `hybrid` - try rules first, then fall back to auto routing

### Context Windows

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

### Token Optimizer

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

### Planning and Cost Checks

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

### Reasoning

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

### Prompt Caching

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

### Usage and Cost

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

### Capability Negotiation

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

### Streaming

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

### Tools and Agents

```ts
import { NexusAI, tool } from 'nexus-ai-pro';

const getCurrentTime = tool({
  name: 'get_current_time',
  description: 'Get the current ISO timestamp.',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ now: new Date().toISOString() }),
});

const result = await ai.agent({
  model: 'auto',
  goal: 'What time is it now?',
  tools: [getCurrentTime],
  maxIterations: 5,
});
```

### RAG and Grounded Answers

```ts
import { MemoryVectorStore, withRagContext } from 'nexus-ai-pro';

const store = new MemoryVectorStore();
await store.add([
  { id: 'doc-1', content: 'NexusAI supports RAG context with citations.', source: 'docs' },
]);

const chunks = await store.search('How does NexusAI ground answers?', { topK: 3 });

const response = await ai.completeVerified(
  withRagContext({
    model: 'auto',
    messages: [{ role: 'user', content: 'How does NexusAI ground answers?' }],
  }, {
    chunks,
    requireCitations: true,
  }),
  {
    context: chunks.map((chunk) => chunk.content),
    minSupportRatio: 0.85,
  },
);
```

## Durable Operations

Long-running work — an image render, a batch, anything asynchronous — runs through one lifecycle:
`queued → running → succeeded | failed`, with `retrying`, `cancelling`, `cancelled`, and `expired`
covering the rest. `OperationRunner` owns it end to end, so a crashed worker does not lose work.

The default store is in-process, so the small case needs no infrastructure:

```ts
import { OperationRunner } from 'nexus-ai-pro/operations';

const runner = new OperationRunner<string>({ retry: { maxAttempts: 3, baseDelayMs: 500 } });

const handle = await runner.submit(async (context) => {
  context.report({ completed: 1, total: 3 });
  return doTheWork(context.signal);
});

for await (const event of handle.events()) {
  console.log(event.type, event.sequence);
}

const value = await handle.result();
```

Swapping the store makes the same code survive a restart. Nothing else changes:

```ts
import { OperationRunner } from 'nexus-ai-pro/operations';
import { BullMQOperationDispatcher, RedisOperationStore } from 'nexus-ai-pro/operations/adapters';

const runner = new OperationRunner({
  store: new RedisOperationStore(redis),
  dispatcher: new BullMQOperationDispatcher(queue),
  owner: process.env.HOSTNAME,
  leaseMs: 30_000,
  webhook: { url: 'https://app.example/hooks/operations', secret: process.env.HOOK_SECRET! },
});
```

**How restart survival actually works.** A worker claims a lease before running and heartbeats
while it works. If the process dies, the lease simply lapses; another worker's `recover()` sweep
finds the record and resumes it. There is no distributed lock — every store write is a
compare-and-set on the record's `sequence`, so two workers racing on the same operation cannot both
win.

```ts
// On startup, in each worker.
const resumed = await runner.recover(executor);
```

Recovery is deliberately conservative: a record past its `expiresAt` is **expired** rather than
re-run, and one that has used every attempt is **dead-lettered** and parked for inspection, so a
permanently failing operation cannot be recovered forever.

**Idempotency.** An `idempotencyKey` that matches an existing record replays that operation instead
of starting a second one, which is what stops an ambiguous timeout from double-charging:

```ts
const handle = await runner.submit(chargeAndRender, { idempotencyKey: `render:${orderId}` });
```

**Webhooks** are signed with HMAC-SHA256 over `${timestamp}.${body}`, so a captured delivery cannot
be replayed indefinitely. The verifying half ships too — a receiver should never have to hand-roll a
constant-time comparison:

```ts
import { OPERATION_WEBHOOK_SIGNATURE_HEADER, verifyOperationWebhook } from 'nexus-ai-pro/operations/webhooks';

app.post('/hooks/operations', (request, response) => {
  const ok = verifyOperationWebhook(
    request.rawBody,
    request.header(OPERATION_WEBHOOK_SIGNATURE_HEADER),
    process.env.HOOK_SECRET!,
  );
  response.sendStatus(ok ? 204 : 400);
});
```

A failed delivery is reported through `onWebhookError` and never turns a completed operation into a
failed one.

**Binary payloads are refused, not truncated.** Persisting a result that carries a `Uint8Array`,
`Buffer`, or `Blob` throws `OperationSerializationError` naming the exact path. Base64 in a job
payload inflates it by a third and most queue backends cap job size well below one image, so the
bytes belong in an `AssetStore` with only a reference on the record. The BullMQ dispatcher likewise
queues the operation id and nothing else.

The image family already runs on this lifecycle, so `ai.images.submit()` reports the same events.

## Embeddings

`ai.embed()` is a first-class operation, not a helper: it gets the same routing, caching, batching,
budget, retry, audit, and metrics as a completion, so embedding spend shows up next to completion
spend instead of being invisible.

The smallest call is one line, and needs no embedding-specific configuration — adapters are derived
from the provider credentials already in `providers`:

```ts
import { NexusAI } from 'nexus-ai-pro';

const ai = new NexusAI({ providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } });

const vector = await ai.embedOne('Provider-neutral embeddings.');
```

A batch returns vectors in input order regardless of how many provider calls the model's batch
limit required, and reports what the call cost:

```ts
const response = await ai.embed({
  input: documents.map((document) => document.text),
  model: 'embed-quality',
  inputType: 'document',
  normalize: true,
});

response.vectors;                  // number[][], in input order
response.meta.batches;             // provider calls the split required
response.meta.usage.inputTokens;   // reported by the provider, or estimated when it reports none
response.meta.cost.amount;         // numeric, priced from the embedding registry
response.meta.cachedInputs;        // inputs answered from cache
response.meta.deduplicatedInputs;  // repeated inputs answered from one call
```

Caching is per input rather than per request, so a partially repeated batch only sends the texts it
has not seen. Repeated texts inside one batch are collapsed into a single provider call:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  embeddings: {
    cache: { enabled: true, ttlSeconds: 86_400 },
    costBudget: { enabled: true, maxEstimatedCost: 5 },
    retry: { enabled: true, maxRetries: 2 },
    fallback: [{ provider: 'cohere', model: 'embed-v4.0' }],
  },
});
```

Unlike a completion, an unsupported embedding option is **refused rather than dropped**. A vector
built with different dimensions or a different input type is silently incompatible with the vectors
already in a store, and the mismatch only surfaces later as unexplained retrieval quality loss:

```ts
await ai.embed({ input: 'x', model: 'embed-english-v3.0', dimensions: 512 });
// EmbeddingCapabilityError: model has a fixed size of 1024 dimensions
```

An option the registry says nothing about is still passed through, because an undeclared capability
means unknown rather than unsupported, and `providerOptions` reaches the provider body untouched for
anything the neutral contract does not model yet.

Existing vector stores keep their contract. `toEmbeddingFunction()` adapts the family to the plain
function `MemoryVectorStore`, the semantic cache, and RAG ingestion already accept:

```ts
import { MemoryVectorStore, toEmbeddingFunction } from 'nexus-ai-pro';

const store = new MemoryVectorStore(toEmbeddingFunction(ai, { inputType: 'document' }));
```

Bundled adapters cover OpenAI (and any OpenAI-compatible `/embeddings` server), Google, Cohere,
Mistral, and Ollama. A custom adapter implements `EmbeddingsProvider` and is checked against the
neutral contract by `runEmbeddingProviderConformance()`:

```ts
import { OpenAIEmbeddingProvider } from 'nexus-ai-pro/embeddings/adapters';
import { MockEmbeddingProvider } from 'nexus-ai-pro/embeddings/mock';

ai.registerEmbeddingProvider('gateway', new OpenAIEmbeddingProvider({
  apiKey: process.env.GATEWAY_KEY!,
  baseUrl: 'https://gateway.internal/v1',
  providerName: 'gateway',
}));
ai.registerEmbeddingProvider('mock', new MockEmbeddingProvider());
```

Bundled embedding dimensions and prices are defaults, not financial truth. Override them through
`embeddings.models.registry` when exact numbers matter.

## Image Generation and Editing (Experimental)

Image operations use a separate provider-neutral manager because generated assets have different
capabilities, delivery modes, safety checks, and lifecycles from text completions.

```ts
import { NexusAI } from 'nexus-ai-pro';
import { OpenAIImageProvider } from 'nexus-ai-pro/images/openai';

const openaiImages = new OpenAIImageProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

const mediaAi = new NexusAI({
  providers: {},
  images: {
    defaultProvider: 'openai',
    providers: { openai: openaiImages },
  },
});

const image = await mediaAi.images.generate({
  model: 'auto',
  prompt: 'A clean product photograph of a red mechanical keyboard',
  dimensions: { width: 1536, height: 1024 },
  quality: 'high',
  delivery: { kind: 'bytes', format: 'png' },
});

console.log(image.assets[0]?.location);
```

`ImageProvider` is independent from completion providers. Explicit options are negotiated against the
selected provider's declared capabilities, so unsupported formats, delivery kinds, masks, seeds, or
dimensions fail before a provider call. The OpenAI adapter supports one-shot generation and
reference-based editing through byte assets. Masked OpenAI edits remain disabled until a transformer can
verify dimensions and convert the neutral mask contract to OpenAI's alpha-channel semantics.

Use `submit()` for a cancellable local operation handle with replayable lifecycle events:

```ts
const operation = mediaAi.images.submit('generate', {
  prompt: 'A minimal blue geometric poster',
  delivery: { kind: 'bytes', format: 'png' },
});

for await (const event of operation.events()) {
  console.log(event.type);
}
```

For deterministic tests, register `MockImageProvider` from `nexus-ai-pro/images/mock`. The current
`submit()` handle is in-process; durable leases, recovery, distributed deduplication, and webhooks remain
future infrastructure work. `nexus-ai-pro/images/assets` includes a bounded, tenant-isolated
`MemoryAssetStore` for local development and single-process workloads; it computes SHA-256 checksums,
copies bytes at its boundaries, enforces retention and capacity, and never silently evicts live assets.

## Voice Integrations

Voice support is optional and split into small imports.

Use the provider-neutral core when you bring your own voice service:

```ts
import { VoiceManager } from 'nexus-ai-pro/voice';
```

Use the OpenAI adapter only when your app needs it:

```ts
import { OpenAIVoiceProvider } from 'nexus-ai-pro/voice/openai';
```

This keeps text-only apps small, while voice apps can opt into the larger integration.

### Transcribe

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  voice: {
    defaultTranscriptionProvider: 'openai',
    providers: {
      openai: new OpenAIVoiceProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        transcriptionModel: 'gpt-4o-transcribe',
      }),
    },
  },
});

const transcript = await ai.transcribe({
  audio: { path: './call.wav', mimeType: 'audio/wav' },
});
```

### Speak

```ts
const speech = await ai.speak({
  provider: 'openai',
  text: 'Thanks for calling. I can help with that.',
  voice: 'alloy',
  format: 'mp3',
});

await fs.promises.writeFile('reply.mp3', speech.audio.data);
```

### Full Voice Turn

`ai.voice(...)` runs:

```txt
audio/transcript -> transcribe -> complete -> optional speak
```

The completion still uses the normal Nexus pipeline, so routing, security, context windows, token optimization, cache, tracing, and failover still apply.

```ts
const result = await ai.voice({
  audio: { path: './call.wav', mimeType: 'audio/wav' },
  transcription: { provider: 'openai' },
  completion: {
    model: 'auto',
    messages: [{ role: 'system', content: 'Answer as a helpful support agent.' }],
  },
  transcriptMessage: {
    template: 'Caller said: {{transcript}}',
  },
  speech: {
    provider: 'openai',
    voice: 'alloy',
    format: 'mp3',
  },
});

console.log(result.transcriptText);
console.log(result.response.content);
console.log(result.speech?.audio.data);
```

### Voice Session With App Requests

Use `VoiceSession` when a call has multiple turns, should keep history, and may need to call your app while talking.

The prompt setup is flexible:

- `prompt` describes the assistant or business role.
- `instructions` describe behavior.
- `taskPrompts` add conditional instructions when the caller asks about something specific.
- `tools` let the model call your app, such as booking, CRM, billing, or inventory APIs.

```ts
import { tool } from 'nexus-ai-pro';

const session = ai.createVoiceSession({
  model: 'auto',
  prompt: 'You are a phone booking assistant for a small clinic.',
  instructions: [
    'Keep answers short and natural for a phone call.',
    'Ask one follow-up question at a time.',
  ],
  taskPrompts: [
    {
      name: 'booking',
      when: ['book', 'appointment', 'free slot'],
      instructions: 'When the caller asks about availability, call check_free_slots before offering times.',
      tools: ['check_free_slots'],
    },
  ],
  tools: [
    tool({
      name: 'check_free_slots',
      description: 'Check available booking slots for a date.',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string' } },
        required: ['date'],
      },
      execute: async ({ date }) => bookingApi.freeSlots(String(date)),
    }),
  ],
  toolSelection: 'task',
  speech: { provider: 'openai', voice: 'alloy', format: 'mp3' },
});

const turn = await session.handleTurn({
  transcript: 'Do you have any free slots tomorrow?',
});

console.log(turn.response.content);
console.log(turn.toolSteps);
console.log(turn.speech?.audio.data);
```

You can use only `prompt`, only `instructions`, only `taskPrompts`, or all of them together. For phone calls through Twilio media streams, parse incoming audio/media events in `telephony`, feed complete caller turns into `session.handleTurn(...)`, then send the returned speech audio back through your call transport.

### Custom Voice Provider

Bring any private, local, or hosted voice service:

```ts
ai.registerVoiceProvider('private-voice', {
  info: { name: 'private-voice', isLocal: true },
  async transcribe(request) {
    return {
      text: await myStt(request.audio),
      providerUsed: 'private-voice',
    };
  },
  async speak(request) {
    return {
      audio: {
        data: await myTts(request.text, request.voice),
        format: request.format || 'mp3',
      },
      providerUsed: 'private-voice',
      format: request.format || 'mp3',
    };
  },
});
```

`VoiceSession` remains the batch-oriented path: each turn is transcription -> completion/tools -> optional
speech. For a persistent connection with live microphone audio, streamed remote audio, barge-in, and
provider events, use the separate realtime entry points below. Neither API replaces the other.

## Realtime Voice Agents

Realtime is opt-in and is not re-exported from the package root or from `nexus-ai-pro/voice`:

```ts
import {
  createRealtimeAgent,
  defineTool,
  OpenAIRealtimeProvider,
} from 'nexus-ai-pro/realtime';
```

The framework-independent session normalizes connection, speech, transcript, response, tool,
interruption, error, conversation, and metrics events while retaining provider events when configured.
The browser and server transports use structural platform interfaces, so the realtime core does not
require React, a DOM shim, or an OpenAI SDK.

### Browser WebRTC

Give the browser a same-origin `sessionEndpoint`; never put a permanent provider API key in browser
code. The endpoint receives the SDP offer and returns the SDP answer while your server owns the
provider key and authoritative session configuration.

```ts
type BookingInput = { startTime: string; endTime: string; timezone: string };

const createBooking = defineTool({
  name: 'create_calendar_booking',
  description: 'Create a calendar booking after the user confirms it.',
  parameters: {
    type: 'object',
    properties: {
      startTime: { type: 'string', format: 'date-time' },
      endTime: { type: 'string', format: 'date-time' },
      timezone: { type: 'string' },
    },
    required: ['startTime', 'endTime', 'timezone'],
    additionalProperties: false,
  },
  requiresConfirmation: true,
  execute: async (input: BookingInput, context) =>
    calendar.create(input, { idempotencyKey: context.idempotencyKey, signal: context.signal }),
});

const provider = new OpenAIRealtimeProvider({
  sessionEndpoint: '/api/realtime/session',
});

const agent = createRealtimeAgent({
  provider,
  model: 'gpt-realtime',
  modalities: ['audio', 'text'],
  instructions: 'Check availability before booking. Never write without confirmation.',
  tools: [createBooking],
  voice: {
    transport: 'webrtc',
    voice: 'alloy',
    turnDetection: { type: 'server_vad', silenceDurationMs: 450 },
    interruption: {
      enabled: true,
      cancelResponse: true,
      truncateUnheardAudio: true,
    },
  },
  toolExecution: { mode: 'automatic', timeoutMs: 8_000, maxParallelCalls: 3 },
  reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500 },
  conversation: { captureTranscripts: true, captureToolCalls: true, maxRawEvents: 2_000 },
  security: {
    maxSessionDurationMs: 30 * 60_000,
    maxAudioDurationMs: 20 * 60_000,
    toolAllowlist: ['create_calendar_booking'],
  },
  telemetry: {
    includeTranscripts: false,
    estimateCost: (usage) => pricing.estimateRealtime(usage),
  },
});

agent.on('tool.confirmation.required', ({ call }) => {
  const approved = window.confirm(`Create booking requested by ${call.name}?`);
  agent.confirmTool(call.callId, approved);
});

agent.on('metrics', (metrics) => {
  console.log('speech end -> first audio', metrics.speechEndToFirstAudioMs);
});

const audioElement = document.querySelector<HTMLAudioElement>('#assistant-audio')!;
await agent.connect({ microphone: true, audioElement });
```

WebRTC attaches the selected microphone track directly to the peer connection and assigns the remote
media stream to `audioElement`. Browsers still require HTTPS (or localhost), user permission, and often
a user gesture before audio playback. `sendAudio()` is intended for transports that accept binary
chunks; normal WebRTC microphone use should stay on the media track.

WebRTC first-audio timing uses the provider's `output_audio_buffer.started` event. WebSocket playback
remains application-owned, so its player must call `markAudioPlayed()` as described below.

A minimal server endpoint can use the focused server helper:

```ts
import { createOpenAIRealtimeCall } from 'nexus-ai-pro/realtime/openai-server';

export async function POST(request: Request) {
  const answerSdp = await createOpenAIRealtimeCall(await request.text(), {
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-realtime',
    session: {
      instructions: 'You are a concise scheduling assistant.',
      max_output_tokens: 1_024,
    },
  }, request.signal);

  return new Response(answerSdp, { headers: { 'content-type': 'application/sdp' } });
}
```

Authenticate that endpoint, authorize the tenant and requested tools, apply origin/CSRF and rate-limit
controls, and keep its accepted session options allowlisted. The client must not choose arbitrary tools,
instructions, limits, or credentials.

### Server WebSocket

Server-to-server agents can inject their WebSocket implementation and keep provider authorization in
request headers. The package deliberately does not force a WebSocket dependency:

```ts
import {
  OpenAIWebSocketTransport,
  type OpenAIWebSocketFactory,
} from 'nexus-ai-pro/realtime/openai-websocket';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';

const webSocketFactory: OpenAIWebSocketFactory = (url, { headers, protocols }) =>
  serverWebSocketClient.connect(url, { headers, protocols });

const session = createRealtimeSession({
  provider: 'openai',
  model: 'gpt-realtime',
  transport: new OpenAIWebSocketTransport({
    apiKey: process.env.OPENAI_API_KEY!,
    webSocketFactory,
  }),
  modalities: ['audio', 'text'],
  reconnect: { enabled: true, maxAttempts: 3 },
  connection: {
    remoteAudioSink: (audio) => audioPlayer.enqueue(audio.data),
  },
});

await session.connect();
```

When an application plays WebSocket audio itself, call `session.markAudioPlayed()` when the first bytes
actually reach playback. That makes the primary latency metric—user speech ended to first assistant
audio played—represent user experience rather than network receipt.

The global browser WebSocket path accepts only an ephemeral token. Supplying a permanent API key to a
browser adapter is rejected; use an injected server factory or an ephemeral-token provider instead.

### Interruption, tools, state, and exports

With interruption enabled, a `speech.started` event can stop local playback, cancel the active response,
and, for WebSocket playback with a known position, truncate unheard assistant audio. Applications can
also call `session.interrupt('manual')`.

Realtime tools support structural `parse`, `safeParse`, or `validate` schemas, execution timeouts,
bounded parallelism, safe-tool retries, duplicate call suppression, idempotency keys, allowlists, and
write confirmation. A tool marked `safe: true` can also opt into cross-call caching with `cache: true`
or `{ ttlMs, key }` when `toolExecution.cache` supplies a structural cache adapter; cache failures are
ignored unless `cacheFailureMode: 'fail'` is configured. `requiresConfirmation` does not replace server
authorization: re-check identity, permissions, business invariants, and idempotency in the tool
implementation.

Session state is available as immutable snapshots and four export formats:

```ts
const json = session.export('json');
const providerEvents = session.export('openai-events');
const transcript = session.export('text');
const analytics = session.export('analytics');

session.on('conversation.updated', (snapshot) => conversationStore.save(snapshot));
session.on('error', (error) => telemetry.recordException(error));
```

`json` contains normalized user/assistant speech, text messages, tool calls/results, interruptions,
errors, and latency/usage metrics. `openai-events` returns retained raw provider events; it is useful for
diagnostics and replay but follows the upstream provider schema. Disable transcript/raw-event retention
for sensitive workloads. `piiHook` redacts normalized conversation/event text, but deliberately does not
rewrite raw provider exports. Telemetry transcript fields are redacted by default; `includeTranscripts`
must be explicitly enabled. `estimateCost` accepts an application-owned pricing callback so model price
changes are not hard-coded into the package. The built-in limits and telemetry hooks are local controls,
not a durable session store, distributed rate limiter, or authorization system.

Focused public imports are available for `realtime`, `realtime/session`, `realtime/tools`,
`realtime/conversation`, `realtime/openai-webrtc`, `realtime/openai-websocket`,
`realtime/openai-server`, and `realtime/mock`. The deterministic mock is suitable for tests and demos;
see [`examples/realtime-scheduling.ts`](./examples/realtime-scheduling.ts).

## Phone Number Telephony

Phone-number support is optional and separate from the voice layer. Use `voice` for audio transcription/TTS, and use `telephony` when calls, webhooks, TwiML, or media-stream events are involved.

```ts
import { TelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
```

Configure only the provider you need:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  telephony: {
    defaultProvider: 'twilio',
    providers: {
      twilio: new TwilioTelephonyProvider({
        accountSid: process.env.TWILIO_ACCOUNT_SID!,
        authToken: process.env.TWILIO_AUTH_TOKEN!,
      }),
    },
  },
});
```

Generate a Twilio webhook response for an inbound phone number:

```ts
const response = await ai.createTelephonyResponse({
  say: 'Thanks for calling. Connecting you now.',
  stream: {
    url: 'wss://voice.example.com/twilio',
    mode: 'bidirectional',
    parameters: { tenant: 'acme' },
  },
});

return new Response(response.body, {
  headers: { 'content-type': response.contentType },
});
```

Start an outbound call with either a webhook, inline TwiML, an application SID, or a media-stream URL:

```ts
const call = await ai.createCall({
  to: '+15551230000',
  from: '+15557650000',
  mediaStreamUrl: 'wss://voice.example.com/twilio',
});
```

For smaller apps, skip Twilio entirely and register your own `TelephonyProvider`.

### Phone Agents: Bridging a Call to a Realtime Session

A phone agent needs the telephony media stream and a realtime session joined together. The bridge owns
that audio path — caller audio in, assistant audio out, barge-in, playback marks, and stream lifecycle —
while session configuration, tools, and authorization stay in application code.

```ts
import { createTelephonyRealtimeBridge, twilioRealtimeAudioOptions } from 'nexus-ai-pro/telephony/realtime-bridge';
import { OpenAIWebSocketTransport } from 'nexus-ai-pro/realtime/openai-websocket';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';

// One socket per call, from your WebSocket server.
function handleCallSocket(socket: AppWebSocket) {
  const session = createRealtimeSession({
    provider: 'openai',
    model: 'gpt-realtime',
    transport: new OpenAIWebSocketTransport({ apiKey: process.env.OPENAI_API_KEY!, webSocketFactory }),
    modalities: ['audio'],
    instructions: 'You are a scheduling assistant.',
    tools: [checkAvailability, createBooking],
    // Telephony audio is 8 kHz G.711 mu-law; this passes it through untranscoded.
    audio: twilioRealtimeAudioOptions({ output: { voice: 'alloy' } }),
  });

  const bridge = createTelephonyRealtimeBridge({
    session,
    telephony,
    send: (message) => socket.send(message.body),
    onStart: (event) => logger.info(`call ${event.callId} started for ${event.parameters?.tenant}`),
    onStop: () => persistTranscript(session.export('json')),
    onError: (error) => logger.error(error),
  });

  socket.on('message', (raw) => bridge.handleMessage(String(raw)));
  socket.on('close', () => bridge.close());
}
```

The bridge feeds only inbound caller audio to the model, so an echoed outbound track never loops back.
On caller speech it clears audio already queued at the provider and cancels the in-flight response, which
is what stops the assistant talking over an interruption. Custom `<Parameter>` values from the stream
instruction are exposed as `bridge.parameters` for tenant and worker routing.

Pass `bargeIn: false` to keep queued audio playing, `autoConnect: false` to connect the session yourself,
and `await bridge.flush()` when you need outstanding sends to settle.

### Call Control and Usage Metering

Meter billable time from the provider's own record rather than from stream lifecycle events, which do not
account for ring time or provider-side teardown:

```ts
// From your status webhook.
const status = ai.parseTelephonyStatusCallback('twilio', requestBody);
if (status?.status === 'completed') {
  await usage.recordCallMinutes({ callId: status.callId, seconds: status.durationSeconds ?? 0 });
}

// Or read it directly, and hang up from a tool.
const details = await ai.getCall({ callId });
await ai.endCall({ callId });
```

### Pointing a Number at Your Webhook

```ts
const [number] = await ai.listPhoneNumbers({ phoneNumber: '+15557650000' });
await ai.updatePhoneNumber({
  id: number.id,
  voiceUrl: 'https://api.example.com/voice/incoming',
  statusCallbackUrl: 'https://api.example.com/voice/status',
});
```

## Security

Security is enabled by default with `standard` mode.

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  security: {
    level: 'strict',
    input: {
      injectionDetection: { enabled: true, onDetection: 'block' },
      pii: {
        enabled: true,
        action: 'mask',
        detect: ['email', 'phone', 'credit-card', 'aws-key', 'private-key'],
      },
      secrets: { enabled: true, action: 'block' },
    },
    output: {
      piiRedaction: true,
      maxContentLength: 8000,
    },
  },
});
```

Security levels:

- `off`
- `basic`
- `standard`
- `strict`
- `paranoid`

Useful helpers:

- prompt-injection detection and optional neutralization
- PII and secret detection
- output redaction
- URL and tool allowlist checks
- reusable policies through `guardrailPolicy(...)`
- `hardenPrompt(...)` for clearly delimiting untrusted input
- `createFetchUrlTool(...)` with DNS pinning, redirect validation, private-network blocking, and
  bounded response reads

CLI scans and audit records redact detected values by default. `nexus scan --reveal-values` is
restricted to an interactive terminal; raw audit data requires both `includeSensitiveData: true`
and an explicit custom sink.

## Caching, Jobs, and Evals

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  cache: {
    enabled: true,
    strategy: 'hybrid',
    ttlSeconds: 600,
    semantic: { enabled: true, similarityThreshold: 0.86 },
  },
});
```

Available runtime helpers:

- exact and semantic cache
- Redis and SQLite cache adapters
- batch completion with concurrency control
- in-memory job queue
- Redis and BullMQ queue adapters
- eval runner with quality, operations, RAG, safety metrics, and optional LLM-as-judge scoring
- voice sessions for multi-turn calls with conditional task prompts and app tools
- realtime sessions with WebRTC/WebSocket transports, interruption, tools, metrics, and conversation exports
- workflow templates for RAG answers, extraction, classification, comparison, support, sales, legal review, and code review

Use a plain assertion for small evals, or add an LLM judge when a rubric is more useful than exact matching:

```ts
import { LLMJudge } from 'nexus-ai-pro/evals';

const judge = new LLMJudge({
  client: ai,
  model: 'openai/gpt-4.1-mini',
  rubric: 'Score whether the answer is correct, concise, and grounded in the supplied context.',
  passThreshold: 0.7,
});

const run = await ai.runEvals([
  {
    name: 'support answer quality',
    request: {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain our refund policy.' }],
    },
    expected: 'Refunds are available within 30 days.',
    judge: judge.asEvalJudge(),
  },
]);
```

## Observability and Reliability

```ts
const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Trace this request.' }],
});

console.log(response.meta.pipeline?.steps);
console.log(ai.getMetricsSnapshot());
console.log(ai.getPrometheusMetrics());
console.log(await ai.checkProviders());
```

Structured logging can be injected without replacing audit logs or metrics:

```ts
const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY!)
  .direct('gpt-5.4-mini')
  .logger({
    console: false,
    sink: (event) => myLogger.info(event),
  })
  .create();
```

Production controls include:

- request timeouts
- provider retries
- health-aware routing
- estimated cost budgets
- pipeline traces
- Prometheus metrics
- OpenTelemetry metrics and trace export helpers
- audit log sink
- structured logger sink
- rate limiting

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
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { OpenAIWebRTCTransport } from 'nexus-ai-pro/realtime/openai-webrtc';
import { TelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
import { createTelephonyRealtimeBridge } from 'nexus-ai-pro/telephony/realtime-bridge';
```

Provider SDKs are optional peer dependencies. The package ships ESM and CommonJS builds, supports Node.js 22+, and is marked with `sideEffects: false`. Only the entry points listed in the package export map are public; deep imports into `dist`, `dist-cjs`, or `src` are unsupported.

## Examples

```bash
npm run example:minimal
npm run example:create-nexus
npm run example:config-builder
npm run example:custom-provider
npm run example:feature-flags
npm run example:basic
npm run example:security
npm run example:optimizer
npm run example:agent
npm run build && npx tsx examples/realtime-scheduling.ts
npx tsc -p tsconfig.examples.browser.json
```

Repository example files cover:

- OpenTelemetry with Node HTTP and Express
- BullMQ workers
- OCR/PDF ingestion
- persisted vector stores
- classifier calibration
- domain workflows
- custom providers
- deterministic realtime scheduling with tools, confirmation, metrics, and conversation exports
- import examples under `examples/exports`

## Test Commands

```bash
npm install
npm run check
npm run check:release
```

`check` runs formatting and lint gates, source/test/example type checks, the build, unit and mock
conformance tests, coverage thresholds, package import checks, and an external type-consumer test.
`check:release` additionally verifies the dry-run tarball and a clean packed-package install.

Real provider conformance is opt-in:

```bash
npm run test:conformance:real
```

## Roadmap

1.4.0 closed the completion-request gap: prompt caching, reasoning controls, tool and sampling
controls, structured usage with numeric cost, and capability negotiation with registry provenance.

Next is durable execution — an operation state machine, provider batch APIs, distributed rate
limiting and circuit breaking, first-class embeddings, and filesystem/S3 asset stores — followed by
image portability and promotion out of experimental. See [ROADMAP.md](./ROADMAP.md).

## Production Notes

- Use direct or rules-based routing when model choice is already known.
- Keep semantic cache, semantic security, and custom hooks off latency-sensitive routes unless needed.
- Disable response traces with `pipeline.includeTraceInResponse = false`.
- Use shared adapters for distributed apps instead of process memory.
- Treat bundled model pricing and context metadata as defaults, not financial truth.
- Keep server-side authorization and provider moderation around high-risk workflows.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
