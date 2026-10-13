import { wireAudio, wireDocument, wireImage } from '../providers/content.js';
import type {
  EmbeddingInput,
  EmbeddingModality,
  EmbeddingPart,
  EmbeddingParts,
  EmbeddingProviderMediaPart,
  EmbeddingProviderPart,
} from '../types/embeddings.js';
import { EmbeddingValidationError } from './errors.js';

/** A media kind an embedding input can hold. */
export type EmbeddingMediaKind = Exclude<EmbeddingModality, 'text'>;

/** A request's inputs, checked and ready for routing, the cache, and the provider. */
export interface EmbeddingInputs {
  /** Each input's text: a string itself, or its text parts joined by a newline. */
  texts: string[];
  /** Each input as the parts an adapter receives, when any input holds media. */
  parts?: EmbeddingProviderPart[][];
  /** The media kinds the inputs hold. */
  media: Set<EmbeddingMediaKind>;
  /** How many images each input holds, for pricing. */
  images: number[];
}

/** Checks a request's input and resolves every media part to base64 data or a URL. */
export function normalizeInputs(input: EmbeddingInput): EmbeddingInputs {
  const items: ReadonlyArray<string | EmbeddingParts> =
    typeof input === 'string' || !Array.isArray(input) ? [input as string | EmbeddingParts] : input;
  if (items.length === 0) {
    throw new EmbeddingValidationError('Embedding input must be a string, parts, or a non-empty list of them');
  }
  const texts: string[] = [];
  const resolved: EmbeddingProviderPart[][] = [];
  const media = new Set<EmbeddingMediaKind>();
  const images: number[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (!item) throw new EmbeddingValidationError('Every embedding input must be a non-empty string');
      texts.push(item);
      resolved.push([{ type: 'text', text: item }]);
      images.push(0);
      continue;
    }
    if (!item || typeof item !== 'object' || !Array.isArray(item.parts) || item.parts.length === 0) {
      throw new EmbeddingValidationError(
        'An embedding input is a non-empty string or { parts } with at least one part',
      );
    }
    const parts = item.parts.map(toProviderPart);
    for (const part of parts) if (part.type !== 'text') media.add(part.type);
    texts.push(
      parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    );
    resolved.push(parts);
    images.push(parts.filter((part) => part.type === 'image').length);
  }
  return { texts, ...(media.size ? { parts: resolved } : {}), media, images };
}

function toProviderPart(part: EmbeddingPart): EmbeddingProviderPart {
  switch (part?.type) {
    case 'text':
      if (typeof part.text !== 'string' || !part.text) {
        throw new EmbeddingValidationError('An embedding text part must hold non-empty text');
      }
      return { type: 'text', text: part.text };
    case 'image': {
      const wire = wireImage(part);
      if (!wire) throw unreadable('image');
      return wire.kind === 'url'
        ? { type: 'image', mimeType: mimeTypeOf(wire.url, 'image/png'), url: wire.url }
        : { type: 'image', mimeType: wire.mimeType, data: wire.data };
    }
    case 'audio': {
      const wire = wireAudio(part);
      if (!wire) throw unreadable('audio');
      return { type: 'audio', mimeType: AUDIO_TYPES[wire.format] ?? `audio/${wire.format}`, data: wire.data };
    }
    case 'document': {
      const wire = wireDocument(part);
      if (!wire) throw unreadable('document');
      return wire.kind === 'url'
        ? { type: 'document', mimeType: wire.mimeType, url: wire.url }
        : { type: 'document', mimeType: wire.mimeType, data: wire.data };
    }
    default:
      throw new EmbeddingValidationError(
        `An embedding part is text, image, audio, or document, not ${JSON.stringify((part as { type?: unknown })?.type)}`,
      );
  }
}

function unreadable(kind: string): EmbeddingValidationError {
  return new EmbeddingValidationError(
    `An embedding ${kind} part must hold its content, as bytes, base64, or a URL; read a file or a stream first`,
  );
}

const AUDIO_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mimeTypeOf(url: string, fallback: string): string {
  const extension = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase();
  return (extension && IMAGE_TYPES[extension]) || fallback;
}

/**
 * Each input's identity, which repeats and the cache are keyed by: a text itself, or its parts with
 * every medium's content hashed, so a megabyte image is never a key. Loaded only for media.
 */
export async function inputIdentities(inputs: EmbeddingInputs): Promise<string[]> {
  if (!inputs.parts) return inputs.texts;
  const { sha256Hex } = await import('../utils/sha256.js');
  return inputs.parts.map((parts, index) =>
    parts.length === 1 && parts[0]?.type === 'text'
      ? (inputs.texts[index] as string)
      : `parts:${JSON.stringify(parts.map((part) => (part.type === 'text' ? part.text : mediaIdentity(part, sha256Hex))))}`,
  );
}

function mediaIdentity(part: EmbeddingProviderMediaPart, hash: (data: string) => string): string[] {
  return [part.type, part.mimeType, part.data === undefined ? `url:${part.url}` : `sha256:${hash(part.data)}`];
}

/**
 * The media kinds a model takes, by its registry entry when it has one, else by its adapter. Text
 * only when neither says.
 */
export function acceptedModalities(
  model: { inputModalities?: readonly EmbeddingModality[] } | undefined,
  provider: { inputModalities?: readonly EmbeddingModality[] },
): readonly EmbeddingModality[] {
  return (model ? model.inputModalities : provider.inputModalities) ?? ['text'];
}
