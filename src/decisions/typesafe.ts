/**
 * TypeSafe AI's decision models, Jev first, over its System One API: every question of a decision in
 * one call, each answered with its probabilities, or with a box around something in a picture, and no
 * text to parse.
 */
import type { MediaResolveOptions } from '../evaluate/media.js';
import { encodeBase64 } from '../utils/base64.js';
import { linkSignals } from '../utils/signals.js';
import type {
  DecisionCallContext,
  DecisionDistribution,
  DecisionProvider,
  DecisionProviderInfo,
  DecisionProviderQuestion,
  DecisionProviderRequest,
  DecisionProviderResult,
  DecisionState,
} from './core.js';
import { DecisionError } from './errors.js';
import { type ReadDecisionPicture, readPicture, replacePictures, statePictures } from './pictures.js';

/** Options for `TypeSafeDecisionProvider`. */
export interface TypeSafeDecisionProviderOptions {
  /** A TypeSafe AI API key, from its console. A tenant's resolved credential replaces it per call. */
  apiKey: string;
  /**
   * The API's base URL. Defaults to `https://api.typesafe.ai`; a proxy that passes the API through,
   * such as LiteLLM's at `<proxy>/typesafe`, works as well.
   */
  baseUrl?: string;
  /** The model asked when a request names none. Defaults to `jev-latest`. */
  model?: string;
  /**
   * Sends `TypeSafe-Danger-Zone-Long-Context: true`, which TypeSafe AI requires for a state longer
   * than its usual context, and marks as experimental.
   */
  longContext?: boolean;
  /**
   * Reads the pictures a state holds by reference, with the media family's readers: `readFile` for a
   * file, `fetch` for a URL, and `assets` for a stored asset. A picture held as bytes or base64 needs
   * none of them. Without them, a picture by reference fails the decision, naming it.
   */
  media?: MediaResolveOptions;
  /** How long a call may take before it fails, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/** A question as the System One API takes it. */
type WireQuestion =
  | { type: 'noul'; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions?: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions?: string; criteria: string[] }
  | { type: 'box'; instructions: string };

/** A picture as the System One API takes it, by the reference the state holds in its place. */
interface WireAsset {
  type: 'image';
  format: 'png' | 'jpeg';
  data_base64: string;
}

/** An answer as the System One API gives it. */
interface WireAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  box?: { top?: unknown; bottom?: unknown; left?: unknown; right?: unknown };
  confidence?: number | null;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

interface WireResponse {
  model?: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * What TypeSafe AI takes of a picture, as of 2026-10-26: a still PNG or JPEG of at most 16 MiB, from
 * 280 to 1,568 pixels a side, in a request of at most 32 MiB. It refuses a picture outside them, never
 * resizing it, so one is refused here first, by its path.
 */
const PICTURE_BYTES = 16 * 1024 * 1024;
const PICTURE_SIDE = { min: 280, max: 1568 };
const REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * TypeSafe AI's System One API (`POST /v1/systemone`): Jev, a model that answers only typed
 * questions, a yes or no ("noul"), a choice among up to 255 options, a score on up to ten levels, or a
 * box around something in a picture, and bills for input tokens alone. Every question of a decision
 * goes in one call and is answered in isolation, against the same state. The pictures a state holds
 * are sent as the API's assets, with the `TypeSafe-Danger-Zone-Images` header it requires for them
 * and for a box, both of which it marks as experimental; a box needs Jev 1.14 or later.
 *
 * ```ts
 * const decisions = new DecisionManager({ providers: { jev: new TypeSafeDecisionProvider({ apiKey: process.env.TYPESAFE_API_KEY! }) } });
 * ```
 */
export class TypeSafeDecisionProvider implements DecisionProvider {
  /** Its name and what it takes: every question type, pictures, 255 options, and 10 levels. */
  readonly info: DecisionProviderInfo;

  constructor(private readonly options: TypeSafeDecisionProviderOptions) {
    this.info = {
      name: 'typesafe',
      capabilities: {
        types: ['yes-no', 'choice', 'score', 'box'],
        maxOptions: 255,
        maxLevels: 10,
        images: true,
        defaultModel: options.model ?? 'jev-latest',
      },
    };
  }

  /** Answers every question of a decision in one call. */
  async decide(request: DecisionProviderRequest, context: DecisionCallContext): Promise<DecisionProviderResult> {
    context.signal.throwIfAborted();
    const boxes = Object.keys(request.questions).filter((name) => request.questions[name]?.type === 'box');
    const before = boxes.length ? beforeBoxes(request.model) : undefined;
    if (before) {
      throw new DecisionError(
        `TypeSafe AI answers a box, such as "${boxes[0]}", on Jev 1.14 or later, not ${before}`,
        'DECISION_UNSUPPORTED',
      );
    }
    const { state, assets } = await this.withAssets(request.state, context);
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [name, wireQuestion(question)]),
    );
    const body = JSON.stringify({ model: request.model, state, questions, ...(assets ? { assets } : {}) });
    if (assets && body.length > REQUEST_BYTES) {
      throw new DecisionError(
        `The decision is ${body.length} bytes with its pictures, and TypeSafe AI takes at most ${REQUEST_BYTES}`,
        'DECISION_INVALID',
      );
    }
    const payload = await this.call<WireResponse>(
      '/v1/systemone',
      { method: 'POST', body },
      context,
      assets || boxes.length ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {},
    );
    const distributions: Record<string, DecisionDistribution> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const answer = payload.answers?.[name];
      if (!answer) throw new DecisionError(`TypeSafe AI did not answer "${name}"`, 'DECISION_FAILED');
      distributions[name] = distributionOf(name, question, answer);
    }
    return {
      ...(payload.model ? { model: payload.model } : {}),
      distributions,
      ...(payload.usage
        ? {
            usage: {
              ...(payload.usage.input_tokens !== undefined ? { inputTokens: payload.usage.input_tokens } : {}),
              ...(payload.usage.output_tokens !== undefined ? { outputTokens: payload.usage.output_tokens } : {}),
            },
          }
        : {}),
    };
  }

  /** The models the key may use, from `GET /v1/models`. */
  async listModels(context: Partial<DecisionCallContext> = {}): Promise<string[]> {
    const payload = await this.call<unknown>('/v1/models', { method: 'GET' }, context);
    const listed = Array.isArray(payload)
      ? payload
      : ((payload as { data?: unknown[]; models?: unknown[] })?.data ??
        (payload as { models?: unknown[] })?.models ??
        []);
    return listed
      .map((item) =>
        typeof item === 'string'
          ? item
          : String((item as { id?: unknown; name?: unknown })?.id ?? (item as { name?: unknown })?.name ?? ''),
      )
      .filter(Boolean);
  }

  /**
   * The state with each picture replaced by a reference of its own, and the pictures as assets by those
   * references; a state without pictures as it was. A new reference per picture per request, as the
   * API advises, since it matches a reference wherever its text appears.
   */
  private async withAssets(
    state: DecisionState,
    context: DecisionCallContext,
  ): Promise<{ state: unknown; assets?: Record<string, WireAsset> }> {
    const pictures = typeof state === 'string' ? [] : statePictures(state);
    if (pictures.length === 0) return { state };
    const read = await Promise.all(pictures.map((picture) => readPicture(picture, this.options.media)));
    context.signal.throwIfAborted();
    const references = new Map<string, string>();
    const assets: Record<string, WireAsset> = {};
    for (const picture of read) {
      const format = fitting(picture);
      const reference = globalThis.crypto.randomUUID();
      references.set(picture.path, reference);
      assets[reference] = { type: 'image', format, data_base64: encodeBase64(picture.bytes) };
    }
    return { state: replacePictures(state, (picture) => references.get(picture.path)), assets };
  }

  private async call<T>(
    path: string,
    init: RequestInit,
    context: Partial<DecisionCallContext>,
    extra: Record<string, string> = {},
  ): Promise<T> {
    // A credential resolved for the call's tenant replaces the configured key.
    const credential = await context.credential?.(this.info.name);
    const linked = linkSignals([context.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]);
    const signal = linked.signal;
    let response: Response;
    let text: string;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${(this.options.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '')}${path}`,
        {
          ...init,
          headers: {
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${credential?.apiKey ?? this.options.apiKey}`,
            ...(this.options.longContext ? { 'TypeSafe-Danger-Zone-Long-Context': 'true' } : {}),
            ...extra,
            ...this.options.headers,
            ...credential?.headers,
          },
          signal,
        },
      );
      text = await response.text();
    } catch (error) {
      if (context.signal?.aborted) throw error;
      // A timeout, or a connection that failed: another provider, or another try, may answer.
      throw new DecisionError(
        `TypeSafe AI could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        'DECISION_FAILED',
        true,
      );
    } finally {
      linked.dispose();
    }
    if (!response.ok) throw failure(response.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DecisionError(
        `TypeSafe AI answered with something other than JSON: ${text.slice(0, 200)}`,
        'DECISION_FAILED',
        true,
        response.status,
      );
    }
  }
}

/** The model named, when it names a Jev before 1.14, which answers no box; an alias may serve one. */
function beforeBoxes(model: string): string | undefined {
  const version = /^jev-(\d+)\.(\d+)/.exec(model);
  if (!version) return undefined;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major < 1 || (major === 1 && minor < 14) ? model : undefined;
}

/** The picture's format on the wire, when TypeSafe AI takes it; otherwise why not, naming its path. */
function fitting(picture: ReadDecisionPicture): WireAsset['format'] {
  const at = `The picture at \`${picture.path}\``;
  const refuse = (why: string) =>
    new DecisionError(`${at} ${why}; TypeSafe AI refuses it rather than convert or resize it`, 'DECISION_INVALID');
  if (picture.mimeType !== 'image/png' && picture.mimeType !== 'image/jpeg') {
    throw refuse(`is ${picture.mimeType}, and TypeSafe AI takes PNG and JPEG`);
  }
  if (picture.mimeType === 'image/png' && animated(picture.bytes)) throw refuse('is an animated PNG');
  if (picture.bytes.length > PICTURE_BYTES) {
    throw refuse(`is ${picture.bytes.length} bytes, over TypeSafe AI's ${PICTURE_BYTES}`);
  }
  const { width, height } = picture;
  if (width === undefined || height === undefined) throw refuse('has a header its size cannot be read from');
  if ([width, height].some((side) => side < PICTURE_SIDE.min || side > PICTURE_SIDE.max)) {
    throw refuse(
      `is ${width} by ${height} pixels, and TypeSafe AI takes ${PICTURE_SIDE.min} to ${PICTURE_SIDE.max} a side`,
    );
  }
  return picture.mimeType === 'image/png' ? 'png' : 'jpeg';
}

/** Whether a PNG is animated: an `acTL` chunk comes before its first image data. */
function animated(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND' || length < 0) return false;
    offset += 12 + length;
  }
  return false;
}

/** A question in the System One API's terms. */
function wireQuestion(question: DecisionProviderQuestion): WireQuestion {
  if (question.type === 'box') return { type: 'box', instructions: question.question };
  const instructions = question.question ? { instructions: question.question } : {};
  if (question.type === 'yes-no') {
    const criteria = {
      ...(question.criteria?.yes ? { true: question.criteria.yes } : {}),
      ...(question.criteria?.no ? { false: question.criteria.no } : {}),
    };
    return { type: 'noul', ...instructions, ...(Object.keys(criteria).length ? { criteria } : {}) };
  }
  if (question.type === 'choice') {
    // An option without a description is read by its name, which the API writes as null.
    return {
      type: 'choice',
      ...instructions,
      criteria: Object.fromEntries(question.options.map((option) => [option.name, option.description ?? null])),
    };
  }
  return { type: 'score', ...instructions, criteria: [...question.levels] };
}

/** A question's probabilities, or its box, from the API's answer. */
function distributionOf(name: string, question: DecisionProviderQuestion, answer: WireAnswer): DecisionDistribution {
  if (question.type === 'yes-no') {
    if (typeof answer.noul !== 'number') throw invalidAnswer(name, 'noul', answer);
    return { type: 'yes-no', yes: answer.noul };
  }
  if (question.type === 'choice') {
    if (!answer.probabilities) throw invalidAnswer(name, 'choice', answer);
    return { type: 'choice', probabilities: answer.probabilities };
  }
  if (question.type === 'box') {
    const box = answer.box;
    if (!box || typeof answer.confidence !== 'number') throw invalidAnswer(name, 'box', answer);
    // Its edges are checked as every provider's are, when the answer is read.
    const edges = box as Record<'top' | 'bottom' | 'left' | 'right', number>;
    return {
      type: 'box',
      box: { top: edges.top, bottom: edges.bottom, left: edges.left, right: edges.right },
      confidence: answer.confidence,
    };
  }
  // A score's probabilities are keyed by each level's number, as a string, from "0".
  if (!answer.probabilities) throw invalidAnswer(name, 'score', answer);
  const probabilities = answer.probabilities;
  return { type: 'score', probabilities: question.levels.map((_, level) => probabilities[String(level)] ?? 0) };
}

function invalidAnswer(name: string, type: string, answer: WireAnswer): DecisionError {
  return new DecisionError(
    `TypeSafe AI answered "${name}" without the ${type} it asks for: ${JSON.stringify(answer).slice(0, 200)}`,
    'DECISION_FAILED',
  );
}

/**
 * The error for a refusal: a 422 names each field the API refused, and a 400 or a 413 refuses the
 * request as it was sent, such as a picture it would not take; a 408, a 429, or a 5xx may pass on
 * another try, and anything else, such as a refused key, will not.
 */
function failure(status: number, text: string): DecisionError {
  if (status === 422 || status === 400 || status === 413) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      if (Array.isArray(parsed.detail)) {
        detail = (parsed.detail as Array<{ loc?: unknown[]; msg?: string }>)
          .map((item) => `${(item.loc ?? []).join('.')}: ${item.msg ?? 'invalid'}`)
          .join('; ');
      } else if (typeof parsed.detail === 'string') {
        detail = parsed.detail;
      }
    } catch {
      // The body is not the API's error; its text is the detail.
    }
    return new DecisionError(`TypeSafe AI refused the decision: ${detail}`, 'DECISION_INVALID', false, status);
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return new DecisionError(
    `TypeSafe AI answered ${status}: ${text.slice(0, 300)}`,
    'DECISION_FAILED',
    retryable,
    status,
  );
}
