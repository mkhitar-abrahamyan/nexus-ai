import type { CompletionRequest } from '../types/messages.js';
import type { EvalMetrics, MetricInputs } from './metrics.js';
import { calculateEvalMetrics } from './metrics.js';

export interface EvalClient<Response = unknown> {
  complete(request: CompletionRequest): Promise<Response>;
}

export interface EvalJudgment {
  score: number;
  passed: boolean;
  rationale?: string;
  labels?: string[];
  raw?: unknown;
  providerUsed?: string;
  modelUsed?: string;
}

export type EvalJudge<Response = unknown> = (
  response: Response,
  testCase: EvalCase<Response>,
) => boolean | EvalJudgment | Promise<boolean | EvalJudgment>;

export interface EvalCase<Response = unknown> {
  name: string;
  request: CompletionRequest;
  assert?: (response: Response) => boolean | Promise<boolean>;
  judge?: EvalJudge<Response>;
  expected?: string;
  metrics?: (response: Response) => MetricInputs | Promise<MetricInputs>;
  tags?: string[];
}

export interface EvalResult<Response = unknown> {
  name: string;
  passed: boolean;
  durationMs: number;
  response?: Response;
  metrics?: EvalMetrics;
  judgment?: EvalJudgment;
  error?: string;
  tags?: string[];
}

export interface EvalRunResult<Response = unknown> {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  durationMs: number;
  results: EvalResult<Response>[];
}

export class EvalRunner<Response = unknown> {
  constructor(private client: EvalClient<Response>) {}

  async run(cases: EvalCase<Response>[]): Promise<EvalRunResult<Response>> {
    const started = Date.now();
    const results: EvalResult<Response>[] = [];

    for (const testCase of cases) {
      const caseStarted = Date.now();
      try {
        const response = await this.client.complete(testCase.request);
        if (!testCase.assert && !testCase.judge) {
          throw new Error(`Eval case "${testCase.name}" requires assert or judge`);
        }
        const assertPassed = testCase.assert ? await testCase.assert(response) : true;
        const judgment = testCase.judge ? normalizeJudgment(await testCase.judge(response, testCase)) : undefined;
        const passed = assertPassed && (judgment?.passed ?? true);
        const metrics = testCase.metrics ? await calculateEvalMetrics(await testCase.metrics(response)) : undefined;
        results.push({
          name: testCase.name,
          passed,
          durationMs: Date.now() - caseStarted,
          response,
          metrics,
          judgment,
          tags: testCase.tags,
        });
      } catch (error) {
        results.push({
          name: testCase.name,
          passed: false,
          durationMs: Date.now() - caseStarted,
          error: error instanceof Error ? error.message : String(error),
          tags: testCase.tags,
        });
      }
    }

    const passedCount = results.filter((result) => result.passed).length;
    return {
      passed: passedCount === results.length,
      total: results.length,
      passedCount,
      failedCount: results.length - passedCount,
      durationMs: Date.now() - started,
      results,
    };
  }
}

function normalizeJudgment(value: boolean | EvalJudgment): EvalJudgment {
  if (typeof value === 'boolean') {
    return {
      score: value ? 1 : 0,
      passed: value,
    };
  }

  return value;
}
