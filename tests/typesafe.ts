/**
 * A stand-in for TypeSafe AI's System One API, written from its documentation (docs.typesafe.ai/api,
 * /images, and /primitives/box) and nothing of this package: `POST /v1/systemone` and `GET /v1/models`,
 * bearer keys, the request's validation as a 422 naming each field at fault, pictures as `assets`
 * behind the `TypeSafe-Danger-Zone-Images` header with their documented limits and refusals, and
 * answers in the documented shapes, with score probabilities keyed by each level's number as a string
 * and a box's four edges with its confidence. What the model answers is the test's `judge`, which is
 * given the pictures the state references; the stand-in also computes the documented confidence, so a
 * client that recomputes it can be checked against it.
 */

/** A question as the API takes it. */
export interface WireQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

/** A picture the request sent, decoded, by the reference the state holds for it. */
export interface StandInPicture {
  format: 'png' | 'jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** A box, as the model finds it: its four edges, and how sure it is. */
export interface JudgedBox {
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number;
}

/** What the stand-in's model answers: a probability of yes, each option's or level's probability, or a box. */
export type Judged = number | Record<string, number> | number[] | JudgedBox;

/** What each request carried. */
export interface Seen {
  path: string;
  method: string;
  authorization: string | null;
  headers: Headers;
  body?: {
    model?: unknown;
    state?: unknown;
    questions?: Record<string, WireQuestion>;
    assets?: Record<string, { type?: unknown; format?: unknown; data_base64?: unknown }>;
  };
}

/** The models the stand-in serves, and what each alias resolves to, as the box page's example shows. */
const MODELS = ['jev-1.13.0', 'jev-1.14.0'];
const ALIASES: Record<string, string> = { 'jev-latest': 'jev-1.14.0', 'jev-preview': 'jev-1.14.0' };

/** The documented limits on pictures. */
const LIMITS = { bytes: 16 * 1024 * 1024, request: 32 * 1024 * 1024, side: [280, 1568] as const };

/**
 * The API's fetch, answering as `judge` says for each question, and recording each request in
 * `seen`. Keys in `keys` are accepted; any other is refused with a 401.
 */
export function typesafeStandIn(options: {
  judge: (state: unknown, name: string, question: WireQuestion, pictures: Record<string, StandInPicture>) => Judged;
  keys?: readonly string[];
  /** Answers every call with this status instead, as an overloaded service does. */
  failWith?: () => number | undefined;
  /** Input tokens per question asked, as billed. Defaults to 40. */
  tokensPerQuestion?: number;
}) {
  const seen: Seen[] = [];
  const keys = new Set(options.keys ?? ['ts-key']);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const record: Seen = {
      path: url.pathname,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization'),
      headers,
    };
    if (typeof init.body === 'string') record.body = JSON.parse(init.body);
    seen.push(record);
    init.signal?.throwIfAborted();
    const forced = options.failWith?.();
    if (forced) return json(forced, { detail: 'The service is overloaded' });
    const key = headers.get('authorization')?.replace(/^Bearer /, '');
    if (!key || !keys.has(key)) return json(401, { detail: 'Invalid API key' });
    if (url.pathname === '/v1/models' && record.method === 'GET')
      return json(200, { data: MODELS.map((id) => ({ id })) });
    if (url.pathname !== '/v1/systemone' || record.method !== 'POST') return json(404, { detail: 'Not Found' });
    if (typeof init.body === 'string' && init.body.length > LIMITS.request)
      return json(413, { detail: 'The request is over 32 MiB' });
    const body = record.body ?? {};
    const detail = validate(body);
    if (detail.length) return json(422, { detail });
    const model = ALIASES[String(body.model)] ?? String(body.model);
    if (!MODELS.includes(model))
      return json(422, { detail: [{ loc: ['body', 'model'], msg: `Unknown model ${model}`, type: 'value_error' }] });
    const boxes = Object.values(body.questions ?? {}).some((question) => question.type === 'box');
    const images = body.assets !== undefined || boxes;
    if (images && headers.get('TypeSafe-Danger-Zone-Images') !== 'true')
      return json(400, { detail: 'Images are not enabled: send TypeSafe-Danger-Zone-Images: true' });
    const decoded = decodeAssets(body);
    if ('refusal' in decoded) return json(decoded.refusal.status, { detail: decoded.refusal.detail });
    const pictures = decoded.pictures;
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions ?? {})) {
      answers[name] = answer(question, options.judge(body.state, name, question, pictures));
    }
    const asked = Object.keys(body.questions ?? {}).length;
    return json(200, {
      model,
      answers,
      usage: { input_tokens: asked * (options.tokensPerQuestion ?? 40), output_tokens: asked * 3 },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

/** The request's validation errors, in the API's `HTTPValidationError` shape. */
function validate(body: Seen['body'] & object): Array<{ loc: Array<string | number>; msg: string; type: string }> {
  const errors: Array<{ loc: Array<string | number>; msg: string; type: string }> = [];
  if (typeof body.model !== 'string') errors.push({ loc: ['body', 'model'], msg: 'Field required', type: 'missing' });
  if (body.state === undefined) errors.push({ loc: ['body', 'state'], msg: 'Field required', type: 'missing' });
  const questions = body.questions;
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    errors.push({ loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item', type: 'too_short' });
    return errors;
  }
  for (const [name, question] of Object.entries(questions)) {
    const at = ['body', 'questions', name];
    if (question.type === 'noul') {
      const criteria = question.criteria as Record<string, unknown> | undefined;
      if (criteria && Object.keys(criteria).some((key) => key !== 'true' && key !== 'false')) {
        errors.push({ loc: [...at, 'criteria'], msg: 'Only "true" and "false" are allowed', type: 'extra_forbidden' });
      }
    } else if (question.type === 'choice') {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        errors.push({ loc: [...at, 'criteria'], msg: 'Input should be a valid dictionary', type: 'dict_type' });
      } else {
        const count = Object.keys(criteria).length;
        if (count < 1 || count > 255)
          errors.push({ loc: [...at, 'criteria'], msg: 'Between 1 and 255 choices', type: 'too_long' });
        for (const [option, description] of Object.entries(criteria)) {
          if (description !== null && typeof description !== 'string' && typeof description !== 'object') {
            errors.push({
              loc: [...at, 'criteria', option],
              msg: 'A description is a string, an object, an array, or null',
              type: 'type_error',
            });
          }
        }
      }
    } else if (question.type === 'score') {
      const criteria = question.criteria;
      if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 10) {
        errors.push({ loc: [...at, 'criteria'], msg: 'Between 1 and 10 levels', type: 'too_long' });
      }
    } else if (question.type === 'box') {
      if (question.criteria !== undefined)
        errors.push({ loc: [...at, 'criteria'], msg: 'A box takes no criteria', type: 'extra_forbidden' });
      if (typeof question.instructions !== 'string')
        errors.push({ loc: [...at, 'instructions'], msg: 'Field required', type: 'missing' });
    } else {
      errors.push({
        loc: [...at, 'type'],
        msg: `Input tag '${question.type}' does not match any of 'noul', 'choice', 'score', 'box'`,
        type: 'union_tag_invalid',
      });
    }
  }
  return errors;
}

/**
 * The request's pictures, decoded and checked as the images page documents, by reference; or the
 * refusal: a 400 for a picture it rejects or a reference nothing uses, and a 413 for one too large.
 */
function decodeAssets(
  body: Seen['body'] & object,
): { pictures: Record<string, StandInPicture> } | { refusal: { status: number; detail: string } } {
  const pictures: Record<string, StandInPicture> = {};
  const assets = body.assets ?? {};
  // A reference counts wherever its text appears in the state, the instructions, or the criteria.
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(body.state);
  for (const question of Object.values(body.questions ?? {})) {
    collect(question.instructions);
    collect(question.criteria);
  }
  for (const [reference, asset] of Object.entries(assets)) {
    const refuse = (detail: string, status = 400) => ({ refusal: { status, detail: `Asset ${reference}: ${detail}` } });
    if (!reference.trim()) return refuse('a reference cannot be empty');
    if (!strings.some((text) => text.includes(reference))) return refuse('nothing references it');
    if (asset.type !== undefined && asset.type !== 'image') return refuse('the type must be "image"');
    if (asset.format !== 'png' && asset.format !== 'jpg' && asset.format !== 'jpeg')
      return refuse('the format must be png, jpg, or jpeg');
    const data = asset.data_base64;
    if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      return refuse('data_base64 is not standard base64');
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.length > LIMITS.bytes) return refuse('the image is over 16 MiB', 413);
    const read = header(bytes);
    if (!read || read.format !== (asset.format === 'png' ? 'png' : 'jpeg'))
      return refuse(`the image is not the ${asset.format} it says it is`);
    if (read.animated) return refuse('an animated PNG is not a still image');
    const [min, max] = LIMITS.side;
    if ([read.width, read.height].some((side) => side < min || side > max))
      return refuse(`the image is ${read.width}x${read.height}, outside ${min} to ${max} pixels a side`);
    pictures[reference] = { format: read.format, bytes, width: read.width, height: read.height };
  }
  return { pictures };
}

/** A PNG's or a JPEG's size from its header, and whether a PNG is animated. */
function header(
  bytes: Uint8Array,
): { format: 'png' | 'jpeg'; width: number; height: number; animated: boolean } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let animated = false;
    for (let offset = 8; offset + 8 <= bytes.length; ) {
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === 'acTL') animated = true;
      if (type === 'IDAT') break;
      offset += 12 + view.getUint32(offset);
    }
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20), animated };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length; ) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1] as number;
      const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (frame)
        return {
          format: 'jpeg',
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
          animated: false,
        };
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return undefined;
}

/** An answer in the documented shape, with the documented confidence. */
function answer(question: WireQuestion, judged: Judged): unknown {
  if (question.type === 'box') {
    const found = judged as JudgedBox;
    return { type: 'box', box: found.box, confidence: found.confidence };
  }
  if (question.type === 'noul') return { type: 'noul', noul: judged as number };
  if (question.type === 'choice') {
    const names = Object.keys(question.criteria as Record<string, unknown>);
    const probabilities = Object.fromEntries(
      names.map((name) => [name, (judged as Record<string, number>)[name] ?? 0]),
    );
    const top = names.reduce(
      (best, name) => ((probabilities[name] ?? 0) > (probabilities[best] ?? 0) ? name : best),
      names[0] as string,
    );
    const n = names.length;
    return {
      type: 'choice',
      choice: top,
      confidence: n > 1 ? Math.max(0, ((probabilities[top] ?? 0) - 1 / n) / (1 - 1 / n)) : 1,
      probabilities,
    };
  }
  const levels = question.criteria as string[];
  const weights = levels.map((_, level) => (judged as number[])[level] ?? 0);
  return {
    type: 'score',
    score: weights.reduce((sum, weight, level) => sum + weight * level, 0),
    confidence: null,
    legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
    probabilities: Object.fromEntries(weights.map((weight, index) => [String(index), weight])),
  };
}
