# Testing with recorded traffic

<!-- covers: ./testing ./testing/record -->
<!-- sources: src/testing -->

Tests that call a provider need credentials. With recordings, they run everywhere else too.

- `nexus-ai-pro/testing/record` records provider traffic once, redacted, as fixture files you can
  review. It replays them with no network.
- Conformance suites check an adapter against the neutral contract. They run on the recordings in
  every pull request, and live where credentials are.

```ts
import { fixtureFetch } from 'nexus-ai-pro/testing/record';

// Replays by default. NEXUS_FIXTURES=record captures, NEXUS_FIXTURES=live bypasses.
const fetch = fixtureFetch({ directory: 'tests/fixtures/openai' });
const provider = new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY ?? 'replay', fetch });
```

## Recording and replaying

Recording writes one JSON file per exchange. Credential headers and query parameters are removed
before anything is written. A `redact` hook handles the rest, such as personal data in a prompt, with
a PII detector from `nexus-ai-pro/security`.

Replay serves the files back with no network. It matches requests by method, URL, and body, with
object keys sorted and multipart boundaries ignored. A request with no recording throws
`FixtureMissingError`, instead of reaching the live API.

```bash
npm run test:conformance:images       # replays image recordings; needs no credentials
npm run conformance:images:record     # records them; needs OPENAI_API_KEY, GOOGLE_API_KEY, or COMFYUI_URL
```

`fixtureFetch()` picks a `FixtureMode` of `record`, `replay`, or `live`. It reads its `mode` option,
then `NEXUS_FIXTURES`, and defaults to `replay`. So one test file serves all three. The pieces it
chooses between are exported too:

| Function | What it does |
| --- | --- |
| `recordingFetch()` | Wraps a real fetch and writes every exchange to the directory. |
| `replayFetch()` | Serves the recorded files back. |
| `readFixtures()` | Reads every `RecordedExchange` in a directory, to inspect or replay yourself. |
| `installFetch()` | Puts a fetch in place of the global one, for code that calls it directly. Call the function it returns to put the original back. |

`recordingFetch()` returns a `RecordingFetch`: a fetch with a `flush()`. Await `flush()` before a test
ends; it resolves once every fixture is on disk. `RecordOptions` add the real `fetch`, the `redact`
hook, a clock, and `timing`.

**Replaying a stream at its pace.** With `timing: true`, a recording keeps each chunk of the response
and when it arrived, as a `RecordedChunk` in the response's `chunks`. `ReplayOptions.pace`, a
`ReplayPace`, then decides how a replay sends them:

| Pace | Sends |
| --- | --- |
| `instant` (the default) | The whole body at once, as without timing |
| `original` | Each chunk when it arrived, relative to the first |
| A number | The gaps scaled: `0.1` is ten times faster |
| A function | Each chunk once the function resolves, so a test releases them one at a time |

A pacing function is told the chunk's position, how many there are, when it arrived, and the gap
before it, as `ReplayChunkInfo`. Paced replay is what tests idle timeouts, cancellation mid-stream,
backpressure, and a streaming UI against a real provider's rhythm.

```ts
const fetch = replayFetch({ directory, pace: 'original' });
```

`ReplayOptions` add `onMissing`. The default, `throw`, raises `FixtureMissingError` with the request's
method, URL, and match key, so you can find the recording that should have matched. `live` falls
through to the real `fetch` instead.

### Matching options

`FixtureOptions` are shared by recording and replay:

| Option | What it does |
| --- | --- |
| `directory` | Where the fixture files are. |
| `match` | Turns a request into its match key. |
| `ignoreBodyFields` | Top-level body fields that change between runs, such as a request id or a timestamp. |
| `redactHeaders`, `redactQuery` | More names to remove, beyond the credential names always removed. |

A custom `match` function receives a `MatchInput`: the method, the URL with credentials removed and the
query sorted, the redacted headers, and the body as text with multipart boundaries normalized.

### What a fixture holds

Each fixture file is one `RecordedExchange`:

- the match key, and its position among requests that share it. A request made three times replays
  three responses, in order.
- the `RecordedRequest` and the `RecordedResponse`;
- when it was recorded.

Bodies are text, or base64 for binary. Transport headers that `fetch` already applied, such as content
encoding, are left out, so replay never describes a body it no longer has.

## Conformance suites

Each suite checks an adapter against the neutral contract and returns one result per case. A test
asserts on the results; a report prints them. The suites are exported from the root.

### Chat providers

```ts
import { runProviderConformance } from 'nexus-ai-pro/testing';

const results = await runProviderConformance('openai', provider, { testStream: true, testTools: true });
assert.ok(results.every((result) => result.completeOk && result.streamOk !== false), JSON.stringify(results));
```

`runProviderConformance()` takes a provider name, a provider, and `ProviderConformanceOptions`:

| Option | What it does |
| --- | --- |
| `model` | Runs every case on one model. |
| `fixtures` | Replaces the default cases. |
| `testTools` | Adds a tool-calling case. |
| `testStream` | Also streams each case. |
| `testHealth` | Also runs the health check. |

Each `ProviderConformanceCase` is a request and a `validate` function. The defaults are a plain text
completion and a JSON response shape. `PROVIDER_CONFORMANCE_FIXTURES` holds them for each bundled
provider, with a model that provider serves. Each `ProviderConformanceResult` says whether completion,
streaming, and health passed, and what went wrong.

### Embedding providers

`runEmbeddingProviderConformance()` checks that a provider returns one vector per input, in order, all
of one width, with finite components, and that it honors a requested `dimensions`.

- `EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES` has a single input, a batch, and a query-typed input.
- An `EmbeddingProviderConformanceCase` adds an input type, dimensions, and an extra `validate`.
- `EmbeddingProviderConformanceOptions` picks the model and the cases. `testAbort`, on by default,
  checks that an already-aborted signal stops the call before the network. `testDeterminism` embeds
  one input twice and compares.
- Each `EmbeddingProviderConformanceResult` has `ok`, `abortOk`, and the error.

### Image providers

`runImageProviderConformance()` runs `ImageProviderConformanceCase` values. Each is an
`ImageGenerateProviderConformanceCase` or an `ImageEditProviderConformanceCase`: a request and an
optional `validate`.

- `IMAGE_PROVIDER_CONFORMANCE_FIXTURES` is a generation, an edit, and a masked edit. Edits run only when
  the provider declares them, and the masked edit only when it declares mask support.
- `ImageProviderConformanceOptions` sets the model, the cases, and the image and mask the edits start
  from, a portable 1×1 PNG by default. `testAbort`, `testEdit`, and `testMask` turn checks on or off.
- Each `ImageProviderConformanceResult` names the operation, whether it met the contract, and every
  violation found. The contract covers assets, metadata, and the operation and request ids echoed back.

## Limitations

- Replay matches requests exactly, after normalization. A change to a prompt or a request field needs
  a new recording. That is the point: the fixture shows what changed.
- Without `timing`, a streamed response is recorded whole and replayed in one chunk. Recording with
  timing still reads the whole response before handing it to the caller.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/testing`

| Export | Kind | Summary |
| --- | --- | --- |
| `EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES` | constant | The default embeddings conformance cases: a single input, a batch, and a query-typed input. |
| `EmbeddingProviderConformanceCase` | interface | One embeddings conformance case. |
| `EmbeddingProviderConformanceOptions` | interface | Options for `runEmbeddingProviderConformance()`. |
| `EmbeddingProviderConformanceResult` | interface | The outcome of one embeddings conformance case. |
| `IMAGE_PROVIDER_CONFORMANCE_FIXTURES` | constant | The default image conformance cases: one generation, one edit, and one masked edit. |
| `ImageEditProviderConformanceCase` | interface | A conformance case that edits an image. |
| `ImageGenerateProviderConformanceCase` | interface | A conformance case that generates an image. |
| `ImageProviderConformanceCase` | type | One image conformance case: a generation or an edit. |
| `ImageProviderConformanceOptions` | interface | Options for `runImageProviderConformance()`. |
| `ImageProviderConformanceResult` | interface | The outcome of one image conformance case. |
| `PROVIDER_CONFORMANCE_FIXTURES` | constant | Default conformance cases for each bundled chat provider, keyed by provider name. |
| `ProviderConformanceCase` | interface | One chat-provider conformance case: a request and a check on its response. |
| `ProviderConformanceOptions` | interface | Options for `runProviderConformance()`. |
| `ProviderConformanceResult` | interface | The outcome of one chat-provider conformance case. |
| `runEmbeddingProviderConformance` | function | Checks an embeddings adapter against the neutral contract. |
| `runImageProviderConformance` | function | Checks an image adapter against the neutral contract: the results it returns, the operations it declares, and optionally how it handles an aborted signal. |
| `runProviderConformance` | function | Checks a chat provider against the neutral contract: completion, and optionally streaming, health, JSON output, and tool calls. |

### `nexus-ai-pro/testing/record`

| Export | Kind | Summary |
| --- | --- | --- |
| `fixtureFetch` | function | Picks recording, replay, or the live network by mode, so one test file serves all three. |
| `FixtureMissingError` | class | Raised on replay when no recording matches a request. |
| `FixtureMode` | type | `record` captures live traffic, `replay` serves fixtures, `live` passes through untouched. |
| `FixtureOptions` | interface | Where fixtures live and how requests are matched to them. |
| `installFetch` | function | Replaces `globalThis.fetch` until the returned function is called, for code that does not take a `fetch` option — several completion providers call the global directly. |
| `MatchInput` | interface | What a matcher sees: the request, with credentials already removed. |
| `readFixtures` | function | Reads every exchange in a fixture directory, for inspection or a custom replay. |
| `RecordedChunk` | interface | One piece of a streamed response, and when it arrived. |
| `RecordedExchange` | interface | One request and the response it got, as written to a fixture file. |
| `RecordedRequest` | interface | A recorded request, with credentials removed. |
| `RecordedResponse` | interface | A recorded response. |
| `recordingFetch` | function | Wraps a real fetch so that every exchange is written to the fixture directory. |
| `RecordingFetch` | type | A fetch that also lets a test wait for every fixture it has written. |
| `RecordOptions` | interface | Options for recording. |
| `ReplayChunkInfo` | interface | What a pacing function is told about the chunk it releases. |
| `replayFetch` | function | Serves recorded exchanges instead of calling the network. |
| `ReplayOptions` | interface | Options for replaying. |
| `ReplayPace` | type | How a replayed stream is paced, for a recording made with `timing`. |
<!-- reference:end -->
