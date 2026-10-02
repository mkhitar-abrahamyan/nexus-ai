# Voice

<!-- covers: ./voice ./voice/openai ./voice/session -->

Speech-to-text and text-to-speech from `nexus-ai-pro/voice`: transcribe, speak, run a full voice turn through a model, or keep a multi-turn voice session, with an OpenAI adapter on `nexus-ai-pro/voice/openai` and a contract for your own provider.

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
provider events, use the [realtime guide](./realtime.md). Neither API replaces the other.

## Requests and responses

`TranscriptionRequest` takes the audio as a `VoiceAudioInput`: a file path, a URL, bytes, base64
text, or a readable stream. Each can carry a file name and MIME type, for providers that infer the
format from them.

| Field | What it sets |
| --- | --- |
| provider, model, language | Where and how it is transcribed. |
| `prompt` | Guides spelling and names. |
| temperature | Sampling. |
| `responseFormat` | The provider's format: text, JSON, verbose JSON with timings, or subtitles. |
| `timestampGranularities` | Asks for timings by segment, word, or both. |
| signal, metadata | Cancellation, and application data. |

`TranscriptionResponse` has the text, the provider and model, the language, and the audio's duration.
When asked for, it also has timed `TranscriptionSegment` and `TranscriptionWord` values. The
provider's raw response is included.

`SpeechRequest` takes the text, and optionally:

- the provider, model, and voice;
- a `VoiceAudioFormat`: `mp3`, `wav`, `opus`, `aac`, `flac`, `pcm`, `webm`, or `ogg`;
- the speaking rate, and `instructions` for models that take direction on tone and pace;
- a signal, and metadata.

`SpeechResponse` carries the audio as a `VoiceAudioOutput` — the bytes, their format, and MIME type —
with the provider, model, and voice that produced it.

`VoiceTurnRequest` is a whole turn for `ai.voice()`: listen, answer, and speak.

| Field | What it sets |
| --- | --- |
| audio, or `transcript` | What the user said, as audio or as text already transcribed. |
| transcription settings | How the audio is transcribed. |
| `completion` | The request that answers. |
| `transcriptMessage` | How the transcript joins that request. |
| `speech` | Speech settings, or `false` for a text-only answer. |

`VoiceTranscriptMessageConfig` is the `transcriptMessage` setting. `append: false` leaves the
transcript out, for a prompt that already includes it. `role` makes it a user or system message, and
`template` places it with `{{transcript}}`.

`VoiceTurnResponse` returns the transcription, the text answered, the completion's response, and the
speech.

## Providers and the manager

A `VoiceProvider` is `info` and two optional methods, `transcribe()` and `speak()`. Each receives the
call's `ProviderCallContext` as its second argument, since every transcription and every utterance
runs through the client's [lifecycle](./lifecycle.md).
`VoiceProviderInfo` gives its name, whether it runs locally, and `supports`, which operations it
implements. `VoiceConfig` is the client's `voice` option: the default transcription and speech
providers and the providers by name.

`VoiceManager` routes each request to the provider it names, else the configured default, else the
first provider that supports the operation. The client uses it, and it also works alone with any
`VoiceCompletionClient` — anything with `complete()`.

| Methods | What they do |
| --- | --- |
| `registerProvider()`, `hasProvider()`, `listProviders()` | Manage providers. |
| `transcribe()`, `speak()`, `runTurn()` | Do the work. |
| `createSession()` | Starts a session. |

Two errors cover failures. `VoiceProviderError` means a provider failed, the named provider is not
registered, or no provider supports the operation; it names the provider and carries the cause.
`VoiceCapabilityError` means the named provider lacks the operation.

`OpenAIVoiceProvider`, from `nexus-ai-pro/voice/openai`, takes `OpenAIVoiceProviderConfig`: the API
key, base URL, organization, `transcriptionModel` (`gpt-4o-transcribe` by default), `speechModel`
(`gpt-4o-mini-tts`), `defaultVoice` (`alloy`), extra headers, and a `fetch`.

## Sessions

`VoiceSessionConfig` sets up a conversation.

| Field | What it sets |
| --- | --- |
| `systemPrompt`, `prompt`, `instructions` | Prompt text, joined in that order. Each is a `VoicePromptText`: one string, or several joined with blank lines. |
| `taskPrompts` | Prompts that apply only when their task matches. |
| `messages` | The conversation so far. |
| `tools`, `toolSelection` | The tools, and which are offered: `all`, or `task` for only the matched task prompts' tools (every tool when none matched). |
| `maxToolIterations` | Rounds of tool calls per turn. Defaults to 4. |
| sampling, `responseFormat`, `stop`, `userId`, `metadata` | Passed to each completion. |
| transcription, transcript message, speech | Settings every turn shares. |
| `maintainHistory` | Keeps the conversation between turns. On by default. |
| `onToolCall` | Called after each tool call. |

A `VoiceTaskPrompt` has a name, prompt text and instructions added when it applies, the tools it
needs, and `when`, a `VoiceTaskPromptMatcher`: a substring, a pattern, a list of either, or a function
that receives a `VoiceTaskPromptMatcherInput` — the turn's transcript, the conversation, and its
metadata. A task prompt without `when` always applies.

`session.handleTurn()` takes a `VoiceSessionTurnInput`: audio or a transcript, and settings for this
turn only — transcription, speech, completion fields merged over the session's, and extra prompt
text, instructions, task prompts, and tools. It returns a `VoiceSessionTurnResponse`: the session
id, the transcription and the text answered, the response, the speech, each tool call as a
`VoiceSessionToolStep` (its round, call id, tool, arguments, and result or error), the task prompts
that matched, and the conversation after the turn. `getHistory()` copies the conversation, and
`reset()` starts it over.

`VoiceSession`, from `nexus-ai-pro/voice/session`, can be built without a client: it takes the
configuration, a `VoiceSessionRuntime` (anything with `transcribe()` and `speak()`, such as a
`VoiceManager`), and a `VoiceSessionCompletionClient`.

## Limitations

- Each turn is a request and a reply: the user finishes speaking, then the answer is produced. For
  interruption and streamed audio, use realtime.
- `OpenAIVoiceProvider` is the only bundled adapter; others implement `VoiceProvider`.
- Audio preprocessing is limited to what the provider does: no resampling, denoising, or format
  conversion happens here, and providers differ in the formats and languages they accept.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/voice`

| Export | Kind | Summary |
| --- | --- | --- |
| `SpeechRequest` | interface | Turns text into speech. |
| `SpeechResponse` | interface | Synthesized speech and what produced it. |
| `TranscriptionRequest` | interface | Turns speech into text. |
| `TranscriptionResponse` | interface | A transcription. |
| `TranscriptionSegment` | interface | A stretch of transcribed speech with its timing. |
| `TranscriptionWord` | interface | One transcribed word with its timing. |
| `VoiceAudioFormat` | type | Audio encodings voice providers accept and produce. |
| `VoiceAudioInput` | type | Audio to transcribe: a file path, a URL, bytes, base64 text, or a readable stream. |
| `VoiceAudioOutput` | interface | Synthesized speech. |
| `VoiceCapabilityError` | class | Raised when a provider does not support transcription, speech, or realtime. |
| `VoiceCompletionClient` | interface | The part of a client a voice turn needs. |
| `VoiceConfig` | interface | Voice providers available to a client. |
| `VoiceManager` | class | Routes speech-to-text and text-to-speech to registered providers: the one a request names, the configured default, or the first that supports the operation. |
| `VoicePromptText` | type | Prompt text: one string, or several joined with blank lines. |
| `VoiceProvider` | interface | A batch voice backend: transcription, speech, or both. |
| `VoiceProviderError` | class | Raised when a voice provider fails, or none is registered for an operation. |
| `VoiceProviderInfo` | interface | Identifies a voice provider and what it supports. |
| `VoiceSessionConfig` | interface | A multi-turn voice conversation: prompts, tools, history, and the transcription and speech settings every turn shares. |
| `VoiceSessionToolStep` | interface | One tool call a voice session made while answering a turn. |
| `VoiceSessionTurnInput` | interface | What one turn of a voice session receives. |
| `VoiceSessionTurnResponse` | interface | The outcome of one voice session turn. |
| `VoiceTaskPrompt` | interface | Instructions that apply only to turns about one task, so a session prompt stays short and each task still gets its detail. |
| `VoiceTaskPromptMatcher` | type | Decides whether a task prompt applies: a substring, a pattern, any of several, or a function. |
| `VoiceTaskPromptMatcherInput` | interface | What a task prompt's matcher sees when deciding whether it applies to a turn. |
| `VoiceTranscriptMessageConfig` | interface | How a transcript becomes a message in the completion that answers it. |
| `VoiceTurnRequest` | interface | One spoken turn: transcribe the audio, answer it, and speak the answer. |
| `VoiceTurnResponse` | interface | The outcome of a voice turn. |

### `nexus-ai-pro/voice/openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIVoiceProvider` | class | OpenAI speech-to-text and text-to-speech. |
| `OpenAIVoiceProviderConfig` | interface | Options for the OpenAI voice provider. |

### `nexus-ai-pro/voice/session`

| Export | Kind | Summary |
| --- | --- | --- |
| `VoiceSession` | class | A multi-turn voice conversation: each turn transcribes the user, answers with the model, and speaks the answer, keeping the history. |
| `VoiceSessionCompletionClient` | interface | The part of a client a voice session needs. |
| `VoiceSessionRuntime` | interface | The speech operations a voice session needs, such as a `VoiceManager`. |
<!-- reference:end -->
