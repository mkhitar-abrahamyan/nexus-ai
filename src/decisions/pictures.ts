/**
 * The pictures a decision's state holds: image parts, or image assets, anywhere in an object or a
 * list, each named by its path, which a question writes in backticks, such as `photo`, `faces.happy`,
 * or `frames[2].frame`.
 */
import { type MediaResolveOptions, resolveMedia } from '../evaluate/media.js';
import { asMediaPart } from '../evaluate/trace.js';
import type { MediaPart } from '../types/evaluate.js';
import { sha256Hex } from '../utils/sha256.js';
import { DecisionError } from './errors.js';

/** A picture in a decision's state, and where it is. */
export interface DecisionPicture {
  /** Its path in the state, as a question names it in backticks: `photo`, `faces.happy`, or `frames[2].frame`. */
  path: string;
  /** The picture: an image part, `{ type: 'image', source }`, or an image asset. */
  part: MediaPart;
}

/** A picture's bytes, read for a provider that sends them. */
export interface ReadDecisionPicture extends DecisionPicture {
  /** Its bytes. */
  bytes: Uint8Array;
  /** Its MIME type, as its first bytes say, whatever it was declared as. */
  mimeType: string;
  /** Its width in pixels, from its header. */
  width?: number;
  /** Its height in pixels. */
  height?: number;
}

/** How deep a state is searched for pictures: past this, its values are data. */
const MAX_DEPTH = 256;

/** Every picture in a state, in the order they appear, each with its path. A picture used twice is listed at both. */
export function statePictures(state: unknown): DecisionPicture[] {
  const found: DecisionPicture[] = [];
  replacePictures(state, (picture) => {
    found.push(picture);
    return picture.part;
  });
  return found;
}

/**
 * The state with each picture replaced by what `replace` returns for it, copying only the objects and
 * lists on the way to one, so a state without pictures comes back as it was given.
 */
export function replacePictures(state: unknown, replace: (picture: DecisionPicture) => unknown): unknown {
  // The objects above the one visited: a state that contains itself is not followed round.
  const above = new Set<object>();
  const visit = (item: unknown, path: string, depth: number): unknown => {
    if (item === null || typeof item !== 'object' || depth > MAX_DEPTH || above.has(item)) return item;
    // Bytes are a picture's content, never a container of pictures.
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return item;
    const part = pictureOf(item as Record<string, unknown>);
    if (part) return replace({ path, part });
    above.add(item);
    try {
      if (Array.isArray(item)) {
        let changed = false;
        const copy = item.map((entry, index) => {
          const next = visit(entry, `${path}[${index}]`, depth + 1);
          if (next !== entry) changed = true;
          return next;
        });
        return changed ? copy : item;
      }
      // Only plain objects are containers; a date or a class's instance is a value.
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return item;
      let changed = false;
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const next = visit(entry, path ? `${path}.${key}` : key, depth + 1);
        if (next !== entry) changed = true;
        copy[key] = next;
      }
      return changed ? copy : item;
    } finally {
      above.delete(item);
    }
  };
  return visit(state, '', 0);
}

/**
 * Identifies a picture without its bytes, for a cache key or a trace: a digest of what it holds, or
 * where it is when it is a file or at a URL, so a picture changed at the same path is keyed the same.
 */
export function pictureDigest(part: MediaPart): string {
  const source = (part.type === 'asset' ? part.asset.location : (part as { source: unknown }).source) as Record<
    string,
    unknown
  >;
  if (typeof source.base64 === 'string') return `sha256:${sha256Hex(source.base64)}`;
  const bytes = source.buffer ?? source.data;
  if (bytes instanceof Uint8Array) return `sha256:${sha256Hex(bytes)}`;
  if (typeof source.path === 'string') return `path:${source.path}`;
  if (typeof source.url === 'string') return `url:${source.url}`;
  if (typeof source.assetId === 'string') return `asset:${source.assetId}`;
  if (source.asset && typeof source.asset === 'object')
    return pictureDigest({ type: 'asset', asset: source.asset as never });
  return `sha256:${sha256Hex(JSON.stringify(source) ?? '')}`;
}

/**
 * Reads a picture's bytes, with the media family's readers: bytes and base64 as they are, a file with
 * `readFile`, a URL with `fetch`, and a stored asset from `assets`. Throws `DecisionError`
 * `DECISION_INVALID`, naming the picture's path, for one that cannot be read or is not a picture.
 */
export async function readPicture(
  picture: DecisionPicture,
  options: MediaResolveOptions = {},
): Promise<ReadDecisionPicture> {
  const media = await resolveMedia(picture.part, options);
  if (!media.bytes) {
    const why =
      media.unreadable ??
      (media.path !== undefined
        ? `it is the file ${media.path}, and no readFile was given to read it`
        : media.url !== undefined
          ? `it is at ${media.url}, and no fetch was given to fetch it`
          : 'it holds no bytes');
    throw new DecisionError(`The picture at \`${picture.path}\` could not be read: ${why}`, 'DECISION_INVALID');
  }
  if (media.kind !== 'image' || !media.mimeType?.startsWith('image/')) {
    throw new DecisionError(
      `The picture at \`${picture.path}\` is not an image its bytes name${media.mimeType ? `, but ${media.mimeType}` : ''}`,
      'DECISION_INVALID',
    );
  }
  return {
    ...picture,
    bytes: media.bytes,
    mimeType: media.mimeType,
    ...(media.width !== undefined ? { width: media.width } : {}),
    ...(media.height !== undefined ? { height: media.height } : {}),
  };
}

/** The value as a picture, when it is one: an image part, or an asset or asset part of an image. */
function pictureOf(item: Record<string, unknown>): MediaPart | undefined {
  const part = asMediaPart(item);
  if (!part) return undefined;
  if (part.type === 'image') return part;
  if (part.type === 'asset' && part.asset.mimeType.startsWith('image/')) return part;
  return undefined;
}
