import {
  createOcrExtractor,
  createPdfExtractor,
  ingestFilesAfterScan,
} from '../src/index.js';

// Wire your preferred OCR/PDF libraries here, for example:
// - pdf-parse, pdfjs-dist, or a hosted document AI parser for PDFs
// - tesseract.js, cloud vision, or another OCR service for images

const pdfExtractor = createPdfExtractor(async (file) => {
  return `[pdf text extracted from ${file.name}]`;
});

const ocrExtractor = createOcrExtractor(async (file) => {
  return `[ocr text extracted from ${file.name}]`;
});

const result = await ingestFilesAfterScan([
  {
    name: 'policy.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1200,
    content: Buffer.from('fake pdf bytes'),
  },
  {
    name: 'diagram.png',
    mimeType: 'image/png',
    sizeBytes: 800,
    content: Buffer.from('fake image bytes'),
  },
], {
  scan: {
    maxBytes: 5_000_000,
    allowedMimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  },
  extractors: [pdfExtractor, ocrExtractor],
  chunkSize: 800,
  overlap: 80,
});

console.log(result.chunks);
