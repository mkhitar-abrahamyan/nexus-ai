/**
 * Ids and text measures from Web Crypto and plain JavaScript, so the modules that use them run on
 * every runtime: Node.js, Deno, Bun, edge runtimes, and browsers.
 */

/** Random bytes as lowercase hex, two characters per byte. */
export function randomHex(bytes: number): string {
  const values = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let hex = '';
  for (const value of values) hex += HEX[value];
  return hex;
}

export function generateRequestId(): string {
  return `req_${randomHex(12)}`;
}

/** The bytes UTF-8 takes for a string, as `Buffer.byteLength()` counts them, without encoding it. */
export function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      length += 4;
      index += 1;
    } else length += 3; // A lone surrogate is written as U+FFFD, which is three bytes too.
  }
  return length;
}

const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
