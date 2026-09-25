# Testing with recorded traffic

<!-- covers: ./testing/record -->
<!-- sources: src/testing -->

Suites that need credentials can run everywhere from recordings. `nexus-ai-pro/testing/record` captures provider traffic once, redacted, as reviewable fixture files, and replays it with no network. The conformance suites that run against those recordings — `runProviderConformance()`, `runEmbeddingProviderConformance()`, and `runImageProviderConformance()` — are exported from the root and described below.

## Recorded provider traffic

A suite that needs credentials can run everywhere else from recordings:

```ts
import { fixtureFetch } from 'nexus-ai-pro/testing/record';

// Replays by default; NEXUS_FIXTURES=record captures, NEXUS_FIXTURES=live bypasses.
const fetch = fixtureFetch({ directory: 'tests/fixtures/openai' });
const provider = new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY ?? 'replay', fetch });
```

Recording writes one reviewable JSON file per exchange. Credential headers and query parameters are
removed before anything is written, and a `redact` hook handles the rest — personal data in a prompt,
through a PII detector from `nexus-ai-pro/security`, for instance. Replay serves the files back with
no network, matches requests by method, URL, and body with object keys sorted and multipart
boundaries ignored, and throws `FixtureMissingError` for anything unrecorded instead of reaching the
live API. `installFetch()` covers code that calls the global `fetch`.

```bash
npm run test:conformance:images       # replays image recordings; needs no credentials
npm run conformance:images:record     # records them; needs OPENAI_API_KEY, GOOGLE_API_KEY, or COMFYUI_URL
```

## Recording and replay, piece by piece

`fixtureFetch()` picks a `FixtureMode` — `record`, `replay`, or `live` — from its `mode` option, then
from `NEXUS_FIXTURES`, then defaults to `replay`, so one test file serves all three. The pieces it
chooses between are exported too:

- `recordingFetch()` wraps a real fetch and writes every exchange to the directory. It returns a
  `RecordingFetch`, a fetch with a `flush()` that waits until every fixture is on disk — await it
  before a test ends. `RecordOptions` add the real `fetch`, the `redact` hook, and a clock.
- `replayFetch()` serves the files back. `ReplayOptions` add `onMissing`: `throw`, the default, raises
  `FixtureMissingError` with the request's method, URL, and match key, so you can find the recording
  that should have matched; `live` falls through to the real `fetch` instead.
- `readFixtures()` reads every `RecordedExchange` in a directory, for inspection or a replay of your
  own.

`FixtureOptions` is what both share: the `directory`, a `match` function that turns a request into
its key, `ignoreBodyFields` for top-level fields that change between runs — a request id, a
timestamp — and `redactHeaders` and `redactQuery` for anything beyond the credential names always
removed. A custom matcher receives a `MatchInput`: the method, the URL with credentials removed and
the query sorted, the redacted headers, and the body as text with multipart boundaries normalized.

Each fixture file is one `RecordedExchange`: the match key, its position among requests that share
the key — so a request made three times replays three responses in order — the `RecordedRequest`, the
`RecordedResponse`, and when it was recorded. Bodies are text, or base64 for binary, and the
transport headers `fetch` has already applied, such as content encoding, are left out so replay does
not describe a body it no longer has.

## Conformance suites

Each suite checks an adapter against the neutral contract and returns one result per case, so a
test asserts on them and a report prints them. Run them against recordings on every pull request,
and live where credentials are.

**Chat providers.** `runProviderConformance()` takes a provider name, a provider, and
`ProviderConformanceOptions`. Each `ProviderConformanceCase` is a request and a `validate` function;
the defaults are a plain text completion and a JSON response shape, with a tool-calling case when
`testTools` is on, and `PROVIDER_CONFORMANCE_FIXTURES` holds them per bundled provider with a model
that provider serves. `model` runs every case on one model, `fixtures` replaces the cases, and
`testStream` and `testHealth` also stream each case and run the health check. Each
`ProviderConformanceResult` says whether completion, streaming, and health passed, and what went
wrong.

```ts
import { runProviderConformance } from 'nexus-ai-pro';

const results = await runProviderConformance('openai', provider, { testStream: true, testTools: true });
assert.ok(results.every((result) => result.completeOk && result.streamOk !== false), JSON.stringify(results));
```

**Embedding providers.** `runEmbeddingProviderConformance()` checks one vector per input, in order,
of one width, with finite components, and a requested `dimensions` honored.
`EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES` is a single input, a batch, and a query-typed input; an
`EmbeddingProviderConformanceCase` adds an input type, dimensions, and an extra `validate`.
`EmbeddingProviderConformanceOptions` picks the model and cases, `testAbort` (on by default) checks
that an already-aborted signal stops the call before the network, and `testDeterminism` embeds one
input twice and compares. Each `EmbeddingProviderConformanceResult` has `ok`, `abortOk`, and the
error.

**Image providers.** `runImageProviderConformance()` runs `ImageProviderConformanceCase` values,
each an `ImageGenerateProviderConformanceCase` or an `ImageEditProviderConformanceCase` with its
request and an optional `validate`. `IMAGE_PROVIDER_CONFORMANCE_FIXTURES` is a generation, an edit,
and a masked edit; edits run only when the provider declares them, and the masked edit only when it
declares mask support. `ImageProviderConformanceOptions` sets the model, the cases, the image and
mask the edits start from (a portable 1x1 PNG by default), and `testAbort`, `testEdit`, and
`testMask`. Each `ImageProviderConformanceResult` names the operation, whether it met the contract —
assets, metadata, and the call's operation and request ids echoed back — and every violation found.

## Limitations

- Replay matches requests exactly, after normalization. A change to a prompt or a request field
  needs a new recording, which is the point: the fixture shows what changed.
- Streaming responses are recorded whole and replayed in one chunk, so replay does not reproduce a
  provider's chunk timing.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

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
| `RecordedExchange` | interface | One request and the response it got, as written to a fixture file. |
| `RecordedRequest` | interface | A recorded request, with credentials removed. |
| `RecordedResponse` | interface | A recorded response. |
| `recordingFetch` | function | Wraps a real fetch so that every exchange is written to the fixture directory. |
| `RecordingFetch` | type | A fetch that also lets a test wait for every fixture it has written. |
| `RecordOptions` | interface | Options for recording. |
| `replayFetch` | function | Serves recorded exchanges instead of calling the network. |
| `ReplayOptions` | interface | Options for replaying. |

### `nexus-ai-pro`

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
<!-- reference:end -->
