/**
 * Typed decisions: questions answered with a yes or no, a choice, or a score, each with probabilities
 * and a confidence read alike whichever provider gave them; checked before any provider sees them;
 * failed over, cached, traced, and run as operations of the client, budgeted and on the tenant's key.
 * TypeSafe AI's adapter is checked against a stand-in written from the API's documentation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCacheAdapter } from '../src/cache/adapters.js';
import { NexusAI } from '../src/core/nexus.js';
import { memorySecrets, tenantCredentials } from '../src/credentials/index.js';
import {
  answeredRight,
  answerProbability,
  type CachedDecision,
  calibrate,
  choiceConfidence,
  DecisionError,
  DecisionManager,
  type DecisionProvider,
  decide,
  decisionAnswer,
  gate,
  priceDecision,
  runDecisionConformance,
  scoreConfidence,
  yesNoConfidence,
} from '../src/decisions/index.js';
import { MockDecisionProvider } from '../src/decisions/mock.js';
import { TypeSafeDecisionProvider } from '../src/decisions/typesafe.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { OperationDescriptor } from '../src/types/lifecycle.js';
import { type Judged, typesafeStandIn, type WireQuestion } from './typesafe.js';

const close = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

const ticket = {
  type: 'choice',
  question: 'Which team should handle this?',
  options: { billing: 'Charges and invoices', technical: 'Errors and outages', sales: 'Plans and quotes' },
} as const;

test('answers are typed by their questions, and confidence is read alike from any provider', async () => {
  const provider = new MockDecisionProvider({
    answer: (name) =>
      name === 'team'
        ? { type: 'choice', probabilities: { billing: 7, technical: 2, sales: 1 } }
        : name === 'urgent'
          ? { type: 'yes-no', yes: 0.9 }
          : { type: 'score', probabilities: [0, 0.57, 0.43] },
  });
  const {
    answers,
    provider: answered,
    model,
  } = await decide(provider, {
    state: 'My card was charged twice for October.',
    questions: {
      team: ticket,
      urgent: { type: 'yes-no', question: 'Does it need an answer today?' },
      severity: { type: 'score', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
    },
  });
  assert.deepEqual([answered, model], ['mock', 'mock-decision']);
  // The answers' types follow their questions: a choice names only its options.
  const team: 'billing' | 'technical' | 'sales' = answers.team.choice;
  const urgent: boolean = answers.urgent.yes;
  // @ts-expect-error a choice's answer is one of its options, not any string
  const other: 'marketing' = answers.team.choice;
  void other;
  assert.equal(team, 'billing');
  assert.equal(urgent, true);
  // Probabilities are normalized to sum to 1.
  assert.deepEqual(answers.team.probabilities, { billing: 0.7, technical: 0.2, sales: 0.1 });
  close(answers.team.confidence, (0.7 - 1 / 3) / (1 - 1 / 3), 'a choice: (pmax - 1/n) / (1 - 1/n)');
  close(answers.urgent.probability, 0.9, 'yes');
  close(answers.urgent.confidence, 0.8, 'a yes or no: |2p - 1|');
  assert.equal(answers.severity.level, 1, 'the most probable level');
  close(answers.severity.score, 0.57 + 0.86, 'the probability-weighted level');
  // Distance from level 1: 0.43; for an even spread, (1 + 0 + 1) / 3.
  close(answers.severity.confidence, 1 - 0.43 / (2 / 3), 'a score: one less the spread over an even one');
  close(choiceConfidence([0.5, 0.5]), 0, 'an even split');
  close(scoreConfidence([1 / 3, 1 / 3, 1 / 3]), 0, 'an even spread');
  close(scoreConfidence([0.5, 0, 0.5]), 0, 'wider than an even spread floors at 0');
  close(yesNoConfidence(0.5), 0, 'an even chance');
  close(yesNoConfidence(0), 1, 'a certain no');
  assert.equal(choiceConfidence([1]), 1, 'one option is certain');
});

test('a malformed decision is refused before any provider sees it', async () => {
  const provider = new MockDecisionProvider();
  const manager = new DecisionManager({ providers: { mock: provider } });
  const refused = (request: unknown, pattern: RegExp) =>
    assert.rejects(
      manager.decide(request as never),
      (error: unknown) =>
        error instanceof DecisionError && error.code === 'DECISION_INVALID' && pattern.test(error.message),
      String(pattern),
    );
  await refused({ state: 'x', questions: {} }, /at least one question/);
  await refused({ state: 'x', questions: { a: { type: 'choice', options: ['only'] } } }, /at least two options/);
  await refused(
    { state: 'x', questions: { a: { type: 'choice', options: ['same', 'same'] } } },
    /names an option twice/,
  );
  await refused({ state: 'x', questions: { a: { type: 'choice', options: ['ok', ' '] } } }, /without a name/);
  await refused({ state: 'x', questions: { a: { type: 'score', levels: ['one'] } } }, /at least two levels/);
  await refused({ state: 'x', questions: { a: { type: 'polygon' } } }, /a yes-no, a choice, a score, or a box/);
  const stopped = new AbortController();
  stopped.abort(new Error('stopped'));
  await assert.rejects(
    manager.decide({ state: 'x', questions: { a: { type: 'yes-no' } }, signal: stopped.signal }),
    /stopped/,
  );
  assert.equal(provider.requests.length, 0, 'no provider saw any of them');
});

test('probabilities that do not fit the question are refused', async () => {
  const answering = (distribution: unknown) =>
    new DecisionManager({ providers: { mock: new MockDecisionProvider({ answer: () => distribution as never }) } });
  const cases: Array<[unknown, unknown, RegExp]> = [
    [{ type: 'yes-no' }, { type: 'yes-no', yes: -0.1 }, /not a number from 0 to 1/],
    [{ type: 'yes-no' }, { type: 'yes-no', yes: Number.NaN }, /not a number from 0 to 1/],
    [{ type: 'yes-no' }, { type: 'choice', probabilities: {} }, /answered as a choice/],
    [ticket, { type: 'choice', probabilities: { billing: 1, marketing: 0 } }, /"marketing" is not an option/],
    [
      { type: 'score', levels: ['a', 'b', 'c'] },
      { type: 'score', probabilities: [0.5, 0.5] },
      /3 levels was answered with 2/,
    ],
  ];
  for (const [question, distribution, pattern] of cases) {
    await assert.rejects(
      answering(distribution).decide({ state: 'x', questions: { q: question as never } }),
      (error: unknown) =>
        error instanceof DecisionError && error.code === 'DECISION_INVALID' && pattern.test(error.message),
      String(pattern),
    );
  }
});

test('a provider that cannot take a question is refused, a fallback that cannot is passed over, and failover follows the error', async () => {
  const narrow: DecisionProvider = {
    info: { name: 'narrow', capabilities: { types: ['yes-no'], maxOptions: 2, maxLevels: 2, defaultModel: 'n' } },
    decide: async () => ({ distributions: {} }),
  };
  const asked: string[] = [];
  const failing = (name: string, error: Error) =>
    new MockDecisionProvider({
      name,
      fail: () => {
        asked.push(name);
        return error;
      },
    });
  const wide = new MockDecisionProvider({
    name: 'wide',
    answer: () => ({ type: 'choice', probabilities: { billing: 1 } }),
  });
  const few: DecisionProvider = {
    info: { name: 'few', capabilities: { types: ['choice', 'score'], maxOptions: 2, maxLevels: 2, defaultModel: 'f' } },
    decide: async () => ({ distributions: {} }),
  };
  await assert.rejects(
    new DecisionManager({ providers: { few } }).decide({ state: 'x', questions: { team: ticket } }),
    /takes at most 2 options, not 3 in "team"/,
  );
  await assert.rejects(
    new DecisionManager({ providers: { few } }).decide({
      state: 'x',
      questions: { s: { type: 'score', levels: ['a', 'b', 'c'] } },
    }),
    /takes at most 2 levels, not 3 in "s"/,
  );
  await assert.rejects(
    new DecisionManager({ providers: { narrow } }).decide({ state: 'x', questions: { team: ticket } }),
    (error: unknown) =>
      error instanceof DecisionError &&
      error.code === 'DECISION_UNSUPPORTED' &&
      /does not answer choice/.test(error.message),
  );

  const manager = new DecisionManager({
    providers: {
      down: failing('down', new DecisionError('overloaded', 'DECISION_FAILED', true, 503)),
      refusing: failing('refusing', new DecisionError('bad key', 'DECISION_FAILED', false, 401)),
      unreachable: failing('unreachable', new TypeError('fetch failed')),
      narrow,
      wide,
    },
    fallbacks: ['narrow', 'unreachable', 'wide'],
  });
  const result = await manager.decide({ provider: 'down', state: 'x', questions: { team: ticket } });
  assert.equal(result.provider, 'wide', 'past an overloaded service and a refused connection');
  assert.deepEqual(asked, ['down', 'unreachable'], 'the narrow fallback, which cannot take a choice, never asked');
  asked.length = 0;
  await assert.rejects(manager.decide({ provider: 'refusing', state: 'x', questions: { team: ticket } }), /bad key/);
  assert.deepEqual(asked, ['refusing'], 'a refused key is not failed over');
  await assert.rejects(
    manager.decide({ provider: 'missing', state: 'x', questions: { team: ticket } }),
    /No decision provider/,
  );
});

test('the cache answers the same questions about the same state, for the same tenant, once', async () => {
  const provider = new MockDecisionProvider({ answer: () => ({ type: 'yes-no', yes: 0.8 }) });
  const store = new MemoryCacheAdapter<CachedDecision>();
  const manager = new DecisionManager({ providers: { mock: provider }, cache: { store } });
  const ask = (state: string, extra: object = {}) =>
    manager.decide({ state, questions: { urgent: { type: 'yes-no', question: 'Urgent?' } }, ...extra });
  const first = await ask('The site is down.');
  const again = await ask('The site is down.');
  assert.equal(first.cached, undefined);
  assert.equal(again.cached, true);
  assert.deepEqual(again.answers, first.answers);
  assert.equal(provider.requests.length, 1, 'asked once');
  await ask('The site is up.');
  await ask('The site is down.', { tenantId: 'acme' });
  await ask('The site is down.', { cache: false });
  assert.equal(provider.requests.length, 4, 'another state, another tenant, or no cache: asked again');
});

test('every decision is an operation of the client: authorized, budgeted at the model’s price, and on the tenant’s key', async () => {
  const seen: OperationDescriptor[] = [];
  // What each decision operation recorded as its cost, as cost reporting reads it.
  const finished: Array<number | undefined> = [];
  const budget = budgetLedger({ limit: 1 });
  const ai = new NexusAI({
    providers: {},
    lifecycle: {
      authorize: (operation) => {
        seen.push({ ...operation });
        return true;
      },
      budget,
      credentials: tenantCredentials({ secrets: memorySecrets({ 'acme/typesafe': 'ts-acme' }), missing: 'config' }),
      hooks: {
        onFinish: (operation, outcome) => {
          if (operation.family === 'decision') finished.push(outcome.cost);
        },
      },
    },
  });
  const api = typesafeStandIn({ judge: () => 0.95, keys: ['ts-key', 'ts-acme'], tokensPerQuestion: 1_000_000 });
  const manager = new DecisionManager(
    { providers: { typesafe: new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }) } },
    { lifecycle: ai.lifecycle },
  );
  const result = await manager.decide({
    state: 'Order 1042 arrived broken.',
    questions: { refund: { type: 'yes-no', question: 'Should it be refunded?' } },
    tenantId: 'acme',
  });
  assert.equal(api.seen[0]?.authorization, 'Bearer ts-acme', 'the tenant’s own key');
  assert.equal(seen[0]?.family, 'decision');
  assert.equal(seen[0]?.operation, 'decision.decide');
  assert.equal(seen[0]?.tenantId, 'acme');
  // A million input tokens, billed at $0.042 a million, output free.
  close(result.cost?.amount ?? -1, 0.042, 'priced at Jev’s rate');
  close(await budget.spent('acme'), 0.042, 'charged to the tenant’s budget');

  // A budget that cannot hold the estimate stops the decision before the provider sees it.
  const spent = new DecisionManager(
    { providers: { typesafe: new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }) } },
    { lifecycle: new NexusAI({ providers: {}, lifecycle: { budget: budgetLedger({ limit: 0 }) } }).lifecycle },
  );
  const calls = api.seen.length;
  await assert.rejects(
    spent.decide({ state: 'x'.repeat(4_000), questions: { refund: { type: 'yes-no' } } }),
    /[Bb]udget/,
  );
  assert.equal(api.seen.length, calls, 'refused before it was sent');

  // A provider whose own calls were charged already is not charged again.
  const charged: DecisionProvider = {
    info: {
      name: 'charged',
      capabilities: { types: ['yes-no'], maxOptions: 2, maxLevels: 2, defaultModel: 'jev-1.13.0' },
      chargedByItsCalls: true,
    },
    decide: async () => ({
      distributions: { refund: { type: 'yes-no', yes: 1 } },
      cost: { amount: 0.5, currency: 'USD', basis: 'reported' },
    }),
  };
  const before = await budget.spent('acme');
  const twice = await new DecisionManager({ providers: { charged } }, { lifecycle: ai.lifecycle }).decide({
    state: 'x',
    questions: { refund: { type: 'yes-no' } },
    tenantId: 'acme',
  });
  assert.equal(twice.cost?.amount, 0.5, 'its cost is reported');
  close(await budget.spent('acme'), before, 'and not charged a second time');
  close(finished[0] ?? -1, 0.042, 'the decision’s operation records what it cost');
  assert.equal(
    finished.at(-1),
    undefined,
    'and one whose calls were charged records nothing, so spend is not counted twice',
  );
});

test('a decision is a run of kind decision, with its answers, usage, and cost, and its provider’s runs inside it', async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const provider: DecisionProvider = {
    info: {
      name: 'traced',
      capabilities: { types: ['yes-no'], maxOptions: 2, maxLevels: 2, defaultModel: 'jev-1.13.0' },
    },
    decide: async () =>
      tracer.trace({ name: 'inner call', kind: 'model' }, () => ({
        distributions: { refund: { type: 'yes-no' as const, yes: 0.75 } },
        usage: { inputTokens: 500, outputTokens: 2 },
      })),
  };
  await new DecisionManager({ providers: { traced: provider } }, { tracer }).decide({
    state: 'Order 1042 arrived broken.',
    questions: { refund: { type: 'yes-no' } },
    metadata: { flow: 'support' },
  });
  const runs = store.query({});
  const decision = runs.find((run) => run.kind === 'decision');
  assert.ok(decision, 'a decision run');
  assert.equal(decision.provider, 'traced');
  assert.equal(decision.model, 'jev-1.13.0');
  assert.deepEqual(decision.metadata, { flow: 'support' });
  assert.equal((decision.outputs as { refund: { probability: number } }).refund.probability, 0.75);
  assert.deepEqual(decision.usage, { inputTokens: 500, outputTokens: 2 });
  close(decision.cost ?? -1, (500 / 1_000_000) * 0.042, 'its cost');
  const inner = runs.find((run) => run.name === 'inner call');
  assert.equal(inner?.parentId, decision.id, 'the provider’s call nests beneath it');
});

test('a gate acts, has a person review, or abstains by confidence', () => {
  assert.equal(gate({ confidence: 0.92 }, { act: 0.9 }), 'act');
  assert.equal(gate({ confidence: 0.9 }, { act: 0.9 }), 'act', 'at the threshold');
  assert.equal(gate({ confidence: 0.2 }, { act: 0.9 }), 'review', 'below it, a person reviews, by default');
  assert.equal(gate({ confidence: 0.6 }, { act: 0.9, review: 0.5 }), 'review');
  assert.equal(gate({ confidence: 0.4 }, { act: 0.9, review: 0.5 }), 'abstain');
});

test('calibration measures how answers’ probabilities track accuracy, and chooses the confidence that holds the target', () => {
  // A yes or no's answer at probability p has confidence |2p - 1|: 0.875 is 0.75, 0.75 is 0.5, 0.625 is 0.25.
  const answerAt = (yes: number) => decisionAnswer({ type: 'yes-no' }, { type: 'yes-no', yes });
  const at = (yes: number, count: number, right: number) =>
    Array.from({ length: count }, (_, index) => ({ answer: answerAt(yes), correct: index < right }));
  close(answerProbability(answerAt(0.25)), 0.75, 'a no at 0.25 gives its answer 0.75');
  // 40 answers at 0.875, 35 right; 40 at 0.75, 26 right; 20 at 0.625, 8 right.
  const samples = [...at(0.875, 40, 35), ...at(0.75, 40, 26), ...at(0.625, 20, 8)];
  const report = calibrate(samples, { targetAccuracy: 0.85 });
  assert.equal(report.samples, 100);
  close(report.accuracy, 0.69, 'accuracy');
  // |0.875 - 0.875| * 0.4 + |0.75 - 0.65| * 0.4 + |0.625 - 0.4| * 0.2
  close(report.expectedCalibrationError, 0.085, 'the expected calibration error');
  assert.deepEqual(
    report.bins.map((bin) => [bin.from, bin.count, bin.probability, bin.accuracy]),
    [
      [0.6, 20, 0.625, 0.4],
      [0.7, 40, 0.75, 0.65],
      [0.8, 40, 0.875, 0.875],
    ],
  );
  assert.equal(
    report.threshold,
    0.75,
    'on confidence: answers at 0.75 are right 87.5% of the time; with those at 0.5, 76%',
  );
  close(report.coverage ?? -1, 0.4, 'a gate there acts on 40%');
  const looser = calibrate(samples, { targetAccuracy: 0.75 });
  assert.equal(looser.threshold, 0.5);
  close(looser.coverage ?? -1, 0.8, 'coverage');
  assert.equal(calibrate(samples, { targetAccuracy: 0.85, minSamples: 50 }).threshold, undefined, 'too few to choose');
  assert.equal(calibrate(samples, { targetAccuracy: 0.99 }).threshold, undefined, 'none reaches it');
  const honest = calibrate([...at(1, 10, 10), ...at(0.5, 10, 5)]);
  close(honest.expectedCalibrationError, 0, 'certain and right, even and half right');
});

test('an answer is right by its answer, and a score by its level or within a tolerance', async () => {
  const { answers } = await decide(
    new MockDecisionProvider({
      answer: (name) =>
        name === 'score'
          ? { type: 'score', probabilities: [0, 0.6, 0.4] }
          : name === 'yes'
            ? { type: 'yes-no', yes: 0.7 }
            : undefined,
    }),
    {
      state: 'x',
      questions: { score: { type: 'score', levels: ['a', 'b', 'c'] }, yes: { type: 'yes-no' }, team: ticket },
    },
  );
  assert.equal(answeredRight(answers.yes, true), true);
  assert.equal(answeredRight(answers.team, 'billing'), true, 'of an even spread, the first option');
  assert.equal(answeredRight(answers.score, 1), true);
  assert.equal(answeredRight(answers.score, 2), false);
  assert.equal(answeredRight(answers.score, 2, { tolerance: 0.6 }), true, 'a weighted 1.4 is within 0.6 of 2');
  assert.equal(answeredRight(answers.score, 'b'), false);
});

test('a decision is priced from its model’s price, or left unpriced, never free', () => {
  close(priceDecision('jev-1.13.0', { inputTokens: 2_000_000, outputTokens: 50 })?.amount ?? -1, 0.084, 'by prefix');
  assert.equal(priceDecision('gpt-5.4', { inputTokens: 1_000 }), undefined, 'a model without a price');
  assert.equal(priceDecision('jev-1.13.0', {}), undefined, 'usage without tokens');
  close(
    priceDecision('house', { inputTokens: 1_000_000 }, { house: { inputPerMillion: 2 } })?.amount ?? -1,
    2,
    'own prices',
  );
});

test('TypeSafe AI: every question in one call, in the API’s terms, and its answers read back', async () => {
  const api = typesafeStandIn({
    judge: (_state, name): Judged =>
      name === 'team'
        ? { billing: 0.61, technical: 0.35, sales: 0.04 }
        : name === 'severity'
          ? [0, 0.57, 0.43]
          : name === 'tone'
            ? { calm: 0, frustrated: 0.84, angry: 0.16 }
            : 0.93,
  });
  const provider = new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch, longContext: true });
  const result = await decide(provider, {
    state: { subject: 'Charged twice', body: 'Help! My card was charged twice.' },
    questions: {
      team: ticket,
      repeat: {
        type: 'yes-no',
        question: 'Have they asked before?',
        criteria: { yes: 'Mentions a prior ticket', no: 'No sign of one' },
      },
      severity: { type: 'score', question: 'How bad is it?', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
      tone: { type: 'choice', options: ['calm', 'frustrated', 'angry'] },
    },
  });
  assert.equal(api.seen.length, 1, 'one call');
  const sent = api.seen[0];
  assert.equal(sent?.path, '/v1/systemone');
  assert.equal(sent?.authorization, 'Bearer ts-key');
  assert.equal(sent?.headers.get('TypeSafe-Danger-Zone-Long-Context'), 'true');
  assert.equal(sent?.body?.model, 'jev-latest');
  assert.deepEqual(sent?.body?.questions, {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Charges and invoices', technical: 'Errors and outages', sales: 'Plans and quotes' },
    },
    repeat: {
      type: 'noul',
      instructions: 'Have they asked before?',
      criteria: { true: 'Mentions a prior ticket', false: 'No sign of one' },
    },
    severity: { type: 'score', instructions: 'How bad is it?', criteria: ['Cosmetic', 'Degraded', 'Blocking'] },
    tone: { type: 'choice', criteria: { calm: null, frustrated: null, angry: null } },
  } satisfies Record<string, WireQuestion>);
  assert.equal(result.model, 'jev-1.14.0', 'the alias, resolved');
  assert.deepEqual(result.usage, { inputTokens: 160, outputTokens: 12 });
  close(result.cost?.amount ?? -1, (160 / 1_000_000) * 0.042, 'priced');
  assert.equal(result.answers.team.choice, 'billing');
  // The confidence read here is the one TypeSafe AI documents.
  close(result.answers.team.confidence, (0.61 - 1 / 3) / (2 / 3), 'a choice’s documented confidence');
  assert.equal(result.answers.repeat.yes, true);
  close(result.answers.repeat.probability, 0.93, 'noul');
  assert.deepEqual(result.answers.severity.probabilities, [0, 0.57, 0.43], 'levels by their numbers');
  assert.equal(result.answers.tone.choice, 'frustrated');
  assert.deepEqual(await provider.listModels(), ['jev-1.13.0', 'jev-1.14.0']);
});

test('TypeSafe AI: a refused field is named, an overloaded service may be failed over, and a refused key may not', async () => {
  let status: number | undefined;
  const api = typesafeStandIn({ judge: () => 0.5, failWith: () => status });
  const provider = new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch });
  const context = { signal: new AbortController().signal, requestId: 'r' };
  // Asked directly, past the manager's own checks: eleven levels are more than the API takes.
  await assert.rejects(
    provider.decide(
      {
        model: 'jev-latest',
        state: 'x',
        questions: { s: { type: 'score', levels: Array.from({ length: 11 }, (_, i) => `l${i}`) } },
      },
      context,
    ),
    (error: unknown) =>
      error instanceof DecisionError &&
      error.code === 'DECISION_INVALID' &&
      error.status === 422 &&
      /body\.questions\.s\.criteria: Between 1 and 10 levels/.test(error.message),
  );
  await assert.rejects(
    provider.decide({ model: 'jev-0.1', state: 'x', questions: { y: { type: 'yes-no' } } }, context),
    /body\.model: Unknown model jev-0\.1/,
  );
  status = 503;
  await assert.rejects(
    provider.decide({ model: 'jev-latest', state: 'x', questions: { y: { type: 'yes-no' } } }, context),
    (error: unknown) => error instanceof DecisionError && error.retryable && error.status === 503,
  );
  status = undefined;
  await assert.rejects(
    new TypeSafeDecisionProvider({ apiKey: 'wrong', fetch: api.fetch }).decide(
      { model: 'jev-latest', state: 'x', questions: { y: { type: 'yes-no' } } },
      context,
    ),
    (error: unknown) => error instanceof DecisionError && !error.retryable && error.status === 401,
  );
  const unreachable = new TypeSafeDecisionProvider({
    apiKey: 'ts-key',
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(
    unreachable.decide({ model: 'jev-latest', state: 'x', questions: { y: { type: 'yes-no' } } }, context),
    (error: unknown) =>
      error instanceof DecisionError && error.retryable && /could not be reached: fetch failed/.test(error.message),
  );
  const slow = new TypeSafeDecisionProvider({
    apiKey: 'ts-key',
    timeoutMs: 50,
    // A request in flight holds the process open, as a real one's socket does; the timeout's own
    // timer does not, so without it Node 22 ends the test before the timeout fires.
    fetch: ((_input: unknown, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        const open = setTimeout(() => undefined, 10_000);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(open);
          reject(init.signal?.reason);
        });
      })) as typeof fetch,
  });
  await assert.rejects(
    slow.decide({ model: 'jev-latest', state: 'x', questions: { y: { type: 'yes-no' } } }, context),
    (error: unknown) => error instanceof DecisionError && error.retryable,
    'a call past its timeout may be tried again',
  );
});

test('the mock and TypeSafe AI pass the decision conformance suite, and a provider that ignores a stopped call does not', async () => {
  const mock = await runDecisionConformance(new MockDecisionProvider());
  assert.deepEqual(mock.failures, []);
  assert.equal(mock.passed.length, 6);

  // The stand-in's model reads the invoice the suite asks about.
  const api = typesafeStandIn({
    judge: (state, _name, question) => {
      const paid = /paid in full/.test(String(state));
      if (question.type === 'noul') return paid ? 0.97 : 0.04;
      if (question.type === 'choice') return { early: 0.9, late: 0.1 };
      return paid ? [0, 0.05, 0.95] : [0.9, 0.1, 0];
    },
  });
  const typesafe = await runDecisionConformance(new TypeSafeDecisionProvider({ apiKey: 'ts-key', fetch: api.fetch }), {
    cases: [
      {
        state: 'The invoice was paid in full.',
        question: { type: 'yes-no', question: 'Was it paid?' },
        expected: true,
      },
      { state: 'The invoice is unpaid.', question: { type: 'yes-no', question: 'Was it paid?' }, expected: false },
      {
        state: 'The invoice was paid in full.',
        question: { type: 'score', levels: ['None', 'Some', 'All'] },
        expected: 2,
      },
    ],
  });
  assert.deepEqual(typesafe.failures, []);
  assert.equal(typesafe.passed.length, 9);

  const careless: DecisionProvider = {
    info: { name: 'careless', capabilities: { types: ['yes-no'], maxOptions: 2, maxLevels: 2, defaultModel: 'c' } },
    decide: async (request) => ({
      distributions: Object.fromEntries(
        Object.keys(request.questions).map((name) => [name, { type: 'yes-no' as const, yes: 1 }]),
      ),
    }),
  };
  const report = await runDecisionConformance(careless, {
    cases: [{ state: 'x', question: { type: 'yes-no' }, expected: false }],
  });
  assert.deepEqual(report.failures, [
    'a stopped decision is not answered: it answered after the call was stopped',
    'case 1: expected false, answered true',
  ]);
});
