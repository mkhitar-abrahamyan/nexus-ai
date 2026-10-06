/** A file offered for upload. */
export interface FileUpload {
  /** File name, whose extension is checked. */
  name: string;
  /** MIME type, checked against `allowedMimeTypes`. */
  mimeType?: string;
  /** Size in bytes. Measured from `content` when omitted. */
  sizeBytes?: number;
  /** The contents, as text or bytes; a Node `Buffer` is bytes. Text contents are scanned for forbidden patterns. */
  content?: string | Uint8Array;
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
      // The declared size is a claim; the content is the fact. The larger of the two is checked, so a
      // small `sizeBytes` cannot carry a large file past `maxBytes`.
      const size = Math.max(file.sizeBytes ?? 0, sizeOf(file.content));
      const mimeType = normalizeMime(file.mimeType);

      // A control character in a name can end the name early on disk: `run.exe\0.txt` is `run.exe`.
      if (controlCharacterAt(file.name) !== -1) {
        findings.push({
          fileName: file.name,
          severity: 'critical',
          message: 'File name contains a control character',
        });
      }

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

      // An allowlist fails closed: a file that names no type is not one of the allowed types.
      const allowed = this.options.allowedMimeTypes?.map(normalizeMime);
      if (allowed?.length && !(mimeType && allowed.includes(mimeType))) {
        findings.push({
          fileName: file.name,
          severity: 'high',
          message: mimeType ? `MIME type ${mimeType} is not allowed` : 'MIME type is missing, and an allowlist is set',
        });
      }

      const text = this.options.scanTextContent === false ? undefined : textOf(file.content, mimeType);
      if (text !== undefined) {
        for (const pattern of forbiddenPatterns) {
          const match = text.match(pattern);
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

/**
 * The extension as the file system will see it. Windows drops trailing dots and spaces, so `run.exe.`
 * and `run.exe ` both run as `run.exe`, and a control character or a path is no part of a name.
 */
function extensionOf(name: string): string {
  const cut = controlCharacterAt(name);
  const base = (cut === -1 ? name : name.slice(0, cut)).split(/[\\/]/).pop() as string;
  const trimmed = base.replace(/[.\s]+$/, '');
  const index = trimmed.lastIndexOf('.');
  return index === -1 ? '' : trimmed.slice(index).toLowerCase();
}

/** Where the first control character in a name is, NUL included, or -1. */
function controlCharacterAt(name: string): number {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return index;
  }
  return -1;
}

/** A MIME type compared as a type: lower-cased, without parameters such as `; charset=utf-8`. */
function normalizeMime(mimeType: string | undefined): string | undefined {
  const type = mimeType?.split(';')[0]?.trim().toLowerCase();
  return type || undefined;
}

/**
 * A file's contents as text, when it is text: a string as it is, and bytes decoded as UTF-8 when the
 * type is textual or not given. Upload middleware hands files over as bytes, so scanning only strings
 * would let every uploaded text file through unread.
 */
export function textOf(content: string | Uint8Array | undefined, mimeType?: string): string | undefined {
  if (typeof content === 'string') return content;
  if (!content || !isTextual(mimeType)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    // Not valid UTF-8: binary, whatever its type claims.
    return undefined;
  }
}

/** Whether a MIME type is text a person or a model reads; no type counts, since text is the common case. */
export function isTextual(mimeType: string | undefined): boolean {
  const type = normalizeMime(mimeType);
  if (!type) return true;
  return (
    type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/markdown', 'application/x-yaml', 'application/yaml'].includes(
      type,
    )
  );
}

function sizeOf(content?: string | Uint8Array): number {
  if (!content) return 0;
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}
