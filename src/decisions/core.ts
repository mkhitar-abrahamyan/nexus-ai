/**
 * Typed decisions: questions a model answers with a yes or no, a choice, a score, or a box around
 * something in a picture, each with a confidence read alike from any provider, so software acts on an
 * answer without parsing text.
 */
import type { CacheAdapter } from '../cache/adapters.js';
import { createCacheKey } from '../cache/memory-cache.js';
import { withLifecycle } from '../lifecycle/run.js';
import type { ImageContent } from '../types/messages.js';
import type { OperationLifecycleLike, ProviderCallContext } from '../types/lifecycle.js';
import type { ResponseCost } from '../types/response.js';
import type { RunKind } from '../types/tracing.js';
import { generateRequestId } from '../utils/ids.js';
import { sha256Hex } from '../utils/sha256.js';
import { DecisionError } from './errors.js';
import { type DecisionPicture, pictureDigest, replacePictures, statePictures } from './pictures.js';

// ── Questions ───────────────────────────────────────────────────────

/**
 * The kinds of question there are: a yes or no, a choice among options, a score on levels, or a box
 * around something in a picture.
 */
export type DecisionQuestionType = 'yes-no' | 'choice' | 'score' | 'box';

/** A question answered yes or no, with the probability that it is yes. */
export interface YesNoQuestion {
  /** Discriminates the question. */
  type: 'yes-no';
  /** The question, or a statement that is true or false, such as "The customer asks for a refund." */
  question?: string;
  /** What counts as yes and as no, when the question alone leaves it open. */
  criteria?: { yes?: string; no?: string };
}

/** A question answered by one of its options, with each option's probability. */
export interface ChoiceQuestion<K extends string = string> {
  /** Discriminates the question. */
  type: 'choice';
  /** The question, such as "Which team should handle this?". */
  question?: string;
  /** The options, by name, each with what it means, or only their names. Up to 255. */
  options: readonly K[] | Readonly<Record<K, string>>;
}

/** A question answered on an ordered rubric: level 0 first, with each level's probability. */
export interface ScoreQuestion {
  /** Discriminates the question. */
  type: 'score';
  /** The question, such as "How urgent is this?". */
  question?: string;
  /** What each level means, lowest first. Two to ten. */
  levels: readonly string[];
}

/** A question answered with where something is in a picture of the state: a box around it. */
export interface BoxQuestion {
  /** Discriminates the question. */
  type: 'box';
  /**
   * What to find, and in which picture, by its path in backticks, such as "the dent in `photo`". A box
   * is given even for something the picture does not show: ask a yes or no beside it whether it does.
   */
  question: string;
}

/** Any question. */
export type DecisionQuestion = YesNoQuestion | ChoiceQuestion | ScoreQuestion | BoxQuestion;

/** Questions by the names their answers come back under. */
export type DecisionQuestions = Record<string, DecisionQuestion>;

/**
 * What every question of a decision is about: text, or any JSON value. An object or a list may hold
 * pictures, as image parts (`{ type: 'image', source }`) or image assets, anywhere in it; a question
 * names each by its path in backticks, such as `photo` or `frames[2].frame`.
 */
export type DecisionState = string | Record<string, unknown> | readonly unknown[];

/**
 * Where something is in a picture: each edge a fraction, from 0 to 1, of the picture's height (`top`,
 * `bottom`) or width (`left`, `right`), measured from its top-left corner.
 */
export interface DecisionBox {
  /** The top edge, from the picture's top. */
  top: number;
  /** The bottom edge, from the picture's top: at least `top`. */
  bottom: number;
  /** The left edge, from the picture's left. */
  left: number;
  /** The right edge, from the picture's left: at least `left`. */
  right: number;
}

// ── Answers ─────────────────────────────────────────────────────────

/** A yes-or-no question's answer. */
export interface YesNoAnswer {
  /** Discriminates the answer. */
  type: 'yes-no';
  /** Whether it is yes: the probability is at least one half. */
  yes: boolean;
  /** The probability that it is yes, from 0 to 1. */
  probability: number;
  /** How far the probability is from an even chance, from 0 to 1: `|2p - 1|`. */
  confidence: number;
}

/** A choice question's answer. */
export interface ChoiceAnswer<K extends string = string> {
  /** Discriminates the answer. */
  type: 'choice';
  /** The most probable option; of equally probable ones, the first given. */
  choice: K;
  /** Every option's probability, summing to 1. */
  probabilities: Record<K, number>;
  /**
   * How far the top probability is above an even split, from 0 to 1: `(pmax - 1/n) / (1 - 1/n)` of
   * `n` options.
   */
  confidence: number;
}

/** A score question's answer. */
export interface ScoreAnswer {
  /** Discriminates the answer. */
  type: 'score';
  /** The probability-weighted level, which may fall between two. */
  score: number;
  /** The most probable level; of equally probable ones, the lowest. */
  level: number;
  /** Each level's probability, lowest first, summing to 1. */
  probabilities: number[];
  /**
   * How close the probability sits around the most probable level, from 0 to 1: one less the
   * probability-weighted distance from it, over that distance for an even spread, and 0 at an even
   * spread or wider.
   */
  confidence: number;
}

/** A box question's answer. */
export interface BoxAnswer {
  /** Discriminates the answer. */
  type: 'box';
  /** Where it is. */
  box: DecisionBox;
  /**
   * How sure the answer is, from 0 to 1: the provider's own, such as TypeSafe AI's Jev gives, or how
   * far several readings of the box agree, for a model asked more than once.
   */
  confidence: number;
}

/** Any answer. */
export type DecisionAnswer = YesNoAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer;

/** The options of a choice question, as a union of their names. */
type OptionsOf<O> = O extends readonly (infer K)[] ? K : keyof O;

/** The answer a question gets: a choice's answer names only its options. */
export type AnswerOf<Q> = Q extends YesNoQuestion
  ? YesNoAnswer
  : Q extends { type: 'choice'; options: infer O }
    ? ChoiceAnswer<Extract<OptionsOf<O>, string>>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : Q extends BoxQuestion
        ? BoxAnswer
        : DecisionAnswer;

/** Answers by their questions' names, each typed by its question. */
export type DecisionAnswers<Q extends DecisionQuestions> = { [K in keyof Q]: AnswerOf<Q[K]> };

// ── Requests and results ────────────────────────────────────────────

/** A decision: questions about one state, answered together and each in isolation. */
export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
  /** What every question is about. */
  state: DecisionState;
  /** The questions, by the names their answers come back under. */
  questions: Q;
  /** The provider to ask. Defaults to the manager's default, then the first registered. */
  provider?: string;
  /** The model to ask. Defaults to the provider's own. */
  model?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Stops the call. */
  signal?: AbortSignal;
  /** Labels for the trace and the audit log. Never include the state's private data. */
  metadata?: Record<string, unknown>;
  /** `false` asks the provider even when the cache holds an answer. */
  cache?: boolean;
}

/** What a decision used, where the provider reports it. */
export interface DecisionUsage {
  /** Input tokens. */
  inputTokens?: number;
  /** Output tokens. */
  outputTokens?: number;
  /** Model calls made, for a provider that asks a completion model. */
  calls?: number;
}

/** A decision's answers, and who gave them. */
export interface DecisionResult<Q extends DecisionQuestions = DecisionQuestions> {
  /** The answers, by question name. */
  answers: DecisionAnswers<Q>;
  /** The provider that answered. */
  provider: string;
  /** The model that answered, as the provider names it. */
  model: string;
  /** What it used. */
  usage?: DecisionUsage;
  /** What it cost, when the provider or the manager's prices price it. */
  cost?: ResponseCost;
  /** How long it took, in milliseconds. */
  latencyMs: number;
  /** True when the answers came from the cache. */
  cached?: boolean;
}

// ── Providers ───────────────────────────────────────────────────────

/** A question as a provider receives it: a choice's options in order, each with its description. */
export type DecisionProviderQuestion =
  | YesNoQuestion
  | { type: 'choice'; question?: string; options: Array<{ name: string; description?: string }> }
  | ScoreQuestion
  | BoxQuestion;

/** What a provider is asked. */
export interface DecisionProviderRequest {
  /** The model to ask. */
  model: string;
  /** What every question is about, with any pictures it holds, which `statePictures()` lists. */
  state: DecisionState;
  /** The questions, by name. */
  questions: Record<string, DecisionProviderQuestion>;
}

/** A provider's probabilities for one question, from which the answer and its confidence are read. */
export type DecisionDistribution =
  | { type: 'yes-no'; yes: number }
  | { type: 'choice'; probabilities: Record<string, number> }
  | { type: 'score'; probabilities: readonly number[] }
  | { type: 'box'; box: DecisionBox; confidence: number };

/** What a provider answers. */
export interface DecisionProviderResult {
  /** The model that answered, when it differs from the one asked, as an alias resolves. */
  model?: string;
  /** Each question's probabilities, by name. */
  distributions: Record<string, DecisionDistribution>;
  /** What it used. */
  usage?: DecisionUsage;
  /** What it cost, when the provider reports it. */
  cost?: ResponseCost;
}

/** What a decision provider takes. */
export interface DecisionProviderCapabilities {
  /** The kinds of question it answers. */
  types: readonly DecisionQuestionType[];
  /** Most options a choice may have. */
  maxOptions: number;
  /** Most levels a score may have. */
  maxLevels: number;
  /** Most questions one decision may ask, when it has a limit. */
  maxQuestions?: number;
  /** Whether it reads the pictures a state holds. A provider without it is not asked about a picture. */
  images?: boolean;
  /** The model asked when a request names none. */
  defaultModel: string;
  /** The models it serves, when it lists them. */
  models?: readonly string[];
}

/** Identifies a decision provider and what it takes. */
export interface DecisionProviderInfo {
  /** Its name, which results carry. */
  name: string;
  /** What it takes. */
  capabilities: DecisionProviderCapabilities;
  /**
   * True for a provider whose calls are charged where they are made, such as one asking a client's
   * own completions: its decisions report their cost, and hold and charge nothing to the budget again.
   */
  chargedByItsCalls?: boolean;
}

/** What every decision call receives: how to stop, the request's id, and the tenant's credential. */
export interface DecisionCallContext {
  /** Stops the call. */
  signal: AbortSignal;
  /** The request's id, for logs and traces. */
  requestId: string;
  /** The tenant it is for. */
  tenantId?: string;
  /**
   * The tenant's credential for a provider, with a credential resolver: an adapter sends it in place
   * of the key it was configured with.
   */
  credential?: ProviderCallContext['credential'];
}

/** A backend that answers decisions: a decision model, a completion model, or a stand-in. */
export interface DecisionProvider {
  /** What it is and takes. */
  readonly info: DecisionProviderInfo;
  /** Answers every question of a decision. */
  decide(request: DecisionProviderRequest, context: DecisionCallContext): Promise<DecisionProviderResult>;
}

export { DecisionError, type DecisionErrorCode } from './errors.js';

// ── Confidence ──────────────────────────────────────────────────────

/** A yes-or-no answer's confidence: how far its probability is from an even chance, `|2p - 1|`. */
export function yesNoConfidence(probability: number): number {
  return clamp(Math.abs(2 * probability - 1));
}

/**
 * A choice's confidence, from its options' probabilities: how far the top one is above an even split,
 * `(pmax - 1/n) / (1 - 1/n)`. One option is certain.
 */
export function choiceConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const top = Math.max(...probabilities);
  return clamp((top - 1 / n) / (1 - 1 / n));
}

/**
 * A score's confidence, from its levels' probabilities: one less the probability-weighted distance
 * from the most probable level, over that distance for an even spread, and 0 at an even spread or
 * wider. One level is certain.
 */
export function scoreConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const mode = argmax(probabilities);
  let spread = 0;
  let even = 0;
  for (let index = 0; index < n; index += 1) {
    spread += (probabilities[index] ?? 0) * Math.abs(index - mode);
    even += Math.abs(index - mode) / n;
  }
  return even === 0 ? 1 : clamp(1 - spread / even);
}

/**
 * An answer from a provider's probabilities for one question: normalized to sum to 1, with its
 * confidence read the same way whichever provider gave them. Throws `DecisionError`
 * `DECISION_INVALID` for probabilities that do not fit the question.
 */
export function decisionAnswer(question: DecisionProviderQuestion, distribution: DecisionDistribution): DecisionAnswer {
  if (distribution.type !== question.type) {
    throw new DecisionError(`A ${question.type} question was answered as a ${distribution.type}`, 'DECISION_INVALID');
  }
  if (question.type === 'yes-no' && distribution.type === 'yes-no') {
    const probability = probabilityOf(distribution.yes, 'yes');
    return { type: 'yes-no', yes: probability >= 0.5, probability, confidence: yesNoConfidence(probability) };
  }
  if (question.type === 'choice' && distribution.type === 'choice') {
    const names = question.options.map((option) => option.name);
    for (const name of Object.keys(distribution.probabilities)) {
      if (!names.includes(name))
        throw new DecisionError(`"${name}" is not an option of the question`, 'DECISION_INVALID');
    }
    const weights = normalize(names.map((name) => probabilityOf(distribution.probabilities[name] ?? 0, name)));
    const probabilities = Object.fromEntries(names.map((name, index) => [name, weights[index] as number]));
    return {
      type: 'choice',
      choice: names[argmax(weights)] as string,
      probabilities,
      confidence: choiceConfidence(weights),
    };
  }
  if (question.type === 'score' && distribution.type === 'score') {
    if (distribution.probabilities.length !== question.levels.length) {
      throw new DecisionError(
        `A score of ${question.levels.length} levels was answered with ${distribution.probabilities.length} probabilities`,
        'DECISION_INVALID',
      );
    }
    const weights = normalize(distribution.probabilities.map((value, index) => probabilityOf(value, `level ${index}`)));
    return {
      type: 'score',
      score: weights.reduce((sum, weight, index) => sum + weight * index, 0),
      level: argmax(weights),
      probabilities: weights,
      confidence: scoreConfidence(weights),
    };
  }
  if (question.type === 'box' && distribution.type === 'box') {
    const edge = (name: keyof DecisionBox) => {
      const value = distribution.box?.[name];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new DecisionError(
          `The box's ${name} edge is ${String(value)}, not a number from 0 to 1`,
          'DECISION_INVALID',
        );
      }
      return value;
    };
    const box = { top: edge('top'), bottom: edge('bottom'), left: edge('left'), right: edge('right') };
    if (box.top > box.bottom || box.left > box.right) {
      throw new DecisionError(
        `The box's edges cross: top ${box.top} and bottom ${box.bottom}, left ${box.left} and right ${box.right}`,
        'DECISION_INVALID',
      );
    }
    const confidence = distribution.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new DecisionError(
        `The box's confidence is ${String(confidence)}, not a number from 0 to 1`,
        'DECISION_INVALID',
      );
    }
    return { type: 'box', box, confidence };
  }
  throw new DecisionError(`Unknown question type "${(question as { type?: unknown }).type}"`, 'DECISION_INVALID');
}

/**
 * How far two boxes overlap, from 0 to 1: the area they share over the area they cover together, the
 * intersection over union by which a box is judged against where the thing is.
 */
export function boxOverlap(a: DecisionBox, b: DecisionBox): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const shared = width * height;
  const area = (box: DecisionBox) => Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  const union = area(a) + area(b) - shared;
  // Two empty boxes at one point are the same box.
  if (union <= 0) return a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right ? 1 : 0;
  return shared / union;
}

// ── Gates ───────────────────────────────────────────────────────────

/** What to do with an answer: act on it, have a person review it, or neither. */
export type GateOutcome = 'act' | 'review' | 'abstain';

/** The confidences a gate acts at, and has reviewed at. */
export interface GateThresholds {
  /** At or above this confidence, act. */
  act: number;
  /** At or above this, and below `act`, a person reviews it; below it, abstain. Defaults to 0. */
  review?: number;
}

/**
 * Turns an answer's confidence into what to do: act at or above `act`, have a person review it at or
 * above `review`, and abstain below. Set the thresholds by risk, and choose them with `calibrate()`
 * on the application's own labelled examples.
 */
export function gate(answer: { confidence: number }, thresholds: GateThresholds): GateOutcome {
  if (answer.confidence >= thresholds.act) return 'act';
  return answer.confidence >= (thresholds.review ?? 0) ? 'review' : 'abstain';
}

// ── Calibration ─────────────────────────────────────────────────────

/** One answer whose right answer is known, and whether it was right. */
export interface CalibrationSample {
  /** The answer. */
  answer: DecisionAnswer;
  /** Whether it was right, as `answeredRight()` reads it. */
  correct: boolean;
}

/** Answers that gave their own answer a probability in one range, and how often they were right. */
export interface CalibrationBin {
  /** The range's lower bound, included. */
  from: number;
  /** Its upper bound, excluded, except for the last range's 1. */
  to: number;
  /** How many answers fell in it. */
  count: number;
  /** The mean probability they gave their own answers. */
  probability: number;
  /** The share of them that were right. */
  accuracy: number;
}

/** Options for `calibrate()`. */
export interface CalibrateOptions {
  /** How many equal ranges of probability to count in. Defaults to 10. */
  bins?: number;
  /** The accuracy the threshold must hold: the share of answers at or above it that are right. */
  targetAccuracy?: number;
  /** The fewest answers the threshold must keep, so one lucky answer does not choose it. Defaults to 10. */
  minSamples?: number;
}

/** How well answers' probabilities tracked how often they were right, and the threshold that holds the target. */
export interface CalibrationReport {
  /** How many answers were counted. */
  samples: number;
  /** The share of all of them that were right. */
  accuracy: number;
  /**
   * The expected calibration error: the bins' gaps between the probability answers gave themselves and
   * how often they were right, weighted by their counts. 0 when answers are as often right as they say.
   */
  expectedCalibrationError: number;
  /** The answers by range of probability, empty ranges left out. */
  bins: CalibrationBin[];
  /**
   * The lowest confidence at which the answers at or above it reach `targetAccuracy`, keeping at least
   * `minSamples`: the `act` threshold for a gate. Absent when no threshold reaches it.
   */
  threshold?: number;
  /** The share of answers at or above `threshold`: how much a gate there acts on. */
  coverage?: number;
}

/**
 * The probability an answer gives its own answer: a yes or no's `max(p, 1 - p)`, a choice's for its
 * option, and a score's for its level. Its confidence measures how far that is above an even spread.
 * A box has no probabilities, so its confidence stands for one.
 */
export function answerProbability(answer: DecisionAnswer): number {
  if (answer.type === 'yes-no') return Math.max(answer.probability, 1 - answer.probability);
  if (answer.type === 'choice') return (answer.probabilities as Record<string, number>)[answer.choice] ?? 0;
  if (answer.type === 'box') return answer.confidence;
  return answer.probabilities[answer.level] ?? 0;
}

/**
 * Measures how well answers' probabilities track how often they are right, and, with
 * `targetAccuracy`, chooses the gate threshold that holds it. Answers are calibrated when those that
 * give their answer 0.8 are right about 80% of the time. The threshold is on confidence, which gates
 * act on: it holds on answers like these, not on a different kind of question or state.
 */
export function calibrate(samples: readonly CalibrationSample[], options: CalibrateOptions = {}): CalibrationReport {
  const count = Math.max(1, Math.floor(options.bins ?? 10));
  const valid = samples
    .map((sample) => ({
      ...sample,
      probability: answerProbability(sample.answer),
      confidence: sample.answer.confidence,
    }))
    .filter((sample) => Number.isFinite(sample.probability) && Number.isFinite(sample.confidence));
  const right = valid.filter((sample) => sample.correct).length;
  const bins: CalibrationBin[] = [];
  let error = 0;
  for (let index = 0; index < count; index += 1) {
    const from = index / count;
    const to = (index + 1) / count;
    const inside = valid.filter((sample) => {
      const probability = clamp(sample.probability);
      return probability >= from && (probability < to || (index === count - 1 && probability <= 1));
    });
    if (inside.length === 0) continue;
    const probability = inside.reduce((sum, sample) => sum + clamp(sample.probability), 0) / inside.length;
    const accuracy = inside.filter((sample) => sample.correct).length / inside.length;
    error += (inside.length / valid.length) * Math.abs(probability - accuracy);
    bins.push({ from, to, count: inside.length, probability, accuracy });
  }
  const report: CalibrationReport = {
    samples: valid.length,
    accuracy: valid.length ? right / valid.length : 0,
    expectedCalibrationError: error,
    bins,
  };
  if (options.targetAccuracy === undefined || valid.length === 0) return report;
  // From the most confident down, the lowest confidence whose answers at or above it hold the target.
  const sorted = [...valid].sort((a, b) => b.confidence - a.confidence);
  const minSamples = Math.max(1, options.minSamples ?? 10);
  let kept = 0;
  let correct = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index] as (typeof sorted)[number];
    kept += 1;
    if (sample.correct) correct += 1;
    // Answers of equal confidence stand or fall together: a threshold cannot fall between them.
    if (index + 1 < sorted.length && (sorted[index + 1] as (typeof sorted)[number]).confidence === sample.confidence)
      continue;
    if (kept >= minSamples && correct / kept >= options.targetAccuracy) {
      report.threshold = sample.confidence;
      report.coverage = kept / valid.length;
    }
  }
  return report;
}

/**
 * Whether an answer is right: a yes-or-no or a choice by its answer, a score by its most probable
 * level, or by its weighted score within `tolerance` levels when one is given, and a box by how far it
 * overlaps the expected one, `boxOverlap()`, at least `overlap` (one half by default).
 */
export function answeredRight(
  answer: DecisionAnswer,
  expected: boolean | string | number | DecisionBox,
  options: { tolerance?: number; overlap?: number } = {},
): boolean {
  if (answer.type === 'yes-no') return answer.yes === expected;
  if (answer.type === 'choice') return answer.choice === expected;
  if (answer.type === 'box') {
    if (expected === null || typeof expected !== 'object') return false;
    return boxOverlap(answer.box, expected) >= (options.overlap ?? 0.5);
  }
  if (typeof expected !== 'number') return false;
  // Within a hair of the tolerance counts, so 1.4 is within 0.6 of 2 as arithmetic says it is.
  return options.tolerance === undefined
    ? answer.level === expected
    : Math.abs(answer.score - expected) <= options.tolerance + 1e-9;
}

// ── Prices ──────────────────────────────────────────────────────────

/** A decision model's price, in US dollars per million tokens. */
export interface DecisionPrice {
  /** Per million input tokens. */
  inputPerMillion: number;
  /** Per million output tokens. Defaults to 0. */
  outputPerMillion?: number;
}

/**
 * Bundled decision prices, by model name or a prefix of it: TypeSafe AI's Jev at its published
 * price, $42 per billion input tokens, with output free, as of 2026-10-24.
 */
export const DECISION_PRICES: Readonly<Record<string, DecisionPrice>> = {
  jev: { inputPerMillion: 0.042, outputPerMillion: 0 },
};

/** The price of a model from `prices`, by its name or the longest prefix of it listed. */
function priceOf(model: string, prices: Readonly<Record<string, DecisionPrice>>): DecisionPrice | undefined {
  if (prices[model]) return prices[model];
  const prefix = Object.keys(prices)
    .filter((name) => model.startsWith(name))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? prices[prefix] : undefined;
}

/**
 * What a decision cost, from its usage and the model's price; `undefined` for a model without a price
 * or usage without tokens, never zero.
 */
export function priceDecision(
  model: string,
  usage: DecisionUsage | undefined,
  prices: Readonly<Record<string, DecisionPrice>> = DECISION_PRICES,
): ResponseCost | undefined {
  const price = priceOf(model, prices);
  if (!price || usage?.inputTokens === undefined) return undefined;
  const input = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * (price.outputPerMillion ?? 0);
  return { amount: input + output, currency: 'USD', basis: 'estimated', input, output };
}

// ── The manager ─────────────────────────────────────────────────────

/** A decision's run in a trace, as decisions finish it. */
export interface DecisionRunLike {
  /** Finishes the run with its answers, usage, and cost, or its error. */
  finish(options?: {
    outputs?: unknown;
    error?: unknown;
    usage?: Record<string, number>;
    cost?: number;
    model?: string;
    provider?: string;
  }): Promise<void>;
}

/** A tracer, or the part of one decisions use: a run per decision, with the provider's calls inside it. */
export interface DecisionTracerLike {
  /** Starts a run. */
  startRun(options: {
    name: string;
    kind?: RunKind;
    inputs?: unknown;
    metadata?: Record<string, unknown>;
    model?: string;
    provider?: string;
  }): DecisionRunLike;
  /** Runs `fn` with the run in scope, so a model call inside it, through a traced client, nests beneath. */
  within<T>(handle: DecisionRunLike, fn: () => T): T;
}

/** Configuration for `DecisionManager`. */
export interface DecisionConfig {
  /** Providers, by name. */
  providers?: Record<string, DecisionProvider>;
  /** The provider a request that names none goes to. Otherwise the first registered. */
  defaultProvider?: string;
  /**
   * Providers to ask, in order, when the one asked fails in a way another may not: a timeout, a
   * refused connection, or an overloaded service. A malformed request fails at once.
   */
  fallbacks?: readonly string[];
  /** Prices by model or prefix, beside the bundled ones. */
  prices?: Readonly<Record<string, DecisionPrice>>;
  /**
   * Keeps each decision's answers, so the same questions about the same state are answered once: a
   * `CacheAdapter`, such as the memory, Redis, or SQLite one, and how long they keep (a day).
   */
  cache?: { store: CacheAdapter<CachedDecision>; ttlSeconds?: number };
}

/** A decision's answers as the cache keeps them. */
export interface CachedDecision {
  /** The answers, by question name. */
  answers: Record<string, DecisionAnswer>;
  /** The provider that answered. */
  provider: string;
  /** The model that answered. */
  model: string;
  /** What it used. */
  usage?: DecisionUsage;
}

/** What the manager runs on. */
export interface DecisionRuntime {
  /**
   * Runs every decision as one operation of a client's lifecycle, family `decision`: pass
   * `ai.lifecycle`, so it is authorized, budgeted, rate limited, and audited, on the tenant's key.
   */
  lifecycle?: OperationLifecycleLike;
  /** Records each decision as a run of kind `decision`, with its answers, usage, and cost. */
  tracer?: DecisionTracerLike;
}

/**
 * Decisions behind one handle: each goes to the provider named, the default, or the first
 * registered, with failover to `fallbacks`, a cache, and every call inside a client's lifecycle.
 *
 * ```ts
 * const decisions = new DecisionManager(
 *   { providers: { jev: new TypeSafeDecisionProvider({ apiKey }) }, fallbacks: ['gpt'] },
 *   { lifecycle: ai.lifecycle },
 * );
 * const { answers } = await decisions.decide({
 *   state: ticket,
 *   questions: {
 *     team: { type: 'choice', options: { billing: 'Charges and invoices', technical: 'Errors and outages' } },
 *     urgent: { type: 'yes-no', question: 'Does the customer need an answer today?' },
 *   },
 * });
 * if (gate(answers.team, { act: 0.8 }) === 'act') route(answers.team.choice);
 * ```
 */
export class DecisionManager {
  private readonly providers = new Map<string, DecisionProvider>();

  constructor(
    private readonly config: DecisionConfig = {},
    private readonly runtime: DecisionRuntime = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers ?? {}))
      this.registerDecisionProvider(name, provider);
  }

  /** Registers a provider under a name. Returns the manager, for chaining. */
  registerDecisionProvider(name: string, provider: DecisionProvider): this {
    if (!name.trim()) throw new DecisionError('A decision provider needs a name', 'DECISION_INVALID');
    this.providers.set(name.trim(), provider);
    return this;
  }

  /** Whether a provider is registered. */
  hasDecisionProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered provider's name. */
  listDecisionProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Answers every question of a decision, each typed by its question: a choice's answer names only
   * its options. Throws `DecisionError` when the request is malformed or no provider can answer.
   */
  async decide<const Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    request.signal?.throwIfAborted();
    const questions = normalizeQuestions(request.questions);
    const pictures = picturesOf(request.state, questions);
    const chosen = request.provider ?? this.config.defaultProvider ?? this.providers.keys().next().value;
    if (chosen === undefined) throw new DecisionError('No decision provider is registered', 'DECISION_NO_PROVIDER');
    const order = [chosen, ...(this.config.fallbacks ?? []).filter((name) => name !== chosen)];
    let last: unknown;
    for (const [position, name] of order.entries()) {
      const provider = this.providers.get(name);
      if (!provider) throw new DecisionError(`No decision provider is registered as "${name}"`, 'DECISION_NO_PROVIDER');
      const unfit = unsupported(provider, questions, pictures);
      if (unfit) {
        // A fallback that cannot take the questions is passed over; the one asked for is refused.
        if (position > 0) continue;
        throw new DecisionError(`Decision provider "${name}" ${unfit}`, 'DECISION_UNSUPPORTED');
      }
      try {
        return (await this.ask(name, provider, request, questions, pictures)) as DecisionResult<Q>;
      } catch (error) {
        last = error;
        if (request.signal?.aborted || !retryable(error)) throw error;
      }
    }
    throw last;
  }

  private async ask(
    name: string,
    provider: DecisionProvider,
    request: DecisionRequest,
    questions: Record<string, DecisionProviderQuestion>,
    pictures: readonly DecisionPicture[],
  ): Promise<DecisionResult> {
    const model = request.model ?? provider.info.capabilities.defaultModel;
    const started = Date.now();
    const cache = request.cache === false ? undefined : this.config.cache;
    // The state as keys and traces hold it: each picture by a digest, never its bytes.
    const described = pictures.length
      ? replacePictures(request.state, (picture) => ({ picture: pictureDigest(picture.part) }))
      : request.state;
    const key = cache
      ? `nexus:decision:${sha256Hex(createCacheKey({ name, model, tenant: request.tenantId, state: described, questions }))}`
      : undefined;
    if (cache && key) {
      const hit = await cache.store.get(key);
      if (hit) {
        return {
          answers: hit.answers,
          provider: hit.provider,
          model: hit.model,
          ...(hit.usage ? { usage: hit.usage } : {}),
          latencyMs: Date.now() - started,
          cached: true,
        };
      }
    }
    const requestId = generateRequestId();
    const charged = provider.info.chargedByItsCalls === true;
    const run = this.runtime.tracer?.startRun({
      name: `decide ${Object.keys(questions).join(', ')}`,
      kind: 'decision',
      inputs: { state: described, questions },
      model,
      provider: name,
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });
    const call = () =>
      withLifecycle(
        this.runtime.lifecycle,
        {
          family: 'decision',
          operation: 'decision.decide',
          requestId,
          provider: name,
          model,
          ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
          metadata: {
            questions: Object.keys(questions).length,
            ...(pictures.length ? { pictures: pictures.length } : {}),
            ...request.metadata,
          },
        },
        request.signal ? { signal: request.signal } : {},
        async (ticket) => {
          // Held against the budget at the model's price, for the tokens the request will send: its
          // text, and each picture at what a picture within 1,568 pixels a side costs at most.
          const estimate = charged
            ? undefined
            : priceDecision(
                model,
                {
                  inputTokens:
                    Math.ceil(JSON.stringify({ state: described, questions }).length / 4) +
                    pictures.length * PICTURE_TOKENS,
                },
                this.prices(),
              );
          if (ticket && estimate) await ticket.reserve(estimate.amount);
          const answered = await provider.decide(
            { model, state: request.state, questions },
            {
              signal: ticket?.context.signal ?? request.signal ?? new AbortController().signal,
              requestId,
              ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
              ...(ticket?.context.credential ? { credential: ticket.context.credential } : {}),
            },
          );
          const answers: Record<string, DecisionAnswer> = {};
          for (const [question, asked] of Object.entries(questions)) {
            const distribution = answered.distributions[question];
            if (!distribution) {
              throw new DecisionError(`Decision provider "${name}" did not answer "${question}"`, 'DECISION_FAILED');
            }
            answers[question] = decisionAnswer(asked, distribution);
          }
          const resolved = answered.model ?? model;
          const cost = answered.cost ?? priceDecision(resolved, answered.usage, this.prices());
          return {
            answers,
            provider: name,
            model: resolved,
            ...(answered.usage ? { usage: answered.usage } : {}),
            ...(cost ? { cost } : {}),
            latencyMs: Date.now() - started,
          } satisfies DecisionResult;
        },
        // A cost the provider's own calls charged is not charged again.
        (result) =>
          result.cost && !charged ? { cost: result.cost.amount, model: result.model } : { model: result.model },
      );
    try {
      const result = run && this.runtime.tracer ? await this.runtime.tracer.within(run, call) : await call();
      await run?.finish({
        outputs: result.answers,
        model: result.model,
        provider: name,
        ...(result.usage ? { usage: numbers(result.usage) } : {}),
        ...(result.cost ? { cost: result.cost.amount } : {}),
      });
      if (cache && key) {
        await cache.store.set(
          key,
          {
            answers: result.answers,
            provider: result.provider,
            model: result.model,
            ...(result.usage ? { usage: result.usage } : {}),
          },
          cache.ttlSeconds ?? 86_400,
        );
      }
      return result;
    } catch (error) {
      await run?.finish({ error });
      throw error;
    }
  }

  private prices(): Readonly<Record<string, DecisionPrice>> {
    return this.config.prices ? { ...DECISION_PRICES, ...this.config.prices } : DECISION_PRICES;
  }
}

/** Answers a decision with one provider, outside any manager: no failover, cache, or lifecycle. */
export async function decide<const Q extends DecisionQuestions>(
  provider: DecisionProvider,
  request: Omit<DecisionRequest<Q>, 'provider'>,
): Promise<DecisionResult<Q>> {
  return new DecisionManager({ providers: { [provider.info.name]: provider } }).decide(request as DecisionRequest<Q>);
}

// ── Conformance ─────────────────────────────────────────────────────

/** A question whose right answer is known, for `runDecisionConformance()`. */
export interface DecisionConformanceCase {
  /** What the question is about. */
  state: DecisionState;
  /** The question. */
  question: DecisionQuestion;
  /**
   * The right answer: a yes or no, a choice's option, a score's level, or where a box should be, which
   * an answer overlapping it by half or more matches.
   */
  expected: boolean | string | number | DecisionBox;
}

/** Options for `runDecisionConformance()`. */
export interface DecisionConformanceOptions {
  /** The model to ask. Defaults to the provider's own. */
  model?: string;
  /**
   * Questions whose answers are known, each of which must be answered right. A stand-in that answers
   * as it is told passes without them; a real model is held to them.
   */
  cases?: readonly DecisionConformanceCase[];
  /**
   * A picture for the checks of a provider that reads pictures or answers boxes: it is asked a yes or
   * no about the picture, and a box around what it shows. Without one, those checks are skipped.
   */
  picture?: ImageContent;
}

/** How a provider did against the decision contract. */
export interface DecisionConformanceReport {
  /** The provider. */
  provider: string;
  /** Checks that passed. */
  passed: string[];
  /** Checks that failed, each with why. */
  failures: string[];
  /** Checks that were not run, each with why, such as a box with no picture given to ask about. */
  skipped: string[];
}

/**
 * Checks a provider against the decision contract: its capabilities are coherent; each question type
 * it declares comes back as probabilities, or a box, that fit the question; a provider that reads
 * pictures answers about one; several questions in one decision each get their own answer; a stopped
 * call is not answered; and every case is answered right. Never throws; failures are listed.
 */
export async function runDecisionConformance(
  provider: DecisionProvider,
  options: DecisionConformanceOptions = {},
): Promise<DecisionConformanceReport> {
  const report: DecisionConformanceReport = { provider: provider.info.name, passed: [], failures: [], skipped: [] };
  const check = async (name: string, run: () => Promise<void> | void) => {
    try {
      await run();
      report.passed.push(name);
    } catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const capabilities = provider.info.capabilities;
  const ask = <const Q extends DecisionQuestions>(state: DecisionState, questions: Q) =>
    decide(provider, { state, questions, ...(options.model ? { model: options.model } : {}) });
  await check('capabilities', () => {
    if (!provider.info.name.trim()) throw new Error('the provider has no name');
    if (capabilities.types.length === 0) throw new Error('it answers no question type');
    if (capabilities.types.includes('choice') && !(capabilities.maxOptions >= 2))
      throw new Error('a choice needs two options');
    if (capabilities.types.includes('score') && !(capabilities.maxLevels >= 2))
      throw new Error('a score needs two levels');
    if (capabilities.types.includes('box') && capabilities.images !== true)
      throw new Error('it answers boxes, and reads no pictures to find them in');
    if (!capabilities.defaultModel.trim()) throw new Error('it names no default model');
  });
  const state = 'The invoice INV-77 for $120 was paid in full on 2026-10-01, a week before it was due.';
  const samples: DecisionQuestions = {
    'yes-no': {
      type: 'yes-no',
      question: 'Was the invoice paid?',
      criteria: { yes: 'Paid in full', no: 'Unpaid or partly paid' },
    },
    choice: {
      type: 'choice',
      question: 'When was it paid?',
      options: { early: 'Before it was due', late: 'After it was due' },
    },
    score: { type: 'score', question: 'How much of it was paid?', levels: ['None', 'Some', 'All'] },
    box: { type: 'box', question: 'What `photo` shows most, wherever it is' },
  };
  const picture = options.picture;
  // A box is asked about the picture, with the invoice beside it.
  const stateFor = (type: DecisionQuestionType): DecisionState =>
    type === 'box' && picture ? { invoice: state, photo: picture } : state;
  // The types that can be asked: a box only with a picture to look in.
  const askable = capabilities.types.filter((type) => type !== 'box' || picture);
  for (const type of capabilities.types) {
    if (!askable.includes(type)) {
      report.skipped.push(`a ${type} question: no picture was given to ask about`);
      continue;
    }
    await check(`a ${type} question`, async () => {
      const question = samples[type] as DecisionQuestion;
      const { answers } = await ask(stateFor(type), { asked: question });
      const answer = answers.asked as DecisionAnswer;
      if (answer.type !== type) throw new Error(`answered as a ${answer.type}`);
      if (!(answer.confidence >= 0 && answer.confidence <= 1)) throw new Error(`confidence ${answer.confidence}`);
    });
  }
  if (capabilities.images) {
    if (picture) {
      await check('a question about a picture', async () => {
        const { answers } = await ask(
          { invoice: state, photo: picture },
          { shown: { type: 'yes-no', question: 'Does `photo` show anything at all?' } },
        );
        if (answers.shown.type !== 'yes-no') throw new Error(`answered as a ${answers.shown.type}`);
      });
    } else {
      report.skipped.push('a question about a picture: no picture was given to ask about');
    }
  }
  await check('several questions in one decision', async () => {
    const questions = Object.fromEntries(askable.map((type) => [`q-${type}`, samples[type] as DecisionQuestion]));
    const { answers } = await ask(askable.includes('box') ? stateFor('box') : state, questions);
    for (const name of Object.keys(questions)) if (!answers[name]) throw new Error(`"${name}" got no answer`);
  });
  await check('a stopped decision is not answered', async () => {
    // Asked directly, as the manager refuses a stopped request before any provider sees it.
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const type = askable[0] ?? 'yes-no';
    const question = samples[type] as DecisionQuestion;
    const answered = await provider
      .decide(
        {
          model: options.model ?? capabilities.defaultModel,
          state: stateFor(type),
          questions: normalizeQuestions({ asked: question }),
        },
        { signal: controller.signal, requestId: generateRequestId() },
      )
      .then(
        () => true,
        () => false,
      );
    if (answered) throw new Error('it answered after the call was stopped');
  });
  for (const [index, item] of (options.cases ?? []).entries()) {
    await check(`case ${index + 1}`, async () => {
      const { answers } = await ask(item.state, { asked: item.question });
      const answer = answers.asked as DecisionAnswer;
      if (!answeredRight(answer, item.expected)) {
        const given =
          answer.type === 'yes-no'
            ? answer.yes
            : answer.type === 'choice'
              ? answer.choice
              : answer.type === 'box'
                ? answer.box
                : answer.level;
        throw new Error(`expected ${JSON.stringify(item.expected)}, answered ${JSON.stringify(given)}`);
      }
    });
  }
  return report;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** The questions as providers receive them, checked: each choice's options in order, with their descriptions. */
function normalizeQuestions(questions: DecisionQuestions): Record<string, DecisionProviderQuestion> {
  const names = Object.keys(questions ?? {});
  if (names.length === 0) throw new DecisionError('A decision needs at least one question', 'DECISION_INVALID');
  const normalized: Record<string, DecisionProviderQuestion> = {};
  for (const name of names) {
    const question = questions[name] as DecisionQuestion;
    if (!name.trim()) throw new DecisionError('A question needs a name', 'DECISION_INVALID');
    if (question?.type === 'yes-no') {
      normalized[name] = question;
    } else if (question?.type === 'choice') {
      const options = Array.isArray(question.options)
        ? (question.options as readonly string[]).map((option) => ({ name: option }))
        : Object.entries(question.options as Record<string, string>).map(([option, description]) => ({
            name: option,
            ...(description ? { description } : {}),
          }));
      if (options.length < 2)
        throw new DecisionError(`Choice "${name}" needs at least two options`, 'DECISION_INVALID');
      if (new Set(options.map((option) => option.name)).size !== options.length) {
        throw new DecisionError(`Choice "${name}" names an option twice`, 'DECISION_INVALID');
      }
      if (options.some((option) => !option.name.trim())) {
        throw new DecisionError(`Choice "${name}" has an option without a name`, 'DECISION_INVALID');
      }
      normalized[name] = { type: 'choice', ...(question.question ? { question: question.question } : {}), options };
    } else if (question?.type === 'score') {
      if (!Array.isArray(question.levels) || question.levels.length < 2) {
        throw new DecisionError(`Score "${name}" needs at least two levels`, 'DECISION_INVALID');
      }
      normalized[name] = question;
    } else if (question?.type === 'box') {
      if (typeof question.question !== 'string' || !question.question.trim()) {
        throw new DecisionError(
          `Box "${name}" needs a question: what to find, and in which picture`,
          'DECISION_INVALID',
        );
      }
      normalized[name] = { type: 'box', question: question.question };
    } else {
      throw new DecisionError(
        `Question "${name}" is a yes-no, a choice, a score, or a box, not ${JSON.stringify((question as { type?: unknown })?.type)}`,
        'DECISION_INVALID',
      );
    }
  }
  return normalized;
}

/** What a picture is held against a budget at, in tokens: the most one within 1,568 pixels a side costs. */
const PICTURE_TOKENS = 1_600;

/**
 * The pictures a decision's state holds, checked: each must be named by a path, and a box question
 * must have a picture to look in.
 */
function picturesOf(state: DecisionState, questions: Record<string, DecisionProviderQuestion>): DecisionPicture[] {
  const pictures = typeof state === 'string' ? [] : statePictures(state);
  if (pictures.some((picture) => picture.path === '')) {
    throw new DecisionError(
      'A picture that is the whole state has no path for a question to name it by: hold it under a key, such as { photo: picture }',
      'DECISION_INVALID',
    );
  }
  const box = Object.entries(questions).find(([, question]) => question.type === 'box');
  if (box && pictures.length === 0) {
    throw new DecisionError(
      `Box "${box[0]}" asks where something is in a picture, and the state holds none`,
      'DECISION_INVALID',
    );
  }
  return pictures;
}

/** Why a provider cannot take these questions about these pictures, or `undefined` when it can. */
function unsupported(
  provider: DecisionProvider,
  questions: Record<string, DecisionProviderQuestion>,
  pictures: readonly DecisionPicture[] = [],
): string | undefined {
  const capabilities = provider.info.capabilities;
  const count = Object.keys(questions).length;
  if (capabilities.maxQuestions !== undefined && count > capabilities.maxQuestions) {
    return `takes at most ${capabilities.maxQuestions} questions, not ${count}`;
  }
  if (pictures.length > 0 && capabilities.images !== true) {
    return `does not read pictures, and the state holds ${pictures.length}, such as \`${pictures[0]?.path}\``;
  }
  for (const [name, question] of Object.entries(questions)) {
    if (!capabilities.types.includes(question.type))
      return `does not answer ${question.type} questions, such as "${name}"`;
    if (question.type === 'choice' && question.options.length > capabilities.maxOptions) {
      return `takes at most ${capabilities.maxOptions} options, not ${question.options.length} in "${name}"`;
    }
    if (question.type === 'score' && question.levels.length > capabilities.maxLevels) {
      return `takes at most ${capabilities.maxLevels} levels, not ${question.levels.length} in "${name}"`;
    }
  }
  return undefined;
}

/**
 * Whether another provider may answer where this one failed: a decision error says, and any other
 * failure, such as a refused connection, may pass.
 */
function retryable(error: unknown): boolean {
  return error instanceof DecisionError ? error.retryable : true;
}

function probabilityOf(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DecisionError(
      `The probability of ${what} is ${String(value)}, not a number from 0 to 1`,
      'DECISION_INVALID',
    );
  }
  return value;
}

function normalize(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 1 / weights.length);
  return weights.map((weight) => weight / total);
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? -Infinity) > (values[best] ?? -Infinity)) best = index;
  }
  return best;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function numbers(usage: DecisionUsage): Record<string, number> {
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}
