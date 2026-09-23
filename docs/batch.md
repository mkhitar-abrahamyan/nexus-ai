# Provider batch tiers

<!-- covers: ./batch ./batch/openai ./batch/anthropic ./batch/mock -->

The providers' discounted batch tiers from `nexus-ai-pro/batch`: submit many requests at roughly half price, poll with backoff, collect and price the results, and resume a batch from its reference in another process. The OpenAI and Anthropic adapters have their own entry points, with a mock for tests.

## Provider Batch Tiers

Both OpenAI and Anthropic sell an asynchronous tier at roughly half price, in exchange for a
completion window measured in hours. Local `runBatch()` concurrency cannot reach it — it is a
different API. `BatchManager` puts both behind one operation handle.

```ts
import { createGraph } from 'nexus-ai-pro/graph';
import { BatchManager } from 'nexus-ai-pro/batch';
import { OpenAIBatchProvider } from 'nexus-ai-pro/batch/openai';

const batch = new BatchManager({
  providers: { openai: new OpenAIBatchProvider({ apiKey: process.env.OPENAI_API_KEY! }) },
  defaultProvider: 'openai',
});

const handle = await batch.submit({
  model: 'gpt-5.4-mini',
  idempotencyKey: `nightly-${date}`,
  items: documents.map((document) => ({
    customId: document.id,
    request: { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: document.text }] },
  })),
});

console.log(handle.id);        // persist this, do not block a request on the result
```

`customId` is required, not optional. A batch provider does not guarantee output order, and matching
results by position is exactly the bug that silently mislabels every row. Duplicates are refused
before submission for the same reason.

The handle settles when the provider finishes, which can be hours later, so treat it as a background
operation:

```ts
const result = await handle.result();

result.status;              // completed | failed | expired | cancelled
result.counts;              // { total, completed, failed }
result.items;               // one entry per customId, with response or error
result.cost.amount;         // priced per item, then discounted at the provider's batch rate
```

A mixed batch is normal: individual items carry their own `error` while the batch still reports
`completed`. Nothing is invented for a failed batch — `items` comes back empty rather than padded.

**Surviving a restart.** Everything after `submit` takes only a `BatchJobRef`, which is
JSON-serializable. A worker that never submitted the batch can collect it:

```ts
const ref = { id: savedBatchId, provider: 'openai' };

await batch.status(ref);     // provider-side state, without waiting
const result = await batch.resume(ref);
await batch.cancel(ref);
```

Polling backs off from the configured interval up to `maxPollIntervalMs`, so a 24-hour batch does
not generate 2,880 polls while a fast one is still caught by the first few short intervals.

## Configuring the manager

`BatchConfig` registers providers, names the default, and sets the poll interval, its upper bound
once backoff has grown it, and the timeout — 26 hours by default, just past the 24-hour tier.
`BatchManagerRuntime` supplies what the manager runs on: the operation runner configuration that makes a submitted batch durable, and the
model registry it prices results against. Providers can also be added later with
`registerBatchProvider()`, and `hasBatchProvider()` and `listBatchProviders()` report what is
registered.

```ts
const batch = new BatchManager(
  { providers: { openai: new OpenAIBatchProvider({ apiKey }) }, defaultProvider: 'openai' },
  { operations: { store: new RedisOperationStore(redis) } },
);
```

## Statuses

A batch moves through `BatchJobStatus`: `validating`, `in_progress`, `finalizing`, then one of
`completed`, `failed`, `expired`, `cancelling`, or `cancelled`. `TERMINAL_BATCH_STATUSES` lists
the ones that never change again and `isTerminalBatchStatus()` is the check, which is what a poll
loop or a dashboard should use rather than comparing strings.

`BatchJobState` is a poll's answer: the `BatchJobRef`, the status, `BatchCounts` of total,
completed, and failed items, timestamps, any batch-level error, and the provider's raw payload.
`BatchJobResult` is the settled result, with one `BatchOutputItem` per `customId` — a response or
an error — and the priced cost.

## Errors

Every failure is a `BatchError` with a stable `code`: `BatchValidationError` for a request refused
before it is sent (a missing or duplicated `customId`, an empty batch), `BatchProviderError` for a
provider failure, `BatchProviderNotFoundError` when no provider is registered under that name,
`BatchCapabilityError` when a provider cannot do what was asked — cancelling, for instance — and
`BatchProviderResponseError` when a provider's answer does not have the shape the adapter expects.

## Writing a provider

`BatchProvider` is four methods — `submit`, `poll`, `results`, and an optional `cancel` — each
taking a `BatchProviderCallContext` with the abort signal and request id. `BatchProviderInfo`
declares the provider's name and its `BatchProviderCapabilities`: how many items and bytes a batch
may hold, which completion windows it offers, whether it can cancel, and the discount it applies,
which is what the manager prices with. A `BatchSubmitRequest` carries `BatchInputItem` values in,
and `BatchOutputItem` values come back.

The two bundled adapters are `OpenAIBatchProvider` and `AnthropicBatchProvider`, configured with
`OpenAIBatchProviderOptions` and `AnthropicBatchProviderOptions`: an API key, a base URL, headers,
a replacement `fetch`, and — for OpenAI — the endpoint each item targets, or for Anthropic the
output token limit an item needs when it names none.

## Testing without a provider

`MockBatchProvider` runs the whole submit-poll-collect cycle in memory, in milliseconds, with no
account and no 24-hour wait. `MockBatchProviderOptions` scripts what the poll returns on each call,
which `customId` values come back as errors, and what token usage to report, so a test can drive a
mixed batch where some items fail and check exactly what the manager does with it.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/batch`

| Export | Kind | Summary |
| --- | --- | --- |
| `BatchCapabilityError` | class | Raised when a batch asks for something the provider does not support. |
| `BatchConfig` | interface | Configuration for `BatchManager`. |
| `BatchCounts` | interface | How many requests a batch holds and how many have finished. |
| `BatchError` | class | Base class for batch errors, each with a stable `code`. |
| `BatchInputItem` | interface | One request in a batch. |
| `BatchJobRef` | interface | A provider-side batch that outlives this process. |
| `BatchJobResult` | interface | A finished batch with every item's outcome, its usage, and its discounted cost. |
| `BatchJobState` | interface | A batch's status as last polled. |
| `BatchJobStatus` | type | Where a provider batch is in its lifecycle. |
| `BatchManager` | class | Provider batch tiers behind one operation handle. |
| `BatchManagerRuntime` | interface | What the batch manager runs on. |
| `BatchOutputItem` | interface | The outcome of one batched request. |
| `BatchProvider` | interface | A provider's asynchronous batch tier. |
| `BatchProviderCallContext` | interface | What a batch adapter receives with every call. |
| `BatchProviderCapabilities` | interface | What a batch tier supports. |
| `BatchProviderError` | class | Raised when a batch provider fails. |
| `BatchProviderInfo` | interface | Identifies a batch adapter and what it supports. |
| `BatchProviderNotFoundError` | class | Raised when no provider, or no provider by the requested name, is registered. |
| `BatchProviderResponseError` | class | Raised when a provider's response does not have the shape the adapter expects. |
| `BatchSubmitRequest` | interface | A batch to submit to a provider's asynchronous tier. |
| `BatchValidationError` | class | Raised when a batch request is invalid before anything is sent. |
| `isTerminalBatchStatus` | function | Whether a batch has reached a status it can never leave. |
| `TERMINAL_BATCH_STATUSES` | constant | Batch statuses from which a batch can never move again. |

### `nexus-ai-pro/batch/anthropic`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnthropicBatchProvider` | class | Anthropic Message Batches: half price, 24-hour window. |
| `AnthropicBatchProviderOptions` | interface | Options for the Anthropic batch provider. |

### `nexus-ai-pro/batch/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockBatchProvider` | class | Deterministic, network-free batch provider. |
| `MockBatchProviderOptions` | interface | Options for the mock batch provider. |

### `nexus-ai-pro/batch/openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIBatchProvider` | class | OpenAI's Batch API: half price, 24-hour window. |
| `OpenAIBatchProviderOptions` | interface | Options for the OpenAI batch provider. |
<!-- reference:end -->
