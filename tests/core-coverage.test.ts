import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentLoop,
  BaseProvider,
  Router,
  biasScore,
  calculateEvalMetrics,
  contextualPrecision,
  contextualRecall,
  exactMatch,
  f1Score,
  faithfulness,
  passAtK,
  perplexity,
  policyAdherence,
  refusalRate,
  semanticSimilarity,
  tokensPerSecond,
  toxicityScore,
  type AgentStep,
  type CompletionRequest,
  type NexusAIConfig,
  type NexusResponse,
  type NexusStream,
  type ToolCall,
} from '../src/index.js';

function meta(model = 'mock/test'): NexusResponse['meta'] {
  return {
    requestId: 'req',
    providerUsed: 'mock',
    modelUsed: model,
    latencyMs: 1,
    tokensInput: 0,
    tokensOutput: 0,
    tokensSaved: 0,
    estimatedCost: '$0.00',
    cacheHit: false,
    guardrailsApplied: [],
  };
}

class ScriptedProvider extends BaseProvider {
  readonly info = { name: 'mock', isLocal: true };

  async complete(): Promise<NexusResponse> {
    return { content: 'unused', role: 'assistant', finishReason: 'stop', meta: meta() };
  }

  stream(): NexusStream {
    throw new Error('not used');
  }
}

// ── Agent loop ─────────────────────────────────────────────────────

class ScriptedAgentClient {
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly script: Array<{ content: string; toolCalls?: ToolCall[] }>) {}

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    this.requests.push(request);
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    return {
      content: next.content,
      role: 'assistant',
      toolCalls: next.toolCalls,
      finishReason: next.toolCalls?.length ? 'tool_calls' : 'stop',
      meta: meta(request.model),
    };
  }
}

function toolCall(name: string, args: string, id = 'call_1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

test('the agent loop runs tools, feeds results back, and stops on a final answer', async () => {
  const client = new ScriptedAgentClient([
    { content: '', toolCalls: [toolCall('add', '{"a":2,"b":3}')] },
    { content: 'The total is 5.' },
  ]);
  const steps: AgentStep[] = [];
  const toolSteps: AgentStep[] = [];

  const result = await new AgentLoop(client).run({
    model: 'mock/test',
    goal: 'add two numbers',
    systemPrompt: 'be precise',
    tools: [
      {
        name: 'add',
        description: 'adds numbers',
        parameters: { type: 'object' },
        execute: async (args) => Number(args.a) + Number(args.b),
      },
    ],
    onStep: (step) => {
      steps.push(step);
    },
    onToolCall: (step) => {
      toolSteps.push(step);
    },
  });

  assert.equal(result.content, 'The total is 5.');
  assert.equal(result.iterations, 2);
  assert.deepEqual(
    result.steps.map((step) => step.type),
    ['model', 'tool', 'final'],
  );
  assert.equal(toolSteps.length, 1);
  assert.equal(steps.length, 3);
  assert.equal(toolSteps[0].toolResult, 5);

  // The system prompt leads, and the tool result is fed back as a tool message.
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].content, 'add two numbers');
  const toolMessage = result.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.toolCallId, 'call_1');
  assert.equal(toolMessage?.content, '5');
});

test('the agent loop records a failing tool without aborting the run', async () => {
  const client = new ScriptedAgentClient([
    { content: '', toolCalls: [toolCall('broken', '{}')] },
    { content: 'I could not use the tool.' },
  ]);

  const result = await new AgentLoop(client).run({
    model: 'mock/test',
    goal: 'try a broken tool',
    tools: [
      {
        name: 'broken',
        description: 'always fails',
        parameters: { type: 'object' },
        execute: async () => {
          throw new Error('boom');
        },
      },
    ],
  });

  const toolStep = result.steps.find((step) => step.type === 'tool');
  assert.match(toolStep?.message || '', /Tool failed/);
  assert.deepEqual(toolStep?.toolResult, { error: 'boom' });
  assert.equal(result.content, 'I could not use the tool.');
});

test('the agent loop tolerates malformed tool arguments and stops at maxIterations', async () => {
  const client = new ScriptedAgentClient([{ content: '', toolCalls: [toolCall('echo', 'not json')] }]);
  let received: Record<string, unknown> | undefined;

  const result = await new AgentLoop(client).run({
    model: 'mock/test',
    goal: 'loop forever',
    maxIterations: 3,
    tools: [
      {
        name: 'echo',
        description: 'echoes',
        parameters: { type: 'object' },
        execute: async (args) => {
          received = args;
          return 'ok';
        },
      },
    ],
  });

  assert.deepEqual(received, {}, 'unparsable arguments become an empty object rather than throwing');
  assert.equal(result.iterations, 3);
  assert.equal(client.requests.length, 3);
});

// ── Rules router ───────────────────────────────────────────────────

function routerConfig(rules: NonNullable<NexusAIConfig['routing']>['rules']): NexusAIConfig {
  return { providers: {}, routing: { mode: 'rules', rules } };
}

function routeWith(config: NexusAIConfig, request: Partial<CompletionRequest>, providerNames = ['anthropic']) {
  const providers = new Map<string, BaseProvider>();
  for (const name of providerNames) providers.set(name, new ScriptedProvider());

  return new Router().route(
    { model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...request },
    config,
    providers,
    [],
  );
}

test('rules routing resolves an alias and reports what matched', () => {
  const decision = routeWith(routerConfig([{ when: { taskType: 'legal' }, use: 'anthropic/best' }]), {
    metadata: { taskType: 'legal' },
  });

  assert.equal(decision.providerName, 'anthropic');
  assert.equal(decision.model, 'claude-opus-4-8');
  assert.match(decision.reason, /matched routing rule -> anthropic\/best resolved to claude-opus-4-8/);
});

test('rules routing supports comparison, membership, and wildcard conditions', () => {
  const rules = [
    { when: { messageCount: { gt: 5 } }, use: 'anthropic/best' },
    { when: { taskType: { in: ['support', 'sales'] } }, use: 'anthropic/fast' },
    { when: '*' as const, use: 'anthropic/balanced' },
  ];

  const long = routeWith(routerConfig(rules), {
    messages: Array.from({ length: 6 }, () => ({ role: 'user' as const, content: 'x' })),
  });
  assert.equal(long.model, 'claude-opus-4-8');

  const support = routeWith(routerConfig(rules), { metadata: { taskType: 'support' } });
  assert.equal(support.model, 'claude-haiku-5-0');

  const fallback = routeWith(routerConfig(rules), {});
  assert.equal(fallback.model, 'claude-sonnet-5-0');
});

test('rules routing matches on tool presence and user identity', () => {
  const decision = routeWith(
    routerConfig([
      { when: { hasTools: true, userId: 'u-1' }, use: 'anthropic/best' },
      { when: '*' as const, use: 'anthropic/fast' },
    ]),
    { userId: 'u-1', tools: [{ name: 'x', description: 'x', parameters: {} }] },
  );

  assert.equal(decision.model, 'claude-opus-4-8');

  const otherUser = routeWith(
    routerConfig([
      { when: { hasTools: true, userId: 'u-1' }, use: 'anthropic/best' },
      { when: '*' as const, use: 'anthropic/fast' },
    ]),
    { userId: 'u-2', tools: [{ name: 'x', description: 'x', parameters: {} }] },
  );

  assert.equal(otherUser.model, 'claude-haiku-5-0');
});

test('a rule pointing at an unregistered provider is skipped rather than routed to', () => {
  const decision = routeWith(
    routerConfig([
      { when: '*' as const, use: 'openai/best' },
      { when: '*' as const, use: 'anthropic/best' },
    ]),
    {},
  );

  assert.equal(decision.providerName, 'anthropic', 'the openai rule cannot match with no openai provider');
});

// ── Evaluation metrics ─────────────────────────────────────────────

test('lexical quality metrics score exact, partial, and empty answers', () => {
  assert.equal(exactMatch('The Answer.', 'the answer'), 1);
  assert.equal(exactMatch('yes', 'no'), 0);
  assert.equal(f1Score('', ''), 1);
  assert.equal(f1Score('the quick brown fox', 'the quick brown fox'), 1);
  assert.equal(f1Score('completely different', 'nothing alike'), 0);
  assert.ok(f1Score('the quick fox', 'the quick brown fox') > 0.5);
});

test('operational metrics handle missing and zero-valued inputs', () => {
  assert.equal(tokensPerSecond(100, 1000), 100);
  assert.equal(tokensPerSecond(undefined, 1000), undefined);
  assert.equal(tokensPerSecond(100, 0), undefined);
  assert.equal(perplexity([]), 0);
  assert.ok(perplexity([-1, -1]) > 2.7);
  assert.equal(passAtK([false, true, false], 2), 1);
  assert.equal(passAtK([false, true], 1), 0);
});

test('retrieval metrics reward ranking relevant chunks first', () => {
  const chunks = [
    { id: 'a', content: 'alpha' },
    { id: 'b', content: 'beta' },
  ];

  assert.equal(contextualPrecision([], ['a']), 0);
  assert.equal(contextualPrecision(chunks, ['a']), 1, 'the only relevant chunk is ranked first');
  assert.ok(contextualPrecision(chunks, ['b']) < 1);
  assert.equal(contextualRecall(chunks, []), 1);
  assert.equal(contextualRecall(chunks, ['a', 'c']), 0.5);
});

test('faithfulness rewards claims that appear in the supplied context', () => {
  const context = ['The tower is 324 metres tall.'];
  assert.equal(faithfulness('', []), 1, 'an answer with no factual claims cannot be unfaithful');
  assert.equal(faithfulness('The tower is 324 metres tall.', context), 1);
  assert.equal(faithfulness('Quarterly revenue rose sharply in Berlin offices.', context), 0);
  assert.equal(
    faithfulness('The tower is 324 metres tall. Penguins migrate through orbital shipyards.', context),
    0.5,
    'one grounded claim out of two',
  );
});

test('safety metrics flag toxic, biased, off-policy, and refusing answers', () => {
  assert.ok(toxicityScore('you are stupid and worthless') > 0);
  assert.equal(toxicityScore('a perfectly civil sentence'), 0);
  assert.ok(biasScore('all women are bad at this') > 0);
  assert.equal(biasScore('individual results vary'), 0);
  assert.equal(policyAdherence('mentions discount and refund', { requiredTerms: ['refund'] }), 1);
  assert.ok(policyAdherence('mentions a discount', { forbiddenTerms: ['discount'] }) < 1);
  assert.equal(refusalRate("I can't help with that", true), 1);
  assert.equal(refusalRate("I can't help with that", false), 0, 'refusing an unsafe prompt is not a failure');
});

test('semantic similarity ranks a paraphrase above an unrelated sentence', async () => {
  const same = await semanticSimilarity('the cat sat on the mat', 'the cat sat on the mat');
  const different = await semanticSimilarity('the cat sat on the mat', 'quarterly revenue increased');
  assert.ok(same > different);
});

test('calculateEvalMetrics assembles every metric family it has inputs for', async () => {
  const metrics = await calculateEvalMetrics({
    actual: 'The tower is 324 metres tall.',
    expected: 'The tower is 324 metres tall.',
    contexts: ['The tower is 324 metres tall.'],
    retrievedChunks: [{ id: 'a', content: 'The tower is 324 metres tall.' }],
    relevantChunkIds: ['a'],
    passedCandidates: [true],
    tokenLogProbs: [-0.5, -0.25],
    latencyMs: 500,
    outputTokens: 50,
    inputTokens: 20,
    estimatedCost: 0.01,
    policy: { requiredTerms: ['tower'], safePrompt: true },
  });

  assert.equal(metrics.quality?.exactMatch, 1);
  assert.equal(metrics.quality?.f1, 1);
  assert.equal(metrics.quality?.passAtK, 1);
  assert.ok((metrics.quality?.perplexity ?? 0) > 1);
  assert.equal(metrics.operational?.tokensPerSecond, 100);
  assert.equal(metrics.operational?.estimatedCost, 0.01);
  assert.equal(metrics.rag?.contextualRecall, 1);
  assert.equal(metrics.rag?.faithfulness, 1);
  assert.equal(metrics.safety?.policyAdherence, 1);
  assert.equal(metrics.safety?.refusalRate, 0);
});

test('calculateEvalMetrics leaves metrics it has no inputs for unset', async () => {
  const metrics = await calculateEvalMetrics({ actual: 'anything' });

  assert.equal(metrics.quality?.exactMatch, undefined);
  assert.equal(metrics.quality?.semanticSimilarity, undefined);
  assert.equal(metrics.rag?.faithfulness, undefined);
  // Text-only checks still run, because they need nothing but the answer itself.
  assert.equal(metrics.safety?.toxicityScore, 0);
});
