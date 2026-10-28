# Loaders

<!-- covers: ./loaders ./rag/pipeline ./loaders/text ./loaders/markdown ./loaders/html ./loaders/csv ./loaders/json ./loaders/pdf ./loaders/web ./loaders/git -->

Getting documents into retrieval: files, pages, rows, records, PDFs, web pages, and Git
repositories, each read into the `DocumentSource` values that ingestion splits into chunks. Every
format has its own entry point, and none adds a dependency — PDF parsing is a function you inject,
and web pages go through the same SSRF-safe fetch as the `fetch_url` tool.

```ts
import { MemoryVectorStore } from 'nexus-ai-pro/rag';
import { loadIntoStore } from 'nexus-ai-pro/loaders';
import { loadMarkdown } from 'nexus-ai-pro/loaders/markdown';
import { loadDirectory } from 'nexus-ai-pro/loaders/text';
import { loadSitemap } from 'nexus-ai-pro/loaders/web';

const store = new MemoryVectorStore(embed);
await loadIntoStore(
  store,
  [
    loadDirectory('./docs', { parsers: { '.md': (file) => loadMarkdown(file) } }),
    loadSitemap('https://example.com/sitemap.xml', { include: (url) => url.includes('/help/') }),
  ],
  { splitOnMarkdownHeadings: true },
);
```

## Loading into a store

Every loader returns a `DocumentLoader`: an async iterable of `DocumentSource` values, each with an id,
the text, a source, and metadata. Documents arrive one at a time, so a corpus larger than memory
streams through instead of being read whole. A plain array of documents is a loader too.

`loadIntoStore()` streams loaders into one or more stores. Each batch of documents is split with the
ingestion options and added to every store at once. So a vector store and the `KeywordIndex` that
hybrid search reads fill up in one pass. A store is any `ChunkSink`: anything with an `add()` for
chunks.

`LoadIntoStoreOptions` adds a `batchSize` (32 documents), a `signal` that stops between batches, and an
`onBatch` progress callback. The `LoadIntoStoreResult` counts documents, chunks, and characters.

Reloading is safe. Chunk ids come from document ids, and loaders use the file path, URL, or row key as
the id. Loading the same corpus again replaces its chunks instead of duplicating them.

`collectDocuments()` reads loaders into an array instead, for inspection or for code that wants
the documents themselves.

## Keeping an index current

`loadIntoStore()` embeds everything it reads, every time. For a corpus that changes, use the durable
pipeline on `nexus-ai-pro/rag/pipeline`.

`createIngestionPipeline()` keeps a manifest in any `Store`. For each document, an
`IngestedDocument` records:
- the version of its content;
- its chunking;
- the embedding model;
- each chunk's id with the version of its text.

A run of the `IngestionPipeline` does six things:
- It reads the corpus, from any `IngestionSource`: a loader, an array, or an iterable.
- It skips every document whose content, chunking, and model are as recorded.
- It embeds only the chunks that are new or changed. A chunk is named by its text, so one whose text
  did not change keeps its embedding wherever it moved.
- It deletes the chunks a document no longer has.
- It deletes the documents the corpus no longer has, unless `deleteMissing: false` says the run
  loads only part of it.
- It writes every change to the stores before the manifest records it, so a crash repeats a write
  but never loses one.

A different embedding model, or different chunking, re-embeds everything. Chunks are cut by length,
within each Markdown section when `splitOnMarkdownHeadings` is on. An edit therefore re-embeds the
chunks of its own section, and adding a section leaves the others alone.

`IngestionPipelineOptions`:
- the pipeline's `name`, which keeps two manifests apart;
- the `manifest` store;
- the vector store;
- any keyword indexes kept in step;
- the `embed` function and the `embeddingModel`, or a `batchEmbed` tier instead of `embed`;
- the chunking and the batch size.

A `MemoryStore` keeps 10,000 items unless given a larger `maxItems`. A manifest has one item per
document, so size it to the corpus or keep it in a database.

`IngestionRunOptions`: a `signal`, `deleteMissing`, `onProgress`, and the durable `operation` the
run belongs to. `run()` returns an `IngestionReport`, which counts:
- documents read, unchanged, added, updated, and deleted;
- chunks embedded, kept, and deleted;
- documents a resumed run skipped;
- with a batch tier, the provider `batches` submitted, and the `batchesRecovered` from an earlier
  attempt.

`document()` reads one document's manifest record, and `remove()` removes documents from every
store.

`ingestionExecutor()` makes the pipeline the executor of a durable operation. Submit it to an
`OperationRunner`. After each batch, the run records how far it got, and a retry, on this worker or
another, starts at the document the failed attempt stopped on.

```ts
import { OperationRunner } from 'nexus-ai-pro/operations';
import { loadDirectory } from 'nexus-ai-pro/loaders/text';
import { createIngestionPipeline, ingestionExecutor } from 'nexus-ai-pro/rag/pipeline';

const pipeline = createIngestionPipeline({
  name: 'help-center',
  manifest: store,
  vectors,
  keywords: [elasticsearch],
  embed,
  embeddingModel: 'text-embedding-3-small',
  chunking: { splitOnMarkdownHeadings: true },
});
const runner = new OperationRunner({ store: operations, retry: { maxAttempts: 5 } });
const handle = await runner.submit(ingestionExecutor(pipeline, () => loadDirectory('./docs')), {
  idempotencyKey: 'help-center',
});
```

In the test suite, an ingestion of 100,000 documents dies halfway, and its retry embeds no chunk that
had finished. A second run after ten documents are edited embeds exactly ten chunks.

### Through a provider's batch tier

A large ingestion can embed at a provider's batch price, usually half, if it can wait hours instead
of seconds. Give `batchEmbed` a `batchEmbedder()` from the
[embeddings guide](./embeddings.md#a-batch-tier-for-large-jobs) in place of `embed`:

```ts
import { batchEmbedder, EmbeddingBatchManager } from 'nexus-ai-pro/embeddings/batch';
import { OpenAIEmbeddingBatchProvider } from 'nexus-ai-pro/embeddings/batch/openai';

const batches = new EmbeddingBatchManager({ providers: { openai: new OpenAIEmbeddingBatchProvider({ apiKey }) } });
const pipeline = createIngestionPipeline({
  name: 'archive',
  manifest: store,
  vectors,
  batchEmbed: batchEmbedder(batches, { model: 'text-embedding-3-small', size: 20_000 }),
  batchesInFlight: 4,
  embeddingModel: 'text-embedding-3-small',
});
```

The run gathers the chunks to embed into windows of the embedder's `size`, and submits each window
as one provider batch. It writes each window once its batch completes, in order, with
`batchesInFlight` (4) batches outstanding at most. A batch that does not complete, or fails any
input, fails the run before its window is written.

Inside a durable operation, each batch is recorded the moment it is submitted. A retry rebuilds the
same windows from the same corpus, and collects a recorded batch instead of submitting it again. Only
a batch submitted in the instant before a crash, and not yet recorded, can be submitted twice. In the
test suite, an ingestion of 100,000 chunks dies while it collects its third window, and across both
attempts each of its ten windows is submitted once.

## Files

The file loaders take one input or many. A `FileInput` is one of:

- a path, or a `file:` URL;
- content already in memory, with a name for it: `{ source: 'upload.md', content }`. That is how a
  loader reads an upload, a database blob, or a file on a runtime without a filesystem;
- a stream of it, with a name: `{ source: 'export.csv', stream }`, any iterable or async iterable of
  bytes or text, such as a response's body or an object store's download.

`node:fs` is imported only when a path is read. `FileLoaderOptions` adds `metadata` to every document.
The CSV and JSON loaders read a file as it arrives, a path in chunks of 64 KiB and a stream piece by
piece, and yield each row or record as soon as it is read, so a file larger than memory streams through
to the store. The other loaders read a file whole, a stream included.

- **Text.** `loadText()` reads plain text files, one document each, dropping a byte-order mark.
- **Directories.** `loadDirectory()` walks a directory in sorted order, so a load is reproducible. It
  uses paths relative to the directory as ids. `DirectoryLoaderOptions` sets:
  - `extensions`, the files to read;
  - `parsers`, a map from extension to a `FileParser` — any loader given one file, such as
    `loadMarkdown`;
  - `recursive`, and an `ignore` test (by default, `node_modules` and dot directories are skipped);
  - `maxFiles` (10,000), a guard against pointing at the wrong directory.
- **Markdown.** `loadMarkdown()` reads Markdown with its front matter and title in the metadata, so a
  filter can select on them; ingest with `splitOnMarkdownHeadings` so no chunk spans two sections.
  `parseMarkdown()` is the parser on its own, returning a `MarkdownDocument` with the body, the
  `frontMatter` fields, and the `title`. Front matter is read as flat `key: value` lines — strings,
  numbers, booleans, and inline lists — so no YAML parser is needed. `MarkdownLoaderOptions` can set
  `plainText`, which runs `markdownToPlainText()` to strip link targets, emphasis, and fences.
- **HTML.** `loadHtml()` reads HTML files, with the page title and description in the metadata.
  `htmlToText()` does the conversion without a DOM. It drops scripts, styles, and the head, turns
  block elements into line breaks, and decodes entities. Headings become Markdown headings, so HTML
  splits by section too. It returns an `HtmlText`: the text, `title`, `description`, and every link.
  `HtmlToTextOptions` keeps only `<main>` or `<article>` by default (`mainContent`), and resolves links
  against a `baseUrl`. `HtmlLoaderOptions` combines them with the file options.
- **CSV.** `loadCsv()` makes one document per row, writing each column as `name: value` so a model
  reading a chunk knows what each value is. `CsvLoaderOptions` chooses the `textColumns`, an
  `idColumn` for stable ids, and `metadataColumns` to filter on. `parseCsv()` is an RFC 4180 parser
  — quoted delimiters, line breaks, and doubled quotes — and `CsvParseOptions` sets the `delimiter`.
  `CsvRowParser` is the same parser given text a piece at a time: `push()` returns the rows a piece
  completed and `end()` the last, a quote or a CRLF split between two pieces read as one.
- **JSON.** `loadJson()` makes one document per record, from a JSON file or JSON Lines. The items of
  a top-level array, or of the array at `recordsAt`, and the lines of JSON Lines, are read one at a
  time as the file arrives; a file that is not an array is one record. `JsonLoaderOptions` sets:
  - `recordsAt`, object keys from the top, dotted, such as `data.items`, to the array of records. A
    file with no array there is refused;
  - `records`, which picks the records out of the parsed value instead, reading the file whole;
  - `text` and `id`, each a field by dotted path, or a function;
  - `metadataFields`, copied into the metadata;
  - `lines`, which reads one value per line. On by default for `.jsonl` and `.ndjson`; a line that
    does not parse is named by its number.

```ts
import { loadJson } from 'nexus-ai-pro/loaders/json';

const response = await fetch('https://exports.example.com/tickets.json');
// { "meta": { ... }, "data": { "items": [ ...millions of tickets... ] } }, a ticket at a time.
const tickets = loadJson({ source: 'tickets.json', stream: response.body ?? [] }, { recordsAt: 'data.items', id: 'id', text: 'body' });
await loadIntoStore(tickets, store);
```
- **PDF.** `loadPdf()` hands each file's bytes to your parser, a `PdfTextExtractor` wrapping
  `pdfjs-dist`, `unpdf`, or an OCR service, which returns the text or one string per page.
  `PdfLoaderOptions` takes that `extract` function and `splitPages`: on by default, one document per
  page with `page` in the metadata, so a citation can name it. A file without the PDF signature is
  refused with a `PdfLoaderError` before it reaches the parser.

```ts
import { loadPdf } from 'nexus-ai-pro/loaders/pdf';
import { extractText, getDocumentProxy } from 'unpdf';

const manuals = loadPdf(['manual.pdf', 'warranty.pdf'], {
  extract: async (bytes) => (await extractText(await getDocumentProxy(bytes))).text,
});
```

## Web pages and sitemaps

`loadWebPages()` fetches pages through the SSRF-safe fetch. Private, loopback, and cloud-metadata
addresses are refused unless explicitly allowed, and each redirect hop is checked again. HTML becomes
text through `htmlToText()`; plain text, Markdown, and JSON are kept as they are.

`WebLoaderOptions` extends that `SafeFetchPolicy` (`allowedDomains`, `allowPrivateNetworks`, a resolver):

| Option | Default |
| --- | --- |
| `maxBytes` | 5 MB |
| `maxRedirects` | 5 |
| `timeoutMs`, per page | 15 seconds |
| `concurrency` | 4 pages at once, still yielded in the order given |
| `signal`, `metadata`, `mainContent` | — |

A page that fails — a status other than 2xx, a type that is not text, a timeout — raises a
`WebLoaderError` with the URL and status. Set `onError: 'skip'` to pass over it and hear about it in
`onSkip`.

A page whose content a script builds holds little in the HTML a server sends. `render` is a
`WebPageRenderer` that renders one with a browser of the application's own: given the
`WebPageToRender`, the page's URL and the HTML fetched, it returns the HTML the browser ends with, and
the document is read from that, marked `rendered`. It is called for an HTML page that runs a script
and whose text is shorter than `renderBelow`, 200 characters by default; `Infinity` renders every
page that runs one. `browserRenderer()` makes one from a `RenderingBrowser`, such as Playwright's or
Puppeteer's: each page is opened, waited on until `waitUntil` (`networkidle`), read, and closed, within
`timeoutMs` (30 seconds), as `BrowserRendererOptions` say. The package depends on no browser. The
safe fetch checks a page's URL first; the browser then fetches what the page loads under its own
network policy, not the loader's.

```ts
import { chromium } from 'playwright';
import { browserRenderer, loadWebPages } from 'nexus-ai-pro/loaders/web';

const browser = await chromium.launch();
const pages = loadWebPages(urls, { render: browserRenderer(browser) });
```

`sitemapUrls()` reads a sitemap's page URLs, following a sitemap index into its sitemaps and
decompressing gzipped ones; `loadSitemap()` loads those pages. `SitemapOptions` adds an `include`
test and a `limit` (1,000 URLs).

## Git repositories

`loadGitRepository()` reads the files a repository tracks, one document each.

- A remote URL is shallow-cloned into a temporary directory, which is removed afterwards.
- A local path is read in place, unless a `ref` asks for another branch or tag.
- Binary files, and files over the size limit, are skipped.
- Each document carries the repository, the commit, and the path in its metadata, so a citation can
  link to the exact revision.

`GitLoaderOptions` takes the `ref`, `extensions`, an `ignore` test, `parsers` as for directories,
`maxFileBytes` (1 MB), the `git` executable, and a `timeoutMs` for the clone (2 minutes).

It runs `git` without a shell, with credential prompts and the `ext::` transport disabled. It keeps
committed line endings, so a commit loads the same on every platform. A failure raises a
`GitLoaderError` with what `git` printed.

## Limitations

- The HTML conversion is a heuristic, not a browser: a page built by script needs a `render` of the
  application's own, and an HTML file read from disk is never rendered.
- A JSON file's records stream from an array reached by object keys alone; one inside another array,
  or picked by a `records` function, is read whole.
- The Git loader needs the `git` executable on the path.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/loaders`

| Export | Kind | Summary |
| --- | --- | --- |
| `ChunkSink` | interface | Where loaded chunks go: a vector store, a `KeywordIndex`, or anything else with an `add()` for chunks. |
| `collectDocuments` | function | Reads every document from one or more loaders, in order, into an array. |
| `DocumentLoader` | type | Documents produced one at a time. |
| `DocumentSource` | interface | A document to split into chunks. |
| `FileInput` | type | A file to load: a path, a `file:` URL, content already in memory with a name for it, or a stream of it, such as a response's body or an object store's download. |
| `loadIntoStore` | function | Streams documents from loaders into one or more stores: each batch is split into chunks and added to every store at once, so memory holds one batch at a time however large the corpus is. |
| `LoadIntoStoreOptions` | interface | Options for `loadIntoStore()`: how documents are split, and how many are embedded at once. |
| `LoadIntoStoreResult` | interface | What `loadIntoStore()` stored. |

### `nexus-ai-pro/loaders/csv`

| Export | Kind | Summary |
| --- | --- | --- |
| `CsvLoaderOptions` | interface | Options for `loadCsv()`. |
| `CsvParseOptions` | interface | Options for `parseCsv()`. |
| `CsvRowParser` | class | CSV parsed as it arrives: `push()` takes the next piece of text, of any length, and returns the rows it completed; `end()` returns the last. |
| `loadCsv` | function | CSV files, one document per row. |
| `parseCsv` | function | Parses CSV into rows of fields, following RFC 4180: quoted fields may hold the delimiter, line breaks, and doubled quotes; lines may end in CRLF or LF; and a trailing line break adds no row. |

### `nexus-ai-pro/loaders/git`

| Export | Kind | Summary |
| --- | --- | --- |
| `GitLoaderError` | class | Raised when `git` fails, with what it printed. |
| `GitLoaderOptions` | interface | Options for `loadGitRepository()`. |
| `loadGitRepository` | function | The files a Git repository tracks, one document each. |

### `nexus-ai-pro/loaders/html`

| Export | Kind | Summary |
| --- | --- | --- |
| `HtmlLoaderOptions` | interface | Options for `loadHtml()`. |
| `HtmlText` | interface | An HTML page as text, with what a loader needs from its head and its links. |
| `htmlToText` | function | Turns HTML into readable text without a DOM: scripts, styles, and the head are dropped, block elements become line breaks, headings become Markdown headings so `splitOnMarkdownHeadings` splits a page at its sections, and entities are decoded. |
| `HtmlToTextOptions` | interface | Options for `htmlToText()`. |
| `loadHtml` | function | HTML files, one document each, with the page title and description in the metadata. |

### `nexus-ai-pro/loaders/json`

| Export | Kind | Summary |
| --- | --- | --- |
| `JsonLoaderOptions` | interface | Options for `loadJson()`. |
| `loadJson` | function | JSON and JSON Lines files, one document per record. |

### `nexus-ai-pro/loaders/markdown`

| Export | Kind | Summary |
| --- | --- | --- |
| `loadMarkdown` | function | Markdown files, one document each. |
| `MarkdownDocument` | interface | A Markdown file taken apart: its front matter, its title, and its body. |
| `MarkdownLoaderOptions` | interface | Options for `loadMarkdown()`. |
| `markdownToPlainText` | function | Markdown with its syntax removed and its words kept. |
| `parseMarkdown` | function | Splits off a Markdown file's front matter and finds its title. |

### `nexus-ai-pro/loaders/pdf`

| Export | Kind | Summary |
| --- | --- | --- |
| `loadPdf` | function | PDF files, through the parser you inject. |
| `PdfLoaderError` | class | Raised when a file given to `loadPdf()` is not a PDF. |
| `PdfLoaderOptions` | interface | Options for `loadPdf()`. |
| `PdfTextExtractor` | type | Extracts a PDF's text: the whole document as one string, or one string per page. |

### `nexus-ai-pro/loaders/text`

| Export | Kind | Summary |
| --- | --- | --- |
| `DirectoryLoaderOptions` | interface | Options for `loadDirectory()`. |
| `FileLoaderOptions` | interface | Options shared by the file loaders. |
| `FileParser` | type | Turns one file into documents: a loader such as `loadMarkdown` or `loadHtml`, given a single input. |
| `loadDirectory` | function | Every matching file under a directory, in sorted order so a load is reproducible. |
| `loadText` | function | Plain text files, one document each, whose id and source are the file's path or name. |

### `nexus-ai-pro/loaders/web`

| Export | Kind | Summary |
| --- | --- | --- |
| `browserRenderer` | function | A renderer over a browser of the application's own, such as Playwright's `chromium.launch()`: each page is opened, waited on, read, and closed. |
| `BrowserRendererOptions` | interface | Options for `browserRenderer()`. |
| `loadSitemap` | function | Every page a sitemap lists, loaded as `loadWebPages()` loads them. |
| `loadWebPages` | function | Web pages, one document each, fetched through the SSRF-safe fetch. |
| `RenderingBrowser` | interface | What `browserRenderer()` drives: a Playwright or Puppeteer browser, or anything shaped like one. |
| `SafeFetchPolicy` | interface | Which URLs a fetch may reach. |
| `SitemapOptions` | interface | Options for `sitemapUrls()` and `loadSitemap()`. |
| `sitemapUrls` | function | The page URLs a sitemap lists. |
| `WebLoaderError` | class | Raised when a page cannot be loaded: a status that is not 2xx, or a type that is not text. |
| `WebLoaderOptions` | interface | Options for the web loaders. |
| `WebPageRenderer` | type | Renders a page with a browser: the HTML it ends with once the page's scripts have run, which is what a page built by script holds. |
| `WebPageToRender` | interface | A page as fetched, which a renderer is given. |

### `nexus-ai-pro/rag/pipeline`

| Export | Kind | Summary |
| --- | --- | --- |
| `createIngestionPipeline` | function | Builds a pipeline that keeps the stores in step with a corpus, re-embedding only what changed. |
| `IngestedDocument` | interface | What the manifest records for one document. |
| `ingestionExecutor` | function | The pipeline as the executor of a durable operation: submit it to an `OperationRunner`, and an attempt that dies halfway is recovered by another worker, which starts at the document the first one stopped on. |
| `IngestionPipeline` | interface | A pipeline: run it as often as the corpus changes. |
| `IngestionPipelineOptions` | interface | Options for `createIngestionPipeline()`. |
| `IngestionReport` | interface | What a run did. |
| `IngestionRunOptions` | interface | Options for one run. |
| `IngestionSource` | type | A source of documents: a loader, an array, or any iterable, read once per run. |
<!-- reference:end -->
