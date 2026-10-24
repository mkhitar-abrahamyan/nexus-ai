/** A decision provider for tests: it answers as it is told, and records what it was asked. */
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

/** Options for `MockDecisionProvider`. */
export interface MockDecisionProviderOptions {
  /** Its name in results. Defaults to `mock`. */
  name?: string;
  /** The model it reports. Defaults to `mock-decision`. */
  model?: string;
  /**
   * Answers each question with its probabilities, from the question's name, the question, and the
   * state. Returning `undefined`, or leaving it out, answers with an even spread: confidence 0.
   */
  answer?: (name: string, question: DecisionProviderQuestion, state: DecisionState) => DecisionDistribution | undefined;
  /** Fails every call with this error, or the error the function returns. */
  fail?: Error | ((request: DecisionProviderRequest) => Error | undefined);
  /** The input tokens it reports per call. Defaults to a quarter of the request's length. */
  inputTokens?: number;
}

/**
 * Answers decisions as `answer` says, without a model, and keeps every request it was asked in
 * `requests`. It takes every question type, 255 options, and 10 levels, as TypeSafe AI's Jev does.
 */
export class MockDecisionProvider implements DecisionProvider {
  /** Its name and what it takes. */
  readonly info: DecisionProviderInfo;
  /** Every request it was asked, in order. */
  readonly requests: DecisionProviderRequest[] = [];

  constructor(private readonly options: MockDecisionProviderOptions = {}) {
    this.info = {
      name: options.name ?? 'mock',
      capabilities: {
        types: ['yes-no', 'choice', 'score'],
        maxOptions: 255,
        maxLevels: 10,
        defaultModel: options.model ?? 'mock-decision',
      },
    };
  }

  /** Answers every question as `answer` says, or with an even spread. */
  async decide(request: DecisionProviderRequest, context: DecisionCallContext): Promise<DecisionProviderResult> {
    this.requests.push(request);
    context.signal.throwIfAborted();
    const failure = typeof this.options.fail === 'function' ? this.options.fail(request) : this.options.fail;
    if (failure) throw failure;
    const distributions: Record<string, DecisionDistribution> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      distributions[name] = this.options.answer?.(name, question, request.state) ?? evenly(question);
    }
    return {
      model: request.model,
      distributions,
      usage: {
        inputTokens: this.options.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4),
        outputTokens: 0,
      },
    };
  }
}

/** An even spread over a question's answers: no answer more likely than another. */
function evenly(question: DecisionProviderQuestion): DecisionDistribution {
  if (question.type === 'yes-no') return { type: 'yes-no', yes: 0.5 };
  if (question.type === 'choice') {
    return {
      type: 'choice',
      probabilities: Object.fromEntries(question.options.map((option) => [option.name, 1 / question.options.length])),
    };
  }
  return { type: 'score', probabilities: question.levels.map(() => 1 / question.levels.length) };
}
