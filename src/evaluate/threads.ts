/**
 * Evaluation of whole conversations. A simulated user holds a conversation with an agent for each
 * goal in a dataset, and thread evaluators score the conversation: whether the goal was met, each
 * turn, and the turn where it went wrong. A multi-turn agent is then compared between versions as a
 * single-turn one is, with `evaluate()` and `compareExperiments()`.
 */
import type { LLMJudge } from '../evals/judge.js';
import type { DatasetExample, EvaluationContext, EvaluationScore, Evaluator } from '../types/evaluate.js';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { EvaluationTarget } from './run.js';

/** One turn of a conversation. */
export interface ThreadTurn {
  /** Who spoke. */
  role: 'user' | 'assistant';
  /** What they said. */
  content: string;
  /** For an assistant turn, how long the agent took, in milliseconds. */
  latencyMs?: number;
  /**
   * For an assistant turn, every message the agent added: its tool calls, their results, and the
   * answer. The agent is given them back on later turns, and an evaluator can read its trajectory.
   */
  messages?: Message[];
}

/** Why a conversation ended. */
export type ThreadEnding = 'goal' | 'gave-up' | 'max-turns' | 'error';

/** A finished conversation: what a conversation target returns, and what thread evaluators read. */
export interface Thread {
  /** Every turn, in order. */
  turns: ThreadTurn[];
  /**
   * `goal` when the user said its goal was met, `gave-up` when it said it never would be, `max-turns`
   * when the turn limit ended it, and `error` when the agent failed.
   */
  ended: ThreadEnding;
  /** The agent's error, when it failed. */
  error?: string;
}

/** What a conversation is about: the user's goal, and optionally who they are and how they open. */
export interface ThreadInputs {
  /** What the user wants, in their words or the dataset's. */
  goal: string;
  /** Who the user is and how they talk, such as "an impatient customer who writes in short lines". */
  persona?: string;
  /** The user's first message, instead of letting the simulated user write it. */
  opening?: string;
}

/** What a simulated user sees when it writes its next message. */
export interface SimulatedUserContext {
  /** The goal. */
  goal: string;
  /** The persona, when the example gives one. */
  persona?: string;
  /** The conversation so far. Empty for the first message. */
  turns: readonly ThreadTurn[];
  /** Aborted when the evaluation is cancelled or times out. */
  signal?: AbortSignal;
}

/** A simulated user's move: its next message, or the end of the conversation and why. */
export type SimulatedUserReply = { message: string } | { done: 'goal' | 'gave-up' };

/** Plays the user in a conversation. */
export interface SimulatedUser {
  /** The next move, given the conversation so far. */
  next(context: SimulatedUserContext): Promise<SimulatedUserReply> | SimulatedUserReply;
}

/** A model client, as the judges take one. */
export interface SimulatedUserClient {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<{ content: string }>;
}

/** Options for `simulatedUser()`. */
export interface SimulatedUserOptions {
  /** The client the user's model is called through. */
  client: SimulatedUserClient;
  /** The model that plays the user. */
  model: string;
  /** A persona for every conversation, when the examples give none. */
  persona?: string;
  /** Sampling temperature. Defaults to 0, so a conversation repeats. */
  temperature?: number;
  /** Output token limit for each message. Defaults to 300. */
  maxTokens?: number;
  /** Replaces the instructions the model is given. `{goal}` and `{persona}` are filled in. */
  instructions?: string;
}

const USER_INSTRUCTIONS = `You are playing a user who is talking to an assistant. Stay in character.
Your goal: {goal}
{persona}
Write only your next message to the assistant, as the user would. Give details the assistant asks for when your goal needs them.
When the assistant has fully achieved your goal, reply with exactly: DONE: GOAL
When you are sure the assistant will never achieve it, reply with exactly: DONE: GAVE UP`;

const DONE = /^\s*DONE:\s*(GOAL|GAVE[\s-]*UP)\b/i;

/**
 * A simulated user driven by a model: it is told the goal and the persona, sees the conversation
 * with the roles turned around, and writes the next message, or says it is done and why.
 */
export function simulatedUser(options: SimulatedUserOptions): SimulatedUser {
  return {
    async next(context) {
      const instructions = (options.instructions ?? USER_INSTRUCTIONS)
        .replace('{goal}', context.goal)
        .replace('{persona}', context.persona ?? options.persona ?? '');
      // From the simulator's side, the assistant's turns are what it was told, and its own are its replies.
      const messages: Message[] = [
        { role: 'system', content: instructions },
        ...context.turns.map(
          (turn): Message => ({
            role: turn.role === 'assistant' ? 'user' : 'assistant',
            content: turn.content,
          }),
        ),
      ];
      if (context.turns.length === 0) messages.push({ role: 'user', content: 'Begin the conversation.' });
      const response = await options.client.complete({
        model: options.model,
        messages,
        temperature: options.temperature ?? 0,
        maxTokens: options.maxTokens ?? 300,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const done = DONE.exec(response.content ?? '');
      if (done) return { done: /^GOAL$/i.test(done[1] as string) ? 'goal' : 'gave-up' };
      return { message: (response.content ?? '').trim() };
    },
  };
}

/**
 * A user that follows a script, for deterministic tests: its messages in order, then `done`. A
 * function decides each move itself.
 */
export function scriptedUser(
  script: { messages: readonly string[]; done?: 'goal' | 'gave-up' } | SimulatedUser['next'],
): SimulatedUser {
  if (typeof script === 'function') return { next: script };
  return {
    next: ({ turns }) => {
      const said = turns.filter((turn) => turn.role === 'user').length;
      const message = script.messages[said];
      return message === undefined ? { done: script.done ?? 'goal' } : { message };
    },
  };
}

/** What a thread agent is told besides the conversation. */
export interface ThreadAgentContext<I extends ThreadInputs = ThreadInputs> {
  /** The example's inputs. */
  inputs: I;
  /** The turn, counted from 1. */
  turn: number;
  /** Names this conversation, the same on every turn and new for every conversation: a thread id. */
  conversationId: string;
  /** Aborted when the evaluation is cancelled or times out. */
  signal?: AbortSignal;
}

/**
 * What a thread agent answers: the reply, or the reply and every message the agent added on the way,
 * such as its tool calls and their results. Those are given back to it on later turns.
 */
export type ThreadAgentReply = string | { content: string; messages?: Message[] };

/**
 * The agent a conversation target talks to. It is given the conversation so far, with its own earlier
 * turns as it recorded them, and answers the user's newest message.
 */
export type ThreadAgent<I extends ThreadInputs = ThreadInputs> = (
  messages: readonly Message[],
  context: ThreadAgentContext<I>,
) => Promise<ThreadAgentReply> | ThreadAgentReply;

/** Options for `conversationTarget()`. */
export interface ConversationTargetOptions<I extends ThreadInputs = ThreadInputs> {
  /** The user, or a user per example, such as one with the example's own persona. */
  user: SimulatedUser | ((inputs: I) => SimulatedUser);
  /** The most user messages a conversation may have. Defaults to 10. */
  maxTurns?: number;
}

/**
 * An `evaluate()` target that holds a conversation per example: the simulated user speaks, the agent
 * answers, until the user says it is done or the turn limit is reached. It returns the `Thread`.
 */
export function conversationTarget<I extends ThreadInputs = ThreadInputs>(
  agent: ThreadAgent<I>,
  options: ConversationTargetOptions<I>,
): EvaluationTarget<I> {
  const maxTurns = options.maxTurns ?? 10;
  return async (inputs, context) => {
    const user = typeof options.user === 'function' ? options.user(inputs) : options.user;
    const turns: ThreadTurn[] = [];
    // New for every conversation, so a re-run never continues an earlier run's thread.
    const conversationId = `${context.example.id}:${context.run}:${globalThis.crypto.randomUUID()}`;
    const ask = async (): Promise<SimulatedUserReply> =>
      user.next({
        goal: inputs.goal,
        ...(inputs.persona === undefined ? {} : { persona: inputs.persona }),
        turns,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    let move: SimulatedUserReply = inputs.opening === undefined ? await ask() : { message: inputs.opening };
    for (let turn = 1; ; turn += 1) {
      if ('done' in move) return { turns, ended: move.done } satisfies Thread;
      if (turn > maxTurns) return { turns, ended: 'max-turns' } satisfies Thread;
      turns.push({ role: 'user', content: move.message });
      const started = performance.now();
      try {
        const reply = await agent(transcriptOf(turns), {
          inputs,
          turn,
          conversationId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const latencyMs = Math.round(performance.now() - started);
        turns.push(
          typeof reply === 'string'
            ? { role: 'assistant', content: reply, latencyMs }
            : {
                role: 'assistant',
                content: reply.content,
                latencyMs,
                ...(reply.messages ? { messages: reply.messages } : {}),
              },
        );
      } catch (error) {
        return {
          turns,
          ended: 'error',
          error: error instanceof Error ? error.message : String(error),
        } satisfies Thread;
      }
      move = await ask();
    }
  };
}

/** The conversation as the agent recorded it: each of its turns as the messages it added. */
function transcriptOf(turns: readonly ThreadTurn[]): Message[] {
  return turns.flatMap((turn): Message[] =>
    turn.role === 'assistant' && turn.messages?.length ? turn.messages : [{ role: turn.role, content: turn.content }],
  );
}

/** A graph a thread agent can drive: one that takes `{ messages }`, as `createAgent()` builds. */
export interface ThreadGraph {
  /** Runs one turn. */
  invoke(
    input: { messages: Message[] },
    options?: { threadId?: string; signal?: AbortSignal },
  ): Promise<{ state: unknown }>;
}

/**
 * An agent from `createAgent()`, or any graph that takes `{ messages }` and ends with an `answer`, as
 * a thread agent. Each turn runs on the conversation's thread with the transcript so far, and the
 * messages the run added to its `messages` are recorded with the turn. The agent therefore sees its
 * own tool calls on later turns, as it does with a real user, without needing a checkpointer.
 */
export function graphThreadAgent(graph: ThreadGraph): ThreadAgent {
  return async (messages, context) => {
    const result = await graph.invoke(
      { messages: [...messages] },
      { threadId: context.conversationId, ...(context.signal ? { signal: context.signal } : {}) },
    );
    const state = result.state as { answer?: unknown; messages?: unknown } | null;
    const content = typeof state?.answer === 'string' ? state.answer : JSON.stringify(result.state);
    const after = Array.isArray(state?.messages) ? (state.messages as Message[]) : undefined;
    return after && after.length > messages.length ? { content, messages: after.slice(messages.length) } : content;
  };
}

function threadOf(context: EvaluationContext): Thread | undefined {
  const output = context.output as Thread | undefined;
  return output && Array.isArray(output.turns) ? output : undefined;
}

/** The conversation as text, for a judge or a person. */
export function formatThread(thread: Thread): string {
  return thread.turns.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`).join('\n\n');
}

/**
 * Whether the user said its goal was met: 1 when the conversation ended on `goal`, otherwise 0, with
 * how it ended as the comment. Key `goal_reached`.
 */
export function goalReached(): Evaluator<ThreadInputs> {
  return (context) => {
    const thread = threadOf(context);
    const reached = thread?.ended === 'goal';
    return {
      key: 'goal_reached',
      score: reached ? 1 : 0,
      passed: reached,
      comment: thread ? `ended: ${thread.ended}${thread.error ? ` (${thread.error})` : ''}` : 'no conversation',
    };
  };
}

/**
 * Whether the goal was met, in a judge's opinion of the whole conversation, not the user's. Key
 * `goal_completion`, with the judge's rationale as the comment.
 */
export function goalCompletion(judge: Pick<LLMJudge, 'evaluate'>): Evaluator<ThreadInputs> {
  return async (context) => {
    const thread = threadOf(context);
    if (!thread) return { key: 'goal_completion', score: 0, passed: false, comment: 'no conversation' };
    const verdict = await judge.evaluate({
      actual: formatThread(thread),
      query: context.example.inputs.goal,
      rubric:
        "The text is a conversation between a user and an assistant. Score whether the assistant achieved the user's goal, given as the question, by the end of the conversation.",
    });
    return {
      key: 'goal_completion',
      score: verdict.score,
      passed: verdict.passed,
      ...(verdict.rationale ? { comment: verdict.rationale } : {}),
    };
  };
}

/** How many times the assistant spoke: fewer is better. Key `turns`; compare with `lowerIsBetter: ['turns']`. */
export function turnCount(): Evaluator<ThreadInputs> {
  return (context) => ({
    key: 'turns',
    score: threadOf(context)?.turns.filter((turn) => turn.role === 'assistant').length ?? 0,
  });
}

/** Options for `turnScores()`. */
export interface TurnScoresOptions {
  /** The score's key. Defaults to `turn_score`. */
  key?: string;
  /** A turn scoring below this went wrong. Defaults to 0.5. */
  threshold?: number;
}

/**
 * Scores every assistant turn with an evaluator of single answers, and the conversation by their
 * mean. The evaluator sees each turn as an example of its own: the user's message as the input, the
 * conversation before it in `metadata.history`, and the turn as the output. The score's metadata holds
 * each turn's score, and `wentWrongAt`, the first turn below the threshold, counted from 1.
 */
export function turnScores<I = unknown>(
  evaluator: Evaluator<I>,
  options: TurnScoresOptions = {},
): Evaluator<ThreadInputs> {
  const key = options.key ?? 'turn_score';
  const threshold = options.threshold ?? 0.5;
  return async (context) => {
    const thread = threadOf(context);
    const scores: number[] = [];
    for (const [index, turn] of (thread?.turns ?? []).entries()) {
      if (turn.role !== 'assistant') continue;
      const history = (thread as Thread).turns.slice(0, index);
      const question = [...history].reverse().find((item) => item.role === 'user')?.content ?? '';
      const example: DatasetExample<I> = {
        ...(context.example as unknown as DatasetExample<I>),
        id: `${context.example.id}#${scores.length + 1}`,
        inputs: question as unknown as I,
        metadata: { ...context.example.metadata, history, goal: context.example.inputs.goal },
      };
      scores.push(numeric(await evaluator({ ...context, example, output: turn.content } as EvaluationContext<I>)));
    }
    const mean = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const wrong = scores.findIndex((score) => score < threshold);
    return {
      key,
      score: mean,
      metadata: { turns: scores, ...(wrong === -1 ? {} : { wentWrongAt: wrong + 1 }) },
      ...(wrong === -1 ? {} : { comment: `turn ${wrong + 1} scored ${(scores[wrong] as number).toFixed(2)}` }),
    } satisfies EvaluationScore;
  };
}

function numeric(result: Awaited<ReturnType<Evaluator>>): number {
  if (typeof result === 'number') return result;
  if (typeof result === 'boolean') return result ? 1 : 0;
  const first = Array.isArray(result) ? result[0] : result;
  return first?.score ?? 0;
}
