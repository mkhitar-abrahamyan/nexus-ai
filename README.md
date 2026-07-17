# nexus-ai-pro

The Universal AI Pipeline for Node.js: one typed API for routing, guardrails, caching, context-window management, tools, RAG, evals, jobs, and provider failover.

Use the whole pipeline for production AI features, or turn pieces off when you only need a thin provider wrapper.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Full technical notes and manual test cases: [NEXUS.md](./NEXUS.md)
- Planned image generation and infrastructure work: [ROADMAP.md](./ROADMAP.md)

## Install

```bash
npm install nexus-ai-pro
```

Requires Node.js 22 or newer. `nexus-ai-pro` is ESM-only: use `import` from an ES module rather than CommonJS `require()`.
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
import { guardrailPolicy } from 'nexus-ai-pro/security';
import { RedisCacheAdapter } from 'nexus-ai-pro/cache';
import { DeepSeekProvider } from 'nexus-ai-pro/providers/deepseek';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';
import { OpenAIWebRTCTransport } from 'nexus-ai-pro/realtime/openai-webrtc';
```

Provider SDKs are optional peer dependencies. The package is ESM-only, supports Node.js 22+, and is marked with `sideEffects: false`. Only the entry points listed in the package export map are public; deep imports into `dist` or `src` are unsupported.

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

The next recommended feature family is first-class image generation and editing through a
provider-neutral `ImageManager`, portable asset types, durable operation handles, visual safety,
asset storage, and media-specific evaluations. The design and prioritized infrastructure backlog
are in [ROADMAP.md](./ROADMAP.md).

## Production Notes

- Use direct or rules-based routing when model choice is already known.
- Keep semantic cache, semantic security, and custom hooks off latency-sensitive routes unless needed.
- Disable response traces with `pipeline.includeTraceInResponse = false`.
- Use shared adapters for distributed apps instead of process memory.
- Treat bundled model pricing and context metadata as defaults, not financial truth.
- Keep server-side authorization and provider moderation around high-risk workflows.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
