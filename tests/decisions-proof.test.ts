/**
 * The proofs of typed decisions:
 * - one decision suite passes on TypeSafe AI's API, against a stand-in written from its documentation,
 *   on a model's log probabilities, and on sampling;
 * - on labelled examples, the threshold a calibration chooses holds the accuracy it was chosen for on
 *   examples it never saw, where a threshold taken on trust does not;
 * - a support graph routes tickets by decision, and every ticket it is unsure of reaches a person.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answeredRight,
  calibrate,
  completionDecisions,
  type DecisionConformanceCase,
  DecisionManager,
  decisionRoute,
  gate,
  runDecisionConformance,
  type YesNoAnswer,
} from '../src/decisions/index.js';
import { TypeSafeDecisionProvider } from '../src/decisions/typesafe.js';
import { lastValue } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { createGraph } from '../src/graph/graph.js';
import type { CompletionRequest } from '../src/types/messages.js';
import { END } from '../src/types/graph.js';
import type { NexusResponse, TokenLogprob } from '../src/types/response.js';
import { type Judged, typesafeStandIn, type WireQuestion } from './typesafe.js';

/** How a reader of these tickets judges them: the same reading, whichever backend serves it. */
function reads(state: unknown, kind: 'yes-no' | 'choice' | 'score'): number | Record<string, number> | number[] {
  const text = String(typeof state === 'string' ? state : JSON.stringify(state));
  const paid = /paid in full/.test(text);
  const charged = /charged twice|refund/.test(text);
  if (kind === 'yes-no') return paid || charged ? 0.95 : 0.05;
  if (kind === 'choice') return /before it was due|charged twice/.test(text) ? [0.9, 0.1] : [0.1, 0.9];
  return paid ? [0.02, 0.08, 0.9] : [0.9, 0.08, 0.02];
}

/** A completion client whose model reads as `reads` does, by log probabilities or by sampling. */
function readingModel(by: 'logprobs' | 'sampling') {
  let sample = 0;
  return {
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      request.signal?.throwIfAborted();
      const prompt = String(request.messages[1]?.content);
      const state = prompt.slice(prompt.indexOf('State:\n') + 7, prompt.indexOf('\n\nQuestion:'));
      const codes = (/Answer with one code: (.*)\./.exec(prompt)?.[1] ?? '').split(', ');
      const kind = codes[0] === 'Y' ? 'yes-no' : codes[0] === '0' ? 'score' : 'choice';
      const judged = reads(state, kind);
      const weights = typeof judged === 'number' ? [judged, 1 - judged] : (judged as number[]);
      const meta = {} as NexusResponse['meta'];
      if (by === 'logprobs' && request.logprobs) {
        const logprobs: TokenLogprob[] = [
          {
            token: codes[0] as string,
            logprob: Math.log(weights[0] ?? 0),
            top: codes.map((code, index) => ({ token: code, logprob: Math.log(weights[index] || 1e-9) })),
          },
        ];
        return { content: codes[0] as string, role: 'assistant', finishReason: 'stop', logprobs, meta };
      }
      // Sampled: the most likely code nine times in ten, deterministically.
      sample += 1;
      const top = weights.indexOf(Math.max(...weights));
      return {
        content: (sample % 10 === 0 ? codes[(top + 1) % codes.length] : codes[top]) as string,
        role: 'assistant',
        finishReason: 'stop',
        meta,
      };
    },
  };
}

const ticketCases: DecisionConformanceCase[] = [
  {
    state: 'The invoice was paid in full.',
    question: { type: 'yes-no', question: 'Was the invoice paid?' },
    expected: true,
  },
  { state: 'The invoice is open.', question: { type: 'yes-no', question: 'Was the invoice paid?' }, expected: false },
  {
    state: 'My card was charged twice.',
    question: { type: 'choice', options: ['billing', 'technical'] },
    expected: 'billing',
  },
  {
    state: 'The app crashes on start.',
    question: { type: 'choice', options: ['billing', 'technical'] },
    expected: 'technical',
  },
  { state: 'The invoice was paid in full.', question: { type: 'score', levels: ['None', 'Some', 'All'] }, expected: 2 },
];

test('proof: one decision suite passes on TypeSafe AI’s API, on a model’s log probabilities, and on sampling', async () => {
  const api = typesafeStandIn({
    judge: (state, _name, question: WireQuestion): Judged => {
      const kind = question.type === 'noul' ? 'yes-no' : (question.type as 'choice' | 'score');
      const judged = reads(state, kind);
      if (kind !== 'choice') return judged;
      const names = Object.keys(question.criteria as Record<string, unknown>);
      return Object.fromEntries(names.map((name, index) => [name, (judged as number[])[index] ?? 0]));
    },
  });
  const backends = [
    new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }),
    completionDecisions(readingModel('logprobs'), { model: 'reader', name: 'logprobs', method: 'logprobs' }),
    completionDecisions(readingModel('sampling'), {
      model: 'reader',
      name: 'sampling',
      method: 'sampling',
      samples: 10,
    }),
  ];
  for (const backend of backends) {
    const report = await runDecisionConformance(backend, { cases: ticketCases });
    assert.deepEqual(report.failures, [], backend.info.name);
    assert.equal(report.passed.length, 6 + ticketCases.length, `${backend.info.name}: every check`);
  }
});

/** A seeded generator, so the examples are the same on every run. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('proof: the threshold a calibration chooses holds its accuracy on examples it never saw, and one taken on trust does not', async () => {
  // 4,000 invoices, each overdue or not; a model sure of each to some degree, and right as often as
  // it is sure; and a second, overconfident model, reporting more certainty than it has.
  const random = seeded(2026_10_24);
  const invoices = Array.from({ length: 4_000 }, (_, index) => {
    const overdue = random() < 0.5;
    const sure = 0.5 + 0.5 * random();
    const says = random() < sure ? overdue : !overdue;
    return { id: `INV-${index}`, overdue, sure, says };
  });
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const model = (overconfident: boolean) =>
    new DecisionManager({
      providers: {
        jev: new TypeSafeDecisionProvider({
          apiKey: 'ts-key',
          fetch: typesafeStandIn({
            judge: (state) => {
              const invoice = byId.get(String(state)) as (typeof invoices)[number];
              // Overconfident: its confidence, 2p - 1, reported to the power of an eighth, so nearly every
              // answer claims more than it has, in the same order.
              const sure = overconfident ? (1 + (2 * invoice.sure - 1) ** (1 / 8)) / 2 : invoice.sure;
              return invoice.says ? sure : 1 - sure;
            },
          }).fetch,
        }),
      },
    });
  const answer = async (decisions: DecisionManager, ids: readonly string[]) => {
    const answers: YesNoAnswer[] = [];
    for (let start = 0; start < ids.length; start += 200) {
      const batch = await Promise.all(
        ids.slice(start, start + 200).map(async (id) => {
          const { answers: answered } = await decisions.decide({
            state: id,
            questions: { overdue: { type: 'yes-no', question: 'Is it overdue?' } },
          });
          return answered.overdue;
        }),
      );
      answers.push(...batch);
    }
    return answers;
  };
  const target = 0.95;
  const ids = invoices.map((invoice) => invoice.id);
  const seen = ids.slice(0, 2_000);
  const unseen = ids.slice(2_000);
  const samplesOf = (answers: YesNoAnswer[], from: readonly string[]) =>
    answers.map((item, index) => ({
      answer: item,
      correct: answeredRight(item, byId.get(from[index] as string)?.overdue as boolean),
    }));
  /** The accuracy of the unseen answers a gate at `threshold` acts on, and how many it acts on. */
  const heldOut = (answers: YesNoAnswer[], threshold: number) => {
    const acted = samplesOf(answers, unseen).filter(
      (_, index) => gate(answers[index] as YesNoAnswer, { act: threshold }) === 'act',
    );
    return { accuracy: acted.filter((sample) => sample.correct).length / acted.length, count: acted.length };
  };

  for (const overconfident of [false, true]) {
    const decisions = model(overconfident);
    const chosen = calibrate(samplesOf(await answer(decisions, seen), seen), {
      targetAccuracy: target,
      minSamples: 100,
    });
    assert.ok(chosen.threshold !== undefined, 'a threshold reaches the target');
    const unseenAnswers = await answer(decisions, unseen);
    const held = heldOut(unseenAnswers, chosen.threshold as number);
    // Five standard errors below the target, for the answers the gate acts on.
    const margin = 5 * Math.sqrt((target * (1 - target)) / held.count);
    assert.ok(
      held.accuracy >= target - margin,
      `${overconfident ? 'overconfident' : 'calibrated'}: ${held.accuracy.toFixed(3)} on ${held.count} unseen answers at ${chosen.threshold?.toFixed(3)}`,
    );
    const report = calibrate(samplesOf(unseenAnswers, unseen));
    if (overconfident) {
      // Taken on trust, a gate at 0.9 acts on answers right about 86% of the time, well short.
      const trusted = heldOut(unseenAnswers, 0.9);
      const below = 5 * Math.sqrt((target * (1 - target)) / trusted.count);
      assert.ok(
        trusted.accuracy < target - below,
        `a threshold on trust: ${trusted.accuracy.toFixed(3)} on ${trusted.count}`,
      );
      assert.ok(
        report.expectedCalibrationError > 0.1,
        `overconfidence shows: ${report.expectedCalibrationError.toFixed(3)}`,
      );
      assert.ok((chosen.threshold as number) > 0.9, 'the calibration asks more of an overconfident model');
    } else {
      assert.ok(report.expectedCalibrationError < 0.05, `calibrated: ${report.expectedCalibrationError.toFixed(3)}`);
    }
  }
});

test('proof: a support graph routes tickets by decision, and every ticket it is unsure of reaches a person', async () => {
  const api = typesafeStandIn({
    judge: (state) => {
      const text = String(state);
      if (/charged|refund/.test(text)) return { billing: 0.95, technical: 0.05 };
      if (/crash|error/.test(text)) return { billing: 0.03, technical: 0.97 };
      return { billing: 0.55, technical: 0.45 };
    },
  });
  const decisions = new DecisionManager({
    providers: { jev: new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }) },
  });
  const routed: string[] = [];
  const graph = createGraph({ channels: { ticket: lastValue(''), team: lastValue('') } })
    .addNode('triage', () => ({}))
    .addNode('billing', () => ({ team: 'billing' }))
    .addNode('technical', () => ({ team: 'technical' }))
    // A person reads the ticket and names the team.
    .addNode('ask-a-person', (context) => ({
      team: context.interrupt<string>({ reason: 'Which team takes this ticket?', payload: context.state.ticket }),
    }))
    .setEntry('triage')
    .addConditionalEdges(
      'triage',
      decisionRoute(decisions, {
        state: (state: { ticket: string }) => state.ticket,
        question: {
          type: 'choice',
          question: 'Which team should handle this ticket?',
          options: { billing: 'Charges, invoices, and refunds', technical: 'Errors, crashes, and outages' },
        },
        act: 0.8,
        review: 'ask-a-person',
        onAnswer: (answer, node) => routed.push(`${(answer as { choice: string }).choice}->${node}`),
      }),
    )
    .addEdge('billing', END)
    .addEdge('technical', END)
    .addEdge('ask-a-person', END)
    .compile({ checkpointer: new MemoryGraphCheckpointer() });

  const tickets = {
    't-1': 'I was charged twice for October.',
    't-2': 'The app crashes when I open settings.',
    't-3': 'Please refund my last order.',
    't-4': 'Can I change the email on my account?',
    't-5': 'Something is wrong and I do not know what.',
  };
  const results = await Promise.all(
    Object.entries(tickets).map(
      async ([threadId, ticket]) => [threadId, await graph.invoke({ ticket }, { threadId })] as const,
    ),
  );
  const paused = results.filter(([, result]) => result.status === 'awaiting_input').map(([threadId]) => threadId);
  assert.deepEqual(paused, ['t-4', 't-5'], 'every ticket the decision was unsure of waits for a person');
  for (const [threadId, result] of results) {
    if (paused.includes(threadId)) {
      assert.equal(
        result.interrupts?.[0]?.payload,
        tickets[threadId as keyof typeof tickets],
        'with the ticket to read',
      );
    } else {
      assert.equal(result.status, 'completed');
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      results
        .filter(([, result]) => result.status === 'completed')
        .map(([threadId, result]) => [threadId, result.state.team]),
    ),
    { 't-1': 'billing', 't-2': 'technical', 't-3': 'billing' },
    'and every one it was sure of reached its team, without one',
  );
  // The person answers, and the ticket goes where they say.
  const answered = await graph.resumeWith('t-4', 'billing');
  assert.deepEqual([answered.status, answered.state.team], ['completed', 'billing']);
  assert.equal(routed.filter((entry) => entry.endsWith('->ask-a-person')).length, 2);
});
