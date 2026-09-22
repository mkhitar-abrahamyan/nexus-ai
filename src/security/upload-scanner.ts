/** A file offered for upload. */
export interface FileUpload {
  /** File name, whose extension is checked. */
  name: string;
  /** MIME type, checked against `allowedMimeTypes`. */
  mimeType?: string;
  /** Size in bytes. Measured from `content` when omitted. */
  sizeBytes?: number;
  /** The contents. Text contents are scanned for forbidden patterns. */
  content?: string | Buffer;
}

/** Options for scanning uploads. */
export interface UploadScannerOptions {
  /** Largest file allowed, in bytes. No limit by default. */
  maxBytes?: number;
  /** MIME types allowed. Any type by default. */
  allowedMimeTypes?: string[];
  /** Extensions refused. Defaults to executables and scripts such as `.exe`, `.ps1`, and `.js`. */
  blockedExtensions?: string[];
  /** Scans text contents for forbidden patterns. Defaults to true. */
  scanTextContent?: boolean;
  /**
   * Patterns refused in text contents. Defaults to private keys, cloud and GitHub tokens, and
   * instruction-override phrases.
   */
  forbiddenPatterns?: RegExp[];
}

/** One problem found in an upload. */
export interface UploadScanFinding {
  /** The file it was found in. */
  fileName: string;
  /** How serious it is. `high` and `critical` findings fail the scan. */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** What was found. */
  message: string;
  /** The matched text, for a forbidden pattern. */
  value?: string;
}

/** The outcome of scanning uploads. */
export interface UploadScanResult {
  /** True when nothing `high` or `critical` was found. */
  ok: boolean;
  /** Every finding. */
  findings: UploadScanFinding[];
}

const DEFAULT_BLOCKED_EXTENSIONS = ['.exe', '.dll', '.bat', '.cmd', '.ps1', '.sh', '.js', '.vbs', '.scr'];
const DEFAULT_FORBIDDEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
];

/**
 * Checks uploads for size, extension, MIME type, and forbidden content before they reach a model or
 * a store.
 */
export class UploadScanner {
  constructor(private options: UploadScannerOptions = {}) {}

  /** Scans a set of files. */
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

/** Scans a set of files with a one-off scanner. */
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
