import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { EvalCase, EvalJudge } from './runner.js';

export interface JudgeClient<Response = NexusResponse> {
  complete(request: CompletionRequest): Promise<Response>;
}

export interface LLMJudgeInput {
  actual: string;
  expected?: string;
  query?: string;
  rubric?: string;
  contexts?: string[];
  metadata?: Record<string, unknown>;
}

export interface LLMJudgeOptions<Response = NexusResponse> {
  client: JudgeClient<Response>;
  model: string;
  rubric?: string;
  systemPrompt?: string;
  passThreshold?: number;
  range?: [number, number];
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMJudgeResult {
  score: number;
  passed: boolean;
  rationale?: string;
  labels?: string[];
  raw: unknown;
  providerUsed?: string;
  modelUsed?: string;
}

export type LLMJudgeInputMapper<Response> = (
  response: Response,
  testCase: EvalCase<Response>,
) => LLMJudgeInput | Promise<LLMJudgeInput>;

const DEFAULT_SYSTEM_PROMPT = [
  'You are a careful evaluation judge.',
  'Return only JSON with these fields: score, passed, rationale, labels.',
  'Score must be numeric within the configured range.',
].join(' ');

export class LLMJudge<Response = NexusResponse> {
  constructor(private options: LLMJudgeOptions<Response>) {}

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

export function createLLMJudgeEval<Response = NexusResponse>(
  judge: LLMJudge<Response>,
  mapper?: LLMJudgeInputMapper<Response>,
): EvalJudge<Response> {
  return judge.asEvalJudge(mapper);
}

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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
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
