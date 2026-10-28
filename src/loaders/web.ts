import { parseUrl, type SafeFetchPolicy, safeFetch } from '../utils/safe-fetch.js';
import { htmlToText } from './html.js';
import type { DocumentSource } from './index.js';

export type { SafeFetchPolicy } from '../utils/safe-fetch.js';

/**
 * Options for the web loaders. The fetch policy is the same one the `fetch_url` tool uses: private,
 * loopback, and cloud-metadata addresses are refused unless explicitly allowed, and every redirect
 * hop is checked again.
 */
export interface WebLoaderOptions extends SafeFetchPolicy {
  /** Largest response read, in bytes. Defaults to 5 MB. */
  maxBytes?: number;
  /** Redirects followed per page. Defaults to 5. */
  maxRedirects?: number;
  /** Time allowed per page, in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Pages fetched at once. Documents are still yielded in the order the URLs were given. Defaults to 4. */
  concurrency?: number;
  /** Stops loading. */
  signal?: AbortSignal;
  /** Application data added to every document. */
  metadata?: Record<string, unknown>;
  /** Keeps only a page's `<main>` or `<article>`, as `htmlToText()` does. On by default. */
  mainContent?: boolean;
  /**
   * What a page that cannot be loaded does: `throw` stops the load, `skip` passes over it and calls
   * `onSkip`. Defaults to `throw`.
   */
  onError?: 'throw' | 'skip';
  /** Called for each page skipped, with the reason. */
  onSkip?: (url: string, reason: Error) => void;
  /**
   * Renders a page whose content a script builds, with a browser of the application's own, such as
   * `browserRenderer()` over Playwright's: given the page fetched, it returns the HTML the browser ends
   * with. Called for an HTML page that runs a script and whose text, as fetched, is shorter than
   * `renderBelow`. The fetch has checked the page's URL first; the browser fetches what the page
   * loads under its own policy.
   */
  render?: WebPageRenderer;
  /** Renders a page whose fetched text is shorter than this many characters. Defaults to 200; `Infinity` renders every page that runs a script. */
  renderBelow?: number;
}

/** A page as fetched, which a renderer is given. */
export interface WebPageToRender {
  /** Its URL, after redirects. */
  url: string;
  /** The HTML the server sent. */
  html: string;
}

/**
 * Renders a page with a browser: the HTML it ends with once the page's scripts have run, which is
 * what a page built by script holds.
 */
export type WebPageRenderer = (page: WebPageToRender, signal: AbortSignal) => Promise<string> | string;

/** What `browserRenderer()` drives: a Playwright or Puppeteer browser, or anything shaped like one. */
export interface RenderingBrowser {
  /** Opens a page. */
  newPage(): Promise<{
    /** Goes to a URL and waits as told. */
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    /** The HTML the page holds now. */
    content(): Promise<string>;
    /** Closes it. */
    close(): Promise<unknown>;
  }>;
}

/** Options for `browserRenderer()`. */
export interface BrowserRendererOptions {
  /** When the page counts as rendered. Defaults to `networkidle`, as Playwright names it. */
  waitUntil?: string;
  /** Time allowed per page, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/**
 * A renderer over a browser of the application's own, such as Playwright's `chromium.launch()`: each
 * page is opened, waited on, read, and closed. The package depends on no browser; the browser fetches
 * the page and what it loads under its own network policy, not the loader's.
 *
 * ```ts
 * const browser = await chromium.launch();
 * for await (const page of loadWebPages(urls, { render: browserRenderer(browser) })) store(page);
 * ```
 */
export function browserRenderer(browser: RenderingBrowser, options: BrowserRendererOptions = {}): WebPageRenderer {
  return async (page, signal) => {
    signal.throwIfAborted();
    const tab = await browser.newPage();
    try {
      await tab.goto(page.url, { waitUntil: options.waitUntil ?? 'networkidle', timeout: options.timeoutMs ?? 30_000 });
      signal.throwIfAborted();
      return await tab.content();
    } finally {
      await tab.close().catch(() => undefined);
    }
  };
}

/** The most a sitemap may hold uncompressed, by the sitemap protocol. */
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

/** Raised when a page cannot be loaded: a status that is not 2xx, or a type that is not text. */
export class WebLoaderError extends Error {
  constructor(
    message: string,
    /** The page. */
    readonly url: string,
    /** The HTTP status, when the server answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebLoaderError';
  }
}

/**
 * Web pages, one document each, fetched through the SSRF-safe fetch. HTML becomes text through
 * `htmlToText()`, with its title and description in the metadata; plain text, Markdown, and JSON are
 * kept as they are. The id is the final URL after redirects.
 */
export async function* loadWebPages(
  urls: Iterable<string | URL> | AsyncIterable<string | URL>,
  options: WebLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  const concurrency = options.concurrency ?? 4;
  if (!(Number.isInteger(concurrency) && concurrency > 0)) {
    throw new RangeError('concurrency must be a positive integer');
  }
  let window: Array<Promise<DocumentSource | Error>> = [];
  const drain = async function* () {
    for (const pending of window) {
      const result = await pending;
      if (result instanceof Error) {
        if ((options.onError ?? 'throw') === 'throw') throw result;
        options.onSkip?.(result instanceof WebLoaderError ? result.url : '', result);
      } else yield result;
    }
    window = [];
  };

  for await (const url of urls) {
    options.signal?.throwIfAborted();
    window.push(loadPage(String(url), options).catch((error: unknown) => asError(error, String(url))));
    if (window.length >= concurrency) yield* drain();
  }
  yield* drain();
}

/** Options for `sitemapUrls()` and `loadSitemap()`. */
export interface SitemapOptions extends WebLoaderOptions {
  /** Keeps a page URL; the rest are not fetched. */
  include?: (url: string) => boolean;
  /** Most page URLs returned. Defaults to 1,000. */
  limit?: number;
}

/**
 * The page URLs a sitemap lists. A sitemap index is followed into its sitemaps, three levels deep at
 * most, and gzipped sitemaps are decompressed. Each URL appears once.
 */
export async function sitemapUrls(url: string | URL, options: SitemapOptions = {}): Promise<string[]> {
  const limit = options.limit ?? 1000;
  const pages = new Set<string>();
  const seen = new Set<string>();

  const visit = async (sitemap: string, depth: number): Promise<void> => {
    if (seen.has(sitemap) || depth > 3 || pages.size >= limit) return;
    seen.add(sitemap);
    const { bytes } = await fetchBody(sitemap, options, 'application/xml, text/xml;q=0.9, */*;q=0.5');
    let xml: string;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const { gunzipSync } = await import('node:zlib');
      try {
        // A few megabytes of gzip can inflate to gigabytes; the sitemap protocol caps a sitemap at
        // 50 MB uncompressed, so nothing larger is a sitemap.
        xml = gunzipSync(bytes, { maxOutputLength: MAX_SITEMAP_BYTES }).toString('utf8');
      } catch (error) {
        throw new WebLoaderError(
          `${sitemap} does not decompress to a sitemap of at most 50 MB: ${error instanceof Error ? error.message : String(error)}`,
          sitemap,
        );
      }
    } else xml = new TextDecoder().decode(bytes);
    const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeXml(match[1]));
    if (/<sitemapindex\b/i.test(xml)) {
      for (const child of locations) await visit(child, depth + 1);
      return;
    }
    for (const location of locations) {
      if (pages.size >= limit) break;
      if (!options.include || options.include(location)) pages.add(location);
    }
  };

  await visit(String(url), 0);
  return [...pages];
}

/** Every page a sitemap lists, loaded as `loadWebPages()` loads them. */
export async function* loadSitemap(url: string | URL, options: SitemapOptions = {}): AsyncGenerator<DocumentSource> {
  yield* loadWebPages(await sitemapUrls(url, options), options);
}

async function loadPage(url: string, options: WebLoaderOptions): Promise<DocumentSource> {
  const response = await fetchBody(
    url,
    options,
    'text/html, application/xhtml+xml, text/plain;q=0.9, text/markdown;q=0.9, application/json;q=0.8',
  );
  const type = (response.contentType ?? '').split(';')[0].trim().toLowerCase();
  const body = new TextDecoder().decode(response.bytes);
  const metadata: Record<string, unknown> = { ...options.metadata, url: response.url };
  if (type === 'text/html' || type === 'application/xhtml+xml' || (!type && /^\s*</.test(body))) {
    let page = htmlToText(body, { baseUrl: response.url, mainContent: options.mainContent });
    if (options.render && page.text.length < (options.renderBelow ?? 200) && /<script\b/i.test(body)) {
      const html = await options.render(
        { url: response.url, html: body },
        options.signal ?? new AbortController().signal,
      );
      page = htmlToText(html, { baseUrl: response.url, mainContent: options.mainContent });
      metadata.rendered = true;
    }
    if (page.title) metadata.title = page.title;
    if (page.description) metadata.description = page.description;
    return { id: response.url, text: page.text, source: response.url, metadata };
  }
  if (type.startsWith('text/') || type === 'application/json' || type.endsWith('+json')) {
    return { id: response.url, text: body, source: response.url, metadata };
  }
  throw new WebLoaderError(
    `${response.url} is ${type || 'of no declared type'}, not text`,
    response.url,
    response.status,
  );
}

async function fetchBody(url: string, options: WebLoaderOptions, accept: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  timer.unref?.();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await safeFetch(parseUrl(url), {
      ...options,
      maxBytes: options.maxBytes ?? 5_000_000,
      maxRedirects: options.maxRedirects ?? 5,
      signal: controller.signal,
      accept,
    });
    if (!response.ok) {
      throw new WebLoaderError(`${url} answered ${response.status}`, response.url, response.status);
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new WebLoaderError(`${url} did not answer within ${options.timeoutMs ?? 15_000}ms`, url);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

function asError(error: unknown, url: string): Error {
  if (error instanceof WebLoaderError) return error;
  const wrapped = new WebLoaderError(`${url} could not be loaded: ${(error as Error)?.message ?? error}`, url);
  wrapped.cause = error;
  return wrapped;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
