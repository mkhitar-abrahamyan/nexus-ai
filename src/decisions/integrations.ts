/**
 * Decisions where the package already decides: a graph's branch, an agent's approval, a guardrail, a
 * model's choice, a judge's score, and an evaluation sent to people. A confident answer acts, and an
 * uncertain one goes to a person.
 */
import type { AgentMiddleware } from '../agent/create-agent.js';
import type { PermissionPolicyLike, PermissionRequest, PermissionVerdict } from '../agent/permissions.js';
import type { EvaluationContext, EvaluationScore, Evaluator } from '../types/evaluate.js';
import type { Message } from '../types/messages.js';
import {
  type BoxQuestion,
  boxOverlap,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionBox,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  type DecisionState,
  type ScoreQuestion,
  type YesNoAnswer,
  type YesNoQuestion,
} from './core.js';

/** Anything that answers decisions, such as a `DecisionManager`. */
export interface DecisionManagerLike {
  /** Answers every question of a decision. */
  decide<const Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>>;
}

/** The parts of a decision request an integration takes from the application: whom and what to ask. */
export type DecisionRequestOptions = Partial<Pick<DecisionRequest, 'provider' | 'model' | 'tenantId' | 'metadata'>>;

// ── A graph's branch ────────────────────────────────────────────────

/** Options for `decisionRoute()`. */
export interface DecisionRouteOptions<S> {
  /** What the question is about, read from the graph's state. */
  state: (graph: S) => DecisionState;
  /** A choice whose options name the nodes to go to, or a yes or no; `routes` maps them otherwise. */
  question: ChoiceQuestion | YesNoQuestion;
  /** Where each answer goes, by option, or by `yes` and `no`, when they are not node names. */
  routes?: Readonly<Record<string, string>>;
  /** At or above this confidence, the answer routes; below it, the run goes to `review`. */
  act: number;
  /** The node an uncertain answer goes to, such as one that asks a person with `interrupt()`. */
  review: string;
  /** Whom and what to ask, from the graph's state, such as its tenant. */
  request?: (graph: S) => DecisionRequestOptions;
  /** Hears each answer and the node it chose, such as to record it. */
  onAnswer?: (answer: ChoiceAnswer | YesNoAnswer, node: string) => void;
}

/**
 * A graph router that asks a decision, for `addConditionalEdges()`: a confident answer goes to its
 * node, and an uncertain one to `review`, where a person can answer instead.
 *
 * ```ts
 * graph.addConditionalEdges('triage', decisionRoute(decisions, {
 *   state: (s) => s.ticket,
 *   question: { type: 'choice', options: { billing: 'Charges', technical: 'Errors' } },
 *   act: 0.8,
 *   review: 'ask-a-person',
 * }));
 * ```
 */
export function decisionRoute<S>(
  decisions: DecisionManagerLike,
  options: DecisionRouteOptions<S>,
): (graph: S) => Promise<string> {
  return async (graph) => {
    const { answers } = await decisions.decide({
      ...options.request?.(graph),
      state: options.state(graph),
      questions: { route: options.question as DecisionQuestion },
    });
    const answer = answers.route as ChoiceAnswer | YesNoAnswer;
    const picked = answer.type === 'choice' ? answer.choice : answer.yes ? 'yes' : 'no';
    const node = answer.confidence >= options.act ? (options.routes?.[picked] ?? picked) : options.review;
    options.onAnswer?.(answer, node);
    return node;
  };
}

// ── An agent's approvals ────────────────────────────────────────────

/** Options for `decisionPermissions()`. */
export interface DecisionPermissionsOptions {
  /**
   * The policy that decides first: what it allows or refuses stands, and only the calls it would ask a
   * person about are asked as a decision. Without one, every call is.
   */
  base?: PermissionPolicyLike;
  /** The question asked of a call: yes runs it. Defaults to whether it is safe to run without a person checking. */
  question?: YesNoQuestion;
  /** What the question is about. Defaults to the tool, its arguments, and what it declares. */
  state?: (request: PermissionRequest) => DecisionState;
  /** A yes this sure runs the call, and a no this sure refuses it; anything less asks a person. */
  act: number;
  /** Whom and what to ask. Defaults to the principal's tenant. */
  request?: (request: PermissionRequest) => DecisionRequestOptions;
}

/**
 * A permission policy that asks a decision where a person would otherwise be asked: a confident yes
 * runs the call, a confident no refuses it, and anything less still asks the person.
 */
export function decisionPermissions(
  decisions: DecisionManagerLike,
  options: DecisionPermissionsOptions,
): PermissionPolicyLike {
  const question: YesNoQuestion = options.question ?? {
    type: 'yes-no',
    question: 'Is this tool call safe to run without a person checking it first?',
    criteria: { yes: 'It does what the tool is for, on what it names', no: 'It could cause harm, loss, or a leak' },
  };
  return {
    async decide(request: PermissionRequest): Promise<PermissionVerdict> {
      const base = await options.base?.decide(request);
      if (base && base.decision !== 'ask') return base;
      const tenantId = request.principal?.tenantId;
      const { answers } = await decisions.decide({
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...options.request?.(request),
        state: options.state?.(request) ?? {
          tool: request.tool,
          arguments: request.args,
          ...(request.capabilities ? { capabilities: request.capabilities } : {}),
        },
        questions: { safe: question },
      });
      const answer = answers.safe as YesNoAnswer;
      const odds = `yes at ${answer.probability.toFixed(2)}`;
      if (answer.confidence >= options.act) {
        return answer.yes
          ? { decision: 'allow', reason: `A decision allowed it: ${odds}` }
          : { decision: 'deny', reason: `A decision refused it: ${odds}` };
      }
      return {
        decision: 'ask',
        reason: `A decision was unsure, ${odds}; a person decides${base ? `. ${base.reason}` : ''}`,
      };
    },
  };
}

// ── An agent's guardrail ────────────────────────────────────────────

/** What a person answers when a guard is unsure: let it pass, or not. */
export interface DecisionGuardReview {
  /** True lets the message, or the answer, go on. */
  allow: boolean;
}

/** Options for `decisionGuard()`. */
export interface DecisionGuardOptions {
  /** Asked of each new message from the user, before the model sees it: a yes stops the run. */
  input?: YesNoQuestion;
  /** Asked of each answer, before it is given: a yes withholds it. */
  output?: YesNoQuestion;
  /** A yes this sure stops, and a no this sure passes; anything between asks a person. */
  act: number;
  /** What the agent answers in place of what the guard stopped. Defaults to "I can't help with that." */
  refusal?: string;
  /** Whom and what to ask. Defaults to the run's tenant. */
  request?: DecisionRequestOptions;
  /** Hears each verdict, without the text it judged. */
  onVerdict?: (verdict: {
    where: 'input' | 'output';
    outcome: 'passed' | 'stopped' | 'reviewed';
    probability: number;
  }) => void;
}

/**
 * Agent middleware that guards each message and answer with a yes-or-no decision, such as whether a
 * message is a prompt injection or an answer leaks what it must not. A confident yes stops it, a
 * confident no passes it, and in between the run asks a person, who answers a `DecisionGuardReview`.
 */
export function decisionGuard(decisions: DecisionManagerLike, options: DecisionGuardOptions): AgentMiddleware {
  const refusal = options.refusal ?? "I can't help with that.";
  const judge = async (
    where: 'input' | 'output',
    question: YesNoQuestion,
    text: string,
    context: {
      tenantId?: string;
      signal: AbortSignal;
      interrupt<T>(request: { reason: string; payload?: unknown }): T;
    },
  ): Promise<boolean> => {
    const { answers } = await decisions.decide({
      ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
      ...options.request,
      state: text,
      questions: { flagged: question },
      signal: context.signal,
    });
    const answer = answers.flagged as YesNoAnswer;
    if (answer.confidence >= options.act) {
      options.onVerdict?.({ where, outcome: answer.yes ? 'stopped' : 'passed', probability: answer.probability });
      return !answer.yes;
    }
    options.onVerdict?.({ where, outcome: 'reviewed', probability: answer.probability });
    const review = context.interrupt<DecisionGuardReview>({
      reason: `The guard is unsure whether this ${where === 'input' ? 'message' : 'answer'} may go on`,
      payload: { where, text, question: question.question, probability: answer.probability },
    });
    return review?.allow === true;
  };
  return {
    name: 'decision-guard',
    async wrapModelCall(request, next, context) {
      const last = request.messages.at(-1);
      if (options.input && last?.role === 'user' && !(await judge('input', options.input, textOf(last), context))) {
        return context.stop(refusal);
      }
      const response = await next(request);
      if (options.output && response.content.trim() && !response.toolCalls?.length) {
        if (!(await judge('output', options.output, response.content, context)))
          return { ...response, content: refusal };
      }
      return response;
    },
  };
}

// ── An agent's model ────────────────────────────────────────────────

/** Options for `decisionModel()`. */
export interface DecisionModelOptions<K extends string = string> {
  /** A choice among kinds of request, asked of each new message from the user. */
  question: ChoiceQuestion<K>;
  /** The model each kind goes to. */
  models: Readonly<Record<K, string>>;
  /** At or above this confidence the request goes to its kind's model; below, it keeps its own. */
  act: number;
  /** Whom and what to ask. Defaults to the run's tenant. */
  request?: DecisionRequestOptions;
}

/**
 * Agent middleware that sends each turn to a model by a decision about the user's message: a quick
 * question to a fast model, a hard one to a strong one. Every model call of the turn goes to the model
 * its message chose, and an uncertain answer keeps the agent's own model.
 */
export function decisionModel<const K extends string>(
  decisions: DecisionManagerLike,
  options: DecisionModelOptions<K>,
): AgentMiddleware {
  // What each message chose, so the calls after its tools go to the same model.
  const chosen = new Map<string, string | null>();
  return {
    name: 'decision-model',
    async beforeModel(context) {
      const message = [...context.request.messages].reverse().find((item) => item.role === 'user');
      if (!message) return;
      const text = textOf(message);
      const key = `${context.threadId}\u0000${text}`;
      if (!chosen.has(key)) {
        const { answers } = await decisions.decide({
          ...(context.tenantId !== undefined ? { tenantId: context.tenantId } : {}),
          ...options.request,
          state: text,
          questions: { kind: options.question as DecisionQuestion },
          signal: context.signal,
        });
        const answer = answers.kind as ChoiceAnswer;
        chosen.set(key, answer.confidence >= options.act ? (options.models[answer.choice as K] ?? null) : null);
        if (chosen.size > 1_000) chosen.delete(chosen.keys().next().value as string);
      }
      const model = chosen.get(key);
      return model ? { ...context.request, model } : undefined;
    },
  };
}

// ── A judge's score ─────────────────────────────────────────────────

/** Options for `decisionEvaluator()`. */
export interface DecisionEvaluatorOptions<I = unknown, O = unknown> {
  /** The score's key. */
  key: string;
  /** The question: a yes or no, a score, a choice, or a box about a picture the state holds. */
  question: YesNoQuestion | ScoreQuestion | ChoiceQuestion | BoxQuestion;
  /** What the question is about. Defaults to the example's inputs, the output, and what was expected. */
  state?: (context: EvaluationContext<I, O>) => DecisionState;
  /**
   * What passes: for a yes or no, `true` (the default) or `false`; for a score, the lowest level that
   * passes (the top one by default); for a choice, the option that does.
   */
  passing?: boolean | number | string;
  /**
   * For a box, where the thing is, such as from the example's expected output: the score is how far
   * the box overlaps it, `boxOverlap()`, and it passes at `overlap` or more. Without it, the score is
   * the box's confidence.
   */
  where?: (context: EvaluationContext<I, O>) => DecisionBox | undefined;
  /** The overlap a box passes at, from 0 to 1. Defaults to one half. */
  overlap?: number;
  /** Whom and what to ask. */
  request?: DecisionRequestOptions;
}

/**
 * An evaluator that asks a decision: the score is the probability of yes, the score's level as a
 * share of the top one, the passing option's probability, or how far a box overlaps where the thing
 * is, and its metadata carries the answer's confidence and probabilities, or its box, so an uncertain
 * score can go to people with `reviewUnsure()`.
 */
export function decisionEvaluator<I = unknown, O = unknown>(
  decisions: DecisionManagerLike,
  options: DecisionEvaluatorOptions<I, O>,
): Evaluator<I, O> {
  return async (context) => {
    const { answers, model } = await decisions.decide({
      ...options.request,
      state: options.state?.(context) ?? {
        inputs: context.example.inputs,
        output: context.output,
        ...(context.example.expected !== undefined ? { expected: context.example.expected } : {}),
      },
      questions: { judged: options.question as DecisionQuestion },
    });
    const answer = answers.judged as DecisionAnswer;
    const metadata = {
      confidence: answer.confidence,
      ...(answer.type === 'box'
        ? { box: answer.box }
        : { probabilities: answer.type === 'yes-no' ? { yes: answer.probability } : answer.probabilities }),
      model,
    };
    if (answer.type === 'box') {
      const where = options.where?.(context);
      if (!where) return { key: options.key, score: answer.confidence, metadata } satisfies EvaluationScore;
      const overlap = boxOverlap(answer.box, where);
      return {
        key: options.key,
        score: overlap,
        passed: overlap >= (options.overlap ?? 0.5),
        metadata,
      } satisfies EvaluationScore;
    }
    if (answer.type === 'yes-no') {
      const passWhen = options.passing !== false;
      return {
        key: options.key,
        score: answer.probability,
        passed: answer.yes === passWhen,
        metadata,
      } satisfies EvaluationScore;
    }
    if (answer.type === 'score') {
      const top = answer.probabilities.length - 1;
      const passing = typeof options.passing === 'number' ? options.passing : top;
      return { key: options.key, score: top > 0 ? answer.score / top : 1, passed: answer.level >= passing, metadata };
    }
    const passing = typeof options.passing === 'string' ? options.passing : undefined;
    return {
      key: options.key,
      score: passing !== undefined ? (answer.probabilities[passing] ?? 0) : answer.confidence,
      ...(passing !== undefined ? { passed: answer.choice === passing } : {}),
      comment: answer.choice,
      metadata,
    };
  };
}

/**
 * A `reviewWhen` for online evaluation that sends a run to people when any of its decision scores,
 * or the one `key` names, is less sure than `threshold`.
 */
export function reviewUnsure(threshold: number, key?: string): (scores: EvaluationScore[]) => boolean {
  return (scores) =>
    scores.some(
      (score) =>
        (key === undefined || score.key === key) &&
        typeof score.metadata?.confidence === 'number' &&
        score.metadata.confidence < threshold,
    );
}

/** A message's text, its parts joined. */
function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}
