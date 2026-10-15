# Video generation

<!-- covers: ./video ./video/google ./video/runway ./video/mock -->

Videos from a prompt, a first or last frame, or reference images, from `nexus-ai-pro/video`. One
contract covers Google Veo, on the Gemini API or Vertex AI, and Runway, whose task API also serves
Veo, Gemini Omni Flash, Seedance, and the other models it hosts. A generation is a durable job: it
survives the process that submitted it, streams its video into an asset store, and is priced per
second of video.

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
      veo: new GoogleVideoProvider({ apiKey: process.env.GEMINI_API_KEY! }),
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
| `durationSeconds`, `aspectRatio`, `resolution` | Its length, shape (`16:9`, `9:16`), and size (`720p`, `1080p`, `4k`). |
| `audio`, `negativePrompt`, `seed`, `count` | Sound, what it must not show, repeatability, and how many videos. |
| `providerOptions` | Fields only one provider knows, sent as they are. |
| `delivery`, `tenantId`, `ttlSeconds`, `metadata` | Where the video goes, who owns it, how long it is kept, and labels for it. |
| `idempotencyKey`, `pollIntervalMs`, `timeoutMs`, `signal` | Replays, polling, and when to stop waiting. |

Before any job is submitted, the request is checked against the model's capabilities. A
`VideoProviderCapabilities` declares the provider's models and what they take, a
`VideoModelCapabilities` for each model where it differs (`byModel`), and `capabilitiesOf()` merges
the two for one model. A `VideoInputKind` is `image`, `last-frame`, or `references`; a
`VideoAudioSupport` is `always`, `optional`, or `none`. A length, shape, size, input, seed, or count
the model does not take is refused with a `VideoError` of code `VIDEO_UNSUPPORTED`, naming what it
does take. A provider receives a `VideoProviderRequest`: the model chosen, and a stored input read
into bytes.

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
list prices for the Veo 3.1 models published on 2026-10-14, or from the account's own prices. A
`VideoPrice` is a rate per second, one for every size or one per resolution, and optionally a lower
rate without sound. A model without a price is left unpriced, never recorded as free. A result's
`cost` is what the provider reported, or this price times the length of each video.

## Providers

`GoogleVideoProvider` speaks Veo's long-running prediction protocol. With an `apiKey` it uses the
Gemini API: the operation's name is the ref, and each video is read from the URI Google returns,
with the key, within the two days Google keeps it. With an `accessToken`, a string or a function that
returns a fresh one, and a Vertex AI `baseUrl`, it polls with `fetchPredictOperation` and reads each
video from Cloud Storage, under `storageUri`, or from the bytes Vertex returns inline.
`GoogleVideoProviderConfig` also sets the models (the Veo 3.1 family: standard, Fast, and Lite, which
makes no 4k video), `byModel`, and `personGeneration`. Veo 3.1 always makes sound.

`RunwayVideoProvider` speaks Runway's task API: a prompt alone is text to video, and a first frame
makes it image to video. A request's shape and size become Runway's `ratio`, such as `1280:720`, and a
ratio of Runway's own passes through as `aspectRatio`. Each video is read from the signed URL the
finished task lists, which is fetched without the API secret. `cancel()` and `remove()` delete the
task. `RunwayVideoProviderConfig` sets the key, the API version (`2024-11-06`), the models (every
text-to-video model Runway names; `gen4.5` by default), and `byModel`. Runway's prices are in credits
that depend on the account, so none are bundled: set `prices`.

`MockVideoProvider`, from `nexus-ai-pro/video/mock`, finishes each job after `pollsToComplete` polls
and makes each video on the fly, as large as `bytes` asks, streamed a chunk at a time. Its videos
begin as an MP4 file does, without being playable. `MockVideoProviderOptions` can fail each job, and
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
`VideoConformanceOptions` adds an image-to-video check, and a cancellation check, which costs a job
and is off by default. In the test suite the mock, Veo on the Gemini API and on Vertex AI, and Runway
pass it against stand-ins for their APIs.

## Limitations

- The family is experimental until Veo and Runway pass the conformance suite against the live
  services.
- OpenAI removed its Videos API, and the Sora 2 models, on 2026-09-24, so there is no OpenAI adapter.
- Gemini Omni Flash is reached through Runway. Google serves it on its Interactions API, which this
  release does not speak.
- Video extension, and a video as input, are not part of the contract; pass a provider's fields in
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
| `VIDEO_PRICES` | constant | List prices on the Gemini API's paid tier, in dollars per second with sound, as published on 2026-10-14. |
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
| `VideoInputKind` | type | What a video can be made from beside its prompt. |
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
| `VideoWarning` | interface | Something about a video job the caller should know, which did not fail it. |

### `nexus-ai-pro/video/google`

| Export | Kind | Summary |
| --- | --- | --- |
| `GoogleVideoProvider` | class | Veo behind the video contract. |
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
