import type { RagChunk } from '../hallucination/rag.js';

/** A document to split into chunks. */
export interface DocumentSource {
  /** Its id, used in chunk ids. Defaults to `doc-1`, `doc-2`, and so on. */
  id?: string;
  /** Its text. */
  text: string;
  /** Where it came from, carried on each chunk. */
  source?: string;
  /** Application data carried on each chunk. */
  metadata?: Record<string, unknown>;
}

/** How documents are split. */
export interface IngestionOptions {
  /** Most characters per chunk. Defaults to 1,200. */
  chunkSize?: number;
  /** Characters repeated between neighbouring chunks. Defaults to 150. */
  overlap?: number;
  /** Splits at Markdown headings first, so no chunk spans two sections. Off by default. */
  splitOnMarkdownHeadings?: boolean;
}

/** The chunks produced from a set of documents. */
export interface IngestionResult {
  /** The chunks, ready for a vector store. */
  chunks: RagChunk[];
  /** Documents read. */
  documents: number;
  /** Characters across every document. */
  totalCharacters: number;
}

/** Splits documents into overlapping chunks for retrieval. */
export function ingestDocuments(documents: DocumentSource[], options: IngestionOptions = {}): IngestionResult {
  const chunks: RagChunk[] = [];
  const chunkSize = options.chunkSize || 1200;
  const overlap = Math.min(options.overlap || 150, Math.max(0, chunkSize - 1));

  for (const [docIndex, doc] of documents.entries()) {
    const sections = options.splitOnMarkdownHeadings ? splitMarkdownSections(doc.text) : [doc.text];

    for (const [sectionIndex, section] of sections.entries()) {
      let start = 0;
      let chunkIndex = 0;
      while (start < section.length) {
        const end = Math.min(section.length, start + chunkSize);
        const content = section.slice(start, end).trim();
        if (content) {
          chunks.push({
            id: `${doc.id || `doc-${docIndex + 1}`}-${sectionIndex + 1}-${chunkIndex + 1}`,
            content,
            source: doc.source,
            metadata: {
              ...doc.metadata,
              documentId: doc.id,
              sectionIndex,
              chunkIndex,
            },
          });
        }
        if (end >= section.length) break;
        start = Math.max(0, end - overlap);
        chunkIndex += 1;
      }
    }
  }

  return {
    chunks,
    documents: documents.length,
    totalCharacters: documents.reduce((sum, doc) => sum + doc.text.length, 0),
  };
}

/** Splits one text into overlapping chunks for retrieval. */
export function ingestText(text: string, options: IngestionOptions & { source?: string } = {}): IngestionResult {
  return ingestDocuments([{ text, source: options.source }], options);
}

function splitMarkdownSections(text: string): string[] {
  const sections = text
    .split(/(?=^#{1,6}\s+)/m)
    .map((section) => section.trim())
    .filter(Boolean);
  return sections.length ? sections : [text];
}
