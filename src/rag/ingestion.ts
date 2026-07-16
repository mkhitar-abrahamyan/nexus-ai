import type { RagChunk } from '../hallucination/rag.js';

export interface DocumentSource {
  id?: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestionOptions {
  chunkSize?: number;
  overlap?: number;
  splitOnMarkdownHeadings?: boolean;
}

export interface IngestionResult {
  chunks: RagChunk[];
  documents: number;
  totalCharacters: number;
}

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
