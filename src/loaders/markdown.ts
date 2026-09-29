import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readText } from './input.js';
import type { FileLoaderOptions } from './text.js';

/** A Markdown file taken apart: its front matter, its title, and its body. */
export interface MarkdownDocument {
  /** The body, without the front matter. */
  text: string;
  /** Fields from a leading `---` block: strings, numbers, booleans, and inline `[a, b]` lists. */
  frontMatter: Record<string, unknown>;
  /** The front matter's `title`, or else the first `#` heading. */
  title?: string;
}

/**
 * Splits off a Markdown file's front matter and finds its title. The front matter is read as flat
 * `key: value` lines — the subset almost every docs site uses — so no YAML parser is needed; a
 * nested value is kept as its raw text.
 */
export function parseMarkdown(markdown: string): MarkdownDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const frontMatter: Record<string, unknown> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (field) frontMatter[field[1]] = scalar(field[2].trim());
    }
  }
  const text = match ? markdown.slice(match[0].length) : markdown;
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text);
  const title = typeof frontMatter.title === 'string' ? frontMatter.title : heading?.[1];
  return { text, frontMatter, ...(title ? { title } : {}) };
}

/** Options for `loadMarkdown()`. */
export interface MarkdownLoaderOptions extends FileLoaderOptions {
  /**
   * Removes Markdown syntax — link targets, images, emphasis, and code fences — leaving the words.
   * Off by default, because headings are what `splitOnMarkdownHeadings` splits on and models read
   * Markdown well.
   */
  plainText?: boolean;
}

/**
 * Markdown files, one document each. Front matter and the title go into the metadata, so a filter can
 * select by them; ingest with `splitOnMarkdownHeadings` so no chunk spans two sections.
 */
export async function* loadMarkdown(
  inputs: FileInput | Iterable<FileInput>,
  options: MarkdownLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, text } = await readText(input);
    const parsed = parseMarkdown(text);
    yield {
      id: source,
      text: options.plainText ? markdownToPlainText(parsed.text) : parsed.text,
      source,
      metadata: {
        ...options.metadata,
        ...parsed.frontMatter,
        ...(parsed.title ? { title: parsed.title } : {}),
      },
    };
  }
}

/** Markdown with its syntax removed and its words kept. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scalar(value: string): unknown {
  if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1);
  if (value === 'true' || value === 'false') return value === 'true';
  if (value !== '' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\[.*\]$/.test(value)) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map(scalar);
  }
  return value;
}
