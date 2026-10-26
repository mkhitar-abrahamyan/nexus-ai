/**
 * Pictures for the tests of decisions about pictures, made and read here with zlib alone and nothing of
 * this package: a PNG of one colour with a rectangular mark of another, and a reader that finds the
 * mark again in a PNG's pixels, so a stand-in model answers from what a picture shows.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** A colour by name, as the tests ask about it. */
export const COLOURS = {
  white: [255, 255, 255],
  red: [220, 30, 30],
  green: [30, 170, 60],
  blue: [30, 60, 220],
} as const;

/** A colour's name. */
export type Colour = keyof typeof COLOURS;

/** Where a mark is, in pixels: its top and left rows and columns, and its bottom and right ones, excluded. */
export interface Mark {
  colour: Colour;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A picture: its size, its background, and a mark on it, if any. */
export interface Scene {
  width: number;
  height: number;
  background?: Colour;
  mark?: Mark;
  /** Every pixel a colour of its own, so the picture hardly compresses at all. */
  noise?: boolean;
}

/** The scene as a PNG: 8-bit RGB, each row unfiltered. */
export function scenePng(scene: Scene): Uint8Array {
  const background = COLOURS[scene.background ?? 'white'];
  const row = scene.width * 3 + 1;
  const raw = new Uint8Array(row * scene.height);
  // xorshift32: the same noise every time, with no pattern a compressor finds.
  let seed = 2_463_534_242;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) & 255;
  };
  for (let y = 0; y < scene.height; y += 1) {
    for (let x = 0; x < scene.width; x += 1) {
      const mark = scene.mark;
      const inside = mark && y >= mark.top && y < mark.bottom && x >= mark.left && x < mark.right;
      const colour = inside ? COLOURS[mark.colour] : scene.noise ? [next(), next(), next()] : background;
      raw.set(colour, y * row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, scene.width);
  view.setUint32(4, scene.height);
  header.set([8, 2, 0, 0, 0], 8);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The PNG with an `acTL` chunk before its image data, as an animated PNG has. */
export function animatedPng(scene: Scene): Uint8Array {
  const png = scenePng(scene);
  // After the signature and the 25 bytes of IHDR.
  const control = chunk('acTL', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]));
  return concat([png.subarray(0, 33), control, png.subarray(33)]);
}

/** What a picture shows: its size, and its mark's colour and box as fractions of its height and width. */
export interface Seen {
  width: number;
  height: number;
  colour?: Colour;
  box?: { top: number; bottom: number; left: number; right: number };
  /** The share of the picture the mark covers. */
  covers: number;
}

/** Reads a PNG made by `scenePng` and finds its mark: every pixel unlike the top-left one. */
export function look(png: Uint8Array): Seen {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const data: Uint8Array[] = [];
  for (let offset = 8; offset + 8 <= png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(concat(data));
  const row = width * 3 + 1;
  const at = (x: number, y: number) => raw.subarray(y * row + 1 + x * 3, y * row + 4 + x * 3);
  const background = at(0, 0);
  let [top, bottom, left, right, count] = [height, -1, width, -1, 0];
  let mark: Uint8Array | undefined;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = at(x, y);
      if (pixel[0] === background[0] && pixel[1] === background[1] && pixel[2] === background[2]) continue;
      mark ??= pixel;
      count += 1;
      [top, bottom, left, right] = [Math.min(top, y), Math.max(bottom, y), Math.min(left, x), Math.max(right, x)];
    }
  }
  if (!mark) return { width, height, covers: 0 };
  const found = mark;
  const colour = (Object.keys(COLOURS) as Colour[]).find((name) =>
    COLOURS[name].every((value, index) => value === found[index]),
  );
  return {
    width,
    height,
    ...(colour ? { colour } : {}),
    box: { top: top / height, bottom: (bottom + 1) / height, left: left / width, right: (right + 1) / width },
    covers: count / (width * height),
  };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
