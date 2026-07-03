# Nexus AI Testing and Problem Guide

Package: `nexus-ai-pro`

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Human-friendly overview: [README.md](./README.md)
- Conceptual guide: [EXPLANATION.md](./EXPLANATION.md)

## Purpose

`nexus-ai-pro` gives Node.js apps one typed pipeline for production AI work:

- provider routing
- provider failover and retry
- normalized streaming
- guardrails for inputs and outputs
- context-window compaction for long chats
- token and cost planning
- exact and semantic cache
- tools and agent loops
- RAG, verification, evals, queues, workflows, metrics, and traces

The goal is not to hide every provider detail. The goal is to remove repeated app-level plumbing while still letting teams choose their own models, policies, adapters, and infrastructure.

## Problems It Solves

Building production AI apps usually means every project rewrites the same plumbing:

- one SDK wrapper per provider
- different stream formats
- brittle model fallback logic
- weak input validation
- prompt-injection and PII risk
- long conversation prompts that exceed model limits
- no cost preview before provider calls
- tool loops without iteration caps
- ad hoc RAG, eval, job, and cache wiring

`nexus-ai-pro` centralizes those concerns around `NexusAI`.

## What Is Implemented

Core runtime:

- `ai.complete(...)`
- `ai.stream(...)`
- `ai.agent(...)`
- `ai.plan(...)`
- `ai.batchComplete(...)`
- `ai.createQueue(...)`
- `createNexus(...)`
- `createNexusConfig(...)`

Provider adapters:

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
- custom providers through `providers.custom` or `registerProvider(...)`

CLI:

- `nexus scan`
- `nexus models`
- `nexus eval`
- `nexus optimize`

Pipeline layers:

- routing and fallback
- retry and timeout handling
- input/output security
- context-window management
- token optimization
- cost estimation and budgets
- caching
- metrics and provider health
- audit logs and rate limits
- pipeline hooks and custom steps
- structured logger hooks

Supporting modules:

- RAG helpers
- in-memory vector store
- document ingestion and upload scanning
- Chain of Verification
- self-consistency sampling
- eval runner and metrics
- optional LLM-as-judge eval scoring
- workflow templates
- web/search connector tools
- provider conformance fixtures
- Redis/SQLite cache adapter wrappers
- Redis/BullMQ queue adapter wrappers

## Voice Testing

Voice is implemented as an optional layer. Import size is controlled through subpaths:

- `nexus-ai-pro/voice` for provider-neutral types, errors, and `VoiceManager`
- `nexus-ai-pro/voice/openai` for the OpenAI voice adapter
- `nexus-ai-pro/telephony` for provider-neutral phone-call types and `TelephonyManager`
- `nexus-ai-pro/telephony/twilio` for the Twilio phone-number adapter

Current support:

- `ai.transcribe(...)`
- `ai.speak(...)`
- `ai.voice(...)`
- `ai.voiceTurn(...)`
- `ai.createVoiceSession(...)`
- `registerVoiceProvider(...)`
- configurable `voice.providers`
- custom voice providers
- OpenAI voice provider adapter
- full completion pipeline reuse after transcription
- stateful `VoiceSession` turns with prompts, task prompts, tool calls, history, and optional speech
- optional telephony providers for calls, webhook responses, webhook validation, and media-stream event parsing

Useful test cases:

- registered voice provider can transcribe
- registered voice provider can synthesize speech
- `ai.voice(...)` transcribes, appends transcript, calls `ai.complete(...)`, and optionally speaks
- `VoiceSession` can accept transcript or audio, select matching task prompts, execute tools, and speak
- `nexus-ai-pro/voice` imports without provider adapters
- `nexus-ai-pro/voice/openai` imports separately
- `nexus-ai-pro/voice/session` imports separately
- type consumer can configure `VoiceConfig`
- missing voice provider errors clearly
- registered telephony provider can create calls
- Twilio adapter can create inline-TwiML/media-stream calls
- Twilio webhook signatures can be validated
- Twilio media-stream messages can be normalized

Example:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  voice: {
    defaultTranscriptionProvider: 'openai',
    defaultSpeechProvider: 'openai',
    providers: {
      openai: new OpenAIVoiceProvider({ apiKey: process.env.OPENAI_API_KEY! }),
    },
  },
});

const result = await ai.voice({
  audio: { path: './call.wav', mimeType: 'audio/wav' },
  completion: {
    model: 'auto',
    messages: [{ role: 'system', content: 'Reply as support.' }],
  },
  speech: { provider: 'openai', voice: 'alloy', format: 'mp3' },
});
```

Still future work:

- audio chunks in `NexusStream`
- WebRTC/SIP session helpers
- fully managed Twilio/OpenAI realtime bridge

Telephony is intentionally separate from voice:

- `voice` handles file/buffer/stream audio turns.
- `VoiceSession` handles multi-turn call state and app/tool requests during a conversation.
- `telephony` handles phone numbers, TwiML, provider webhooks, and media-stream protocol messages.
- apps can use one, both, or neither.

## Context Window Testing

Context-window management is optional. It is enabled when `contextWindow` is present and `enabled !== false`.

Supported strategies:

- `last-messages`
- `last-tokens`
- `last-messages-with-summary`
- `last-tokens-with-summary`
- `auto`

Useful test cases:

- keep only the latest N non-system messages
- preserve system messages by default
- summarize older messages locally
- summarize older messages with a configured provider model
- fall back to local summary when provider summarization fails
- emit `response.meta.contextWindow`
- include `plan.contextWindow`
- preserve stream `done.meta.contextWindow`

Representative config:

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

## Test Commands

Run from the package root:

```bash
cd nexus-ai
npm install
npm run build
```

Quick CLI checks after build:

```bash
node dist/cli.js models --provider deepseek
node dist/cli.js scan src --no-fail
node dist/cli.js optimize README.md --model gpt-5.4-mini
```

Main test suite:

```bash
npm test
```

Focused checks:

```bash
npm run test:unit
npm run test:conformance:mock
npm run test:smoke
npm run test:api
npm run test:types
npm run pack:dry-run
```

Clean install packaging check:

```bash
npm run test:clean-install
```

Real provider conformance is opt-in:

```bash
npm run test:conformance:real
```

## Expected Test Meaning

`npm run build`:

- TypeScript compiles
- public declarations are generated under `dist`
- import paths are valid

`npm run test:unit`:

- routing behavior
- security behavior
- context-window behavior
- response-format validation
- provider error normalization
- streaming helpers
- failover behavior
- self-consistency behavior

`npm run test:conformance:mock`:

- provider adapter contract shape
- normalized complete and stream behavior
- mocked health checks

`npm run test:smoke`:

- package subpath exports can be imported
- public package entry points are not broken

`npm run test:api`:

- root exports match the intended public API
- `package.json` export map contains expected subpaths

`npm run test:types`:

- a temporary external TypeScript project can install the packed package and compile against its types

## Provider Credentials

Real provider tests need credentials. On Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="your_key"
$env:ANTHROPIC_API_KEY="your_key"
$env:GOOGLE_API_KEY="your_key"
$env:GROQ_API_KEY="your_key"
$env:MISTRAL_API_KEY="your_key"
$env:COHERE_API_KEY="your_key"
$env:OPENROUTER_API_KEY="your_key"
```

Ollama real tests require a local server and model:

```bash
ollama serve
ollama pull llama3.2
```

Real conformance should skip unavailable providers rather than failing the whole suite when credentials are missing.

## Manual Smoke Checklist

Before publishing, verify these scenarios:

- direct OpenAI-style completion
- direct local Ollama completion
- `model: 'auto'` routing
- streaming response
- strict JSON response format
- blocked prompt-injection input
- PII redaction in output
- long chat with `contextWindow`
- token budget warning or truncation
- exact cache hit
- semantic cache hit, if embeddings/config are enabled
- RAG response with citations
- agent tool call with max iteration cap
- `ai.plan(...)` warning for too-large prompts
- `response.meta.pipeline.steps` when tracing is enabled
- package import from root and subpaths

## Known Limitations

- Voice support is not a complete runtime yet.
- Audio/video preprocessing is limited.
- Some providers support modalities differently; unsupported content may be converted to text placeholders.
- The built-in model registry is a convenience default, not a source of pricing truth.
- Provider pricing, regional availability, context windows, and aliases can change.
- The default vector store uses deterministic hash embeddings unless a real embedding provider is passed.
- NLI verification is an interface; bring a specialized verifier for stronger entailment.
- Security checks are guardrails, not a complete security boundary.
- Process-memory cache and queues should be replaced with shared adapters in distributed deployments.

## Maintenance Notes

When adding new public features:

- add type exports in `src/index.ts`
- add subpath exports in `package.json` if useful
- update `tests/api-contract.mjs`
- update `tests/package-smoke.mjs`
- update `tests/type-consumer.mjs`
- add focused unit tests
- mention the feature in README only once, in the most relevant section
- keep `EXPLANATION.md` conceptual and `NEXUS.md` operational

When adding voice integrations:

- start with provider-neutral request/response types
- keep transcription, speech synthesis, and realtime sessions separate
- route transcript text through existing security/context layers
- avoid logging raw audio by default
- add mock conformance fixtures before real provider fixtures
