import { deflateSync, inflateSync } from 'node:zlib';
import { ImageValidationError } from './errors.js';
import { ascii, PNG_SIGNATURE, readUint32BE, startsWith } from './image-header.js';

/**
 * Just enough image codec to make mask and similarity decisions without a native dependency.
 *
 * PNG decoding and encoding cover masks and perceptual hashing; broader format support belongs
 * behind the injectable `decode` hooks rather than in this module. Header sniffing lives in
 * `image-header.ts` and is re-exported here.
 */

export {
  type ImageDimensionsInfo,
  readImageDimensions,
  type SniffedImage,
  type SniffedImageFormat,
  sniffImageType,
} from './image-header.js';

/** Decoded pixels, always expanded to 8-bit RGBA so callers need no per-format branches. */
export interface RgbaImage {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Pixels as RGBA, 4 bytes each, row by row. */
  data: Uint8Array;
}

/** Options for `decodePng()`. */
export interface DecodePngOptions {
  /**
   * Refuses to allocate pixel memory past this count. Checked against the header before
   * decompression, so a small file claiming enormous dimensions is rejected before it costs
   * anything.
   */
  maxPixels?: number;
}

/** Decodes a non-interlaced 8-bit PNG of any colour type into RGBA. */
export function decodePng(bytes: Uint8Array, options: DecodePngOptions = {}): RgbaImage {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new ImageValidationError('Image is not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const compressed: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new ImageValidationError('PNG chunk runs past the end of the file');
    const body = bytes.subarray(start, end);

    if (type === 'IHDR') {
      width = readUint32BE(body, 0);
      height = readUint32BE(body, 4);
      bitDepth = body[8] as number;
      colorType = body[9] as number;
      interlace = body[12] as number;
      if (options.maxPixels !== undefined && width * height > options.maxPixels) {
        throw new ImageValidationError(
          `PNG is ${width}x${height} (${width * height} pixels), above the ${options.maxPixels}-pixel limit`,
        );
      }
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (width === 0 || height === 0) throw new ImageValidationError('PNG is missing a valid IHDR chunk');
  if (bitDepth !== 8) throw new ImageValidationError(`PNG bit depth ${bitDepth} is not supported; only 8-bit`);
  if (interlace !== 0) throw new ImageValidationError('Interlaced PNG is not supported');

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new ImageValidationError(`PNG colour type ${colorType} is invalid`);
  if (colorType === 3 && !palette) throw new ImageValidationError('Palette PNG is missing its PLTE chunk');

  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new ImageValidationError('PNG image data is truncated');

  const pixels = unfilter(raw, width, height, channels);
  const rgba = new Uint8Array(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colorType === 6) {
      rgba.set(pixels.subarray(source, source + 4), target);
    } else if (colorType === 2) {
      rgba[target] = pixels[source] as number;
      rgba[target + 1] = pixels[source + 1] as number;
      rgba[target + 2] = pixels[source + 2] as number;
      rgba[target + 3] = 255;
    } else if (colorType === 0) {
      const gray = pixels[source] as number;
      rgba.fill(gray, target, target + 3);
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      const gray = pixels[source] as number;
      rgba.fill(gray, target, target + 3);
      rgba[target + 3] = pixels[source + 1] as number;
    } else {
      const entry = pixels[source] as number;
      const base = entry * 3;
      rgba[target] = palette?.[base] ?? 0;
      rgba[target + 1] = palette?.[base + 1] ?? 0;
      rgba[target + 2] = palette?.[base + 2] ?? 0;
      rgba[target + 3] = transparency && entry < transparency.length ? (transparency[entry] as number) : 255;
    }
  }

  return { width, height, data: rgba };
}

function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] as number;
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const current = out.subarray(row * stride, (row + 1) * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] as number) : 0;
      const up = previous[x] as number;
      const upLeft = x >= channels ? (previous[x - channels] as number) : 0;
      const value = line[x] as number;

      switch (filter) {
        case 0:
          current[x] = value;
          break;
        case 1:
          current[x] = (value + left) & 0xff;
          break;
        case 2:
          current[x] = (value + up) & 0xff;
          break;
        case 3:
          current[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          current[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new ImageValidationError(`PNG row ${row} uses unknown filter type ${filter}`);
      }
    }
    previous = current;
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Encodes RGBA pixels as an 8-bit, colour-type-6 PNG. */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new ImageValidationError(`RGBA buffer holds ${data.length} bytes, expected ${width * height * 4}`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return new Uint8Array(
    Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
