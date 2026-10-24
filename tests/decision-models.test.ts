/**
 * Log probabilities from the providers that report them, and decisions from any completion model:
 * each question asked on its own for a one-token code, its probabilities read from that token's
 * alternatives, or counted over samples where the model reports none or refuses to.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negotiateCompletionRequest } from '../src/capabilities/negotiate.js';
import { completionDecisions, DecisionError, DecisionManager, runDecisionConformance } from '../src/decisions/index.js';
import { GoogleProvider } from '../src/providers/google.js';
import { GroqProvider } from '../src/providers/groq.js';
import { MistralProvider } from '../src/providers/mistral.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import type { CompletionRequest, ModelCapabilities } from '../src/index.js';
import type { NexusResponse, TokenLogprob } from '../src/types/response.js';

const close = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
const ask: CompletionRequest = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Y or N?' }],
  logprobs: { top: 50 },
};

/** An OpenAI-compatible provider with its client replaced, answering with these log probabilities. */
function chatProvider<P extends OpenAIProvider>(provider: P, logprobs?: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          sent.push(params);
          return { model: 'gpt-4.1-mini', choices: [{ message: { content: 'Y' }, finish_reason: 'stop', logprobs }] };
        },
      },
    },
  };
  return { provider, sent };
}

test('OpenAI and the OpenAI-compatible providers ask for log probabilities, and read them back; Groq and Mistral are not sent them', async () => {
  const wire = {
    content: [
      {
        token: 'Y',
        logprob: Math.log(0.8),
        top_logprobs: [
          { token: 'Y', logprob: Math.log(0.8) },
          { token: 'N', logprob: Math.log(0.15) },
        ],
      },
    ],
  };
  const openai = chatProvider(new OpenAIProvider({ apiKey: 'k' }), wire);
  const response = await openai.provider.complete(ask);
  assert.equal(openai.sent[0]?.logprobs, true);
  assert.equal(openai.sent[0]?.top_logprobs, 20, 'at most twenty alternatives');
  assert.deepEqual(response.logprobs, [
    {
      token: 'Y',
      logprob: Math.log(0.8),
      top: [
        { token: 'Y', logprob: Math.log(0.8) },
        { token: 'N', logprob: Math.log(0.15) },
      ],
    },
  ] satisfies TokenLogprob[]);
  const plain = chatProvider(new OpenAIProvider({ apiKey: 'k' }));
  const unasked = await plain.provider.complete({ ...ask, logprobs: undefined });
  assert.equal(plain.sent[0]?.logprobs, undefined, 'not asked, not sent');
  assert.equal(unasked.logprobs, undefined);
  const router = chatProvider(new OpenRouterProvider({ apiKey: 'k' }), wire);
  await router.provider.complete({ ...ask, model: 'openrouter/openai/gpt-4.1-mini' });
  assert.equal(router.sent[0]?.logprobs, true, 'a compatible provider sends it');
  for (const provider of [new GroqProvider({ apiKey: 'k' }), new MistralProvider({ apiKey: 'k' })]) {
    const refusing = chatProvider(provider);
    const answered = await refusing.provider.complete({ ...ask, model: 'some-model' });
    assert.equal(refusing.sent[0]?.logprobs, undefined, `${provider.info.name} refuses the option, so it is not sent`);
    assert.equal(answered.logprobs, undefined);
  }
});

test('Gemini asks for log probabilities, and reads each chosen token with its alternatives', async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'B' }] },
            finishReason: 'STOP',
            logprobsResult: {
              chosenCandidates: [{ token: 'B', logProbability: Math.log(0.7) }],
              topCandidates: [
                {
                  candidates: [
                    { token: 'B', logProbability: Math.log(0.7) },
                    { token: 'A', logProbability: Math.log(0.25) },
                  ],
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  try {
    const response = await new GoogleProvider({ apiKey: 'k' }).complete({
      ...ask,
      model: 'gemini-2.5-flash',
      logprobs: { top: 5 },
    });
    const config = body.generationConfig as Record<string, unknown>;
    assert.equal(config.responseLogprobs, true);
    assert.equal(config.logprobs, 5);
    assert.deepEqual(response.logprobs, [
      {
        token: 'B',
        logprob: Math.log(0.7),
        top: [
          { token: 'B', logprob: Math.log(0.7) },
          { token: 'A', logprob: Math.log(0.25) },
        ],
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('Ollama asks for log probabilities, and reads them back', async () => {
  const provider = new OllamaProvider({});
  let sent: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    async chat(request: Record<string, unknown>) {
      sent = request;
      return {
        message: { content: 'N' },
        logprobs: [{ token: 'N', logprob: Math.log(0.9), top_logprobs: [{ token: 'N', logprob: Math.log(0.9) }] }],
        prompt_eval_count: 10,
        eval_count: 1,
      };
    },
  };
  const response = await provider.complete({ ...ask, model: 'ollama/llama3.2', logprobs: { top: 3 } });
  assert.deepEqual([sent.logprobs, sent.top_logprobs], [true, 3]);
  assert.deepEqual(response.logprobs, [
    { token: 'N', logprob: Math.log(0.9), top: [{ token: 'N', logprob: Math.log(0.9) }] },
  ]);
});

test('a model that declares it reports no log probabilities has the option removed, with a warning', () => {
  const capabilities = { logprobs: false, maxContextTokens: 8_000 } as ModelCapabilities;
  const { value, warnings } = negotiateCompletionRequest(ask, capabilities);
  assert.equal(value.logprobs, undefined);
  assert.equal(warnings[0]?.feature, 'logprobs');
  assert.equal(
    negotiateCompletionRequest(ask, { maxContextTokens: 8_000 } as ModelCapabilities).value.logprobs?.top,
    50,
    'undeclared, passed through',
  );
});

/** A completion client of the test's own, answering each request as `answer` says. */
function model(answer: (request: CompletionRequest, call: number) => Partial<NexusResponse> | Error) {
  const requests: CompletionRequest[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  return {
    requests,
    mostInFlight: () => mostInFlight,
    client: {
      async complete(request: CompletionRequest): Promise<NexusResponse> {
        // Numbered as it arrives, before any answer, as concurrent samples arrive together.
        const call = requests.push(request);
        request.signal?.throwIfAborted();
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        const answered = answer(request, call);
        if (answered instanceof Error) throw answered;
        return {
          content: '',
          role: 'assistant',
          finishReason: 'stop',
          meta: {
            provider: 'test',
            model: request.model,
            requestId: 'r',
            latencyMs: 1,
            timestamp: '2026-10-24T00:00:00.000Z',
            usage: { inputTokens: 100, outputTokens: 1 },
            cost: { amount: 0.001, currency: 'USD', basis: 'estimated' },
          },
          ...answered,
        } as NexusResponse;
      },
    },
  };
}

const tokens = (alternatives: Record<string, number>): TokenLogprob[] => [
  {
    token: Object.keys(alternatives)[0] as string,
    logprob: Math.log(Object.values(alternatives)[0] as number),
    top: Object.entries(alternatives).map(([token, probability]) => ({ token, logprob: Math.log(probability) })),
  },
];

const team = {
  type: 'choice',
  question: 'Which team should handle this?',
  options: { billing: 'Charges and invoices', technical: 'Errors and outages', sales: 'Plans and quotes' },
} as const;

test('a completion model’s decision: one call per question, its probabilities read from the code’s alternatives', async () => {
  const fake = model((request) => {
    const prompt = String(request.messages[1]?.content);
    if (prompt.includes('Which team')) return { logprobs: tokens({ A: 0.6, ' B': 0.25, B: 0.05, C: 0.05, The: 0.05 }) };
    if (prompt.includes('urgent')) return { logprobs: tokens({ Yes: 0.7, No: 0.2, Maybe: 0.1 }) };
    return { logprobs: tokens({ '2': 0.5, '1': 0.3, '0': 0.2 }) };
  });
  const provider = completionDecisions(fake.client, {
    model: 'gpt-4.1-mini',
    instructions: 'Billing is any money matter.',
  });
  assert.equal(provider.info.chargedByItsCalls, true, 'its calls are charged where they are made');
  const result = await new DecisionManager({ providers: { gpt: provider } }).decide({
    state: { subject: 'Charged twice', body: 'My card was charged twice.' },
    questions: {
      team,
      urgent: { type: 'yes-no', question: 'Is it urgent?', criteria: { yes: 'Money is lost' } },
      severity: { type: 'score', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
    },
    tenantId: 'acme',
  });
  assert.equal(fake.requests.length, 3, 'one call per question');
  const asked = fake.requests.find((request) =>
    String(request.messages[1]?.content).includes('Which team'),
  ) as CompletionRequest;
  assert.deepEqual([asked.temperature, asked.maxTokens, asked.logprobs?.top, asked.tenantId], [0, 2, 20, 'acme']);
  assert.match(String(asked.messages[1]?.content), /"subject": "Charged twice"/);
  assert.match(String(asked.messages[1]?.content), /Billing is any money matter\./);
  assert.match(
    String(asked.messages[1]?.content),
    /A: billing, Charges and invoices\nB: technical, Errors and outages\nC: sales, Plans and quotes/,
  );
  // " B" and "B" read as one code; "The" is no code, and is left out.
  close(result.answers.team.probabilities.billing, 0.6 / 0.95, 'billing');
  close(result.answers.team.probabilities.technical, 0.3 / 0.95, 'technical');
  close(result.answers.urgent.probability, 0.7 / 0.9, 'Yes and No read as Y and N');
  for (const [level, expected] of [0.2, 0.3, 0.5].entries()) {
    close(result.answers.severity.probabilities[level] ?? -1, expected, `level ${level}`);
  }
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 3, calls: 3 });
  close(result.cost?.amount ?? -1, 0.003, 'the calls’ cost, as the client priced them');
});

test('a model that reports no log probabilities, or refuses them, is sampled, and sampled from then on', async () => {
  // Six of eight samples answer A, two answer B.
  const silent = model((request, call) => (request.logprobs ? {} : { content: call % 4 === 0 ? 'B' : 'A.' }));
  const provider = completionDecisions(silent.client, { model: 'claude-x' });
  const manager = new DecisionManager({ providers: { claude: provider } });
  const first = await manager.decide({ state: 'x', questions: { team } });
  assert.equal(silent.requests.filter((request) => request.logprobs).length, 1, 'asked once for log probabilities');
  assert.equal(silent.requests.filter((request) => !request.logprobs).length, 8, 'then sampled eight times');
  assert.deepEqual(
    silent.requests.filter((request) => !request.logprobs).map((request) => [request.temperature, request.maxTokens]),
    Array.from({ length: 8 }, () => [1, 4]),
  );
  // The log-probability call was the first; samples 4 and 8 of the calls answered B.
  close(first.answers.team.probabilities.billing, 6 / 8, 'six of eight said A');
  close(first.answers.team.probabilities.technical, 2 / 8, 'two said B');
  close(first.answers.team.probabilities.sales, 0, 'none said C');
  assert.deepEqual(provider.sampledModels.has('claude-x'), true);
  const before = silent.requests.length;
  await manager.decide({ state: 'y', questions: { team } });
  assert.equal(
    silent.requests.slice(before).filter((request) => request.logprobs).length,
    0,
    'not asked for them again',
  );

  const refusing = model((request) =>
    request.logprobs ? Object.assign(new Error('logprobs is not supported'), { status: 400 }) : { content: 'C' },
  );
  const sampledAfterRefusal = await new DecisionManager({
    providers: { strict: completionDecisions(refusing.client, { model: 'strict', samples: 3 }) },
  }).decide({ state: 'x', questions: { team } });
  assert.equal(sampledAfterRefusal.answers.team.choice, 'sales');
  assert.equal(sampledAfterRefusal.answers.team.confidence, 1, 'three samples of three said C');

  // Asked for log probabilities alone, neither falls back.
  await assert.rejects(
    new DecisionManager({
      providers: { only: completionDecisions(model(() => ({})).client, { model: 'm', method: 'logprobs' }) },
    }).decide({
      state: 'x',
      questions: { team },
    }),
    (error: unknown) => error instanceof DecisionError && /reported no log probabilities/.test(error.message),
  );
  await assert.rejects(
    new DecisionManager({
      providers: { only: completionDecisions(refusing.client, { model: 'm', method: 'logprobs' }) },
    }).decide({ state: 'x', questions: { team } }),
    /logprobs is not supported/,
  );
  // Any other failure is the decision's, not a reason to sample.
  await assert.rejects(
    new DecisionManager({
      providers: {
        down: completionDecisions(model(() => Object.assign(new Error('overloaded'), { status: 503 })).client, {
          model: 'm',
        }),
      },
    }).decide({ state: 'x', questions: { team } }),
    /overloaded/,
  );
});

test('a choice of more options than one token’s alternatives hold is sampled, and answers that are no code are not counted', async () => {
  const options = Array.from({ length: 30 }, (_, index) => `option-${index + 1}`);
  // A sample may say more than its code; only the first word is read.
  const answers = ['7', 'nonsense', '7)', '12', '7 is closest'];
  const fake = model((_request, call) => ({ content: answers[(call - 1) % answers.length] as string }));
  const result = await new DecisionManager({
    providers: { gpt: completionDecisions(fake.client, { model: 'gpt-4.1-mini', samples: 5 }) },
  }).decide({ state: 'x', questions: { pick: { type: 'choice', options } } });
  assert.equal(
    fake.requests.filter((request) => request.logprobs).length,
    0,
    'thirty options are numbered, and sampled',
  );
  assert.match(String(fake.requests[0]?.messages[1]?.content), /30: option-30/);
  assert.equal(result.answers.pick.choice, 'option-7');
  close(result.answers.pick.probabilities['option-7'], 3 / 4, 'three of the four answers that named an option');
  await assert.rejects(
    new DecisionManager({
      providers: {
        gpt: completionDecisions(model(() => ({ content: 'I cannot say' })).client, { model: 'm', samples: 2 }),
      },
    }).decide({ state: 'x', questions: { team } }),
    (error: unknown) => error instanceof DecisionError && /none of 2 samples/.test(error.message),
  );
  await assert.rejects(
    new DecisionManager({
      providers: { gpt: completionDecisions(fake.client, { model: 'm', method: 'logprobs' }) },
    }).decide({ state: 'x', questions: { pick: { type: 'choice', options } } }),
    (error: unknown) => error instanceof DecisionError && error.code === 'DECISION_UNSUPPORTED',
  );
});

test('questions are asked as many at once as the limit allows, and a completion model passes the conformance suite', async () => {
  const fake = model(() => ({ logprobs: tokens({ Y: 0.9, N: 0.1 }) }));
  const provider = completionDecisions(fake.client, { model: 'm', concurrency: 2 });
  await new DecisionManager({ providers: { m: provider } }).decide({
    state: 'x',
    questions: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`q${index}`, { type: 'yes-no' as const }])),
  });
  assert.equal(fake.mostInFlight(), 2);

  // A model that reads the invoice the suite asks about.
  const reader = model((request) => {
    const prompt = String(request.messages[1]?.content);
    if (/Was the invoice paid/.test(prompt)) return { logprobs: tokens({ Y: 0.95, N: 0.05 }) };
    if (/When was it paid/.test(prompt)) return { logprobs: tokens({ A: 0.9, B: 0.1 }) };
    return { logprobs: tokens({ '2': 0.9, '1': 0.1 }) };
  });
  const report = await runDecisionConformance(completionDecisions(reader.client, { model: 'm' }), {
    cases: [{ state: 'paid in full', question: { type: 'yes-no', question: 'Was the invoice paid?' }, expected: true }],
  });
  assert.deepEqual(report.failures, []);
});
