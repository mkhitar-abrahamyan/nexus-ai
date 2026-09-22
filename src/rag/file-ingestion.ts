import { scanUploads, type FileUpload, type UploadScannerOptions } from '../security/upload-scanner.js';
import { ingestDocuments, type DocumentSource, type IngestionOptions, type IngestionResult } from './ingestion.js';

/** Turns one kind of file into text, such as PDF or an image through OCR. */
export interface FileTextExtractor {
  /** Whether it handles this file. */
  supports(file: FileUpload): boolean;
  /** Extracts the file's text. */
  extract(file: FileUpload): Promise<string> | string;
}

/** Options for `ingestFilesAfterScan()`. */
export interface FileIngestionOptions extends IngestionOptions {
  /** Upload scan settings. Every file is scanned before any is read. */
  scan?: UploadScannerOptions;
  /** Extractors tried in order. Text files need none. */
  extractors?: FileTextExtractor[];
}

/** The chunks produced from a set of files, and the files that could not be read. */
export interface FileIngestionResult extends IngestionResult {
  /** Files scanned. */
  scannedFiles: number;
  /** Files skipped because no extractor handles them. */
  skippedFiles: Array<{ name: string; reason: string }>;
}

/**
 * Scans uploads, extracts their text, and splits it into chunks. Throws when the scan finds
 * anything `high` or `critical`.
 */
export async function ingestFilesAfterScan(
  files: FileUpload[],
  options: FileIngestionOptions = {},
): Promise<FileIngestionResult> {
  const scan = scanUploads(files, options.scan);
  if (!scan.ok) {
    throw new Error(
      `Upload scan failed: ${scan.findings.map((finding) => `${finding.fileName}: ${finding.message}`).join('; ')}`,
    );
  }

  const documents: DocumentSource[] = [];
  const skippedFiles: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    const extractor = options.extractors?.find((item) => item.supports(file));
    if (extractor) {
      documents.push({
        id: file.name,
        source: file.name,
        text: await extractor.extract(file),
        metadata: { mimeType: file.mimeType, sizeBytes: file.sizeBytes },
      });
      continue;
    }

    if (typeof file.content === 'string' && isTextMime(file.mimeType)) {
      documents.push({
        id: file.name,
        source: file.name,
        text: file.content,
        metadata: { mimeType: file.mimeType, sizeBytes: file.sizeBytes },
      });
      continue;
    }

    skippedFiles.push({ name: file.name, reason: 'No extractor available for file type' });
  }

  const result = ingestDocuments(documents, options);
  return {
    ...result,
    scannedFiles: files.length,
    skippedFiles,
  };
}

/** An extractor for PDF files, around your own PDF-to-text function. */
export function createPdfExtractor(extractPdfText: (file: FileUpload) => Promise<string> | string): FileTextExtractor {
  return {
    supports: (file) => file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    extract: extractPdfText,
  };
}

/** An extractor for images, around your own OCR function. Defaults to PNG, JPEG, and WebP. */
export function createOcrExtractor(
  ocrImage: (file: FileUpload) => Promise<string> | string,
  mimeTypes = ['image/png', 'image/jpeg', 'image/webp'],
): FileTextExtractor {
  return {
    supports: (file) => Boolean(file.mimeType && mimeTypes.includes(file.mimeType)),
    extract: ocrImage,
  };
}

function isTextMime(mimeType?: string): boolean {
  if (!mimeType) return true;
  return (
    mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/markdown'].includes(mimeType)
  );
}
