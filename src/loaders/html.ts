import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readText } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** An HTML page as text, with what a loader needs from its head and its links. */
export interface HtmlText {
  /** The readable text. Headings become Markdown `#` lines and list items `- ` lines. */
  text: string;
  /** The `<title>`. */
  title?: string;
  /** The `<meta name="description">`. */
  description?: string;
  /** Every `href` on an `<a>`, resolved against `baseUrl` when one is given. */
  links: string[];
}

/** Options for `htmlToText()`. */
export interface HtmlToTextOptions {
  /**
   * Keeps only `<main>`, or else `<article>`, when the page has one, dropping navigation, headers,
   * and footers. On by default.
   */
  mainContent?: boolean;
  /** Resolves relative links. */
  baseUrl?: string | URL;
}

const DROPPED = /<(script|style|noscript|template|svg|iframe|canvas|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK =
  /<\/?(p|div|section|article|main|header|footer|nav|aside|blockquote|pre|table|thead|tbody|tfoot|tr|ul|ol|dl|dt|dd|figure|figcaption|form|fieldset|address|hr)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  euro: '€',
  pound: '£',
  deg: '°',
};

/**
 * Turns HTML into readable text without a DOM: scripts, styles, and the head are dropped, block
 * elements become line breaks, headings become Markdown headings so `splitOnMarkdownHeadings` splits
 * a page at its sections, and entities are decoded. A heuristic, not a browser: it is built for pages
 * whose content is in the HTML, not rendered by script.
 */
export function htmlToText(html: string, options: HtmlToTextOptions = {}): HtmlText {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const description =
    /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(html)?.[1];

  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROPPED, '');
  if (options.mainContent ?? true) {
    const region =
      /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body) ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(body);
    if (region) body = region[1];
  }

  const links: string[] = [];
  for (const match of body.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const href = decodeEntities(match[1]);
    try {
      links.push(options.baseUrl ? new URL(href, options.baseUrl).href : href);
    } catch {
      // An unparseable href is not a link a loader can follow.
    }
  }

  const text = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '');

  return {
    text: tidy(decodeEntities(text)),
    ...(title ? { title: tidy(decodeEntities(title)) } : {}),
    ...(description ? { description: decodeEntities(description).trim() } : {}),
    links: [...new Set(links)],
  };
}

/** Options for `loadHtml()`. */
export interface HtmlLoaderOptions extends FileLoaderOptions, HtmlToTextOptions {}

/** HTML files, one document each, with the page title and description in the metadata. */
export async function* loadHtml(
  inputs: FileInput | Iterable<FileInput>,
  options: HtmlLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, text } = await readText(input);
    const page = htmlToText(text, options);
    yield {
      id: source,
      text: page.text,
      source,
      metadata: {
        ...options.metadata,
        ...(page.title ? { title: page.title } : {}),
        ...(page.description ? { description: page.description } : {}),
      },
    };
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
