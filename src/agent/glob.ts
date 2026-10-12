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
