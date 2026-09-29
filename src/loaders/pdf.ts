import type { DocumentSource, FileInput } from './index.js';
import { inputsOf, readInput } from './input.js';
import type { FileLoaderOptions } from './text.js';

/**
 * Extracts a PDF's text: the whole document as one string, or one string per page. Wrap the parser
 * you already use — `pdfjs-dist`, `unpdf`, `pdf-parse`, or an OCR service — so no PDF library is a
 * dependency of this package.
 */
export type PdfTextExtractor = (
  bytes: Uint8Array,
  source: string,
) => Promise<string | readonly string[]> | string | readonly string[];

/** Options for `loadPdf()`. */
export interface PdfLoaderOptions extends FileLoaderOptions {
  /** Your PDF parser. */
  extract: PdfTextExtractor;
  /**
   * One document per page when the extractor returns pages, with `page` in the metadata, so a
   * citation can name the page. On by default; off joins the pages into one document.
   */
  splitPages?: boolean;
}

/** Raised when a file given to `loadPdf()` is not a PDF. */
export class PdfLoaderError extends Error {
  constructor(
    message: string,
    /** The file that failed. */
    readonly source: string,
  ) {
    super(message);
    this.name = 'PdfLoaderError';
  }
}

/**
 * PDF files, through the parser you inject. A file that does not start with the PDF signature is
 * refused before it reaches the parser, so a mislabelled upload fails with a clear error.
 */
export async function* loadPdf(
  inputs: FileInput | Iterable<FileInput>,
  options: PdfLoaderOptions,
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, bytes } = await readInput(input);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw new PdfLoaderError(`${source} is not a PDF`, source);
    }
    const extracted = await options.extract(bytes, source);
    const pages = typeof extracted === 'string' ? [extracted] : extracted;
    if (typeof extracted !== 'string' && (options.splitPages ?? true)) {
      for (const [index, page] of pages.entries()) {
        if (!page.trim()) continue;
        yield {
          id: `${source}#page-${index + 1}`,
          text: page,
          source,
          metadata: { ...options.metadata, page: index + 1 },
        };
      }
      continue;
    }
    yield {
      id: source,
      text: pages.join('\n\n'),
      source,
      metadata: { ...options.metadata, pages: pages.length },
    };
  }
}
