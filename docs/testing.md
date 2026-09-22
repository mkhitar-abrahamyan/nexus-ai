# Testing with recorded traffic

<!-- covers: ./testing/record -->

Suites that need credentials can run everywhere from recordings. `nexus-ai-pro/testing/record` captures provider traffic once, redacted, as reviewable fixture files, and replays it with no network. The conformance suites that run against those recordings are exported from the root and documented in the [client guide](./core.md): `runProviderConformance()`, `runEmbeddingProviderConformance()`, and `runImageProviderConformance()`.

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
<!-- reference:end -->
