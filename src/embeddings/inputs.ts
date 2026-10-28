import { wireAudio, wireDocument, wireImage } from '../providers/content.js';
import type {
  EmbeddingInput,
  EmbeddingModality,
  EmbeddingModelCapabilities,
  EmbeddingPart,
  EmbeddingParts,
  EmbeddingProviderMediaPart,
  EmbeddingProviderPart,
  EmbeddingVideoPart,
} from '../types/embeddings.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { readMediaDuration } from '../utils/media-duration.js';
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
  /** What media each input holds, for pricing and for a model's limits. */
  units: MediaUnits[];
}

/**
 * What an input's media comes to: its images, each audio part's and each video part's length in
 * seconds, read from its own headers, and the audio and video parts whose length could not be read.
 */
export interface MediaUnits {
  images: number;
  audio: number[];
  video: number[];
  unmeasured: number;
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
  const units: MediaUnits[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (!item) throw new EmbeddingValidationError('Every embedding input must be a non-empty string');
      texts.push(item);
      resolved.push([{ type: 'text', text: item }]);
      units.push({ images: 0, audio: [], video: [], unmeasured: 0 });
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
    units.push(measure(parts));
  }
  return { texts, ...(media.size ? { parts: resolved } : {}), media, units };
}

/** An input's media, counted and measured: a length read from the bytes' own headers, never decoded. */
function measure(parts: readonly EmbeddingProviderPart[]): MediaUnits {
  const units: MediaUnits = { images: 0, audio: [], video: [], unmeasured: 0 };
  for (const part of parts) {
    if (part.type === 'image') units.images += 1;
    if (part.type !== 'audio' && part.type !== 'video') continue;
    const read = part.data === undefined ? undefined : readMediaDuration(decodeBase64(part.data));
    if (read) units[part.type].push(read.durationMs / 1000);
    else units.unmeasured += 1;
  }
  return units;
}

/** Every input's media together. */
export function totalUnits(units: readonly MediaUnits[]): MediaUnits {
  return {
    images: units.reduce((total, unit) => total + unit.images, 0),
    audio: units.flatMap((unit) => unit.audio),
    video: units.flatMap((unit) => unit.video),
    unmeasured: units.reduce((total, unit) => total + unit.unmeasured, 0),
  };
}

/** How many frames a model takes from a video of this length, by its `videoFrames`. */
export function framesOf(seconds: number, model: EmbeddingModelCapabilities): number {
  const sampling = model.videoFrames ?? { perSecond: 1 };
  const frames = Math.ceil(seconds * sampling.perSecond);
  return sampling.max === undefined ? frames : Math.min(sampling.max, frames);
}

/**
 * What a model charges for media, in US dollars: each image, each second of audio, counted up, and
 * each frame it takes from a video. A model with no media prices charges nothing for it.
 */
export function mediaCost(units: MediaUnits, model: EmbeddingModelCapabilities | undefined): number {
  if (!model) return 0;
  const seconds = units.audio.reduce((total, length) => total + Math.ceil(length), 0);
  const frames = units.video.reduce((total, length) => total + framesOf(length, model), 0);
  return (
    units.images * (model.costPerImage ?? 0) +
    seconds * (model.costPerAudioSecond ?? 0) +
    frames * (model.costPerVideoFrame ?? 0)
  );
}

/** Whether a model prices a medium by its length, so a part whose length is unknown is unpriced. */
export function pricesByLength(model: EmbeddingModelCapabilities | undefined): boolean {
  return model?.costPerAudioSecond !== undefined || model?.costPerVideoFrame !== undefined;
}

/** Refuses audio or video longer than a model takes, naming the input, before anything is sent. */
export function assertLengths(
  inputs: EmbeddingInputs,
  modelName: string,
  model: EmbeddingModelCapabilities | undefined,
): void {
  inputs.units.forEach((unit, index) => {
    for (const kind of ['audio', 'video'] as const) {
      const most = kind === 'audio' ? model?.maxAudioSeconds : model?.maxVideoSeconds;
      const longest = Math.max(0, ...unit[kind]);
      if (most !== undefined && longest > most) {
        throw new EmbeddingValidationError(
          `Input ${index} holds ${longest.toFixed(1)} s of ${kind}, and ${modelName} takes at most ${most} s; split it`,
        );
      }
    }
  });
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
    case 'video':
      return videoPart(part);
    default:
      throw new EmbeddingValidationError(
        `An embedding part is text, image, audio, video, or document, not ${JSON.stringify((part as { type?: unknown })?.type)}`,
      );
  }
}

/** A video by its content: bytes or base64 with its container's type, or a URL. */
function videoPart(part: EmbeddingVideoPart): EmbeddingProviderMediaPart {
  const source = (part.source ?? {}) as Record<string, unknown>;
  const format = typeof source.format === 'string' ? source.format.toLowerCase() : undefined;
  const named = format ? (VIDEO_TYPES[format] ?? `video/${format}`) : undefined;
  if (typeof source.url === 'string' && source.url) {
    const extension = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(source.url)?.[1]?.toLowerCase();
    return { type: 'video', mimeType: named ?? (extension && VIDEO_TYPES[extension]) ?? 'video/mp4', url: source.url };
  }
  const data =
    typeof source.base64 === 'string'
      ? source.base64
      : source.buffer && typeof (source.buffer as ArrayLike<number>).length === 'number'
        ? encodeBase64(source.buffer as Uint8Array)
        : undefined;
  if (!data) {
    throw new EmbeddingValidationError(
      'An embedding video part must hold its content, as bytes, base64, or a URL; read a file on disk first',
    );
  }
  return { type: 'video', mimeType: named ?? 'video/mp4', data };
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mpeg: 'video/mpeg',
};

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
