# Loaders

<!-- covers: ./loaders ./loaders/text ./loaders/markdown ./loaders/html ./loaders/csv ./loaders/json ./loaders/pdf ./loaders/web ./loaders/git -->

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

Every loader returns a `DocumentLoader`: an async iterable of `DocumentSource` values — an id, the
text, a source, and metadata — produced one at a time, so a corpus larger than memory streams
through instead of being read whole. An ordinary array of documents is a loader too.

`loadIntoStore()` streams loaders into one or more stores. Each batch of documents is split with
the ingestion options and added to every store at once, so a vector store and the `KeywordIndex`
that hybrid search reads fill in one pass. A store is any `ChunkSink` — anything with an `add()`
for chunks. `LoadIntoStoreOptions` adds a `batchSize` (32 documents), a `signal` that stops between
batches, and an `onBatch` callback for progress; the `LoadIntoStoreResult` counts documents, chunks,
and characters. Chunk ids derive from document ids, and loaders use the file path, the URL, or the
row key as the id, so loading the same corpus again replaces its chunks instead of duplicating them.

`collectDocuments()` reads loaders into an array instead, for inspection or for code that wants
the documents themselves.

## Files

The file loaders take one input or many. A `FileInput` is a path, a `file:` URL, or content already
in memory with a name for it — `{ source: 'upload.md', content }` — which is how a loader reads an
upload, a database blob, or a file on a runtime without a filesystem; `node:fs` is imported only
when a path is read. `FileLoaderOptions` adds `metadata` to every document.

- **Text.** `loadText()` reads plain text files, one document each, dropping a byte-order mark.
- **Directories.** `loadDirectory()` walks a directory in sorted order, so a load is reproducible,
  and uses paths relative to it as ids. `DirectoryLoaderOptions` picks the `extensions`, a `parsers`
  map from extension to a `FileParser` — any loader given one file, such as `loadMarkdown` — whether
  to be `recursive`, an `ignore` test (by default `node_modules` and dot directories are skipped),
  and `maxFiles` (10,000), a guard against pointing at the wrong directory.
- **Markdown.** `loadMarkdown()` reads Markdown with its front matter and title in the metadata, so a
  filter can select on them; ingest with `splitOnMarkdownHeadings` so no chunk spans two sections.
  `parseMarkdown()` is the parser on its own, returning a `MarkdownDocument` with the body, the
  `frontMatter` fields, and the `title`. Front matter is read as flat `key: value` lines — strings,
  numbers, booleans, and inline lists — so no YAML parser is needed. `MarkdownLoaderOptions` can set
  `plainText`, which runs `markdownToPlainText()` to strip link targets, emphasis, and fences.
- **HTML.** `loadHtml()` reads HTML files, with the page title and description in the metadata.
  `htmlToText()` does the conversion without a DOM: scripts, styles, and the head are dropped, block
  elements become line breaks, headings become Markdown headings — so HTML splits by section too — and
  entities are decoded. It returns an `HtmlText` with the text, `title`, `description`, and every
  link. `HtmlToTextOptions` keeps only `<main>` or `<article>` by default (`mainContent`) and resolves
  links against a `baseUrl`; `HtmlLoaderOptions` combines them with the file options.
- **CSV.** `loadCsv()` makes one document per row, writing each column as `name: value` so a model
  reading a chunk knows what each value is. `CsvLoaderOptions` chooses the `textColumns`, an
  `idColumn` for stable ids, and `metadataColumns` to filter on. `parseCsv()` is an RFC 4180 parser
  — quoted delimiters, line breaks, and doubled quotes — and `CsvParseOptions` sets the `delimiter`.
- **JSON.** `loadJson()` makes one document per record, from a JSON file or JSON Lines. Through
  `JsonLoaderOptions`, `records` picks them out of the parsed value, `text` and `id` name a field by
  dotted path or a function, `metadataFields` copies fields into the metadata, and `lines` reads one
  value per line — on by default for `.jsonl` and `.ndjson`.
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

`loadWebPages()` fetches pages through the SSRF-safe fetch: private, loopback, and cloud-metadata
addresses are refused unless explicitly allowed, and each redirect hop is checked again.
`WebLoaderOptions` extends that `SafeFetchPolicy` — `allowedDomains`, `allowPrivateNetworks`, a
resolver — with `maxBytes` (5 MB), `maxRedirects` (5), a per-page `timeoutMs` (15 seconds),
`concurrency` (4 pages at once, still yielded in the order given), a `signal`, `metadata`, and
`mainContent`. HTML becomes text through `htmlToText()`; plain text, Markdown, and JSON are kept as
they are. A page that fails — a status other than 2xx, a type that is not text, a timeout — raises a
`WebLoaderError` with the URL and status; set `onError: 'skip'` to pass over it and hear about it in
`onSkip`.

`sitemapUrls()` reads a sitemap's page URLs, following a sitemap index into its sitemaps and
decompressing gzipped ones; `loadSitemap()` loads those pages. `SitemapOptions` adds an `include`
test and a `limit` (1,000 URLs).

## Git repositories

`loadGitRepository()` reads the files a repository tracks, one document each. A remote URL is
shallow-cloned into a temporary directory that is removed afterwards; a local path is read in place,
unless a `ref` asks for another branch or tag. Binary files and files over the size limit are
skipped, and each document carries the repository, the commit, and the path in its metadata, so a
citation can link to the exact revision. `GitLoaderOptions` takes the `ref`, `extensions`, an
`ignore` test, `parsers` as for directories, `maxFileBytes` (1 MB), the `git` executable, and a
`timeoutMs` for the clone (2 minutes). It runs `git` without a shell, with credential prompts and the
`ext::` transport disabled, and keeps committed line endings so a commit loads the same on every
platform; a failure raises a `GitLoaderError` with what `git` printed.

## Limitations

- The HTML conversion is a heuristic, not a browser: pages rendered by script have no content in
  their HTML. Render those elsewhere and pass the result to `htmlToText()`.
- CSV and JSON files are read whole before their rows stream out; split an export larger than memory
  into several files, or use JSON Lines.
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
| `FileInput` | type | A file to load: a path, a `file:` URL, or content already in memory with a name for it. |
| `loadIntoStore` | function | Streams documents from loaders into one or more stores: each batch is split into chunks and added to every store at once, so memory holds one batch at a time however large the corpus is. |
| `LoadIntoStoreOptions` | interface | Options for `loadIntoStore()`: how documents are split, and how many are embedded at once. |
| `LoadIntoStoreResult` | interface | What `loadIntoStore()` stored. |

### `nexus-ai-pro/loaders/csv`

| Export | Kind | Summary |
| --- | --- | --- |
| `CsvLoaderOptions` | interface | Options for `loadCsv()`. |
| `CsvParseOptions` | interface | Options for `parseCsv()`. |
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
| `loadSitemap` | function | Every page a sitemap lists, loaded as `loadWebPages()` loads them. |
| `loadWebPages` | function | Web pages, one document each, fetched through the SSRF-safe fetch. |
| `SafeFetchPolicy` | interface | Which URLs a fetch may reach. |
| `SitemapOptions` | interface | Options for `sitemapUrls()` and `loadSitemap()`. |
| `sitemapUrls` | function | The page URLs a sitemap lists. |
| `WebLoaderError` | class | Raised when a page cannot be loaded: a status that is not 2xx, or a type that is not text. |
| `WebLoaderOptions` | interface | Options for the web loaders. |
<!-- reference:end -->
