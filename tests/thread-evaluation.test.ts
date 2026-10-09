/**
 * Whole conversations, evaluated: a simulated user holds a conversation with a support agent for
 * each goal in a dataset, thread evaluators score each conversation, and two versions of the agent
 * are compared over whole threads with the verdicts a single-turn comparison gives.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { LLMJudge } from '../src/evals/judge.js';
import { compareExperiments, createDataset, evaluate } from '../src/evaluate/index.js';
import {
  conversationTarget,
  formatThread,
  goalCompletion,
  goalReached,
  graphThreadAgent,
  scriptedUser,
  simulatedUser,
  type Thread,
  type ThreadInputs,
  turnCount,
  turnScores,
} from '../src/evaluate/threads.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const POLICIES: Record<string, string> = {
  refund: 'Refunds reach your card within 5 days.',
  shipping: 'Orders ship within 2 days.',
  password: 'Reset it from the sign-in page.',
  invoice: 'Invoices are under Billing, then History.',
  cancel: 'You can cancel until the order ships.',
};
const TOPICS = Object.keys(POLICIES);

const text = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');
const reply = (content: string) =>
  ({ content, role: 'assistant', finishReason: 'stop', meta: { modelUsed: 'mock' } }) as unknown as NexusResponse;

/**
 * The model that plays the user, deterministic: it opens on its topic, gives its order number when
 * asked, says it is done once an answer names the policy and its order, and gives up after three
 * replies that do not.
 */
function userModel(seen: CompletionRequest[] = []) {
  return {
    async complete(request: CompletionRequest) {
      seen.push(request);
      const system = text(request.messages[0]);
      const [, topic, order] = /Your goal: Learn the (\w+) policy for order (\d+)/.exec(system) ?? [];
      // The roles are turned around for the user's model: the assistant's turns arrive as `user`.
      const heard = request.messages.filter((message) => message.role === 'user').map(text);
      const last = heard.at(-1) ?? '';
      if (heard.length === 1 && last === 'Begin the conversation.')
        return { content: `Hi, a question about ${topic}.` };
      if (last.includes(POLICIES[topic as string] as string) && last.includes(`order ${order}`)) {
        return { content: 'DONE: GOAL' };
      }
      if (/order number/.test(last)) return { content: `It is order ${order}.` };
      if (heard.length >= 3) return { content: 'DONE: GAVE UP' };
      return { content: `That does not answer my ${topic} question.` };
    },
  };
}

/**
 * Two versions of a support agent, as `createAgent()` agents over a scripted model. Both ask for the
 * order number; version 1 knows only three of the five policies.
 */
function supportAgent(version: 1 | 2) {
  const known = version === 1 ? TOPICS.slice(0, 3) : TOPICS;
  return createAgent({
    client: {
      async complete(request: CompletionRequest) {
        const said = request.messages.filter((message) => message.role === 'user').map(text);
        const topic = TOPICS.find((name) => said.some((line) => line.includes(name)));
        const order = said.map((line) => /order (\d+)/.exec(line)?.[1]).find(Boolean);
        if (!order) return reply('Sure. What is your order number?');
        if (!topic || !known.includes(topic)) return reply('Sorry, I cannot help with that.');
        return reply(`For order ${order}: ${POLICIES[topic]}`);
      },
    },
    model: 'mock',
  });
}

/** A judge whose model passes a conversation in which the policy for the goal was given. */
function judgeModel() {
  return new LLMJudge({
    model: 'judge',
    client: {
      async complete(request: CompletionRequest) {
        const prompt = request.messages.map(text).join('\n');
        const passed = Object.values(POLICIES).some(
          (policy) => prompt.includes(`Assistant: For order`) && prompt.includes(policy),
        );
        return reply(
          JSON.stringify({ score: passed ? 1 : 0, passed, rationale: passed ? 'answered' : 'never answered' }),
        );
      },
    },
  });
}

/** Scores one assistant turn: helpful when it gives a policy or asks what it needs. */
const helpful = ({ output }: { output: unknown }) => (/Sorry/.test(String(output)) ? 0 : 1);

const goals = createDataset<ThreadInputs>({
  name: 'support-goals',
  examples: Array.from({ length: 50 }, (_, index) => {
    const topic = TOPICS[index % TOPICS.length] as string;
    return { id: `goal-${index + 1}`, inputs: { goal: `Learn the ${topic} policy for order ${1000 + index}.` } };
  }),
});

async function experiment(version: 1 | 2) {
  const target = conversationTarget(graphThreadAgent(supportAgent(version)), {
    user: simulatedUser({ client: userModel(), model: 'user-sim' }),
    maxTurns: 6,
  });
  return evaluate(target, goals, [goalReached(), goalCompletion(judgeModel()), turnCount(), turnScores(helpful)], {
    name: `support v${version}`,
    concurrency: 8,
  });
}

test('a simulated user holds 50 conversations, and two agent versions compare over whole threads', async () => {
  const [baseline, candidate] = await Promise.all([experiment(1), experiment(2)]);
  assert.equal(baseline.results.length, 50);

  const mean = (run: typeof baseline, key: string) =>
    run.results.reduce((sum, result) => sum + (result.scores.find((score) => score.key === key)?.score ?? 0), 0) /
    run.results.length;
  assert.equal(mean(baseline, 'goal_reached'), 0.6, 'version 1 meets three topics of five');
  assert.equal(mean(candidate, 'goal_reached'), 1);
  assert.equal(mean(candidate, 'goal_completion'), 1, 'the judge agrees with the user');
  assert.equal(mean(candidate, 'turns'), 2, 'one turn to ask for the order, one to answer');
  assert.ok(mean(baseline, 'turns') > 2, 'a failing conversation runs until the user gives up');

  // A failed conversation says how it ended, and which turn went wrong.
  const failed = baseline.results.find((result) => result.exampleId === 'goal-4');
  const thread = failed?.output as Thread;
  assert.equal(thread.ended, 'gave-up');
  assert.equal(thread.turns[0]?.content, 'Hi, a question about invoice.');
  const perTurn = failed?.scores.find((score) => score.key === 'turn_score');
  assert.deepEqual(perTurn?.metadata, { turns: [1, 0, 0], wentWrongAt: 2 });
  assert.match(perTurn?.comment ?? '', /turn 2 scored 0\.00/);

  const comparison = compareExperiments(baseline, candidate, { lowerIsBetter: ['turns'] });
  const verdict = (key: string) => comparison.metrics.find((metric) => metric.key === key)?.verdict;
  assert.equal(verdict('goal_reached'), 'better');
  assert.equal(verdict('goal_completion'), 'better');
  assert.equal(verdict('turns'), 'better', 'fewer turns is better');
  assert.equal(verdict('turn_score'), 'better');
  assert.equal(comparison.regressed, false);
  assert.equal(compareExperiments(candidate, baseline, { lowerIsBetter: ['turns'] }).regressed, true);
});

test('the user model sees the conversation with the roles turned around, and its goal and persona', async () => {
  const seen: CompletionRequest[] = [];
  const target = conversationTarget(() => 'Sure. What is your order number?', {
    user: simulatedUser({ client: userModel(seen), model: 'user-sim', persona: 'A terse customer.' }),
    maxTurns: 2,
  });
  const thread = (await target(
    { goal: 'Learn the refund policy for order 7.' },
    { example: { id: 'x', inputs: { goal: 'Learn the refund policy for order 7.' } }, run: 0 },
  )) as Thread;
  assert.equal(thread.ended, 'max-turns');
  assert.deepEqual(
    thread.turns.map((turn) => [turn.role, turn.content]),
    [
      ['user', 'Hi, a question about refund.'],
      ['assistant', 'Sure. What is your order number?'],
      ['user', 'It is order 7.'],
      ['assistant', 'Sure. What is your order number?'],
    ],
  );
  assert.ok(thread.turns.every((turn) => turn.role === 'user' || typeof turn.latencyMs === 'number'));
  const system = text(seen[0]?.messages[0]);
  assert.match(system, /Your goal: Learn the refund policy for order 7\./);
  assert.match(system, /A terse customer\./);
  assert.equal(seen[0]?.temperature, 0);
  assert.deepEqual(
    seen[1]?.messages.slice(1).map((message) => message.role),
    ['assistant', 'user'],
    "the user's own message is the model's, and the agent's is what it was told",
  );
});

test('a conversation ends on the opening, a script, the turn limit, or an agent error', async () => {
  const example = (goal: string) => ({ example: { id: goal, inputs: { goal } }, run: 0 });
  const echo = conversationTarget((messages) => ({ content: `heard ${messages.length}` }), {
    user: scriptedUser({ messages: ['one', 'two'], done: 'gave-up' }),
  });
  const scripted = (await echo({ goal: 'g' }, example('g'))) as Thread;
  assert.equal(scripted.ended, 'gave-up');
  assert.deepEqual(
    scripted.turns.map((turn) => turn.content),
    ['one', 'heard 1', 'two', 'heard 3'],
  );

  // An opening replaces the user's first message, and a scripted user's function decides each move.
  const opened = conversationTarget(() => 'ok', {
    user: scriptedUser(({ turns }) => (turns.length >= 2 ? { done: 'goal' } : { message: 'unused' })),
  });
  const withOpening = (await opened({ goal: 'g', opening: 'Hello there' }, example('g'))) as Thread;
  assert.deepEqual(
    withOpening.turns.map((turn) => turn.content),
    ['Hello there', 'ok'],
  );
  assert.equal(withOpening.ended, 'goal');

  const failing = conversationTarget(
    () => {
      throw new Error('model down');
    },
    { user: scriptedUser({ messages: ['hi'] }) },
  );
  const failed = (await failing({ goal: 'g' }, example('g'))) as Thread;
  assert.equal(failed.ended, 'error');
  assert.equal(failed.error, 'model down');
  const reached = await goalReached()({ example: { id: 'g', inputs: { goal: 'g' } }, output: failed } as never);
  assert.deepEqual(reached, { key: 'goal_reached', score: 0, passed: false, comment: 'ended: error (model down)' });

  // A user per example, such as one with the example's own persona.
  const personas: string[] = [];
  const perExample = conversationTarget(() => 'ok', {
    user: (inputs) => {
      personas.push(inputs.persona ?? '');
      return scriptedUser({ messages: [] });
    },
  });
  await perExample({ goal: 'g', persona: 'patient' }, example('g'));
  assert.deepEqual(personas, ['patient']);
  assert.equal(formatThread(scripted).split('\n\n')[1], 'Assistant: heard 1');
});

test('each conversation is one agent thread, and every turn of it gets the whole iteration limit', async () => {
  // Every turn looks the order up, then answers: two model calls, the agent's whole limit.
  const requests: CompletionRequest[] = [];
  const agent = createAgent({
    client: {
      async complete(request: CompletionRequest) {
        requests.push(request);
        if (request.messages.at(-1)?.role === 'user') {
          return {
            ...reply(''),
            toolCalls: [{ id: `c${requests.length}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          } as NexusResponse;
        }
        return reply(`answer ${request.messages.filter((message) => message.role === 'user').length}`);
      },
    },
    model: 'mock',
    maxIterations: 2,
    tools: [
      tool({
        name: 'lookup',
        description: 'Looks up the order',
        parameters: { type: 'object' },
        execute: async () => 'found',
      }),
    ],
  });
  const target = conversationTarget(graphThreadAgent(agent), {
    user: scriptedUser({ messages: ['one', 'two', 'three', 'four', 'five'] }),
  });
  const thread = (await target({ goal: 'g' }, { example: { id: 'g', inputs: { goal: 'g' } }, run: 0 })) as Thread;
  assert.deepEqual(
    thread.turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content),
    ['answer 1', 'answer 2', 'answer 3', 'answer 4', 'answer 5'],
    'a thread past the limit in total still answers every turn',
  );
  // The agent kept its own transcript: the fifth turn's last call saw every earlier tool call and result.
  const last = requests.at(-1)?.messages ?? [];
  assert.equal(last.filter((message) => message.role === 'tool').length, 5);
  assert.equal(last.filter((message) => message.role === 'user').length, 5);
  // Each assistant turn records its trajectory: the tool call, the result, and the answer.
  assert.deepEqual(
    thread.turns[1]?.messages?.map((message) => message.role),
    ['assistant', 'tool', 'assistant'],
  );
  assert.equal(thread.turns[1]?.messages?.[0]?.toolCalls?.[0]?.function.name, 'lookup');

  // Without a checkpointer, the agent is given the same transcript.
  const stateless = conversationTarget(
    graphThreadAgent(
      createAgent({
        client: {
          async complete(request: CompletionRequest) {
            return reply(`heard ${request.messages.length} messages`);
          },
        },
        model: 'mock',
        checkpointer: false,
      }),
    ),
    { user: scriptedUser({ messages: ['one', 'two'] }) },
  );
  const again = (await stateless({ goal: 'g' }, { example: { id: 'g', inputs: { goal: 'g' } }, run: 0 })) as Thread;
  assert.deepEqual(
    again.turns.map((turn) => turn.content),
    ['one', 'heard 1 messages', 'two', 'heard 3 messages'],
  );
});

test('thread evaluators score an output that is not a conversation as zero, without throwing', async () => {
  const context = { example: { id: 'x', inputs: { goal: 'g' } }, output: 'just text' } as never;
  assert.deepEqual(await goalReached()(context), {
    key: 'goal_reached',
    score: 0,
    passed: false,
    comment: 'no conversation',
  });
  assert.deepEqual(await goalCompletion(judgeModel())(context), {
    key: 'goal_completion',
    score: 0,
    passed: false,
    comment: 'no conversation',
  });
  assert.deepEqual(await turnCount()(context), { key: 'turns', score: 0 });
  assert.deepEqual(await turnScores(helpful, { key: 'helpfulness' })(context), {
    key: 'helpfulness',
    score: 0,
    metadata: { turns: [] },
  });
});
