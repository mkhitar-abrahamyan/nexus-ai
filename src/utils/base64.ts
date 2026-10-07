/**
 * Base64 on every runtime: Node's `Buffer` where it is there, which is faster on large inputs, and
 * the web's `atob()` and `btoa()` everywhere else.
 */
type BufferLike = {
  from(data: string, encoding: 'base64'): Uint8Array;
  from(data: Uint8Array): { toString(encoding: 'base64'): string };
};
const host = () => (globalThis as { Buffer?: BufferLike }).Buffer;

/** Base64 text as bytes, in a buffer of their own, so typed-array views of it are aligned. */
export function decodeBase64(data: string): Uint8Array {
  const buffer = host();
  if (buffer) return new Uint8Array(buffer.from(data, 'base64'));
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Bytes as base64 text. */
export function encodeBase64(bytes: Uint8Array): string {
  const buffer = host();
  if (buffer) return buffer.from(bytes).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
