/**
 * TypeSafe AI's decision models, Jev first, over its System One API: every question of a decision in
 * one call, each answered with its probabilities, and no text to parse.
 */
import { linkSignals } from '../utils/signals.js';
import {
  type DecisionCallContext,
  type DecisionDistribution,
  DecisionError,
  type DecisionProvider,
  type DecisionProviderInfo,
  type DecisionProviderQuestion,
  type DecisionProviderRequest,
  type DecisionProviderResult,
} from './core.js';

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
  | { type: 'score'; instructions?: string; criteria: string[] };

/** An answer as the System One API gives it. */
interface WireAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
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
 * TypeSafe AI's System One API (`POST /v1/systemone`): Jev, a model that answers only typed
 * questions, a yes or no ("noul"), a choice among up to 255 options, or a score on up to ten levels,
 * each with its probabilities, and bills for input tokens alone. Every question of a decision goes in
 * one call and is answered in isolation, against the same state.
 *
 * ```ts
 * const decisions = new DecisionManager({ providers: { jev: new TypeSafeDecisionProvider({ apiKey: process.env.TYPESAFE_API_KEY! }) } });
 * ```
 */
export class TypeSafeDecisionProvider implements DecisionProvider {
  /** Its name and what it takes: every question type, 255 options, and 10 levels. */
  readonly info: DecisionProviderInfo;

  constructor(private readonly options: TypeSafeDecisionProviderOptions) {
    this.info = {
      name: 'typesafe',
      capabilities: {
        types: ['yes-no', 'choice', 'score'],
        maxOptions: 255,
        maxLevels: 10,
        defaultModel: options.model ?? 'jev-latest',
      },
    };
  }

  /** Answers every question of a decision in one call. */
  async decide(request: DecisionProviderRequest, context: DecisionCallContext): Promise<DecisionProviderResult> {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [name, wireQuestion(question)]),
    );
    const payload = await this.call<WireResponse>(
      '/v1/systemone',
      { method: 'POST', body: JSON.stringify({ model: request.model, state: request.state, questions }) },
      context,
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

  private async call<T>(path: string, init: RequestInit, context: Partial<DecisionCallContext>): Promise<T> {
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

/** A question in the System One API's terms. */
function wireQuestion(question: DecisionProviderQuestion): WireQuestion {
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

/** A question's probabilities from the API's answer. */
function distributionOf(name: string, question: DecisionProviderQuestion, answer: WireAnswer): DecisionDistribution {
  if (question.type === 'yes-no') {
    if (typeof answer.noul !== 'number') throw invalidAnswer(name, 'noul', answer);
    return { type: 'yes-no', yes: answer.noul };
  }
  if (question.type === 'choice') {
    if (!answer.probabilities) throw invalidAnswer(name, 'choice', answer);
    return { type: 'choice', probabilities: answer.probabilities };
  }
  // A score's probabilities are keyed by each level's number, as a string, from "0".
  if (!answer.probabilities) throw invalidAnswer(name, 'score', answer);
  const probabilities = answer.probabilities;
  return { type: 'score', probabilities: question.levels.map((_, level) => probabilities[String(level)] ?? 0) };
}

function invalidAnswer(name: string, type: string, answer: WireAnswer): DecisionError {
  return new DecisionError(
    `TypeSafe AI answered "${name}" without the ${type} probabilities it asks for: ${JSON.stringify(answer).slice(0, 200)}`,
    'DECISION_FAILED',
  );
}

/**
 * The error for a refusal: a 422 names each field the API refused; a 408, a 429, or a 5xx may pass
 * on another try, and anything else, such as a refused key, will not.
 */
function failure(status: number, text: string): DecisionError {
  if (status === 422) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: Array<{ loc?: unknown[]; msg?: string }> };
      if (Array.isArray(parsed.detail)) {
        detail = parsed.detail.map((item) => `${(item.loc ?? []).join('.')}: ${item.msg ?? 'invalid'}`).join('; ');
      }
    } catch {
      // The body is not the API's validation error; its text is the detail.
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
