/**
 * A stand-in for TypeSafe AI's System One API, written from its documentation (docs.typesafe.ai/api)
 * and nothing of this package: `POST /v1/systemone` and `GET /v1/models`, bearer keys, the request's
 * validation as a 422 naming each field at fault, and answers in the documented shapes, with score
 * probabilities keyed by each level's number as a string. What the model answers is the test's
 * `judge`; the stand-in also computes the documented confidence, so a client that recomputes it can
 * be checked against it.
 */

/** A question as the API takes it. */
export interface WireQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

/** What the stand-in's model answers: a probability of yes, or each option's or level's probability. */
export type Judged = number | Record<string, number> | number[];

/** What each request carried. */
export interface Seen {
  path: string;
  method: string;
  authorization: string | null;
  headers: Headers;
  body?: { model?: unknown; state?: unknown; questions?: Record<string, WireQuestion> };
}

/** The models the stand-in serves, and what each alias resolves to. */
const MODELS = ['jev-1.13.0', 'jev-1.14.0'];
const ALIASES: Record<string, string> = { 'jev-latest': 'jev-1.13.0', 'jev-preview': 'jev-1.14.0' };

/**
 * The API's fetch, answering as `judge` says for each question, and recording each request in
 * `seen`. Keys in `keys` are accepted; any other is refused with a 401.
 */
export function typesafeStandIn(options: {
  judge: (state: unknown, name: string, question: WireQuestion) => Judged;
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
    const body = record.body ?? {};
    const detail = validate(body);
    if (detail.length) return json(422, { detail });
    const model = ALIASES[String(body.model)] ?? String(body.model);
    if (!MODELS.includes(model))
      return json(422, { detail: [{ loc: ['body', 'model'], msg: `Unknown model ${model}`, type: 'value_error' }] });
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions ?? {})) {
      answers[name] = answer(question, options.judge(body.state, name, question));
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

/** An answer in the documented shape, with the documented confidence. */
function answer(question: WireQuestion, judged: Judged): unknown {
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
