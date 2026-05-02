import { scanUploads, type FileUpload, type UploadScannerOptions } from '../security/upload-scanner.js';
import { ingestDocuments, type DocumentSource, type IngestionOptions, type IngestionResult } from './ingestion.js';

export interface FileTextExtractor {
  supports(file: FileUpload): boolean;
  extract(file: FileUpload): Promise<string> | string;
}

export interface FileIngestionOptions extends IngestionOptions {
  scan?: UploadScannerOptions;
  extractors?: FileTextExtractor[];
}

export interface FileIngestionResult extends IngestionResult {
  scannedFiles: number;
  skippedFiles: Array<{ name: string; reason: string }>;
}

export async function ingestFilesAfterScan(
  files: FileUpload[],
  options: FileIngestionOptions = {},
): Promise<FileIngestionResult> {
  const scan = scanUploads(files, options.scan);
  if (!scan.ok) {
    throw new Error(`Upload scan failed: ${scan.findings.map((finding) => `${finding.fileName}: ${finding.message}`).join('; ')}`);
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

export function createPdfExtractor(extractPdfText: (file: FileUpload) => Promise<string> | string): FileTextExtractor {
  return {
    supports: (file) => file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    extract: extractPdfText,
  };
}

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
  return mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/markdown'].includes(mimeType);
}
