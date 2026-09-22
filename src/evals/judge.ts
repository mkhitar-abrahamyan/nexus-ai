import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { EvalCase, EvalJudge } from './runner.js';

/** The one method the judge needs from a client. */
export interface JudgeClient<Response = NexusResponse> {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<Response>;
}

/** What the judge sees for one answer. */
export interface LLMJudgeInput {
  /** The answer to judge. */
  actual: string;
  /** A reference answer, when there is one. */
  expected?: string;
  /** The question the answer responds to. */
  query?: string;
  /** The rubric for this answer, overriding the judge's. */
  rubric?: string;
  /** Source passages the answer should be grounded in. */
  contexts?: string[];
  /** Application data, not shown to the judge. */
  metadata?: Record<string, unknown>;
}

/** Configuration for an LLM judge. */
export interface LLMJudgeOptions<Response = NexusResponse> {
  /** Client the judge model is called through. */
  client: JudgeClient<Response>;
  /** The judge model. */
  model: string;
  /** What a good answer looks like, in plain language. */
  rubric?: string;
  /**
   * Replaces the default instruction that asks for JSON with score, passed, rationale, and labels.
   */
  systemPrompt?: string;
  /**
   * Score at or above which an answer passes when the judge does not say. Defaults to the middle of
   * `range`.
   */
  passThreshold?: number;
  /** Scoring range. Defaults to 0 to 1. */
  range?: [number, number];
  /** Sampling temperature. Defaults to 0, for repeatable verdicts. */
  temperature?: number;
  /** Output token limit. Defaults to 512. */
  maxTokens?: number;
  /** Application data sent with every judge request. */
  metadata?: Record<string, unknown>;
}

/** A judge's verdict. */
export interface LLMJudgeResult {
  /** Score, clamped to the range. */
  score: number;
  /** Whether the answer passed. */
  passed: boolean;
  /** Why, in the judge's words. */
  rationale?: string;
  /** Labels the judge applied. */
  labels?: string[];
  /** The judge's raw response. */
  raw: unknown;
  /** Provider the judge ran on. */
  providerUsed?: string;
  /** Model the judge ran on. */
  modelUsed?: string;
}

/** Turns a response and its case into what the judge sees. */
export type LLMJudgeInputMapper<Response> = (
  response: Response,
  testCase: EvalCase<Response>,
) => LLMJudgeInput | Promise<LLMJudgeInput>;

const DEFAULT_SYSTEM_PROMPT = [
  'You are a careful evaluation judge.',
  'Return only JSON with these fields: score, passed, rationale, labels.',
  'Score must be numeric within the configured range.',
].join(' ');

/**
 * Scores answers with a model against a rubric, asking for structured JSON and tolerating a judge
 * that answers in prose.
 */
export class LLMJudge<Response = NexusResponse> {
  constructor(private options: LLMJudgeOptions<Response>) {}

  /** Judges one answer. */
  async evaluate(input: LLMJudgeInput): Promise<LLMJudgeResult> {
    const range = this.options.range || [0, 1];
    const threshold = this.options.passThreshold ?? midpoint(range);
    const response = await this.options.client.complete({
      model: this.options.model,
      messages: this.messages(input, range, threshold),
      temperature: this.options.temperature ?? 0,
      maxTokens: this.options.maxTokens ?? 512,
      responseFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            score: { type: 'number' },
            passed: { type: 'boolean' },
            rationale: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['score', 'passed'],
        },
      },
      metadata: {
        ...this.options.metadata,
        llmJudge: true,
      },
    });

    return parseJudgeResponse(contentOf(response), {
      threshold,
      range,
      raw: response,
      providerUsed: providerOf(response),
      modelUsed: modelOf(response),
    });
  }

  /**
   * Adapts the judge to an `EvalRunner` case, optionally with a mapper that picks what the judge
   * sees.
   */
  asEvalJudge(mapper?: LLMJudgeInputMapper<Response>): EvalJudge<Response> {
    return async (response, testCase) => {
      const input = mapper
        ? await mapper(response, testCase)
        : {
            actual: contentOf(response),
            expected: testCase.expected,
            rubric: this.options.rubric,
          };
      return this.evaluate(input);
    };
  }

  private messages(input: LLMJudgeInput, range: [number, number], threshold: number): Message[] {
    const rubric = input.rubric || this.options.rubric || 'Judge whether the answer satisfies the request.';
    const sections = [
      `Rubric:\n${rubric}`,
      `Score range: ${range[0]} to ${range[1]}`,
      `Pass threshold: ${threshold}`,
      input.query ? `User query:\n${input.query}` : undefined,
      input.expected ? `Reference answer:\n${input.expected}` : undefined,
      input.contexts?.length ? `Context:\n${input.contexts.join('\n\n')}` : undefined,
      `Model answer:\n${input.actual}`,
    ].filter(Boolean);

    return [
      { role: 'system', content: this.options.systemPrompt || DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: sections.join('\n\n') },
    ];
  }
}

/** Adapts a judge to an `EvalRunner` case. The same as `judge.asEvalJudge(mapper)`. */
export function createLLMJudgeEval<Response = NexusResponse>(
  judge: LLMJudge<Response>,
  mapper?: LLMJudgeInputMapper<Response>,
): EvalJudge<Response> {
  return judge.asEvalJudge(mapper);
}

/**
 * Reads a judge's reply: JSON, fenced JSON, or a number in prose, clamped to the range, with
 * `passed` from the reply or the threshold.
 */
export function parseJudgeResponse(
  content: string,
  options: {
    threshold?: number;
    range?: [number, number];
    raw?: unknown;
    providerUsed?: string;
    modelUsed?: string;
  } = {},
): LLMJudgeResult {
  const range = options.range || [0, 1];
  const threshold = options.threshold ?? midpoint(range);
  const parsed = parseJsonObject(content);
  const score = clamp(numberField(parsed.score) ?? numberFromText(content) ?? range[0], range);
  const passed = typeof parsed.passed === 'boolean' ? parsed.passed : score >= threshold;
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.filter((label): label is string => typeof label === 'string')
    : undefined;

  return {
    score,
    passed,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
    labels,
    raw: options.raw ?? parsed,
    providerUsed: options.providerUsed,
    modelUsed: options.modelUsed,
  };
}

function contentOf(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'content' in response) {
    const content = (response as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return JSON.stringify(response);
}

function providerOf(response: unknown): string | undefined {
  return response && typeof response === 'object'
    ? (response as { meta?: { providerUsed?: string } }).meta?.providerUsed
    : undefined;
}

function modelOf(response: unknown): string | undefined {
  return response && typeof response === 'object'
    ? (response as { meta?: { modelUsed?: string } }).meta?.modelUsed
    : undefined;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(unfenced);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberFromText(value: string): number | undefined {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, [min, max]: [number, number]): number {
  return Math.min(Math.max(value, min), max);
}

function midpoint([min, max]: [number, number]): number {
  return min + (max - min) / 2;
}
