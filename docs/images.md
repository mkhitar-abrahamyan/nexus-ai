# Image generation and editing (experimental)

<!-- covers: ./images ./images/assets ./images/mock ./images/openai ./images/google ./images/comfyui ./images/transform ./images/inputs ./images/moderation ./images/evals ./images/stores -->

Image generation and editing from `nexus-ai-pro/images`, experimental: one contract over OpenAI, Google Imagen, and ComfyUI, masked edits with the mask converted for each provider, input validation that stops a decompression bomb from its header, visual moderation, asset stores for results, and media evaluation. The family leaves experimental once recorded live conformance passes on all three backends.

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

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/images`

| Export | Kind | Summary |
| --- | --- | --- |
| `AssetBytesLocation` | interface | An asset held in memory. |
| `AssetChecksum` | interface | A digest of an asset's bytes, for integrity checks and deduplication. |
| `AssetDescriptor` | interface | A generated or edited image, with its dimensions and provenance. |
| `AssetInput` | interface | An image supplied to a request, by content or by reference. |
| `AssetLocation` | type | Where an asset's content lives. |
| `AssetLocationKind` | type | Where an asset's content lives: in memory, at a URL, or in an asset store. |
| `AssetProvenance` | interface | Where a generated asset came from, so it can be traced back to the request that made it. |
| `AssetStoredLocation` | interface | An asset kept in an `AssetStore`, referenced rather than carried. |
| `AssetUrlLocation` | interface | An asset reachable at a URL, such as one a provider hosts for a limited time. |
| `ImageBackground` | type | Background of a generated image. |
| `ImageCapabilityError` | class | Raised when a request asks for something the provider does not support. |
| `ImageConfig` | interface | Configuration for `ImageManager`: providers, routing, safety, and storage. |
| `ImageDelivery` | type | How generated images come back: as bytes, as a URL, or written straight into an asset store. |
| `ImageDimensions` | interface | Width and height in pixels. |
| `ImageEditRequest` | interface | Changes an existing image. |
| `ImageError` | class | Base class for image errors, each with a stable `code`. |
| `ImageGenerateRequest` | interface | Creates images from a prompt. |
| `ImageManager` | class | Routes image generation and edits to registered providers, as operations with status, cancellation, and events. |
| `ImageManagerConfig` | type | Deprecated: Prefer `ImageConfig`; retained as an explicit manager-local alias. |
| `ImageMaskInput` | interface | A mask that marks which part of the input an edit may change. |
| `ImageOperation` | type | What an image request does: create an image from a prompt, or change an existing one. |
| `ImageOperationCancelledError` | class | Raised when work continues on a cancelled image operation. |
| `ImageOperationSubmission` | type | An image operation as queued work: which operation, and its request. |
| `ImageOutputFormat` | type | Encoding for generated images. |
| `ImageProvider` | interface | An image generation backend. |
| `ImageProviderCallContext` | interface | What an image provider receives with every call besides the request. |
| `ImageProviderCapabilities` | interface | What an image provider supports, so routing and validation can refuse a request before it costs anything. |
| `ImageProviderError` | class | Raised when an image provider fails. |
| `ImageProviderInfo` | interface | Identifies an image provider and what it supports. |
| `ImageProviderNotFoundError` | class | Raised when no provider, or no provider by the requested name, is registered. |
| `ImageProviderResponseError` | class | Raised when a provider's response does not have the shape the adapter expects. |
| `ImageQuality` | type | Quality tier. |
| `ImageRequestBase` | interface | Fields every image request shares. |
| `ImageResult` | interface | The outcome of an image operation. |
| `ImageSafetyContext` | interface | What a safety policy sees besides the request or result. |
| `ImageSafetyError` | class | Raised when moderation refuses a prompt, an input, or an output. |
| `ImageSafetyPolicy` | interface | Inspects requests before they reach a provider and results before they reach the caller. |
| `ImageValidationError` | class | Raised when a request or an input is invalid before anything is sent. |
| `ImageWarning` | interface | A request option the provider could not honor exactly, reported instead of silently changed. |
| `MediaSafetyFinding` | interface | One finding from a safety policy, on a request or on a result. |
| `MediaUsage` | interface | What an image operation consumed and produced, in the units media providers price by. |
| `OperationMeta` | interface | How an operation ran: which provider, how long it took, and what it cost. |

### `nexus-ai-pro/images/assets`

| Export | Kind | Summary |
| --- | --- | --- |
| `AssetCapacityConstraint` | type | Which store limit a request ran into. |
| `AssetPutOptions` | interface | How an asset is stored: who owns it, where it came from, and how long it is kept. |
| `AssetSigner` | type | Turns an asset into a URL a client can fetch, such as a presigned S3 URL or a route on your own server. |
| `AssetSignerContext` | interface | What a signer receives: the asset, the time, and the lifetime asked for. |
| `AssetSignOptions` | interface | Options for a signed URL. |
| `AssetStat` | interface | What a store knows about an asset without reading its bytes. |
| `AssetStore` | interface | Provider-neutral asset persistence contract. |
| `AssetStoreCapacityError` | class | Raised when an asset would exceed a store limit. |
| `AssetStoreError` | class | Base class for asset store failures. |
| `AssetStoreResult` | type | A value a store method returns, synchronously or asynchronously. |
| `AssetStoreSigningError` | class | Raised when a signed URL cannot be produced. |
| `AssetStoreValidationError` | class | Raised when an asset or its options are invalid. |
| `ByteAssetDescriptor` | interface | A retrieved asset descriptor whose byte payload is available to the caller. |
| `ByteAssetInput` | interface | An asset input whose payload is already available locally as bytes. |
| `MemoryAssetStore` | class | Process-local, bounded asset storage. |
| `MemoryAssetStoreOptions` | interface | Limits and behaviour for the in-process asset store. |
| `MemoryAssetStoreSnapshot` | interface | What the in-process store currently holds, against its limits. |

### `nexus-ai-pro/images/comfyui`

| Export | Kind | Summary |
| --- | --- | --- |
| `comfyInpaintWorkflow` | function | The stock inpainting graph. |
| `ComfyNode` | interface | One node of a ComfyUI API-format workflow. |
| `comfyTextToImageWorkflow` | function | The stock Stable Diffusion text-to-image graph. |
| `ComfyUIImageProvider` | class | A self-hosted ComfyUI server. |
| `ComfyUIImageProviderConfig` | interface | Options for the ComfyUI image provider. |
| `ComfyUploadedImage` | interface | An image uploaded to ComfyUI's input folder. |
| `ComfyWorkflow` | type | A ComfyUI workflow in API format: nodes keyed by id. |
| `ComfyWorkflowBuilder` | type | Builds the workflow graph for one request. |
| `ComfyWorkflowContext` | interface | What a workflow builder receives besides the request. |

### `nexus-ai-pro/images/evals`

| Export | Kind | Summary |
| --- | --- | --- |
| `MediaEvalCase` | interface | One media evaluation case: a request, how often to run it, and what counts as a pass. |
| `MediaEvalCaseReport` | interface | A case's runs and how consistently it passed. |
| `MediaEvalExpectations` | interface | Evaluation for generated media. |
| `MediaEvalOptions` | interface | Configuration for `MediaEvalRunner`: scorers, where uncertain results go, and how often to run each case. |
| `MediaEvalReport` | interface | A media evaluation: per-case results, distributions, safety accuracy, and operational health. |
| `MediaEvalRunner` | class | Runs media cases repeatedly and reports distributions, safety accuracy, and operations. |
| `MediaEvalRunOptions` | interface | Options for one evaluation run. |
| `MediaEvalRunReport` | interface | The outcome of one run of a case. |
| `MediaEvalScorers` | interface | Scoring functions a case's expectations need. |
| `MediaEvalTarget` | type | Produces one result for one run of a case — usually a thin call into `ImageManager`. |
| `MemoryReviewQueue` | class | A review queue that keeps items in memory, for tests and small setups. |
| `MetricStats` | interface | Distribution of one metric across runs. |
| `perceptualSimilarity` | function | Perceptual similarity from 0 to 1, using a 64-bit difference hash. |
| `ReviewItem` | interface | A run sent to a person, because its score fell in an uncertain band or a safety policy asked for review. |
| `ReviewQueue` | interface | Where uncertain results go for a person to judge. |
| `stats` | function | Mean, spread, and a 95% interval, so a single lucky run is not mistaken for a capability. |
| `textAccuracy` | function | OCR accuracy from 0 to 1: one minus normalised edit distance, after case and whitespace folding. |

### `nexus-ai-pro/images/google`

| Export | Kind | Summary |
| --- | --- | --- |
| `GoogleImageProvider` | class | Google Imagen through the `:predict` protocol, on either the Gemini API or Vertex AI. |
| `GoogleImageProviderConfig` | interface | Options for the Google image provider, for the Gemini API or Vertex AI. |

### `nexus-ai-pro/images/inputs`

| Export | Kind | Summary |
| --- | --- | --- |
| `createImageInputResolver` | function | Builds a resolver, for passing straight into `ImageConfig.inputResolver`. |
| `ImageInputError` | class | An input the resolver refused. |
| `ImageInputPolicy` | interface | Limits on image inputs, and how remote and stored inputs are fetched. |
| `ImageInputRejection` | type | Why the input resolver refused an input. |
| `ImageInputResolver` | class | Turns any asset location into validated bytes. |

### `nexus-ai-pro/images/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockImageProvider` | class | A deterministic, network-free provider for tests, examples, and capability conformance. |
| `MockImageProviderOptions` | interface | Options for the mock image provider. |

### `nexus-ai-pro/images/moderation`

| Export | Kind | Summary |
| --- | --- | --- |
| `combineSafetyPolicies` | function | Runs several safety policies and concatenates what they find. |
| `createOpenAIVisualModeration` | function | Screens prompts, input images, and generated images through OpenAI's multimodal moderation. |
| `VisualModerationOptions` | interface | Options for `createOpenAIVisualModeration()`. |

### `nexus-ai-pro/images/openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIImageProvider` | class | Hosted OpenAI Image API adapter for generation, reference-based editing, and masked editing. |
| `OpenAIImageProviderConfig` | interface | Options for the OpenAI image provider. |
| `OpenAIImageProviderError` | class | An error from the OpenAI Image API, with its HTTP status and request id. |
| `OpenAIModerationDetails` | interface | What OpenAI said about a request its moderation refused. |

### `nexus-ai-pro/images/stores`

| Export | Kind | Summary |
| --- | --- | --- |
| `FilesystemAssetStore` | class | Asset persistence on local disk. |
| `FilesystemAssetStoreOptions` | interface | Options for a store that keeps assets as files on local disk. |
| `S3AssetStore` | class | Asset persistence on any S3-compatible object store. |
| `S3AssetStoreOptions` | interface | Options for a store that keeps assets in an S3-compatible bucket. |
| `S3LikeClient` | interface | The S3 operations the store needs. |

### `nexus-ai-pro/images/transform`

| Export | Kind | Summary |
| --- | --- | --- |
| `AssetTransformer` | interface | Converts a neutral mask into what one provider expects. |
| `decodePng` | function | Decodes a non-interlaced 8-bit PNG of any colour type into RGBA. |
| `DecodePngOptions` | interface | Options for `decodePng()`. |
| `defaultMaskTransformer` | function | Shared default instance, built on first use. |
| `encodePng` | function | Encodes RGBA pixels as an 8-bit, colour-type-6 PNG. |
| `ImageDimensionsInfo` | interface | Image dimensions read from a header. |
| `MaskSemantics` | type | What a provider means by a mask. |
| `MaskTarget` | interface | What a mask must be converted to. |
| `PngMaskTransformer` | class | Converts PNG masks between polarities and alpha semantics, resizing with nearest-neighbour when the mask's `resizeMode` allows. |
| `PngMaskTransformerOptions` | interface | Options for the bundled PNG mask transformer. |
| `PreparedMask` | interface | A mask converted for one provider, at the image's exact dimensions. |
| `readImageDimensions` | function | Reads width and height from the header without decoding pixels. |
| `requireImageDimensions` | function | Reads the dimensions of an image a mask will be applied to. |
| `RgbaImage` | interface | Decoded pixels, always expanded to 8-bit RGBA so callers need no per-format branches. |
| `SniffedImage` | interface | An image format recognised from its first bytes. |
| `SniffedImageFormat` | type | Image header parsing: format sniffing and dimensions, with no decompression. |
| `sniffImageType` | function | Identifies an image from its first bytes, ignoring whatever the caller claimed it was. |
<!-- reference:end -->
