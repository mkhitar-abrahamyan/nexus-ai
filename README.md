# nexus-ai-pro

The Universal AI Pipeline for Node.js: one typed API for routing, guardrails, caching, context-window management, tools, RAG, evals, jobs, and provider failover.

Use the whole pipeline for production AI features, or turn pieces off when you only need a thin provider wrapper.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Full technical notes and manual test cases: [NEXUS.md](./NEXUS.md)

## Install

```bash
npm install nexus-ai-pro
```

Install only the provider SDKs your app uses:

```bash
npm install openai @anthropic-ai/sdk ollama
```

The Google Gemini provider uses Node.js `fetch`, so it does not need an extra SDK.

## Quick Start

```ts
import { NexusAI } from 'nexus-ai-pro';

const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    google: { apiKey: process.env.GOOGLE_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  routing: {
    mode: 'auto',
    strategy: 'quality',
  },
  security: 'standard',
  contextWindow: {
    strategy: 'last-messages-with-summary',
    lastMessages: 10,
    summary: { model: 'openai/fast', maxTokens: 600 },
  },
  tokenOptimizer: {
    densification: { enabled: true },
    budget: {
      enabled: true,
      maxInputTokens: 8000,
      onExceeded: 'densify',
    },
  },
});

const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Explain RAG in 3 bullet points.' }],
});

console.log(response.content);
console.log(response.meta.providerUsed);
console.log(response.meta.modelUsed);
```

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
- keep TypeScript types around every request and response

## Core Concepts

### Providers and Routing

```ts
const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    groq: { apiKey: process.env.GROQ_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
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

`plan()` does not call a provider. It estimates route, token use, context fit, cost, guardrail findings, and warnings.

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

All providers normalize streaming chunks to `text`, `tool_call`, `done`, or `error`.

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

Low-level realtime transport adapters are still future work; the current voice layer covers transcription, speech generation, full request/response voice turns, and stateful voice sessions with tool calls.

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

Production controls include:

- request timeouts
- provider retries
- health-aware routing
- estimated cost budgets
- pipeline traces
- Prometheus metrics
- OpenTelemetry metrics and trace export helpers
- audit log sink
- rate limiting

## Import Surface

The root import is convenient:

```ts
import { NexusAI } from 'nexus-ai-pro';
```

Focused subpaths are available for smaller imports:

```ts
import { NexusAI } from 'nexus-ai-pro/core';
import { TokenOptimizer } from 'nexus-ai-pro/optimizer';
import { ContextWindowManager } from 'nexus-ai-pro/context';
import { guardrailPolicy } from 'nexus-ai-pro/security';
import { RedisCacheAdapter } from 'nexus-ai-pro/cache';
```

Provider SDKs are optional peer dependencies. The package is ESM-first and marked with `sideEffects: false`.

## Examples

```bash
npm run example:minimal
npm run example:feature-flags
npm run example:basic
npm run example:security
npm run example:optimizer
npm run example:agent
```

Included example files cover:

- OpenTelemetry with Node HTTP and Express
- BullMQ workers
- OCR/PDF ingestion
- persisted vector stores
- classifier calibration
- domain workflows

## Test Commands

```bash
npm install
npm run build
npm test
npm run test:types
npm run test:clean-install
npm run test:conformance:mock
```

Real provider conformance is opt-in:

```bash
npm run test:conformance:real
```

## Production Notes

- Use direct or rules-based routing when model choice is already known.
- Keep semantic cache, semantic security, and custom hooks off latency-sensitive routes unless needed.
- Disable response traces with `pipeline.includeTraceInResponse = false`.
- Use shared adapters for distributed apps instead of process memory.
- Treat bundled model pricing and context metadata as defaults, not financial truth.
- Keep server-side authorization and provider moderation around high-risk workflows.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
