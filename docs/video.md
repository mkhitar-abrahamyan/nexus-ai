# Video generation

<!-- covers: ./video ./video/google ./video/runway ./video/mock -->

Videos from a prompt, a first or last frame, reference images, or a video to extend or edit, from
`nexus-ai-pro/video`. One contract covers Google's models, Gemini Omni Flash on the Gemini API and Veo
on Vertex AI, and Runway, whose task API also serves Veo, Gemini Omni Flash, Seedance, and the other
models it hosts. A generation is a durable job: it survives the process that submitted it, streams
its video into an asset store, and is priced per second of video.

```ts
import { NexusAI } from 'nexus-ai-pro';
import { FilesystemAssetStore } from 'nexus-ai-pro/images/stores';
import { RedisOperationStore } from 'nexus-ai-pro/operations';
import { VideoManager } from 'nexus-ai-pro/video';
import { GoogleVideoProvider } from 'nexus-ai-pro/video/google';
import { RunwayVideoProvider } from 'nexus-ai-pro/video/runway';

const ai = new NexusAI({ providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } });
const video = new VideoManager(
  {
    providers: {
      google: new GoogleVideoProvider({ apiKey: process.env.GEMINI_API_KEY! }),
      runway: new RunwayVideoProvider({ apiKey: process.env.RUNWAYML_API_SECRET! }),
    },
    store: new FilesystemAssetStore({ directory: './videos' }),
    tenantId: 'acme',
  },
  { operations: { store: new RedisOperationStore(redis) }, lifecycle: ai.lifecycle },
);

const handle = await video.generate({ prompt: 'A lighthouse at dusk, waves below', durationSeconds: 8 });
const { videos, cost } = await handle.result(); // minutes later: persist handle.id instead of waiting
```

## Requests

A `VideoGenerateRequest` holds the prompt and, as the model allows:

| Field | What it asks for |
| --- | --- |
| `model`, `provider` | The model and provider. Default to the provider's model and the manager's default provider. |
| `image`, `lastFrame`, `references` | A first frame, a last frame, and images whose subject or style the video keeps, as an `AssetInput`: bytes, a URL, or an asset in the manager's store. |
| `video` | A video to extend or edit, as a `VideoSource`: below. |
| `durationSeconds`, `aspectRatio`, `resolution` | Its length, shape (`16:9`, `9:16`), and size (`720p`, `1080p`, `4k`). Extending, the length is what is added. |
| `audio`, `negativePrompt`, `seed`, `count` | Sound, what it must not show, repeatability, and how many videos. |
| `providerOptions` | Fields only one provider knows, sent as they are. |
| `delivery`, `tenantId`, `ttlSeconds`, `metadata` | Where the video goes, who owns it, how long it is kept, and labels for it. |
| `idempotencyKey`, `pollIntervalMs`, `timeoutMs`, `signal` | Replays, polling, and when to stop waiting. |

Before any job is submitted, the request is checked against the model's capabilities. A
`VideoProviderCapabilities` declares the provider's models and what they take, a
`VideoModelCapabilities` for each model where it differs (`byModel`), and `capabilitiesOf()` merges
the two for one model. A `VideoInputKind` is `image`, `last-frame`, `references`, `extend`, or
`edit`; a `VideoAudioSupport` is `always`, `optional`, or `none`. A length, shape, size, input, seed, or count
the model does not take is refused with a `VideoError` of code `VIDEO_UNSUPPORTED`, naming what it
does take. A provider receives a `VideoProviderRequest`: the model chosen, and a stored input read
into bytes.

### Extending and editing a video

A request's `video` is a `VideoSource`. Its `mode` is `extend`, which continues the video from its
end, or `edit`, which changes it as the prompt says. The video comes one of two ways:
- `input`, an `AssetInput` of a video type: bytes, a URL the provider reads, or a stored asset;
- `from`, a finished job of the same provider and which of its videos, which the provider continues
  from what it already holds, with nothing uploaded.

```ts
const first = await (await video.generate({ provider: 'google', prompt: 'A marble rolling down a track' })).result();
const longer = await (
  await video.generate({
    provider: 'google',
    prompt: 'The marble lands in a cup',
    video: { mode: 'extend', from: { ref: first.ref } },
    durationSeconds: 4,
  })
).result();
```

A model says what it takes in its capabilities:
- `inputs` with `extend` or `edit`;
- `extendDurations`, the seconds an extension adds;
- `continuesJobs`, whether `from` may name a job of its own;
- `requires`, what every request must give, such as `edit` for a model that only changes videos;
- `maxInputVideoSeconds`, the longest video it extends or edits: 10 seconds on Omni, 30 on Veo;
- and the provider's `inputVideoMimeTypes`.

A mode the model does not take, a job of another provider, a length it does not add, a video type it
does not read, a video longer than it takes, read from the video's own headers, or a request without
what the model requires is refused before anything is sent. The
input travels with a durable generation, so a worker that takes it over sends the same video.

| Provider | Extends | Edits | Continues its own job |
| --- | --- | --- | --- |
| Gemini Omni Flash, on the Gemini API | 3 to 10 seconds, a video of up to 10 seconds | Yes | By the interaction's id, nothing uploaded |
| Veo 3.1 on Vertex AI | 7 seconds, a video in Cloud Storage, up to 37 seconds in all | No | When `storageUri` keeps its videos in Cloud Storage |
| Runway's `gemini_omni_flash_1.1` | 3 to 10 seconds | Yes | By its task's signed URL |
| Runway's `gemini_omni_flash` and `aleph2` | No | Yes, and `aleph2` only edits | By its task's signed URL |

## Durable jobs

`VideoManager.generate()` runs a generation as a durable operation, in the operation store the
`VideoRuntime` names. It records the provider's job, a `VideoJobRef` of plain JSON, the moment the job
exists, and each video as it is stored. A worker that dies is replaced: `recover()`, run on a
schedule in every worker that shares the operation store, takes over a generation whose worker
stopped heartbeating, collects its job instead of submitting another, and skips a video already
stored. A failed job is submitted again only when its `VideoJobError` says that may help, so a prompt
a safety filter refused is never billed twice. A generation has three attempts unless
`VideoRuntime.operations.retry` says otherwise.

In the test suite, a generation whose process dies after submitting, and one whose process dies
after storing its video, are each collected by another worker with one submission to the provider,
one video in the store, and a price for eight seconds.

Every generation runs as one operation of the client's lifecycle, in the `video` family, when the
runtime's `lifecycle` is given: authorized and budgeted before the provider sees it, and its cost
reconciled when the video is collected.

The rest of the manager works from a ref, which any process can hold:

| Method | What it does |
| --- | --- |
| `start(request)` | Submits a job and returns its ref at once, without an operation. |
| `resume(ref, options)` | Waits for a job and collects its videos, as `VideoCollectOptions` asks. |
| `status(ref)` | Reads the job's `VideoJobState` now: its `VideoJobStatus`, progress, and outputs. |
| `download(ref, index)` | One finished video as a stream, a `VideoContent`, to send on without storing it. |
| `cancel(ref)` | Cancels a running job, on a provider that can. |

`registerVideoProvider()`, `hasVideoProvider()`, and `listVideoProviders()` manage providers by name.

## Where videos go

A `VideoResult` holds each video as a `VideoAsset`: an asset descriptor with its length, provenance
naming the provider, model, job, and request, and the request's labels. `generate()` streams each
video into the manager's `store` through `putStream()`, so a large video never sits in memory; a store
that cannot stream buffers it up to `maxBytes`. An operation keeps no bytes, so `generate()` needs a
store. `resume()` can also return the bytes themselves, with `delivery: 'bytes'`, up to `maxBytes`
(512 MiB).

`VideoConfig` sets the providers and default provider, the store, tenant, and `ttlSeconds`, the poll
interval and its backoff, the timeout (1 hour), prices, and `removeFromProvider`, which deletes the
provider's copy once a video is collected. A deletion that fails is a `VideoWarning` on the result,
never a failure. A job that ends without a video raises `VideoJobFailedError`, carrying the ref and
its final state; every failure is a `VideoError` with a `VideoErrorCode`, and `retryable` says
whether trying again may help.

## Prices

`priceVideo(model, seconds, options)` prices seconds of video from `VIDEO_PRICES`, the Gemini API's
list prices published on 2026-10-20, or from the account's own prices. Gemini Omni Flash is billed by
output token; its 720p rate is 5,792 tokens a second at $17.50 a million, about $0.10 a second, and
its other sizes, for which Google publishes no rate, stay unpriced. A
`VideoPrice` is a rate per second, one for every size or one per resolution, and optionally a lower
rate without sound. A model without a price is left unpriced, never recorded as free. A result's
`cost` is what the provider reported, or this price times the length of each video.

## Providers

`GoogleVideoProvider` serves Google's video models. With an `apiKey` it uses the Gemini API, whose
model is Gemini Omni Flash, `gemini-omni-1.1-flash`, since the Veo 3.1 previews shut down on
2026-10-22. Omni runs on the Interactions API as a background interaction: its id is the ref, any
worker reads it, and its video comes back with it, inline or by a Files API URI read with the key.
Omni makes 3 to 10 seconds at 360p to 4k, in `16:9` or `9:16`, with sound, from a prompt, a first
frame, or reference images, and extends and edits videos. `cancel()` and `remove()` cancel and
delete the interaction, which the free tier keeps a day.

With an `accessToken`, a string or a function that returns a fresh one, and a Vertex AI `baseUrl`, it
serves Veo 3.1 on Vertex: `veo-3.1-generate-001`, Fast, and Lite, in preview. A job is a long-running
operation, polled with `fetchPredictOperation`, and each video is read from Cloud Storage, under
`storageUri`, or from the bytes Vertex returns inline. Veo makes 4, 6, or 8 seconds with sound, up to
four videos a request, and extends a video in Cloud Storage by seven seconds. Fast and Lite make no 4k
video, and Lite takes no reference images. `GoogleVideoProviderConfig` also sets the models, where a
name beginning `gemini-omni` is reached through the Interactions API and any other through Veo's
protocol, `byModel`, and `personGeneration`.

`RunwayVideoProvider` speaks Runway's task API: a prompt alone is text to video, a first frame
makes it image to video, and a video makes it video to video. A request's shape and size become Runway's `ratio`, such as `1280:720`, and a
ratio of Runway's own passes through as `aspectRatio`. Each video is read from the signed URL the
finished task lists, which is fetched without the API secret. `cancel()` and `remove()` delete the
task. A video goes by URL, or inline up to 5 MB. `RunwayVideoProviderConfig` sets the key, the API
version (`2024-11-06`), the models (every text-to-video model Runway names, and `aleph2`; `gen4.5`
by default), and `byModel`. Runway's prices are in credits
that depend on the account, so none are bundled: set `prices`.

`MockVideoProvider`, from `nexus-ai-pro/video/mock`, finishes each job after `pollsToComplete` polls
and makes each video on the fly, as large as `bytes` asks, streamed a chunk at a time. Its videos
begin as an MP4 file does, without being playable. It extends and edits too, and continues its own
jobs. `MockVideoProviderOptions` can fail each job, and
two mocks given one `jobs` map, of `MockVideoJob` entries, stand for two processes in front of one
provider.

A provider of your own implements `VideoProvider`: `submit()`, `poll()`, and `download()`, and
optionally `cancel()` and `remove()`, each taking a `VideoCallContext`. Its `VideoProviderInfo` names
it and declares its capabilities.

## Conformance

`runVideoConformance(provider, options)` checks any provider against the contract and lists what
fails, as a `VideoConformanceReport`. Its capabilities must be coherent; its ref must survive JSON as
it would a restart; a job must settle when polled through a ref parsed afresh; and the video must
stream as non-empty bytes of a video type, an MP4 beginning with its `ftyp` box.
`VideoConformanceOptions` adds an image-to-video check; a `video` check, which extends or edits the
video given and, on a model that continues its own jobs, extends the first job too; and a
cancellation check, which costs a job and is off by default. In the test suite the mock, Omni, Veo on
the Gemini API and on Vertex AI, and Runway pass it against stand-ins for their APIs.

## Limitations

- The family is experimental until Gemini Omni Flash, Veo, and Runway pass the conformance suite
  against the live services.
- OpenAI removed its Videos API, and the Sora 2 models, on 2026-09-24, so there is no OpenAI adapter.
- Gemini Omni Flash is served on the Gemini API, not on Vertex AI, where it is in preview on another
  protocol.
- Veo extends videos on Vertex AI only, and edits none. Editing or extending an uploaded video on Omni
  is unavailable in the EEA, Switzerland, and the UK.
- A video's length is read from its headers when it is given as bytes, and one longer than the model
  takes is refused before it is sent. A video given by URL, or in Cloud Storage, is refused by its
  provider when it is too long.
- Seedance's and Hailuo's reference videos are not part of the contract; pass them in
  `providerOptions`.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/video`

| Export | Kind | Summary |
| --- | --- | --- |
| `capabilitiesOf` | function | A model's capabilities: the provider's, with that model's differences laid over them. |
| `priceVideo` | function | Prices `seconds` of video from `model`, or `undefined` when no price is known for it, so an unpriced model is never recorded as free. |
| `runVideoConformance` | function | Checks a provider against the video contract: its capabilities are coherent, its ref survives JSON as it would a restart, a job settles and is read back through a ref parsed afresh, and the video streams as non-empty bytes of a video type. |
| `VIDEO_PRICES` | constant | List prices on the Gemini API's paid tier, in dollars per second with sound, as published on 2026-10-20. |
| `VideoAsset` | interface | A made video: stored, or as bytes, with its length and where it came from. |
| `VideoAudioSupport` | type | Whether a model makes sound: always, when asked, or never. |
| `VideoCallContext` | interface | What every provider call receives. |
| `VideoCollectOptions` | interface | How `resume()` waits and where it puts the video. |
| `VideoConfig` | interface | Configuration for `VideoManager`. |
| `VideoConformanceOptions` | interface | What `runVideoConformance()` asks a provider for. |
| `VideoConformanceReport` | interface | How a provider did against the video contract. |
| `VideoContent` | interface | A finished video's bytes, as they arrive. |
| `VideoError` | class | Raised for a request no provider can serve, a provider that fails, or a job that does not finish. |
| `VideoErrorCode` | type | Stable codes for video failures. |
| `VideoGenerateRequest` | interface | A video to make. |
| `VideoInputKind` | type | What a video can be made from beside its prompt: a first frame, a last frame, reference images, or a video to continue (`extend`) or to change as the prompt says (`edit`). |
| `VideoJobError` | interface | Why a job failed. |
| `VideoJobFailedError` | class | Raised when a job ends without a video: failed, cancelled, expired, or every video withheld. |
| `VideoJobRef` | interface | A provider's video job, as JSON: everything after `submit` takes only this, so a worker can collect a job it did not submit. |
| `VideoJobState` | interface | A job's state, as a poll reads it. |
| `VideoJobStatus` | type | Where a job is. |
| `VideoManager` | class | Video providers behind one handle. |
| `VideoModelCapabilities` | interface | What one model makes: the inputs, lengths, shapes, and sizes it takes. |
| `VideoPrice` | interface | A model's price per second of video: one rate, or one per frame size. |
| `VideoProvider` | interface | A video backend: a hosted model's job API, or a stand-in. |
| `VideoProviderCapabilities` | interface | What a video provider supports: its models, and what each makes. |
| `VideoProviderInfo` | interface | Identifies a video provider and what it supports. |
| `VideoProviderRequest` | interface | A request as a provider receives it: its model chosen and its inputs resolved to bytes or URLs. |
| `VideoResult` | interface | A finished video job. |
| `VideoRuntime` | interface | What the manager runs on. |
| `VideoSource` | interface | A video to work from: one to continue from its end, or one to change as the prompt says. |
| `VideoWarning` | interface | Something about a video job the caller should know, which did not fail it. |

### `nexus-ai-pro/video/google`

| Export | Kind | Summary |
| --- | --- | --- |
| `GoogleVideoProvider` | class | Google's video models behind the video contract. |
| `GoogleVideoProviderConfig` | interface | Options for the Google video provider, for the Gemini API or Vertex AI. |

### `nexus-ai-pro/video/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockVideoJob` | interface | One job the mock holds. |
| `MockVideoProvider` | class | A stand-in video backend. |
| `MockVideoProviderOptions` | interface | Options for `MockVideoProvider`. |

### `nexus-ai-pro/video/runway`

| Export | Kind | Summary |
| --- | --- | --- |
| `RunwayVideoProvider` | class | Runway behind the video contract. |
| `RunwayVideoProviderConfig` | interface | Options for the Runway video provider. |
<!-- reference:end -->
