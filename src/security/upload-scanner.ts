export interface FileUpload {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  content?: string | Buffer;
}

export interface UploadScannerOptions {
  maxBytes?: number;
  allowedMimeTypes?: string[];
  blockedExtensions?: string[];
  scanTextContent?: boolean;
  forbiddenPatterns?: RegExp[];
}

export interface UploadScanFinding {
  fileName: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  value?: string;
}

export interface UploadScanResult {
  ok: boolean;
  findings: UploadScanFinding[];
}

const DEFAULT_BLOCKED_EXTENSIONS = ['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.js', '.vbs', '.scr'];
const DEFAULT_FORBIDDEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
];

export class UploadScanner {
  constructor(private options: UploadScannerOptions = {}) {}

  scan(files: FileUpload[]): UploadScanResult {
    const findings: UploadScanFinding[] = [];
    const blockedExtensions = this.options.blockedExtensions || DEFAULT_BLOCKED_EXTENSIONS;
    const forbiddenPatterns = this.options.forbiddenPatterns || DEFAULT_FORBIDDEN_PATTERNS;

    for (const file of files) {
      const extension = extensionOf(file.name);
      const size = file.sizeBytes ?? sizeOf(file.content);

      if (this.options.maxBytes && size > this.options.maxBytes) {
        findings.push({
          fileName: file.name,
          severity: 'high',
          message: `File exceeds maxBytes ${this.options.maxBytes}`,
        });
      }

      if (blockedExtensions.includes(extension)) {
        findings.push({
          fileName: file.name,
          severity: 'critical',
          message: `Blocked file extension ${extension}`,
        });
      }

      if (
        this.options.allowedMimeTypes?.length &&
        file.mimeType &&
        !this.options.allowedMimeTypes.includes(file.mimeType)
      ) {
        findings.push({
          fileName: file.name,
          severity: 'high',
          message: `MIME type ${file.mimeType} is not allowed`,
        });
      }

      if (this.options.scanTextContent !== false && typeof file.content === 'string') {
        for (const pattern of forbiddenPatterns) {
          const match = file.content.match(pattern);
          if (match) {
            findings.push({
              fileName: file.name,
              severity: 'critical',
              message: 'Forbidden content pattern found in upload',
              value: match[0],
            });
          }
        }
      }
    }

    return {
      ok: findings.every((finding) => finding.severity !== 'critical' && finding.severity !== 'high'),
      findings,
    };
  }
}

export function scanUploads(files: FileUpload[], options: UploadScannerOptions = {}): UploadScanResult {
  return new UploadScanner(options).scan(files);
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

function sizeOf(content?: string | Buffer): number {
  if (!content) return 0;
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
}
