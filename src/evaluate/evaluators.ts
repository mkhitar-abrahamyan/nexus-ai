import type {
  EvaluationContext,
  EvaluationScore,
  Evaluator,
  ExampleResult,
  SummaryEvaluator,
} from '../types/evaluate.js';

/**
 * Evaluators that need no model call.
 *
 * Cheap, deterministic checks first: most regressions are caught by "did it still contain the order
 * number" rather than by a judge. An LLM judge is available through `nexus-ai-pro/evals/judge`, and
 * plugs in here as an ordinary evaluator.
 */

/** Exact equality against the example's expected output. */
export function exactMatch(options: { key?: string; normalize?: (value: unknown) => unknown } = {}): Evaluator {
  const normalize = options.normalize ?? ((value: unknown) => (typeof value === 'string' ? value.trim() : value));
  return (context) => ({
    key: options.key ?? 'exact-match',
    score: JSON.stringify(normalize(context.output)) === JSON.stringify(normalize(context.example.expected)) ? 1 : 0,
    passed: JSON.stringify(normalize(context.output)) === JSON.stringify(normalize(context.example.expected)),
  });
}

/** Whether the output contains every required phrase, case-insensitively by default. */
export function contains(
  phrases: readonly string[],
  options: { key?: string; caseSensitive?: boolean } = {},
): Evaluator {
  return (context) => {
    const text = asText(context.output);
    const haystack = options.caseSensitive ? text : text.toLowerCase();
    const found = phrases.filter((phrase) => haystack.includes(options.caseSensitive ? phrase : phrase.toLowerCase()));
    return {
      key: options.key ?? 'contains',
      score: phrases.length === 0 ? 1 : found.length / phrases.length,
      passed: found.length === phrases.length,
      ...(found.length === phrases.length
        ? {}
        : { comment: `missing: ${phrases.filter((phrase) => !found.includes(phrase)).join(', ')}` }),
    };
  };
}

/** Fails an output that matches any forbidden pattern: a leaked key, a refusal, a placeholder. */
export function mustNotMatch(patterns: readonly RegExp[], options: { key?: string } = {}): Evaluator {
  return (context) => {
    const text = asText(context.output);
    const hit = patterns.find((pattern) => pattern.test(text));
    return {
      key: options.key ?? 'must-not-match',
      score: hit ? 0 : 1,
      passed: !hit,
      ...(hit ? { comment: `matched ${hit}` } : {}),
    };
  };
}

/** The example either produced an output or it did not. Worth measuring on its own. */
export function completed(options: { key?: string } = {}): Evaluator {
  return (context) => ({
    key: options.key ?? 'completed',
    score: context.error ? 0 : 1,
    passed: !context.error,
    ...(context.error ? { comment: context.error.message } : {}),
  });
}

/** Latency as a pass or fail, so a quality gate can hold a budget as well as a score. */
export function underLatency(maxMs: number, options: { key?: string } = {}): Evaluator {
  return (context) => ({
    key: options.key ?? 'latency',
    score: context.latencyMs,
    passed: context.latencyMs <= maxMs,
  });
}

/** Cosine similarity against the expected answer, through any embedder. */
export function embeddingSimilarity(options: {
  embed: (texts: string[]) => Promise<number[][]>;
  key?: string;
  threshold?: number;
}): Evaluator {
  return async (context) => {
    const expected = asText(context.example.expected);
    const actual = asText(context.output);
    if (!expected || !actual) return { key: options.key ?? 'similarity', score: 0, passed: false };

    const [left, right] = await options.embed([expected, actual]);
    const score = left && right ? cosine(left, right) : 0;
    return {
      key: options.key ?? 'similarity',
      score,
      ...(options.threshold === undefined ? {} : { passed: score >= options.threshold }),
    };
  };
}

export interface TrajectoryOptions {
  /** Tool or node names expected, in order. */
  expected?: readonly string[];
  /** Reads the path actually taken. Defaults to the agent's tool calls. */
  path?: (context: EvaluationContext) => string[];
  /** `exact` requires the same sequence; `subset` only requires each expected step to appear. */
  mode?: 'exact' | 'subset';
  key?: string;
}

/**
 * Scores how an answer was reached, not just what it said.
 *
 * An agent that reaches the right answer by calling the refund tool three times is not working. The
 * trajectory is the part a final-answer check cannot see.
 */
export function trajectory(options: TrajectoryOptions = {}): Evaluator {
  const read = options.path ?? defaultPath;
  return (context) => {
    const actual = read(context);
    const expected = options.expected ?? (context.example.metadata?.expectedPath as string[] | undefined) ?? [];
    if (expected.length === 0) {
      return { key: options.key ?? 'trajectory', score: actual.length === 0 ? 1 : 0, passed: actual.length === 0 };
    }

    if ((options.mode ?? 'subset') === 'exact') {
      const matched = expected.length === actual.length && expected.every((step, index) => actual[index] === step);
      return {
        key: options.key ?? 'trajectory',
        score: matched ? 1 : 0,
        passed: matched,
        ...(matched ? {} : { comment: `expected ${expected.join(' → ')}, got ${actual.join(' → ') || 'nothing'}` }),
      };
    }

    const found = expected.filter((step) => actual.includes(step));
    return {
      key: options.key ?? 'trajectory',
      score: found.length / expected.length,
      passed: found.length === expected.length,
      ...(found.length === expected.length
        ? {}
        : { comment: `missing ${expected.filter((step) => !actual.includes(step)).join(', ')}` }),
    };
  };
}

/** Tool names an agent called, read from the messages its run produced. */
function defaultPath(context: EvaluationContext): string[] {
  const state = (context.output as { state?: { messages?: unknown[] } } | undefined)?.state;
  const messages = (state?.messages ??
    (context.output as { messages?: unknown[] } | undefined)?.messages ??
    []) as Array<{
    toolCalls?: Array<{ function?: { name?: string } }>;
  }>;
  return messages
    .flatMap((message) => (message.toolCalls ?? []).map((call) => call.function?.name ?? ''))
    .filter(Boolean);
}

/**
 * Compares two outputs for the same example and says which is better.
 *
 * Absolute scores drift; a side-by-side judgement is what people are actually good at, and what
 * distinguishes two candidate versions when both look acceptable alone.
 */
export function pairwise(options: {
  compare: (context: {
    example: EvaluationContext['example'];
    a: unknown;
    b: unknown;
  }) => Promise<-1 | 0 | 1> | (-1 | 0 | 1);
  baseline: (exampleId: string) => unknown;
  key?: string;
}): Evaluator {
  return async (context) => {
    const verdict = await options.compare({
      example: context.example,
      a: options.baseline(context.example.id),
      b: context.output,
    });
    return {
      key: options.key ?? 'pairwise',
      // 1 when the new output wins, 0.5 for a tie, 0 when the baseline wins.
      score: verdict === 1 ? 1 : verdict === 0 ? 0.5 : 0,
      passed: verdict >= 0,
    };
  };
}

/** Pass rate over every example, as a summary score for the experiment. */
export function passRate(key = 'pass-rate'): SummaryEvaluator {
  return (results: ExampleResult[]): EvaluationScore[] => {
    const judged = results.flatMap((result) => result.scores).filter((score) => score.passed !== undefined);
    if (judged.length === 0) return [];
    const passed = judged.filter((score) => score.passed).length;
    return [{ key, score: passed / judged.length, passed: passed === judged.length }];
  };
}

/** Total cost of the experiment, so a quality gain that tripled the bill is visible. */
export function totalCost(key = 'total-cost'): SummaryEvaluator {
  return (results: ExampleResult[]): EvaluationScore[] => [
    { key, score: results.reduce((total, result) => total + (result.cost ?? 0), 0) },
  ];
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const field of ['answer', 'content', 'text', 'output']) {
      if (typeof record[field] === 'string') return record[field] as string;
    }
    const state = record.state as Record<string, unknown> | undefined;
    if (state && typeof state.answer === 'string') return state.answer;
  }
  return JSON.stringify(value);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  const magnitude = Math.sqrt(left) * Math.sqrt(right);
  return magnitude === 0 ? 0 : dot / magnitude;
}
