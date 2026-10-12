/**
 * File globs for workspace search, shared by the sandboxes: `*` matches within a path segment, `**`
 * across segments (`**\/` also matches none), `?` one character, and `{a,b}` either alternative.
 * Paths use `/`, are relative to the search root, and match case-sensitively.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  const glob = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  let braces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      braces += 1;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces -= 1;
      source += ')';
    } else if (char === ',' && braces > 0) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  source += ')'.repeat(braces);
  const expression = new RegExp(`^${source}$`);
  return (path) => expression.test(path.replace(/\\/g, '/'));
}

/** Directories workspace search never enters. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);
/** The most directory entries, or files, one search walks. */
export const WALK_LIMIT = 20_000;
/** Files larger than this are not searched. */
export const GREP_FILE_BYTES = 1_048_576;
/** One search reads no more than this, in all. */
export const GREP_TOTAL_BYTES = 64 * 1_048_576;

/** Only this much of a line is searched, so a minified file cannot stall a search. */
const GREP_LINE_CHARS = 4_000;

/**
 * The lines of a file that match, numbered from 1 and cut to 300 characters, at most `limit`; none
 * for a binary file, one with a NUL byte in its first 8,000 bytes.
 */
export function matchingLines(
  bytes: Uint8Array,
  expression: RegExp,
  limit: number,
): Array<{ line: number; text: string }> {
  if (bytes.subarray(0, 8_000).includes(0)) return [];
  const found: Array<{ line: number; text: string }> = [];
  for (const [index, line] of new TextDecoder().decode(bytes).split(/\r?\n/).entries()) {
    if (!expression.test(line.slice(0, GREP_LINE_CHARS))) continue;
    found.push({ line: index + 1, text: line.slice(0, 300) });
    if (found.length >= limit) break;
  }
  return found;
}

/** MIME types for the media a workspace tool reads as content the model sees, by file extension. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  wav: 'audio/wav',
  mp3: 'audio/mp3',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
};
