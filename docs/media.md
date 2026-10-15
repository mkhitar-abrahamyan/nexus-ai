# Media understanding

<!-- covers: ./media ./media/mistral ./media/mock ./media/rag -->

Reading what a document or an image says, describing an image, and answering a question about
either, from `nexus-ai-pro/media`. One contract covers any vision model, reached through the client,
and Mistral's dedicated OCR service. A conformance suite checks any provider against it. Media search
and RAG, on `nexus-ai-pro/media/rag`, find the media a question is about and hand the model the media
themselves.

```ts
import { NexusAI } from 'nexus-ai-pro';
import { MediaManager, modelMediaProvider } from 'nexus-ai-pro/media';
import { MistralOcrProvider } from 'nexus-ai-pro/media/mistral';

const ai = new NexusAI({ providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } });
const media = new MediaManager(
  {
    providers: {
      ocr: new MistralOcrProvider({ apiKey: process.env.MISTRAL_API_KEY! }),
      vision: modelMediaProvider(ai, { model: 'gpt-5.4' }),
    },
    defaults: { read: 'ocr', describe: 'vision', answer: 'vision' },
  },
  { lifecycle: ai.lifecycle },
);

const invoice = { type: 'document' as const, source: { buffer: await readFile('invoice.pdf') } };
const { pages } = await media.read({ media: invoice });
const { caption, altText } = await media.describe({ media: { type: 'image', source: { url: photoUrl } } });
const { answer } = await media.answer({ media: invoice, question: 'What is the total due?' });
```

## Tasks

A `MediaInput` is an image or a document part, the same `ImageContent` and `DocumentContent` a message
takes. It holds bytes, base64, a URL, or an asset. A path is refused, since nothing here reads a file.
A `MediaKind` is `image` or `document`, and a `MediaTask` is one of three:

| Method | Request | Result |
| --- | --- | --- |
| `read()` | `MediaReadRequest`: the medium, and optionally which `pages`, from 0. | `MediaText`: each `MediaPage` with its index, its text as Markdown, its size, and the boxes of the pictures on it; and all the text joined. |
| `describe()` | `MediaDescribeRequest`: the medium, and a `brief` or `detailed` caption. | `MediaDescription`: the caption, short alternative text for a screen reader, and tags. |
| `answer()` | `MediaAnswerRequest`: one medium or several, and the question. | `MediaAnswer`: the answer, and the pages it rests on when the provider says. |

Every result is `MediaResultMeta` too: the provider, the model, the `MediaUsage` (tokens for a model,
pages for an OCR service), and the cost where it is priced.

## The manager

`MediaManager` sends each task to the provider a request names, then to the task's default in
`MediaConfig.defaults`, then to the first provider that performs it on that kind of medium. It
refuses a request no provider can serve with a `MediaError`, whose code is `MEDIA_NO_PROVIDER`,
`MEDIA_UNSUPPORTED`, or `MEDIA_INVALID`. `registerMediaProvider()`, `hasMediaProvider()`, and
`listMediaProviders()` manage its providers.

`MediaRuntime.lifecycle` runs every call as one operation of the client's lifecycle, family `media`,
so it is authorized, budgeted, and audited as every other call is. A vision model is reached through
the client, so its completion is too; the lifecycle covers a provider that calls its service
directly, such as OCR.

## Providers

| Provider | Entry point | Does |
| --- | --- | --- |
| `modelMediaProvider()` | `nexus-ai-pro/media` | All three tasks, through any vision model. |
| `MistralOcrProvider` | `nexus-ai-pro/media/mistral` | Reading: PDFs, slides, documents, and images into Markdown pages. |
| `MockMediaProvider` | `nexus-ai-pro/media/mock` | All three, from what its options say each medium holds, for tests. |

`modelMediaProvider()` takes a `CompletionClientLike`, anything with `complete()` such as a client, and
`ModelMediaProviderOptions`: the `model`, a name, the media kinds it takes, and the most tokens a
reading may produce (8,192). It asks for JSON matching each task's shape. A model that answers in
plain text still gives one page, one caption, or one answer, and the call's cost is the client's own.

`MistralOcrProvider` takes `MistralOcrProviderOptions`: the key, the model (`mistral-ocr-latest`), the
table format, headers, and `fetch`. A medium is sent as a data URI or by its URL. Mistral prices OCR by
the page: set `pricePerPage` to the rate your account pays, and each reading reports its cost.

`MockMediaProviderOptions` gives each medium's pages, caption, and answer as functions, and names the
tasks it performs. Its `calls` keeps every request.

A provider of your own implements `MediaProvider`. Its `MediaProviderInfo` declares its
`MediaProviderCapabilities`, the tasks and kinds it takes, and each task method receives a
`MediaCallContext` with the signal and the request id.

## Conformance

`runMediaConformance()` checks a provider against the contract with `MediaConformanceFixtures`: an
image, a document, a pattern the read text must match, and a question with a pattern for its answer.
Every task it declares must be implemented and return the right shape. It never throws; the
`MediaConformanceReport` lists what passed and what failed. All three bundled providers pass it in the
test suite.

## Media search and RAG

`createMediaIndex()` keeps media in any vector store, and `answerFromMedia()` answers from them:

```ts
import { MemoryAssetStore } from 'nexus-ai-pro/images/assets';
import { answerFromMedia, createMediaIndex } from 'nexus-ai-pro/media/rag';

const index = createMediaIndex({
  vectors,
  media,
  embeddings: ai.embeddings,
  assets: { store: new MemoryAssetStore(), tenantId: 'acme' },
});
await index.add([
  { id: 'invoice-17', media: invoice, source: 'mail/invoice-17.pdf', metadata: { customer: 'globex' } },
  { id: 'q3-chart', media: { type: 'image', source: { buffer: chartPng, mimeType: 'image/png' } } },
]);

const { answer, hits } = await answerFromMedia(media, index, 'Which quarter had the most revenue?');
```

`createMediaIndex()` returns a `MediaIndex`: `add()`, `search()`, and `resolve()`, and, with a
manifest, `delete()`, `reindex()`, `describe()`, and `list()`.
Each `MediaDocument` is an id, a medium, and optionally a source and metadata. `add()` turns it into
chunks:

| Chunk | From | When |
| --- | --- | --- |
| Each page's text, cut at paragraphs past `maxChunkChars` (4,000) | `read()` | By default. |
| A caption | `describe()` | By default, for an image. |
| The medium's own vector | The embedding model, given the medium as parts | With `index: { vectors: true }`, on a model that takes the medium, such as gemini-embedding-2. |

`MediaIndexOptions` takes the vector store, the media manager, a `MediaEmbeddingSource` such as a
client's `embeddings`, the embedding model, what to index, and an asset store. A medium held as bytes
or base64 is kept in the asset store, and one at a URL is kept by its URL, so every hit can hand its
medium back. A medium held as bytes without an asset store is refused. Adding an id again replaces
its chunks. The `MediaIndexReport` counts the media indexed and left `unchanged` and the chunks, and
lists each medium's chunk ids.

### The manifest

Give the index a `manifest`, any `Store`, and a `name`, and it remembers what it holds: one
`MediaIndexEntry` per medium, with a hash of its content, source, metadata, and how it was indexed,
where it is kept, how many pages were read, every chunk's id, the embedding model, and the
`MediaIndexReader` that read and described it. With it:

- `add()` upserts: a medium at the same version writes nothing, and one that changed replaces exactly
  its chunks, removing those of pages it no longer has, and the asset of its old content;
- `delete(ids)` removes media with their chunks and assets;
- `reindex(ids)` indexes media again from where each is kept, after a new embedding model or reader;
- `describe(id)` returns a medium's entry, and `list()` the entries, newest first.

```ts
const index = createMediaIndex({ vectors, media, embeddings, assets, manifest: store, name: 'invoices' });
await index.add(documents); // run again: only what changed is read and embedded
await index.delete(['invoice-17']);
```

A change is recorded as pending before anything is written, and as done only once its chunks are
written, its stale chunks removed, and its old asset deleted. Chunk ids are fixed by the medium and
its pages, so a write repeated after a crash replaces rather than adds, and the next `add()`,
`reindex()`, or `delete()` of a medium a crash left pending finishes it. In the test suite, a medium
indexed, changed, or deleted with a crash at each write ends with exactly its chunks and its asset.

`search()` returns `MediaHit` values, each medium once at its best chunk, the best first, as
`MediaSearchOptions` asks: `topK` (5) and a metadata `filter`. A hit says what matched (a page, the
caption, or the medium's vector), the page and text, the source, the medium's own metadata, and its
`MediaReference`: where the medium is kept. `resolve()` hands back the medium behind a hit, as the
model takes it.

`answerFromMedia()` searches (`topK` 3), resolves each hit, and asks the media manager with the media
themselves, so the model sees what a page or a chart shows, not only what was written about it. Its
`MediaRagAnswer` carries the hits it was given. In the test suite, with stand-in models, answers given
the retrieved charts are right on every question, and answers from the same hits' text on none: the
text says what each chart is, and only the chart shows which bar is tallest.

## Limitations

- A vision model's reading is only as faithful as the model; an OCR service keeps layout better.
- Mistral's price per page is not bundled, since it differs by account and model; set `pricePerPage`.
- Video and audio are not media here; transcribe audio with the voice family.
- Without a manifest, a media index does not remember which media it holds: keep the report's chunk
  ids to remove one.

<!-- reference:start -->
