/**
 * Media you can evaluate: images, documents, audio, and video as the subject of an evaluation, judged
 * by checks that read the media themselves (format, size, dimensions, aspect, duration) and by a
 * model that is shown them.
 */
import { type JudgeClient, parseJudgeResponse } from '../evals/judge.js';
import { readImageDimensions, sniffImageType } from '../images/image-header.js';
import type { EvaluationContext, EvaluationScore, Evaluator, MediaPart } from '../types/evaluate.js';
import type { AssetLocation } from '../types/images.js';
import type { ContentPart, Message } from '../types/messages.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { sha256Hex } from '../utils/sha256.js';
import { withProvenance } from './provenance.js';
import { asMediaPart, mediaParts } from './trace.js';
import { readMediaDuration } from '../utils/media-duration.js';

export { type MediaDuration, readMediaDuration } from '../utils/media-duration.js';

/** What kind of medium something is. */
export type MediaSubjectKind = 'image' | 'audio' | 'video' | 'document' | 'other';

/** A medium read for judging: what it is, and as much of it as could be read. */
export interface ResolvedMedia {
  /** The part it was read from. */
  part: MediaPart;
  /** Its kind, from its part type or its MIME type. */
  kind: MediaSubjectKind;
  /** Its MIME type: the one its bytes say, else the one declared. */
  mimeType?: string;
  /** Its bytes, when they could be read. */
  bytes?: Uint8Array;
  /** Where it is, when only an address is known. */
  url?: string;
  /** A file path it names. */
  path?: string;
  /** A transcript standing in for audio. */
  transcript?: string;
  /** Width in pixels, from an image's header or the asset's own record. */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /**
   * Duration in milliseconds, read from the file's own headers: WAV, MP4 and MOV, WebM and Matroska,
   * MP3, Ogg (Vorbis and Opus), and FLAC.
   */
  durationMs?: number;
  /** Why its bytes could not be read, when they could not. */
  unreadable?: string;
}

/** Where media judged by reference are read from. */
export interface MediaResolveOptions {
  /** Reads stored assets: an `AssetStore` and the tenant whose assets they are. */
  assets?: {
    store: { get(assetId: string, tenantId: string): unknown };
    tenantId: string;
  };
  /** Reads a file a part names by path, such as `fs.promises.readFile`. Without it, paths are not read. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Fetches a medium a part names by URL. Without it, nothing is fetched. */
  fetch?: typeof globalThis.fetch;
  /** The most bytes read of one medium. Defaults to 20 MiB. */
  maxBytes?: number;
}

/** Which media an evaluator judges. */
export interface MediaSelection {
  /**
   * Media in the output, the default; in the example's inputs; or both. With nothing in the output,
   * `output` falls back to the media the run's trace says it produced.
   */
  from?: 'output' | 'input' | 'all';
  /** Picks the media itself instead, from the whole evaluation context. */
  select?: (context: EvaluationContext) => MediaPart[] | Promise<MediaPart[]>;
}

/**
 * The media an evaluation is about: those in the output, or, with none there, those the run's trace
 * says it produced; or those it was given.
 */
export function mediaOf(context: EvaluationContext, from: MediaSelection['from'] = 'output'): MediaPart[] {
  const traced = (direction: 'input' | 'output') =>
    (context.trace?.media ?? []).filter((item) => item.direction === direction).map((item) => item.part);
  const output = (): MediaPart[] => {
    const found = mediaParts(context.output);
    return found.length > 0 ? found : traced('output');
  };
  const input = (): MediaPart[] => {
    const found = mediaParts(context.example.inputs);
    return found.length > 0 ? found : traced('input');
  };
  if (from === 'input') return input();
  if (from === 'all') return [...input(), ...output()];
  return output();
}

/** Reads one medium: its kind, its bytes where it can, and what its header says. */
export async function resolveMedia(part: MediaPart, options: MediaResolveOptions = {}): Promise<ResolvedMedia> {
  const limit = options.maxBytes ?? 20 * 1024 * 1024;
  const declared = declaredMime(part);
  const resolved: ResolvedMedia = {
    part,
    kind: kindOf(part.type, declared),
    ...(declared ? { mimeType: declared } : {}),
  };
  try {
    const where = await locate(part, options, limit);
    if (where.bytes) resolved.bytes = where.bytes;
    if (where.url) resolved.url = where.url;
    if (where.path) resolved.path = where.path;
    if (where.transcript) resolved.transcript = where.transcript;
    if (where.width !== undefined) resolved.width = where.width;
    if (where.height !== undefined) resolved.height = where.height;
    if (where.unreadable) resolved.unreadable = where.unreadable;
  } catch (error) {
    resolved.unreadable = error instanceof Error ? error.message : String(error);
  }
  const bytes = resolved.bytes;
  if (bytes) {
    const sniffed = sniffImageType(bytes);
    if (sniffed) {
      resolved.mimeType = sniffed.mimeType;
      resolved.kind = 'image';
      const dimensions = readImageDimensions(bytes);
      if (dimensions) {
        resolved.width = dimensions.width;
        resolved.height = dimensions.height;
      }
    } else if (startsWith(bytes, '%PDF-')) {
      resolved.mimeType = 'application/pdf';
      resolved.kind = 'document';
    } else {
      const read = readMediaDuration(bytes);
      if (read) {
        resolved.mimeType = read.mimeType;
        resolved.kind = read.kind;
        resolved.durationMs = read.durationMs;
      }
    }
  }
  return resolved;
}

/** A range a measurement must fall in. */
export interface MediaRange {
  /** The smallest allowed. */
  min?: number;
  /** The largest allowed. */
  max?: number;
}

/** Options for `mediaChecks()`. Only the checks given are made. */
export interface MediaCheckOptions extends MediaResolveOptions, MediaSelection {
  /** Prefixes every score's key. Defaults to `media`. */
  key?: string;
  /** How many media there must be. Defaults to at least one. */
  count?: MediaRange;
  /** The kinds allowed, such as `['image']`. */
  kinds?: MediaSubjectKind[];
  /** The MIME types allowed, with `*` for any subtype, as `image/*`. */
  mimeTypes?: string[];
  /** The size in bytes allowed. */
  bytes?: MediaRange;
  /** The width in pixels allowed. */
  width?: MediaRange;
  /** The height in pixels allowed. */
  height?: MediaRange;
  /** Width over height, within a tolerance (0.02 by default), such as `{ ratio: 16 / 9 }`. */
  aspectRatio?: { ratio: number; tolerance?: number };
  /** The duration in milliseconds allowed, for audio or video whose headers say it. */
  durationMs?: MediaRange;
  /** A medium whose measurement could not be read passes or fails that check. Defaults to `fail`. */
  unknown?: 'pass' | 'fail';
}

type Check = {
  name: string;
  test: (media: ResolvedMedia) => boolean | undefined;
  describe: (media: ResolvedMedia) => string;
};

/**
 * Checks the media an evaluation is about, reading them: how many there are, and of each its kind,
 * MIME type, size, dimensions, aspect ratio, and duration, as the options ask. Each check is a score
 * of its own, `media.format` for instance: the share of media that pass it. `media` itself is the
 * share that pass every one, and 0 when the count is wrong.
 */
export function mediaChecks(options: MediaCheckOptions = {}): Evaluator {
  const key = options.key ?? 'media';
  const unknownPasses = options.unknown === 'pass';
  const checks: Check[] = [];
  const range = (value: number | undefined, bounds: MediaRange): boolean | undefined =>
    value === undefined
      ? undefined
      : (bounds.min === undefined || value >= bounds.min) && (bounds.max === undefined || value <= bounds.max);
  const bounds = (bounds: MediaRange, unit: string) =>
    [
      bounds.min === undefined ? '' : `at least ${bounds.min}${unit}`,
      bounds.max === undefined ? '' : `at most ${bounds.max}${unit}`,
    ]
      .filter(Boolean)
      .join(' and ');
  if (options.kinds || options.mimeTypes) {
    checks.push({
      name: 'format',
      test: (media) =>
        (!options.kinds || options.kinds.includes(media.kind)) &&
        (!options.mimeTypes ||
          (media.mimeType !== undefined &&
            options.mimeTypes.some((pattern) => mimeMatches(pattern, media.mimeType as string)))),
      describe: (media) =>
        `${media.mimeType ?? media.kind} is not ${[...(options.kinds ?? []), ...(options.mimeTypes ?? [])].join(' or ')}`,
    });
  }
  if (options.bytes) {
    const allowed = options.bytes;
    checks.push({
      name: 'size',
      test: (media) => range(media.bytes?.length, allowed),
      describe: (media) =>
        `${media.bytes ? `${media.bytes.length} bytes` : 'its size is unknown'}, not ${bounds(allowed, ' bytes')}`,
    });
  }
  if (options.width || options.height) {
    const width = options.width ?? {};
    const height = options.height ?? {};
    checks.push({
      name: 'dimensions',
      test: (media) => {
        const wide = range(media.width, width);
        const high = range(media.height, height);
        return wide === undefined || high === undefined ? undefined : wide && high;
      },
      describe: (media) =>
        media.width === undefined
          ? 'its dimensions are unknown'
          : `${media.width}×${media.height} is not ${[options.width ? `${bounds(width, 'px')} wide` : '', options.height ? `${bounds(height, 'px')} high` : ''].filter(Boolean).join(', ')}`,
    });
  }
  if (options.aspectRatio) {
    const { ratio, tolerance = 0.02 } = options.aspectRatio;
    checks.push({
      name: 'aspect',
      test: (media) =>
        media.width === undefined || media.height === undefined || media.height === 0
          ? undefined
          : Math.abs(media.width / media.height - ratio) <= tolerance * ratio,
      describe: (media) =>
        media.width === undefined
          ? 'its aspect ratio is unknown'
          : `${(media.width / (media.height as number)).toFixed(3)} is not ${ratio.toFixed(3)}`,
    });
  }
  if (options.durationMs) {
    const allowed = options.durationMs;
    checks.push({
      name: 'duration',
      test: (media) => range(media.durationMs, allowed),
      describe: (media) =>
        media.durationMs === undefined
          ? 'its duration is unknown'
          : `${media.durationMs} ms is not ${bounds(allowed, ' ms')}`,
    });
  }

  const evaluator: Evaluator = async (context) => {
    const parts = options.select ? await options.select(context) : mediaOf(context, options.from);
    const media = await Promise.all(parts.map((part) => resolveMedia(part, options)));
    const count = options.count ?? { min: 1 };
    const counted = range(media.length, count) === true;
    const scores: EvaluationScore[] = [
      {
        key: `${key}.count`,
        score: counted ? 1 : 0,
        passed: counted,
        ...(counted ? {} : { comment: `${media.length} media, not ${bounds(count, '')}` }),
      },
    ];
    const passedAll = media.map(() => true);
    for (const check of checks) {
      const failures: string[] = [];
      let passed = 0;
      media.forEach((item, index) => {
        const verdict = check.test(item);
        const ok = verdict === undefined ? unknownPasses : verdict;
        if (ok) passed += 1;
        else {
          passedAll[index] = false;
          failures.push(`#${index + 1}: ${check.describe(item)}${item.unreadable ? ` (${item.unreadable})` : ''}`);
        }
      });
      const share = media.length === 0 ? 0 : passed / media.length;
      scores.push({
        key: `${key}.${check.name}`,
        score: share,
        passed: media.length > 0 && failures.length === 0,
        ...(failures.length ? { comment: failures.join('; ') } : {}),
      });
    }
    const overall = counted && media.length > 0 ? passedAll.filter(Boolean).length / media.length : 0;
    scores.unshift({
      key,
      score: overall,
      passed: counted && passedAll.every(Boolean),
      metadata: { media: media.length },
    });
    return scores;
  };
  return withProvenance(evaluator, { name: key });
}

/** Options for `mediaJudge()`. */
export interface MediaJudgeOptions extends MediaResolveOptions, MediaSelection {
  /** The client the judge model is called through, such as a `NexusAI`. */
  client: JudgeClient;
  /** A model that can see the media: a vision model for images and documents, an audio one for audio. */
  model: string;
  /** What good media look like, in plain language. */
  rubric: string;
  /** The score's key. Defaults to `media-judge`. */
  key?: string;
  /**
   * What the media were made for, shown to the judge beside them. Defaults to the example's inputs as
   * text.
   */
  brief?: (context: EvaluationContext) => string | undefined;
  /** The scoring range. Defaults to 0 to 1. */
  range?: [number, number];
  /** The score at or above which media pass when the judge does not say. Defaults to the middle. */
  passThreshold?: number;
  /** Sampling temperature. Defaults to 0. */
  temperature?: number;
  /** Output token limit. Defaults to 512. */
  maxTokens?: number;
  /** Replaces the instruction that asks for JSON with a score, a verdict, and a rationale. */
  systemPrompt?: string;
  /** The most media shown at once. Defaults to 8. */
  maxMedia?: number;
  /** With nothing to judge, a score of 0, or no score. Defaults to `fail`. */
  whenMissing?: 'fail' | 'skip';
  /** Application data sent with every judge request. */
  metadata?: Record<string, unknown>;
}

const MEDIA_JUDGE_PROMPT = [
  'You are a careful judge of media: images, documents, audio, and video.',
  'Look at every medium you are shown, and judge it against the rubric and the brief.',
  'Return only JSON with these fields: score, passed, rationale.',
  'Score must be numeric within the configured range.',
].join(' ');

/**
 * Judges the media an evaluation is about with a model that is shown them: each image, document,
 * audio clip, or video goes to the model as itself, read from bytes, base64, a URL, a path, or an
 * asset store, beside the rubric and the brief, and the model answers with a score. A stored asset is
 * read and sent as bytes, since a provider cannot read the store.
 */
export function mediaJudge(options: MediaJudgeOptions): Evaluator {
  const key = options.key ?? 'media-judge';
  const range = options.range ?? [0, 1];
  const threshold = options.passThreshold ?? (range[0] + range[1]) / 2;
  const evaluator: Evaluator = async (context) => {
    const parts = (options.select ? await options.select(context) : mediaOf(context, options.from)).slice(
      0,
      options.maxMedia ?? 8,
    );
    if (parts.length === 0) {
      if (options.whenMissing === 'skip') return [];
      return { key, score: range[0], passed: false, comment: 'There were no media to judge.' };
    }
    const media = await Promise.all(parts.map((part) => resolveMedia(part, options)));
    const shown: ContentPart[] = [];
    const notes: string[] = [];
    media.forEach((item, index) => {
      const part = modelPart(item);
      if (part) shown.push(part);
      else
        notes.push(
          `Medium ${index + 1} (${item.mimeType ?? item.kind}) could not be shown${item.unreadable ? `: ${item.unreadable}` : ''}.`,
        );
    });
    const brief = options.brief ? options.brief(context) : textOf(context.example.inputs);
    const sections = [
      `Rubric:\n${options.rubric}`,
      `Score range: ${range[0]} to ${range[1]}`,
      `Pass threshold: ${threshold}`,
      brief ? `What the media were made for:\n${brief}` : undefined,
      `Media to judge: ${shown.length}${notes.length ? `\n${notes.join('\n')}` : ''}`,
    ].filter(Boolean);
    const messages: Message[] = [
      { role: 'system', content: options.systemPrompt ?? MEDIA_JUDGE_PROMPT },
      { role: 'user', content: [{ type: 'text', text: sections.join('\n\n') }, ...shown] },
    ];
    const response = await options.client.complete({
      model: options.model,
      messages,
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 512,
      responseFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { score: { type: 'number' }, passed: { type: 'boolean' }, rationale: { type: 'string' } },
          required: ['score', 'passed'],
        },
      },
      metadata: { ...options.metadata, llmJudge: true, mediaJudge: true },
    });
    const content = (response as { content?: unknown }).content;
    const verdict = parseJudgeResponse(typeof content === 'string' ? content : JSON.stringify(response), {
      threshold,
      range,
    });
    return {
      key,
      score: verdict.score,
      passed: verdict.passed,
      ...(verdict.rationale ? { comment: verdict.rationale } : {}),
      metadata: { media: shown.length },
    };
  };
  return withProvenance(evaluator, {
    name: key,
    judge: {
      model: options.model,
      promptVersion: sha256Hex(options.systemPrompt ?? 'media-default').slice(0, 12),
      temperature: options.temperature ?? 0,
    },
    rubric: options.rubric,
  });
}

/** A medium as a model is shown it, or nothing when it cannot be. */
function modelPart(media: ResolvedMedia): ContentPart | undefined {
  const mimeType = media.mimeType;
  if (media.kind === 'image') {
    if (media.bytes)
      return { type: 'image', source: { base64: encodeBase64(media.bytes), ...(mimeType ? { mimeType } : {}) } };
    if (media.url) return { type: 'image', source: { url: media.url } };
    if (media.path) return { type: 'image', source: { path: media.path } };
  }
  if (media.kind === 'document') {
    if (media.bytes)
      return { type: 'document', source: { base64: encodeBase64(media.bytes), ...(mimeType ? { mimeType } : {}) } };
    if (media.url) return { type: 'document', source: { url: media.url } };
    if (media.path) return { type: 'document', source: { path: media.path } };
  }
  if (media.kind === 'audio') {
    const format = mimeType
      ?.split('/')[1]
      ?.replace(/^x-/, '')
      .replace(/^mpeg$/, 'mp3');
    if (media.bytes)
      return { type: 'audio', source: { base64: encodeBase64(media.bytes), ...(format ? { format } : {}) } };
    if (media.transcript !== undefined) return { type: 'audio', source: { transcript: media.transcript } };
    if (media.path) return { type: 'audio', source: { path: media.path } };
  }
  if (media.kind === 'video' && media.path) return { type: 'video', source: { path: media.path } };
  return undefined;
}

async function locate(
  part: MediaPart,
  options: MediaResolveOptions,
  limit: number,
): Promise<Omit<ResolvedMedia, 'part' | 'kind' | 'mimeType'>> {
  if (part.type === 'asset') return fromLocation(part.asset.location, options, limit, part.asset as never);
  const source = part.source as Record<string, unknown>;
  if (typeof source.transcript === 'string') return { transcript: source.transcript };
  if (typeof source.base64 === 'string') return { bytes: capped(decodeBase64(source.base64), limit) };
  if (source.buffer && typeof (source.buffer as ArrayLike<number>).length === 'number') {
    return { bytes: capped(toBytes(source.buffer), limit) };
  }
  if (typeof source.url === 'string') return fromUrl(source.url, options, limit);
  if (typeof source.path === 'string') {
    if (!options.readFile) return { path: source.path };
    return { path: source.path, bytes: capped(await options.readFile(source.path), limit) };
  }
  if (source.asset && typeof source.asset === 'object') {
    const asset = source.asset as { location: AssetLocation; width?: number; height?: number };
    return fromLocation(asset.location, options, limit, asset);
  }
  return { unreadable: 'it names no content' };
}

async function fromLocation(
  location: AssetLocation,
  options: MediaResolveOptions,
  limit: number,
  asset: { width?: number; height?: number },
): Promise<Omit<ResolvedMedia, 'part' | 'kind' | 'mimeType'>> {
  const known = {
    ...(typeof asset.width === 'number' ? { width: asset.width } : {}),
    ...(typeof asset.height === 'number' ? { height: asset.height } : {}),
  };
  if (location.kind === 'bytes') return { ...known, bytes: capped(toBytes(location.data), limit) };
  if (location.kind === 'url') return { ...known, ...(await fromUrl(location.url, options, limit)) };
  if (!options.assets)
    return { ...known, unreadable: `asset ${location.assetId} is stored, and no asset store was given` };
  const stored = (await options.assets.store.get(location.assetId, options.assets.tenantId)) as
    | { location?: { kind?: string; data?: Uint8Array }; width?: number; height?: number }
    | undefined;
  if (!stored?.location?.data) return { ...known, unreadable: `asset ${location.assetId} is not in the store` };
  return {
    ...known,
    ...(typeof stored.width === 'number' ? { width: stored.width } : {}),
    ...(typeof stored.height === 'number' ? { height: stored.height } : {}),
    bytes: capped(toBytes(stored.location.data), limit),
  };
}

async function fromUrl(url: string, options: MediaResolveOptions, limit: number) {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const body = url.slice(comma + 1);
    const bytes = meta.endsWith(';base64') ? decodeBase64(body) : new TextEncoder().encode(decodeURIComponent(body));
    return { bytes: capped(bytes, limit) };
  }
  if (!options.fetch) return { url };
  const response = await options.fetch(url);
  if (!response.ok) return { url, unreadable: `${url} answered ${response.status}` };
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) return { url, unreadable: `${url} is ${declared} bytes, over the ${limit}-byte limit` };
  return { url, bytes: capped(new Uint8Array(await response.arrayBuffer()), limit) };
}

function capped(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.length > limit) throw new Error(`the medium is ${bytes.length} bytes, over the ${limit}-byte limit`);
  return bytes;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // Bytes that went through JSON, as an object of indices, or a Node.js Buffer's `{ type, data }`.
  const data = (value as { data?: unknown }).data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return Uint8Array.from(Object.values(value as Record<string, number>));
}

function declaredMime(part: MediaPart): string | undefined {
  if (part.type === 'asset') return part.asset.mimeType;
  const source = part.source as { mimeType?: unknown; format?: unknown; asset?: { mimeType?: unknown } };
  if (typeof source.mimeType === 'string') return source.mimeType;
  if (typeof source.asset?.mimeType === 'string') return source.asset.mimeType;
  if (part.type === 'audio' && typeof source.format === 'string') return `audio/${source.format}`;
  if (part.type === 'document') return 'application/pdf';
  return undefined;
}

function kindOf(type: MediaPart['type'], mimeType: string | undefined): MediaSubjectKind {
  if (type !== 'asset') return type;
  const family = mimeType?.split('/')[0];
  if (family === 'image' || family === 'audio' || family === 'video') return family;
  if (mimeType === 'application/pdf' || mimeType?.startsWith('text/')) return 'document';
  return 'other';
}

function mimeMatches(pattern: string, mimeType: string): boolean {
  if (pattern === '*' || pattern === '*/*') return true;
  if (pattern.endsWith('/*')) return mimeType.startsWith(pattern.slice(0, -1));
  return pattern === mimeType;
}

function startsWith(bytes: Uint8Array, text: string): boolean {
  return ascii(bytes, 0, text.length) === text;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = '';
  for (let index = at; index < at + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] as number);
  }
  return text;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  // Media are shown as themselves; the brief is the rest of the request.
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) && (ArrayBuffer.isView(item) || asMediaPart(item))
      ? '[medium]'
      : item,
  );
}
