/**
 * Image header parsing: format sniffing and dimensions, with no decompression.
 *
 * Kept apart from the PNG codec so input validation, which runs on every request that carries an
 * image, loads only this and never the pixel decoder. Reading headers only is also what lets a
 * pixel ceiling stop a decompression bomb before anything is inflated.
 */

export type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'bmp';

/** An image format recognised from its first bytes. */
export interface SniffedImage {
  /** The format. */
  format: SniffedImageFormat;
  /** Its MIME type. */
  mimeType: string;
}

/** Image dimensions read from a header. */
export interface ImageDimensionsInfo {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Identifies an image from its first bytes, ignoring whatever the caller claimed it was. */
export function sniffImageType(bytes: Uint8Array): SniffedImage | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return { format: 'png', mimeType: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { format: 'jpeg', mimeType: 'image/jpeg' };
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
    return { format: 'gif', mimeType: 'image/gif' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { format: 'webp', mimeType: 'image/webp' };
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { format: 'avif', mimeType: 'image/avif' };
  }
  if (ascii(bytes, 0, 2) === 'BM') return { format: 'bmp', mimeType: 'image/bmp' };
  return undefined;
}

/**
 * Reads width and height from the header without decoding pixels.
 *
 * Returns `undefined` for a format it cannot measure, so a caller enforcing a pixel ceiling can
 * choose to refuse rather than decode blind.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensionsInfo | undefined {
  const sniffed = sniffImageType(bytes);
  if (!sniffed) return undefined;

  switch (sniffed.format) {
    case 'png':
      return bytes.length >= 24 ? { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) } : undefined;
    case 'gif':
      return bytes.length >= 10 ? { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) } : undefined;
    case 'bmp':
      return bytes.length >= 26
        ? { width: Math.abs(readInt32LE(bytes, 18)), height: Math.abs(readInt32LE(bytes, 22)) }
        : undefined;
    case 'webp':
      return readWebpDimensions(bytes);
    case 'jpeg':
      return readJpegDimensions(bytes);
    default:
      return undefined;
  }
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensionsInfo | undefined {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = readUint32LE(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }
  return undefined;
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensionsInfo | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] as number;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    // Every SOFn except DHT (C4), JPG (C8) and DAC (CC) carries the frame size.
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: readUint16BE(bytes, offset + 5), width: readUint16BE(bytes, offset + 7) };
    }
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** @internal Byte helpers shared with the PNG codec. */
export function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  let out = '';
  for (let index = offset; index < offset + length; index += 1) out += String.fromCharCode(bytes[index] as number);
  return out;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) >>> 0) +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  );
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) +
    ((bytes[offset + 1] as number) << 8) +
    ((bytes[offset + 2] as number) << 16) +
    (((bytes[offset + 3] as number) << 24) >>> 0)
  );
}

export function readInt32LE(bytes: Uint8Array, offset: number): number {
  return readUint32LE(bytes, offset) | 0;
}

export function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) + ((bytes[offset + 1] as number) << 8) + ((bytes[offset + 2] as number) << 16);
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) + (bytes[offset + 1] as number);
}

export function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) + ((bytes[offset + 1] as number) << 8);
}
