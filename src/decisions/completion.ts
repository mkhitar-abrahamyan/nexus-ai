/**
 * Decisions from any completion model: each question asked on its own, answered with a one-token code,
 * and its probabilities read from the code token's log probabilities, or counted over samples where
 * the model reports none.
 */
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, ResponseCost, TokenLogprob } from '../types/response.js';
import {
  type DecisionCallContext,
  type DecisionDistribution,
  DecisionError,
  type DecisionProvider,
  type DecisionProviderInfo,
  type DecisionProviderQuestion,
  type DecisionProviderRequest,
  type DecisionProviderResult,
  type DecisionState,
  type DecisionUsage,
} from './core.js';

/** Anything that completes a request, such as a `NexusAI` client. */
export interface DecisionCompletionClient {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<NexusResponse>;
}

/** How a completion model's probabilities are read. */
export type CompletionDecisionMethod = 'auto' | 'logprobs' | 'sampling';

/** Options for `completionDecisions()`. */
export interface CompletionDecisionsOptions {
  /** The model to ask, as the client names it. */
  model: string;
  /** The provider's name in results. Defaults to `model`. */
  name?: string;
  /**
   * How probabilities are read: `logprobs`, from one call's token log probabilities; `sampling`, by
   * counting the answers of several calls; or `auto`, the default: log probabilities, and sampling for
   * a model that reports none or refuses to, which it then asks by sampling from the start.
   */
  method?: CompletionDecisionMethod;
  /** Calls per question, when sampling. Defaults to 8. */
  samples?: number;
  /** The temperature samples are drawn at. Defaults to 1. */
  temperature?: number;
  /** Questions asked at once. Defaults to 8. */
  concurrency?: number;
  /** Instructions added to every question, such as what the application's terms mean. */
  instructions?: string;
}

/** The most options a question's codes can be read from one token's alternatives: A to T. */
const LOGPROB_OPTIONS = 20;

/**
 * Any completion model as a decision provider, through a client's own `complete()`, so every call is
 * routed, authorized, budgeted, traced, and priced as every completion is. Each question is asked on
 * its own, at temperature 0, to answer with one code: a letter per option, Y or N, or a level's digit.
 * Its probabilities are read from the log probabilities of that token's alternatives where the model
 * reports them, the way TypeSafe AI's Jev reads its own; elsewhere the question is asked `samples`
 * times, and each answer counted. Sampled probabilities come in steps of one sample, and cost as many
 * calls.
 */
export function completionDecisions(
  client: DecisionCompletionClient,
  options: CompletionDecisionsOptions,
): DecisionProvider & { readonly sampledModels: ReadonlySet<string> } {
  const method = options.method ?? 'auto';
  // Models that reported no log probabilities, or refused them, are sampled from then on.
  const sampled = new Set<string>();
  const info: DecisionProviderInfo = {
    name: options.name ?? options.model,
    capabilities: {
      types: ['yes-no', 'choice', 'score'],
      maxOptions: 255,
      maxLevels: 10,
      defaultModel: options.model,
    },
    chargedByItsCalls: true,
  };

  const ask = async (
    model: string,
    state: DecisionState,
    question: DecisionProviderQuestion,
    context: DecisionCallContext,
    usage: Totals,
  ): Promise<DecisionDistribution> => {
    const codes = codesOf(question);
    const prompt = promptOf(state, question, codes, options.instructions);
    const request = (extra: Partial<CompletionRequest>): CompletionRequest => ({
      model,
      messages: [
        {
          role: 'system',
          content: 'You answer one question about a state with exactly one of the codes given, and nothing else.',
        },
        { role: 'user', content: prompt },
      ],
      signal: context.signal,
      ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
      ...extra,
    });
    const readable = codes.length <= LOGPROB_OPTIONS && codes.every((code) => code.length === 1);
    if (method !== 'sampling' && readable && !sampled.has(model)) {
      let response: NexusResponse | undefined;
      try {
        response = await client.complete(request({ temperature: 0, maxTokens: 2, logprobs: { top: 20 } }));
      } catch (error) {
        // A model that refuses the option is sampled; any other failure is the decision's.
        if (method === 'logprobs' || !refusedOption(error)) throw error;
      }
      if (response) {
        usage.add(response);
        const weights = weightsFrom(response.logprobs, codes);
        if (weights) return distributionOf(question, codes, weights);
        if (method === 'logprobs') {
          throw new DecisionError(
            `"${model}" reported no log probabilities for the codes it was given`,
            'DECISION_FAILED',
          );
        }
      }
      sampled.add(model);
    }
    if (!readable && method === 'logprobs') {
      throw new DecisionError(
        `A question of ${codes.length} options cannot be read from one token's ${LOGPROB_OPTIONS} alternatives`,
        'DECISION_UNSUPPORTED',
      );
    }
    const count = Math.max(1, Math.floor(options.samples ?? 8));
    const answers = await Promise.all(
      Array.from({ length: count }, () =>
        client.complete(request({ temperature: options.temperature ?? 1, maxTokens: 4 })).then((response) => {
          usage.add(response);
          return codeIn(response.content, codes);
        }),
      ),
    );
    const weights = codes.map((code) => answers.filter((answer) => answer === code).length);
    if (weights.every((weight) => weight === 0)) {
      throw new DecisionError(
        `"${model}" answered none of ${count} samples with a code it was given`,
        'DECISION_FAILED',
      );
    }
    return distributionOf(question, codes, weights);
  };

  return {
    info,
    sampledModels: sampled,
    async decide(request: DecisionProviderRequest, context: DecisionCallContext): Promise<DecisionProviderResult> {
      const totals = new Totals();
      const entries = Object.entries(request.questions);
      const distributions: Record<string, DecisionDistribution> = {};
      const limit = Math.max(1, Math.floor(options.concurrency ?? 8));
      let next = 0;
      // Each question on its own, as many at once as the limit allows.
      const worker = async () => {
        while (next < entries.length) {
          const [name, question] = entries[next++] as [string, DecisionProviderQuestion];
          distributions[name] = await ask(request.model, request.state, question, context, totals);
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
      return {
        model: request.model,
        distributions,
        usage: totals.usage(),
        ...(totals.cost() ? { cost: totals.cost() } : {}),
      };
    },
  };
}

/** The usage and cost of a decision's calls, added as they come. */
class Totals {
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;
  private amount = 0;
  private priced = false;

  add(response: NexusResponse): void {
    this.calls += 1;
    this.inputTokens += response.meta.usage?.inputTokens ?? 0;
    this.outputTokens += response.meta.usage?.outputTokens ?? 0;
    if (response.meta.cost) {
      this.amount += response.meta.cost.amount;
      this.priced = true;
    }
  }

  usage(): DecisionUsage {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens, calls: this.calls };
  }

  cost(): ResponseCost | undefined {
    return this.priced ? { amount: this.amount, currency: 'USD', basis: 'estimated' } : undefined;
  }
}

/** The one-token codes a question's answers are given as: Y and N, a level's digit, or a letter per option. */
function codesOf(question: DecisionProviderQuestion): string[] {
  if (question.type === 'yes-no') return ['Y', 'N'];
  if (question.type === 'score') return question.levels.map((_, level) => String(level));
  // Up to 26 options are letters; more are numbers, read by sampling alone.
  return question.options.length <= 26
    ? question.options.map((_, index) => String.fromCharCode(65 + index))
    : question.options.map((_, index) => String(index + 1));
}

/** The question, its codes, and the state, as one prompt. */
function promptOf(
  state: DecisionState,
  question: DecisionProviderQuestion,
  codes: string[],
  instructions?: string,
): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
  const lines = [`State:\n${text}`, ''];
  if (instructions) lines.push(instructions, '');
  if (question.type === 'yes-no') {
    lines.push(`Question: ${question.question ?? 'Is the statement true of the state?'}`);
    lines.push(`Y: yes${question.criteria?.yes ? `, ${question.criteria.yes}` : ''}`);
    lines.push(`N: no${question.criteria?.no ? `, ${question.criteria.no}` : ''}`);
  } else if (question.type === 'choice') {
    lines.push(`Question: ${question.question ?? 'Which option fits the state?'}`);
    question.options.forEach((option, index) => {
      lines.push(`${codes[index]}: ${option.name}${option.description ? `, ${option.description}` : ''}`);
    });
  } else {
    lines.push(`Question: ${question.question ?? 'Which level fits the state?'}`);
    question.levels.forEach((level, index) => {
      lines.push(`${codes[index]}: ${level}`);
    });
  }
  lines.push('', `Answer with one code: ${codes.join(', ')}.`);
  return lines.join('\n');
}

/** A token's text as a code: trimmed of space, quotes, and punctuation, in capitals. */
function codeOf(token: string): string {
  return token.replace(/^[\s"'`*(]+|[\s"'`*).:,]+$/g, '').toUpperCase();
}

/**
 * Each code's probability from the answer's first token and its alternatives, or `undefined` when
 * none of them is a code.
 */
function weightsFrom(logprobs: readonly TokenLogprob[] | undefined, codes: readonly string[]): number[] | undefined {
  // The first token that is not only space carries the code.
  const first = logprobs?.find((item) => item.token.trim() !== '');
  if (!first) return undefined;
  const candidates = first.top?.length ? first.top : [{ token: first.token, logprob: first.logprob }];
  const weights = codes.map(() => 0);
  let found = false;
  for (const candidate of candidates) {
    const index = matchCode(candidate.token, codes);
    if (index < 0 || !Number.isFinite(candidate.logprob)) continue;
    // Tokens that read as one code, such as " A" and "A", add up.
    weights[index] = (weights[index] as number) + Math.exp(candidate.logprob);
    found = true;
  }
  return found ? weights : undefined;
}

/** The code a sampled answer gives, if it gives one of them. */
function codeIn(content: string, codes: readonly string[]): string | undefined {
  const head = content.trim().split(/[\s:,.)]+/)[0] ?? '';
  return codes[matchCode(head, codes)];
}

/**
 * Which of `codes` a token reads as, or -1: a yes-or-no's Y and N also read from Yes, No, True, and
 * False, which a model may write however it is told.
 */
function matchCode(token: string, codes: readonly string[]): number {
  const code = codeOf(token);
  const index = codes.indexOf(code);
  if (index >= 0 || codes.length !== 2 || codes[0] !== 'Y' || codes[1] !== 'N') return index;
  if (code === 'YES' || code === 'TRUE') return 0;
  return code === 'NO' || code === 'FALSE' ? 1 : -1;
}

/** A question's distribution from its codes' weights. */
function distributionOf(
  question: DecisionProviderQuestion,
  codes: readonly string[],
  weights: readonly number[],
): DecisionDistribution {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const share = (index: number) => (total > 0 ? (weights[index] ?? 0) / total : 1 / codes.length);
  if (question.type === 'yes-no') return { type: 'yes-no', yes: share(0) };
  if (question.type === 'score') return { type: 'score', probabilities: codes.map((_, index) => share(index)) };
  return {
    type: 'choice',
    probabilities: Object.fromEntries(question.options.map((option, index) => [option.name, share(index)])),
  };
}

/** Whether a failure is the model refusing an option it was sent, as a 400 or a 422. */
function refusedOption(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  return status === 400 || status === 422;
}
