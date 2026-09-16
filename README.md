# nexus-ai-pro

The Universal AI Pipeline for Node.js: one typed API for routing, guardrails, caching, context-window management, tools, RAG, evals, jobs, and provider failover.

Use the whole pipeline for production AI features, or turn pieces off when you only need a thin provider wrapper.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Contributing, testing, and release procedure: [CONTRIBUTING.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/CONTRIBUTING.md)
- Delivered work and what is planned next: [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md)

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
- build stateful graphs with cycles, fan-out, subgraphs, human approval, and resumable checkpoints
- trip routing away from a failing provider, and share one rate-limit budget across workers
- reach the providers' half-price asynchronous batch tier behind one operation handle
- persist generated media to disk or S3 with tenant isolation, retention, and checksums
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

## Graphs

A graph is nodes, edges, and typed state. Cycles, fan-out, subgraphs, and human approval are
supported shapes rather than workarounds, and every run is checkpointed, so it is resumable by
construction rather than after configuring a checkpointer.

```ts
import { createGraph, appendList, counter, END, MemoryGraphCheckpointer } from 'nexus-ai-pro/graph';

const graph = createGraph({
  channels: { messages: appendList<string>(), turns: counter() },
})
  .addNode('research', async (ctx) => ({ messages: [await search(ctx.state.messages)], turns: 1 }))
  .addNode('answer', async (ctx) => ({ messages: [await ai.complete(...).then((r) => r.content)] }))
  .setEntry('research')
  .addConditionalEdges('research', (state) => (state.turns >= 3 ? 'answer' : 'research'))
  .addEdge('answer', END)
  .compile({ checkpointer: new MemoryGraphCheckpointer() });

const result = await graph.invoke({ messages: ['who won?'] }, { threadId: 'q-42' });
```

**Channels, not assignment.** Each state slot declares how writes combine — `lastValue`,
`appendList`, `appendSet`, `mergeObject`, `counter`, or your own `reducerChannel`. That is what makes
fan-out safe: two branches running in the same superstep can both write, and the channel decides
whether that means overwrite, append, or sum. Assignment would silently drop one branch's work.

**Cycles are first-class**, so `maxSteps` is what stands between a mistaken router and an infinite
loop. Exceeding it names the nodes still pending rather than hanging.

**Branches run in parallel.** Every task in a superstep starts together, so four branches of three
seconds each finish in about three seconds rather than twelve:

```ts
.addConditionalEdges('plan', () => ['research-a', 'research-b', 'research-c', 'research-d'])
```

`maxConcurrency` caps how many run at once — 16 by default, settable per compile and per run, and
`1` restores strictly sequential execution. Whatever the timing, writes are reduced in task order, so
a replay produces the same state. A superstep with one task skips the scheduler entirely.

**Fan out over data decided at run time.** Edges can only name nodes that already exist. `Send`
creates one task per value instead, each reading its own `context.input`:

```ts
import { Send } from 'nexus-ai-pro/graph';

.addNode('research', async (ctx) => ({ findings: [await fetch(ctx.input as string)] }), { ends: [END] })
.addConditionalEdges('plan', (state) => state.urls.map((url) => new Send('research', url)))
```

Fifty-seven URLs become fifty-seven tasks of one node in a single superstep, bounded by
`maxConcurrency` and checkpointed individually, so a resume re-runs only the copies that did not
finish. Declaring `ends` keeps compile-time reachability checks exact.

**Retries and timeouts per node.** A node that calls a flaky service can retry on its own, without
wrapping every node body in the same try/catch:

```ts
.addNode('fetch', fetchNode, {
  retry: { maxAttempts: 3, initialIntervalMs: 500, backoffFactor: 2, jitter: true },
  timeoutMs: 10_000,
})
```

Retrying defaults to off, because only you know whether a node is idempotent; `compile({ retry })`
sets a default for every node. Interrupts, aborts, and validation errors are never retried.
`context.attempt` tells a node which try it is on, and a timeout aborts the node's signal and fails
that attempt. When one task fails, its siblings are aborted by default; `onNodeError: 'settle'` lets
them finish first, and either way what they already wrote is kept.

**Several questions at once.** Parallel tasks can each interrupt. The paused result carries every
pending question, and they can be answered together or a few at a time:

```ts
const run = await graph.invoke(input, { threadId });
await graph.resumeInterruptsWith(threadId, {
  [run.interrupts[0].id]: true,
  [run.interrupts[1].id]: 'use the second draft',
});
```

**Human in the loop.** A node calls `interrupt()`; the graph checkpoints and stops:

```ts
.addNode('approve', (ctx) => ({
  approved: ctx.interrupt<boolean>({ reason: 'Publish this draft?', payload: { chars: 1200 } }),
}))
```

```ts
const run = await graph.invoke(input, { threadId });
if (run.status === 'awaiting_input') {
  // Hours later, in another process:
  await graph.resumeWith(threadId, true);
}
```

The interrupted node runs again from the top and `interrupt()` returns the supplied value instead of
throwing, so the node body reads as straight-line code either way. Keep the work before an interrupt
cheap, because it happens twice. A sibling branch that already finished is **not** re-run — its
writes were checkpointed before the graph suspended.

**Time travel and inspection.** Every superstep is a checkpoint:

```ts
await graph.state(threadId);        // latest checkpoint
await graph.history(threadId);      // newest first
graph.resumeFrom(threadId, 3);      // rewind and run forward
```

**Durable by construction.** The default checkpointer is in-process, holding up to 1,000 threads;
pass `checkpointer: false` to turn checkpointing off. Point it at the operation store
that already backs durable operations and a thread survives a restart — a different worker resumes
what another suspended:

```ts
import { OperationStoreCheckpointer } from 'nexus-ai-pro/graph';
import { RedisOperationStore } from 'nexus-ai-pro/operations/adapters';

const checkpointer = new OperationStoreCheckpointer(new RedisOperationStore(redis));
```

Writes are compare-and-set on the record's sequence, so two workers advancing the same thread cannot
both win.

**Subgraphs.** A compiled graph is a node:

```ts
parent.addNode('research', researchGraph.asNode());
```

Channels shared by name are passed in and merged back; anything the parent does not declare stays
private to the subgraph.

The graph is not in the root import. It costs nothing to a user who does not build graphs.

## Provider Batch Tiers

Both OpenAI and Anthropic sell an asynchronous tier at roughly half price, in exchange for a
completion window measured in hours. Local `runBatch()` concurrency cannot reach it — it is a
different API. `BatchManager` puts both behind one operation handle.

```ts
import { createGraph } from 'nexus-ai-pro/graph';
import { BatchManager } from 'nexus-ai-pro/batch';
import { OpenAIBatchProvider } from 'nexus-ai-pro/batch/openai';

const batch = new BatchManager({
  providers: { openai: new OpenAIBatchProvider({ apiKey: process.env.OPENAI_API_KEY! }) },
  defaultProvider: 'openai',
});

const handle = await batch.submit({
  model: 'gpt-5.4-mini',
  idempotencyKey: `nightly-${date}`,
  items: documents.map((document) => ({
    customId: document.id,
    request: { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: document.text }] },
  })),
});

console.log(handle.id);        // persist this, do not block a request on the result
```

`customId` is required, not optional. A batch provider does not guarantee output order, and matching
results by position is exactly the bug that silently mislabels every row. Duplicates are refused
before submission for the same reason.

The handle settles when the provider finishes, which can be hours later, so treat it as a background
operation:

```ts
const result = await handle.result();

result.status;              // completed | failed | expired | cancelled
result.counts;              // { total, completed, failed }
result.items;               // one entry per customId, with response or error
result.cost.amount;         // priced per item, then discounted at the provider's batch rate
```

A mixed batch is normal: individual items carry their own `error` while the batch still reports
`completed`. Nothing is invented for a failed batch — `items` comes back empty rather than padded.

**Surviving a restart.** Everything after `submit` takes only a `BatchJobRef`, which is
JSON-serializable. A worker that never submitted the batch can collect it:

```ts
const ref = { id: savedBatchId, provider: 'openai' };

await batch.status(ref);     // provider-side state, without waiting
const result = await batch.resume(ref);
await batch.cancel(ref);
```

Polling backs off from the configured interval up to `maxPollIntervalMs`, so a 24-hour batch does
not generate 2,880 polls while a fast one is still caught by the first few short intervals.

## Asset Stores

`AssetStore` has three implementations. They share one contract, so retention, tenant isolation, and
checksums behave identically:

```ts
import { MemoryAssetStore } from 'nexus-ai-pro/images/assets';
import { FilesystemAssetStore, S3AssetStore } from 'nexus-ai-pro/images/stores';

const store = new FilesystemAssetStore({ directory: '/var/lib/app/assets', defaultTtlSeconds: 86_400 });

const s3 = new S3AssetStore({
  client,                    // structural: S3, R2, MinIO, or a test double
  bucket: 'generated-media',
  prefix: 'nexus-assets/',
});
```

A missing asset and one owned by another tenant are **indistinguishable** — both return `undefined`
rather than a permission error, because a distinguishable error leaks the existence of another
tenant's asset.

Both durable stores write two objects per asset: the bytes, and a JSON sidecar holding the
descriptor, tenant, and expiry. A single shared index would be a write-contention point and a
corruption blast radius; per-asset sidecars let concurrent writers proceed and lose at most one
record. `purgeExpired()` is exact but costs a directory listing, so on a large S3 bucket prefer the
provider's own lifecycle rules and keep this as the fallback.

## Model Registry Generation

The registry is generated from versioned provider data in `data/models/`, not hand-edited. The
Claude 5 reasoning bug fixed in 1.4.0 was exactly the kind of error a hand-written literal of 100+
models invites.

```bash
npm run registry:generate   # data/models/*.json -> src/models/generated.ts
npm run registry:check      # fails if the committed output is stale
```

`registry:check` runs as part of `npm run check`, so committed data and committed output cannot
drift apart. The generator validates required fields, price signs, context bounds, status values,
and that every alias points at a model that exists — a dangling alias otherwise fails only when a
request happens to use it.

The runtime still reads the hand-written `KNOWN_MODELS`; a test asserts the generated registry
matches it exactly. Swapping the runtime over is deliberately a separate change, so introducing the
generator cannot quietly alter pricing data in the same release.

`src/models/generated.ts` and `data/` are build-time artifacts and are **not** published. They
duplicate `KNOWN_MODELS` exactly, and shipping them in both builds would add roughly 310KB to every
install for data nothing reads. Both live in the repository, where a diff is what you actually want.

## Resilience: Circuit Breaking and Distributed Limits

Health monitoring ranks a struggling provider lower. A circuit breaker is the stronger step: while a
circuit is open the provider is removed from routing entirely, so a hard-down provider stops
absorbing one failed attempt per request.

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! }, anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  health: { enabled: true },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,        // consecutive failures that open the circuit
    failureRateThreshold: 0.5,  // or half the calls failing in the window
    minimumThroughput: 10,
    resetTimeoutMs: 30_000,     // cooldown before a probe
    halfOpenMaxCalls: 1,
    onStateChange: (event) => logger.warn('circuit', event),
  },
});

ai.getCircuitBreakerStatus();   // state, failure rate, retryAt per provider
ai.resetCircuitBreaker('openai');
```

Two independent triggers, because they catch different failures. A consecutive count catches a
provider that is hard down. A failure *rate* catches one that fails half its calls without ever
failing several in a row — invisible to a consecutive counter. The rate is only considered once
`minimumThroughput` calls have been seen, since one failure out of two is not evidence of anything.

After the cooldown the circuit goes half-open and admits a limited number of probes. A successful
probe closes it; a failed probe reopens it and restarts the cooldown. If *every* circuit is open the
router routes anyway — that usually means a shared dependency is down, and one attempt beats a
certain failure with no attempt at all.

`isFailure` keeps errors that are not the provider's fault out of the calculation:

```ts
circuitBreaker: {
  enabled: true,
  isFailure: (error) => !(error instanceof Error && error.name === 'AbortError'),
}
```

**Distributed rate limiting.** The built-in limiter is process-local, which multiplies the real
limit by the number of workers. Pointing it at a shared store fixes that, and the same budget then
covers completions and embeddings alike:

```ts
import { RedisRateLimitStore } from 'nexus-ai-pro/ops/rate-limit-adapters';

const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  rateLimit: {
    enabled: true,
    maxRequests: 100,
    windowMs: 60_000,
    key: 'userId',
    store: new RedisRateLimitStore(redis),
  },
});
```

Prefer a client exposing `eval`: the increment and the expiry then happen in one atomic round trip.
Without it the store falls back to `INCR` plus `PEXPIRE` and re-arms any missing TTL it sees, so a
crash between the two calls cannot block a key forever.

`NexusRateLimitError` carries `resetAt` and `retryAfterSeconds`, so a gateway can answer with a
real `Retry-After` header:

```ts
catch (error) {
  if (error instanceof NexusRateLimitError) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds ?? 60));
  }
}
```

Omitting `store` keeps the original synchronous in-memory path, which costs no extra microtask per
request.

## Durable Operations

Long-running work — an image render, a batch, anything asynchronous — runs through one lifecycle:
`queued → running → succeeded | failed`, with `retrying`, `cancelling`, `cancelled`, and `expired`
covering the rest. `OperationRunner` owns it end to end, so a crashed worker does not lose work.

The default store is in-process, so the small case needs no infrastructure:

```ts
import { BatchManager } from 'nexus-ai-pro/batch';
import { OpenAIBatchProvider } from 'nexus-ai-pro/batch/openai';
import { FilesystemAssetStore, S3AssetStore } from 'nexus-ai-pro/images/stores';
import { CircuitBreaker } from 'nexus-ai-pro/ops/circuit-breaker';
import { RedisRateLimitStore } from 'nexus-ai-pro/ops/rate-limit-adapters';
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
dimensions fail before a provider call rather than being silently dropped.

### Three backends, one contract

The same request runs against OpenAI, Google Imagen, or a self-hosted ComfyUI server. Each adapter is
its own subpath, so an application loads only the backends it registers.

```ts
import { ComfyUIImageProvider } from 'nexus-ai-pro/images/comfyui';
import { GoogleImageProvider } from 'nexus-ai-pro/images/google';

const portable = new NexusAI({
  providers: {},
  images: {
    defaultProvider: 'google',
    providers: {
      openai: openaiImages,
      google: new GoogleImageProvider({ apiKey: process.env.GEMINI_API_KEY! }),
      local: new ComfyUIImageProvider({ baseUrl: 'http://127.0.0.1:8188' }),
    },
  },
});
```

The backends really do differ, and negotiation says so instead of hiding it. Imagen sizes output by
aspect ratio and refuses `dimensions`. It honours `seed` and `negativePrompt`, which OpenAI refuses, and
setting a seed turns its watermark off, which the result reports as a warning. When Imagen filters some
images in a batch, you get the ones that passed plus a withheld finding for each missing one. ComfyUI
queues work and polls for it, records the seed it used so any run can be reproduced, and removes an
abandoned prompt from the server queue. Its graph is yours: pass a `workflow` builder, or use the bundled
`comfyTextToImageWorkflow` and `comfyInpaintWorkflow`.

### Masked edits

Draw the mask once, with either polarity. Each adapter converts it to what its backend expects:
OpenAI's alpha channel, or Imagen's and ComfyUI's white-is-editable greyscale.

```ts
const edited = await portable.images.edit({
  provider: 'openai',
  prompt: 'Replace the sky with a sunset',
  input: { location: { kind: 'bytes', data: photo }, mimeType: 'image/png' },
  mask: {
    location: { kind: 'bytes', data: maskPng },
    mimeType: 'image/png',
    polarity: 'white-is-editable',
    resizeMode: 'reject', // or 'stretch' | 'contain' | 'cover'
  },
});
```

A mask whose size differs from the image is refused unless `resizeMode` allows resampling.
Partly transparent mask pixels count as non-editable, so a soft brush edge never widens the edit.
The PNG codec behind the bundled `PngMaskTransformer` loads on the first masked request, so an
application that never masks never loads it. To accept JPEG or WebP masks, pass your own
`maskTransformer`.

### Validating inputs

Byte uploads, remote URLs, and stored assets all go through the same checks before any provider sees
them:

```ts
import { createImageInputResolver } from 'nexus-ai-pro/images/inputs';

const guarded = new NexusAI({
  providers: {},
  images: {
    providers: { google: googleImages },
    inputResolver: createImageInputResolver({
      maxBytes: 10 * 1024 * 1024,
      maxPixels: 16_000_000,
      allowedDomains: ['cdn.example.com'],
    }),
  },
});
```

The file's own bytes decide its type. A declared or served MIME type that disagrees is refused. Pixel
limits are checked from the header before decoding, so a small file that claims a huge canvas costs
nothing. Remote URLs use the same SSRF protection as the web connector: pinned DNS, redirect
revalidation, and blocking of private networks and cloud metadata endpoints. A refusal is an
`ImageInputError` whose `reason` is machine-readable (`too-large`, `mime-mismatch`, `blocked-url`, and
so on). Without a resolver, nothing runs and nothing is loaded.

### Visual moderation

```ts
import { combineSafetyPolicies, createOpenAIVisualModeration } from 'nexus-ai-pro/images/moderation';

const safety = combineSafetyPolicies(
  createOpenAIVisualModeration({ apiKey: process.env.OPENAI_API_KEY!, reviewThreshold: 0.4 }),
  myBrandPolicy,
);
```

Visual moderation screens the prompt, the input and reference images, and every generated image. An
innocuous prompt can still produce an unsafe image, so text-only checks are not enough. Scores map to
`block` or `review` findings, with per-category thresholds. If the moderation call itself fails, the
request is blocked unless you set `failOpen`.

### Evaluating media

`MediaEvalRunner` from `nexus-ai-pro/images/evals` scores what a string golden file cannot:

- prompt alignment, scored by your judge;
- rendered text, through your OCR function and edit distance;
- whether an edit preserved the rest of the image, through a perceptual hash that survives re-encoding;
- whether content was blocked when it should have been, reported as false-positive and false-negative
  rates.

Each case runs several times and reports mean, spread, and a 95% interval. Scores inside a configured
uncertainty band go to a `ReviewQueue` for a person to judge instead of being decided automatically.

Image support is still marked experimental. The adapters are verified against recorded wire shapes
and a shared conformance suite, which now includes a masked-edit case. The label comes off after the
opt-in live conformance suite passes against each hosted backend.

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

Provider SDKs are optional peer dependencies. The package ships ESM and CommonJS builds, supports Node.js 22+, and is marked with `sideEffects: false`. Only the entry points listed in the package export map are public; deep imports into `dist`, `dist-cjs`, or `src` are unsupported.

### What each import actually costs

Importing one piece loads one piece. The figures below are the transitive import graph of each entry
point, generated from the build by `npm run size:check`, which fails CI when an entry point grows
past its budget — so the numbers stay true rather than aspirational.

The last column is the part a file-size table usually hides: what an entry point forces you to
install. Most of them force nothing at all — `/graph`, `/operations`, `/images/*`, `/batch`,
`/embeddings` and the rest import no third-party package. The root import, `/core`, `/config`, and
`/security` do, because JSON-schema and Zod validation live there. A production install of this
package is about 10 MB of `node_modules`, of which 3 MB is this package; the clean-install test holds
that total to a ceiling too. `@types/node` accounts for a further 2.4 MB at install time but is types
only, so it never appears in an import graph.

<!-- size-table:start -->
| Import | Size | Share of root | Third-party install |
| --- | --- | --- | --- |
| `nexus-ai-pro` | 612 KB | 100% | +4.7 MB |
| `nexus-ai-pro/config` | 468 KB | 76% | +4.7 MB |
| `nexus-ai-pro/core` | 462 KB | 75% | +4.7 MB |
| `nexus-ai-pro/realtime` | 157 KB | 26% | none |
| `nexus-ai-pro/batch` | 118 KB | 19% | none |
| `nexus-ai-pro/realtime/session` | 94 KB | 15% | none |
| `nexus-ai-pro/embeddings` | 91 KB | 15% | none |
| `nexus-ai-pro/providers/groq` | 79 KB | 13% | none |
| `nexus-ai-pro/providers/mistral` | 79 KB | 13% | none |
| `nexus-ai-pro/providers/azure-openai` | 78 KB | 13% | none |
| `nexus-ai-pro/providers/openrouter` | 78 KB | 13% | none |
| `nexus-ai-pro/providers/deepseek` | 77 KB | 13% | none |
| `nexus-ai-pro/providers/llamacpp` | 77 KB | 13% | none |
| `nexus-ai-pro/providers/lmstudio` | 77 KB | 13% | none |
| `nexus-ai-pro/providers/openai` | 77 KB | 13% | none |
| `nexus-ai-pro/providers/anthropic` | 70 KB | 11% | none |
| `nexus-ai-pro/providers/google` | 66 KB | 11% | none |
| `nexus-ai-pro/images` | 65 KB | 11% | none |
| `nexus-ai-pro/providers/ollama` | 58 KB | 9% | none |
| `nexus-ai-pro/batch/openai` | 52 KB | 8% | none |
| `nexus-ai-pro/batch/anthropic` | 52 KB | 8% | none |
| `nexus-ai-pro/operations` | 49 KB | 8% | none |
| `nexus-ai-pro/batch/mock` | 47 KB | 8% | none |
| `nexus-ai-pro/providers/cohere` | 46 KB | 8% | none |
| `nexus-ai-pro/graph` | 46 KB | 8% | none |
| `nexus-ai-pro/realtime/openai-webrtc` | 46 KB | 8% | none |
| `nexus-ai-pro/security` | 40 KB | 7% | +3.4 MB |
| `nexus-ai-pro/models` | 35 KB | 6% | none |
| `nexus-ai-pro/images/inputs` | 31 KB | 5% | none |
| `nexus-ai-pro/realtime/openai-websocket` | 29 KB | 5% | none |
| `nexus-ai-pro/evals` | 23 KB | 4% | none |
| `nexus-ai-pro/images/transform` | 22 KB | 4% | none |
| `nexus-ai-pro/images/stores` | 22 KB | 4% | none |
| `nexus-ai-pro/telephony/twilio` | 21 KB | 3% | none |
| `nexus-ai-pro/telephony` | 20 KB | 3% | none |
| `nexus-ai-pro/images/openai` | 19 KB | 3% | none |
| `nexus-ai-pro/realtime/mock` | 19 KB | 3% | none |
| `nexus-ai-pro/voice` | 18 KB | 3% | none |
| `nexus-ai-pro/images/comfyui` | 17 KB | 3% | none |
| `nexus-ai-pro/embeddings/adapters` | 17 KB | 3% | none |
| `nexus-ai-pro/realtime/conversation` | 16 KB | 3% | none |
| `nexus-ai-pro/images/google` | 15 KB | 2% | none |
| `nexus-ai-pro/images/evals` | 15 KB | 2% | none |
| `nexus-ai-pro/images/assets` | 14 KB | 2% | none |
| `nexus-ai-pro/context` | 13 KB | 2% | none |
| `nexus-ai-pro/operations/adapters` | 13 KB | 2% | none |
| `nexus-ai-pro/realtime/tools` | 13 KB | 2% | none |
| `nexus-ai-pro/workflows` | 13 KB | 2% | none |
| `nexus-ai-pro/images/mock` | 12 KB | 2% | none |
| `nexus-ai-pro/optimizer` | 11 KB | 2% | none |
| `nexus-ai-pro/voice/session` | 11 KB | 2% | none |
| `nexus-ai-pro/providers` | 10 KB | 2% | none |
| `nexus-ai-pro/providers/base` | 10 KB | 2% | none |
| `nexus-ai-pro/embeddings/models` | 10 KB | 2% | none |
| `nexus-ai-pro/voice/openai` | 9 KB | 1% | none |
| `nexus-ai-pro/images/moderation` | 9 KB | 1% | none |
| `nexus-ai-pro/ops/circuit-breaker` | 8 KB | 1% | none |
| `nexus-ai-pro/realtime/openai-server` | 8 KB | 1% | none |
| `nexus-ai-pro/capabilities` | 8 KB | 1% | none |
| `nexus-ai-pro/telephony/realtime-bridge` | 7 KB | 1% | none |
| `nexus-ai-pro/providers/errors` | 5 KB | 0.8% | none |
| `nexus-ai-pro/embeddings/mock` | 5 KB | 0.8% | none |
| `nexus-ai-pro/cache/semantic-cache` | 5 KB | 0.8% | none |
| `nexus-ai-pro/evals/judge` | 5 KB | 0.8% | none |
| `nexus-ai-pro/operations/webhooks` | 4 KB | 0.7% | none |
| `nexus-ai-pro/ops/rate-limit-adapters` | 3 KB | 0.5% | none |
| `nexus-ai-pro/cache/memory-cache` | 3 KB | 0.5% | none |
| `nexus-ai-pro/cache` | 2 KB | 0.3% | none |
| `nexus-ai-pro/cache/adapters` | 2 KB | 0.3% | none |
| `nexus-ai-pro/rag` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs/durable-adapters` | 2 KB | 0.3% | none |
| `nexus-ai-pro/jobs/queue` | 2 KB | 0.3% | none |
| `nexus-ai-pro/streaming` | 1 KB | 0.2% | none |
| `nexus-ai-pro/providers/type-guards` | 1 KB | 0.2% | none |
| `nexus-ai-pro/jobs/batch` | 1 KB | 0.2% | none |
<!-- size-table:end -->

A capability that only works by importing the whole runtime is treated as a design problem, not an
acceptable cost.

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

See [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md) for what has
shipped and what is planned. It is a design proposal, not a compatibility promise; the guarantees
live in [API_STABILITY.md](./API_STABILITY.md).

Shipped so far:

- completion controls and capability negotiation;
- durable operations, provider batch tiers, and distributed resilience;
- first-class embeddings and graphs;
- per-entry-point size budgets.

The current work is image portability: three backends behind one contract, masked edits, validated
inputs, visual moderation, and media evaluation. Promotion out of experimental waits on live
conformance.

## Known Limitations

- Voice, telephony, images, local models, and custom providers are optional layers; enable only what
  you use.
- Audio and video preprocessing is limited, and provider modality support differs.
- Bundled model metadata is a routing and estimation convenience, not a pricing contract.
- Process-memory cache, queues, and asset storage are not enough for a distributed deployment; use
  the Redis, BullMQ, filesystem, or S3 adapters instead.
- Default hash embeddings suit tests and demos, not strong semantic search. Register a real
  embedding provider for production retrieval.
- NLI verification is an interface; bring a specialized verifier for high-confidence entailment.
- Guardrails reduce risk but do not replace application authorization, provider-side moderation, or
  human review of high-impact actions.
- Circuit-breaker state is per process, and realtime sessions are not yet routed through the metrics,
  audit, and rate-limit path that every other family uses.

## Production Notes

- Use direct or rules-based routing when model choice is already known.
- Keep semantic cache, semantic security, and custom hooks off latency-sensitive routes unless needed.
- Disable response traces with `pipeline.includeTraceInResponse = false`.
- Use shared adapters for distributed apps instead of process memory.
- Treat bundled model pricing and context metadata as defaults, not financial truth.
- Keep server-side authorization and provider moderation around high-risk workflows.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
