# nexus-ai-pro Roadmap

This roadmap is a design proposal, not a compatibility promise. Stable and experimental
surfaces are defined in [API_STABILITY.md](./API_STABILITY.md).

## Recommended next release: first-class image generation

Image generation should be a separate operation family rather than another variation of
`complete()`. Text completions and generated assets have different request shapes, response
lifecycles, costs, safety checks, storage needs, and retry semantics.

The first public surface could look like this:

```ts
const result = await ai.images.generate({
  model: 'auto',
  prompt: 'A clean product photograph of a red mechanical keyboard',
  aspectRatio: '16:9',
  quality: 'high',
  delivery: { kind: 'bytes', format: 'png' },
});

await ai.images.edit({
  model: 'auto',
  prompt: 'Replace the background with a softly lit studio wall',
  input: result.assets[0],
  mask: {
    location: { kind: 'bytes', data: maskBytes },
    mimeType: 'image/png',
    polarity: 'white-is-editable',
  },
  references: [styleReference],
});
```

`auto` should resolve through versioned, verified aliases instead of making a model name part of
the durable API. OpenAI currently supports one-shot generation and editing through the Image API,
while the Responses API supports conversational, multi-turn image workflows. See the
[official image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
and [GPT Image 2 model page](https://developers.openai.com/api/docs/models/gpt-image-2).

### Recommended API boundary

- Add a lightweight `ImageManager` in `nexus-ai-pro/images`, following the voice manager pattern.
- Expose `ai.images.generate()`, `ai.images.edit()`, and `ai.images.submit()`.
- Let `generate()` and `edit()` wait for a result. Let `submit()` return an
  `OperationHandle<TResult>` with `status()`, `result()`, `cancel()`, and `events()`.
- Add `registerImageProvider()`, `hasImageProvider()`, and `listImageProviders()`.
- Keep provider-neutral types in the core export and optional integrations in exports such as
  `nexus-ai-pro/images/openai` and `nexus-ai-pro/images/comfyui`.

### Media types

- Prefer `Uint8Array`, `Blob`, URLs, and web streams in public types; keep Node `Buffer` as a
  convenience input rather than the portable core type.
- Use discriminated asset locations instead of several optional fields:
  `{ kind: 'bytes'; data: Uint8Array }`, `{ kind: 'url'; url; expiresAt? }`, or
  `{ kind: 'stored'; uri; assetId }`.
- Define `AssetInput`, `AssetDescriptor`, `ImageGenerateRequest`, `ImageEditRequest`,
  `ImageResult`, `MediaUsage`, `MediaSafetyFinding`, `OperationEvent`, and
  `OperationHandle<TResult>`.
- Keep dimensions, MIME type, checksum, storage location, and provenance on each asset. Put
  latency, cost, route, and usage in result-level `OperationMeta`.
- Make `input`, `mask`, and `references` explicit for editing. Define mask polarity, sizing, and
  resize rules so adapters cannot silently reinterpret a request.
- Model generation, editing, masking/inpainting, variations, and background transparency as
  explicit capabilities.
- Split model capabilities into `inputModalities` and `outputModalities`, and retire the current
  semantic overlap between `vision`, `image`, and `pdf`.

### Provider architecture

- Introduce `ImageProvider` independently of the completion-shaped `BaseProvider`.
- Give every provider family a shared internal `ProviderCallContext` containing abort signal,
  deadline, request ID, trace context, and idempotency key.
- Start with a deterministic mock provider and one hosted provider supporting generation and edit.
- Add a second cloud adapter and local ComfyUI before stabilizing the API; this exposes assumptions
  around masks, seeds, negative prompts, polling, formats, and quality controls.
- Negotiate operation, input MIME types, mask support, dimensions, aspect ratio, transparency,
  output format, and count. Unsupported options must fail or produce an explicit warning.
- Route by capability, latency, cost, quality, residency, and safety policy.

### Asset and job pipeline

- Add an `AssetStore` interface with `put`, `get`, `stat`, `delete`, `sign`, retention, tenant
  ownership, checksums, and streaming. Start with bounded memory/filesystem adapters, then add
  S3-compatible storage.
- Treat provider URLs as temporary delivery locations, never as durable storage.
- Resolve remote inputs with SSRF protection, MIME sniffing, byte/pixel limits,
  decompression-bomb protection, and a redirect policy.
- Put metadata stripping, provenance, and image transforms behind optional `AssetTransformer`
  adapters so the core install stays small.
- Add visual input and output moderation; text-only security checks are not sufficient.
- Keep idempotency separate from generative caching. An idempotency key replays the same accepted
  operation. Caching remains opt-in and keys on model version, policy version, parameters, and
  source-asset hashes.
- Build a real operation state machine: queued, running, succeeded, failed, cancelling, cancelled,
  and expired. Add leases/heartbeats, progress events, delayed retry, dead-letter handling,
  cancellation, timestamps, signed webhooks, and trace propagation.
- Queue asset references only; never JSON-serialize binary media into job payloads.
- Reserve and reconcile budget using provider-appropriate pricing such as per-image, megapixel, or
  compute time. Ambiguous timeouts must not create duplicate assets or charges.

### Image evaluation

- Prompt/image semantic alignment and OCR accuracy for generated text.
- Perceptual similarity for edit preservation.
- Safety-policy pass rate and false-positive tracking.
- Latency, cost, retry, and provider failover metrics.
- Repeated-run statistical baselines for stochastic output, plus human-review queues.
- Brand/style reference kits, campaign variant matrices, prompt presets, and reproducibility
  manifests.
- A generic evaluation target or parallel `MediaEvalRunner`; string-only golden-file tests are not
  a useful image-quality gate.

## Infrastructure improvements

### One lifecycle for every operation

Create an internal typed lifecycle and adapt existing operations to it incrementally:

`validate -> authorize -> input policy -> resolve assets -> route -> reserve budget -> execute ->`
`output policy -> persist -> reconcile cost -> audit`

Completions, streams, embeddings, voice, images, and jobs should share the same authorization,
budget, hooks, audit, metrics, and finalization stages, including cache hits. Transport-specific
code should only perform the provider call and normalize its result.

### Provider compatibility automation

- Maintain provider contract tests for minimum and latest supported SDK versions.
- Generate the model registry from versioned provider data with `verifiedAt` and source fields.
- Mark aliases as stable, preview, or deprecated and emit opt-in deprecation warnings.
- Record/replay provider fixtures so most conformance tests run without credentials.
- Detect capability drift so provider option loss cannot happen silently.

### Durable production primitives

- Distributed rate-limit and circuit-breaker adapters.
- Idempotency, request deduplication, cancellation, progress, and operation-event adapters.
- Persistent conversation/session stores.
- Webhook delivery with signatures, retries, and a dead-letter queue.
- Resumable background operations for image/video generation and large eval runs.
- GPU-aware local scheduling, leases, heartbeats, and backpressure.

### Observability and governance

- Standard operation spans and metrics across provider, model, modality, cache, retry, and cost.
- Tenant/project budget policies with reservation and reconciliation of actual usage.
- Redaction-safe audit records with stable finding IDs rather than sensitive values.
- OpenTelemetry semantic conventions plus trace propagation through queues and webhooks.
- An optional local control plane for approvals, traces, evals, costs, provider health, assets,
  retention, and queued operations.

### Smaller install surface

- Keep a small provider-neutral core.
- Move heavy or environment-specific integrations into optional exports or a future scoped package
  family, including OpenTelemetry, BullMQ, image transforms, and provider adapters.
- Make browser/edge compatibility explicit by isolating Node filesystem, crypto, DNS, and stream
  dependencies behind adapters.

## Additional feature backlog

1. True mixed text/asset outputs and tool results that pass asset references without base64 JSON.
2. OCR, captioning, visual question answering, image embeddings, and visual moderation.
3. Realtime voice/video sessions with interruption handling, turn detection, and live tool calls.
4. Video generation through the same asynchronous operation, job, and asset contracts.
5. Media search and RAG using image embeddings.
6. MCP client/server adapters with asset and tool interoperability.
7. Human approval checkpoints for high-impact tools and generated-media publication.
8. Policy-as-code presets versioned independently from the runtime.
9. Prompt/workflow versioning with offline replay and A/B evaluation.
10. Multi-tenant credential-vault adapters and per-provider residency routing.

## Suggested delivery order

1. Stabilize the shared operation lifecycle and provider conformance suite.
2. Add portable media types, `ImageManager`, `ImageProvider`, and a deterministic mock provider.
3. Ship one hosted generate/edit adapter, bounded local asset storage, and visual safety hooks as
   experimental APIs.
4. Add the production asset store and operation state machine with progress, cancellation,
   idempotency, and cost reconciliation.
5. Add a second cloud provider and local ComfyUI to validate portability.
6. Add true multimodal outputs and media evaluation.
7. Promote the media API only after packed-package tests, provider conformance, and image evals
   cover the supported capability matrix.

