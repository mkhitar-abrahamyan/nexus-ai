import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AnthropicProvider,
  BaseProvider,
  NexusAI,
  NexusCapabilityError,
  OpenAIProvider,
  assertRegistryFreshness,
  buildMeta,
  checkRegistryFreshness,
  costAmount,
  describeModel,
  ensureUsageAndCost,
  estimateCost,
  negotiateCompletionRequest,
  type CompletionRequest,
  type ModelCapabilities,
  type NexusResponse,
  type NexusStream,
  type StreamChunk,
} from '../src/index.js';

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'mock/test',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    provider: 'mock',
    modalities: ['text'],
    streaming: true,
    toolCalling: true,
    maxContextTokens: 128000,
    costPer1kInput: 0.001,
    costPer1kOutput: 0.002,
    ...overrides,
  };
}

async function* asyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// ── Negotiation ────────────────────────────────────────────────────

test('negotiation returns the original request when nothing needs changing', () => {
  const input = request({ temperature: 0.5 });
  const result = negotiateCompletionRequest(input, capabilities());

  assert.equal(result.value, input, 'the request object should not be copied on the fast path');
  assert.equal(result.warnings.length, 0);
});

test('negotiation leaves undeclared capabilities alone', () => {
  // A model that says nothing about seeds is unknown, not unsupported.
  const input = request({ seed: 7, topK: 20, reasoning: { effort: 'high' } });
  const result = negotiateCompletionRequest(input, capabilities());

  assert.equal(result.value, input);
  assert.equal(result.warnings.length, 0);
});

test('strict policy refuses an option the model does not support', () => {
  const input = request({ reasoning: { effort: 'high' } });

  assert.throws(
    () => negotiateCompletionRequest(input, capabilities({ reasoning: false }), { policy: 'strict', provider: 'mock' }),
    (error: unknown) => {
      assert.ok(error instanceof NexusCapabilityError);
      assert.equal(error.feature, 'reasoning');
      assert.equal(error.provider, 'mock');
      assert.match(error.message, /mock\/mock\/test cannot honor "reasoning"/);
      return true;
    },
  );
});

test('warn policy drops an unsupported option and records why', () => {
  const input = request({ reasoning: { effort: 'high' } });
  const result = negotiateCompletionRequest(input, capabilities({ reasoning: false }), { policy: 'warn' });

  assert.equal(result.value.reasoning, undefined);
  assert.notEqual(result.value, input, 'the caller request must not be mutated');
  assert.equal(input.reasoning?.effort, 'high');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].feature, 'reasoning');
  assert.equal(result.warnings[0].action, 'dropped');
});

test('off policy sends the request untouched so newer provider features are never blocked', () => {
  const input = request({ reasoning: { effort: 'high' }, capabilityPolicy: 'off' });
  const result = negotiateCompletionRequest(input, capabilities({ reasoning: false }), { policy: 'strict' });

  assert.equal(result.value, input);
  assert.equal(result.warnings.length, 0);
});

test('an unsupported reasoning effort falls back to the nearest supported level', () => {
  const input = request({ reasoning: { effort: 'max' } });
  const result = negotiateCompletionRequest(input, capabilities({ reasoning: { efforts: ['low', 'medium'] } }));

  assert.equal(result.value.reasoning?.effort, 'medium');
  assert.equal(result.warnings[0].action, 'adjusted');
  assert.equal(result.warnings[0].adjustedTo, 'medium');
});

test('thinking budgets and output limits are clamped to the model maximum', () => {
  const input = request({ maxTokens: 999_999, reasoning: { maxTokens: 500_000 } });
  const result = negotiateCompletionRequest(
    input,
    capabilities({ maxOutputTokens: 64000, reasoning: { maxTokens: 32000 } }),
  );

  assert.equal(result.value.maxTokens, 64000);
  assert.equal(result.value.reasoning?.maxTokens, 32000);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.action === 'adjusted'));
});

test('explicit cache mode degrades to auto on providers that cache automatically', () => {
  const input = request({ cache: { mode: 'explicit' } });
  const result = negotiateCompletionRequest(input, capabilities({ promptCaching: { explicit: false, ttls: ['5m'] } }));

  assert.equal(result.value.cache?.mode, 'auto');
  assert.equal(result.warnings[0].feature, 'cache.mode');
});

test('an unsupported cache lifetime falls back to one the model accepts', () => {
  const input = request({ cache: { mode: 'explicit', ttl: '1h' } });
  const result = negotiateCompletionRequest(input, capabilities({ promptCaching: { explicit: true, ttls: ['5m'] } }));

  assert.equal(result.value.cache?.ttl, '5m');
  assert.equal(result.value.cache?.mode, 'explicit');
});

test('schema output downgrades to JSON mode when only structured outputs are unsupported', () => {
  const input = request({ responseFormat: { type: 'json_schema', schema: { type: 'object' } } });
  const result = negotiateCompletionRequest(input, capabilities({ structuredOutputs: false, jsonMode: true }));

  assert.deepEqual(result.value.responseFormat, { type: 'json' });
  assert.equal(result.warnings[0].action, 'adjusted');
});

test('tool options are removed together when the model cannot call tools', () => {
  const input = request({
    tools: [{ name: 'lookup', description: 'x', parameters: {} }],
    toolChoice: 'required',
    parallelToolCalls: false,
  });
  const result = negotiateCompletionRequest(input, capabilities({ toolCalling: false }));

  assert.equal(result.value.tools, undefined);
  assert.equal(result.value.toolChoice, undefined);
  assert.equal(result.value.parallelToolCalls, undefined);
});

// ── Usage and cost ─────────────────────────────────────────────────

test('cached reads and writes are priced separately from standard input', () => {
  const estimate = estimateCost({
    model: 'claude-sonnet-5-0',
    inputTokens: 1000,
    outputTokens: 1000,
    cachedReadTokens: 10000,
    cachedWriteTokens: 2000,
  });

  const model = describeModel('claude-sonnet-5-0').capabilities;
  assert.ok(model);
  assert.equal(estimate.inputCost, model.costPer1kInput);
  assert.equal(estimate.outputCost, model.costPer1kOutput);
  // A cached read is a tenth of the standard input rate, so ten thousand cached tokens cost the
  // same as one thousand fresh ones.
  assert.ok(estimate.cachedReadCost !== undefined);
  assert.ok(Math.abs(estimate.cachedReadCost - model.costPer1kInput) < 1e-9);
  assert.ok(estimate.cachedWriteCost !== undefined);
  assert.ok(estimate.cachedWriteCost > 0);
  assert.equal(estimate.currency, 'USD');
});

test('a long-lived cache write costs more than a short-lived one', () => {
  const short = estimateCost({ model: 'claude-sonnet-5-0', inputTokens: 0, cachedWriteTokens: 1000 });
  const long = estimateCost({
    model: 'claude-sonnet-5-0',
    inputTokens: 0,
    cachedWriteTokens: 1000,
    cacheTtl: '1h',
  });

  assert.ok(long.totalCost > short.totalCost);
});

test('cache pricing multipliers can be overridden per application', () => {
  const estimate = estimateCost({
    model: 'claude-sonnet-5-0',
    inputTokens: 0,
    cachedReadTokens: 1000,
    config: { models: { cachePricing: { read: 0 } } },
  });

  assert.equal(estimate.totalCost, 0);
});

test('buildMeta reports uncached input separately while the legacy field keeps the full prompt', () => {
  const meta = buildMeta({
    provider: 'anthropic',
    model: 'claude-sonnet-5-0',
    latencyMs: 12,
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 900,
    reasoningTokens: 20,
  });

  assert.equal(meta.usage?.inputTokens, 100);
  assert.equal(meta.usage?.cachedReadTokens, 900);
  assert.equal(meta.usage?.reasoningTokens, 20);
  assert.equal(meta.usage?.totalTokens, 1050);
  assert.equal(meta.tokensInput, 1000, 'tokensInput keeps its original meaning of every prompt token');
  const cost = meta.cost;
  assert.ok(cost);
  assert.equal(cost.basis, 'estimated');
  assert.equal(cost.currency, 'USD');
  assert.equal(meta.estimatedCost, `$${cost.amount.toFixed(4)}`);
});

test('responses from a provider that predates structured usage are filled in', () => {
  const meta = ensureUsageAndCost({
    requestId: 'r1',
    providerUsed: 'custom',
    modelUsed: 'gpt-5.6-luna',
    latencyMs: 5,
    tokensInput: 1000,
    tokensOutput: 500,
    tokensSaved: 0,
    estimatedCost: '$0.00',
    cacheHit: false,
    guardrailsApplied: [],
  });

  assert.equal(meta.usage?.inputTokens, 1000);
  assert.equal(meta.usage?.totalTokens, 1500);
  assert.ok(meta.cost);
  assert.ok(meta.cost.amount > 0);
  assert.equal(costAmount(meta), meta.cost.amount);
});

test('costAmount falls back to the formatted string for a hand-built response', () => {
  assert.equal(
    costAmount({
      requestId: 'r1',
      providerUsed: 'custom',
      modelUsed: 'custom',
      latencyMs: 1,
      tokensInput: 0,
      tokensOutput: 0,
      tokensSaved: 0,
      estimatedCost: '$1.2500',
      cacheHit: false,
      guardrailsApplied: [],
    }),
    1.25,
  );
});

// ── Registry provenance ────────────────────────────────────────────

test('model provenance reports an alias stage and a verification date', () => {
  const floating = describeModel('anthropic/best');
  assert.equal(floating.model, 'claude-opus-4-8');
  assert.equal(floating.alias?.stage, 'stable');
  assert.equal(floating.alias?.floating, true, 'intent aliases can change target between releases');
  assert.match(floating.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);

  const pinned = describeModel('claude-opus-4-8');
  assert.equal(pinned.alias, undefined, 'a concrete model name is not an alias');

  const preview = describeModel('gemini-pro-latest');
  assert.equal(preview.alias?.stage, 'preview', 'an alias resolving to a preview model is preview');
});

test('an application alias can declare its own stage', () => {
  const config = {
    models: {
      aliases: { 'team/legacy': 'gpt-5.6-luna' },
      aliasMetadata: { 'team/legacy': { stage: 'deprecated' as const, replacement: 'team/current' } },
    },
  };

  const described = describeModel('team/legacy', config);
  assert.equal(described.model, 'gpt-5.6-luna');
  assert.equal(described.alias?.stage, 'deprecated');
  assert.equal(described.alias?.replacement, 'team/current');
});

test('registry freshness fails once the bundled data is past its window', () => {
  const fresh = checkRegistryFreshness({ now: new Date(`${describeModel('gpt-5.6-luna').verifiedAt}T00:00:00Z`) });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageDays, 0);

  assert.throws(
    () => assertRegistryFreshness({ now: new Date('2099-01-01T00:00:00Z') }),
    /Model registry was last verified .* days ago/,
  );
});

// ── Provider wiring ────────────────────────────────────────────────

test('OpenAI reports cached and reasoning tokens and maps tool choice', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test' });
  let captured: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          captured = params;
          return {
            model: 'gpt-4o',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 200,
              prompt_tokens_details: { cached_tokens: 800 },
              completion_tokens_details: { reasoning_tokens: 150 },
            },
          };
        },
      },
    },
  };

  const response = await provider.complete(
    request({
      model: 'gpt-4o',
      tools: [{ name: 'lookup', description: 'x', parameters: {} }],
      toolChoice: { name: 'lookup' },
      parallelToolCalls: false,
      seed: 42,
      frequencyPenalty: 0.5,
      reasoning: { effort: 'high' },
    }),
  );

  assert.deepEqual(captured.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(captured.parallel_tool_calls, false);
  assert.equal(captured.seed, 42);
  assert.equal(captured.frequency_penalty, 0.5);
  assert.equal(captured.reasoning_effort, 'high');

  // prompt_tokens includes the cached share, so only the remainder is billed as fresh input.
  assert.equal(response.meta.usage?.inputTokens, 200);
  assert.equal(response.meta.usage?.cachedReadTokens, 800);
  assert.equal(response.meta.usage?.reasoningTokens, 150);
  assert.equal(response.meta.tokensInput, 1000);
});

test('OpenAI streams reasoning summaries separately from visible text', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test' });
  (provider as unknown as { client: unknown }).client = {
    responses: {
      async create() {
        return asyncGenerator([
          { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
          { type: 'response.output_text.delta', delta: 'answer' },
          {
            type: 'response.completed',
            response: {
              model: 'gpt-5.5-pro',
              usage: {
                input_tokens: 100,
                output_tokens: 40,
                input_tokens_details: { cached_tokens: 60 },
                output_tokens_details: { reasoning_tokens: 30 },
              },
            },
          },
        ]);
      },
    },
  };

  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream(request({ model: 'gpt-5.5-pro', reasoning: { summary: 'auto' } }))) {
    chunks.push(chunk);
  }

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['reasoning', 'text', 'done'],
  );
  assert.equal(chunks[0].content, 'thinking');
  assert.equal(chunks[1].content, 'answer');
  assert.equal(chunks[2].meta?.usage?.inputTokens, 40);
  assert.equal(chunks[2].meta?.usage?.cachedReadTokens, 60);
  assert.equal(chunks[2].meta?.usage?.reasoningTokens, 30);
});

test('Anthropic places cache breakpoints and caps them at the provider limit', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test' });
  let captured: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    messages: {
      async create(params: Record<string, unknown>) {
        captured = params;
        return {
          model: 'claude-sonnet-5-0',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 40 },
        };
      },
    },
  };

  const response = await provider.complete({
    model: 'claude-sonnet-5-0',
    cache: { mode: 'explicit', ttl: '1h' },
    tools: [{ name: 'lookup', description: 'x', parameters: {}, cache: true }],
    messages: [
      { role: 'system', content: 'policy', cache: true },
      { role: 'user', content: 'a', cache: true },
      { role: 'assistant', content: 'b', cache: true },
      { role: 'user', content: 'c', cache: true },
      { role: 'user', content: 'd' },
    ],
  });

  // Five marks, four slots: the tool mark is the shallowest and is the one that loses out.
  const tools = captured.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0].cache_control, undefined);

  const system = captured.system as Array<Record<string, unknown>>;
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral', ttl: '1h' });

  const messages = captured.messages as Array<{ content: unknown }>;
  const marked = messages.filter(
    (message) => Array.isArray(message.content) && message.content.some((block) => 'cache_control' in block),
  );
  assert.equal(marked.length, 3);

  // Anthropic reports cache tokens outside input_tokens, so nothing is subtracted.
  assert.equal(response.meta.usage?.inputTokens, 10);
  assert.equal(response.meta.usage?.cachedReadTokens, 2000);
  assert.equal(response.meta.usage?.cachedWriteTokens, 40);
  assert.equal(response.meta.tokensInput, 2050);
  assert.ok(response.meta.cost);
  assert.ok(response.meta.cost.amount > 0, 'pricing now comes from the registry instead of a hardcoded rate');
});

test('every Claude release from 3.7 onward is declared as a reasoning model', () => {
  for (const model of ['claude-sonnet-5-0', 'claude-haiku-5-0', 'claude-opus-4-8', 'claude-3-7-sonnet-20250219']) {
    assert.notEqual(describeModel(model).capabilities?.reasoning, false, `${model} supports extended thinking`);
  }
  for (const model of ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307']) {
    assert.equal(describeModel(model).capabilities?.reasoning, false, `${model} predates extended thinking`);
  }
});

test('Anthropic enables extended thinking with room for visible output', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test' });
  let captured: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    messages: {
      async create(params: Record<string, unknown>) {
        captured = params;
        return { model: 'claude-sonnet-5-0', content: [], stop_reason: 'end_turn' };
      },
    },
  };

  await provider.complete(
    request({ model: 'claude-sonnet-5-0', maxTokens: 1000, temperature: 0.7, reasoning: { effort: 'high' } }),
  );

  assert.deepEqual(captured.thinking, { type: 'enabled', budget_tokens: 16384 });
  assert.equal(captured.max_tokens, 16384 + 1024);
  assert.equal(captured.temperature, undefined, 'Anthropic rejects temperature while thinking is enabled');
});

test('Anthropic streams thinking deltas as reasoning chunks with final usage', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test' });
  (provider as unknown as { client: unknown }).client = {
    messages: {
      stream() {
        return asyncGenerator([
          { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 500 } } },
          { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
          { type: 'message_delta', usage: { output_tokens: 9 } },
          { type: 'message_stop' },
        ]);
      },
    },
  };

  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream(request({ model: 'claude-sonnet-5-0' }))) {
    chunks.push(chunk);
  }

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['reasoning', 'text', 'done'],
  );
  assert.equal(chunks[0].content, 'hmm');
  assert.equal(chunks[2].meta?.usage?.inputTokens, 12);
  assert.equal(chunks[2].meta?.usage?.cachedReadTokens, 500);
  assert.equal(chunks[2].meta?.usage?.outputTokens, 9);
});

// ── End to end ─────────────────────────────────────────────────────

class RecordingProvider extends BaseProvider {
  readonly info = { name: 'recording', isLocal: false };
  lastRequest?: CompletionRequest;

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    this.lastRequest = request;
    return {
      content: 'ok',
      role: 'assistant',
      finishReason: 'stop',
      meta: {
        requestId: 'req',
        providerUsed: this.info.name,
        modelUsed: request.model,
        latencyMs: 1,
        tokensInput: 1000,
        tokensOutput: 500,
        tokensSaved: 0,
        estimatedCost: '$0.00',
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  stream(): NexusStream {
    throw new Error('not used');
  }
}

test('NexusAI negotiates against the routed model and reports the outcome on the response', async () => {
  const provider = new RecordingProvider();
  const ai = new NexusAI({ providers: {}, routing: { mode: 'direct' }, security: 'off' });
  ai.registerProvider('anthropic', provider);

  const response = await ai.complete(
    request({ model: 'claude-sonnet-5-0', reasoning: { effort: 'high' }, maxTokens: 999_999 }),
  );

  assert.equal(provider.lastRequest?.maxTokens, 64000, 'the output limit is clamped before the provider call');
  assert.equal(provider.lastRequest?.reasoning?.effort, 'high', 'Claude 5 supports extended thinking');
  assert.equal(response.meta.capabilityWarnings?.length, 1);
  assert.equal(response.meta.capabilityWarnings?.[0].feature, 'maxTokens');
  assert.ok(response.meta.usage, 'a provider that omits structured usage still gets it filled in');
  assert.ok(response.meta.cost);
  assert.equal(response.meta.usage.totalTokens, 1500);
});

test('a strict capability policy fails the request instead of silently changing it', async () => {
  const ai = new NexusAI({
    providers: {},
    routing: { mode: 'direct' },
    security: 'off',
    capabilities: { policy: 'strict' },
  });
  ai.registerProvider('anthropic', new RecordingProvider());

  await assert.rejects(
    () => ai.complete(request({ model: 'claude-sonnet-5-0', responseFormat: { type: 'json' } })),
    NexusCapabilityError,
  );
});

test('plan reports capability problems before a provider is called', () => {
  const ai = new NexusAI({ providers: {}, routing: { mode: 'direct' }, security: 'off' });
  ai.registerProvider('anthropic', new RecordingProvider());

  const plan = ai.plan(request({ model: 'claude-sonnet-5-0', maxTokens: 999_999 }));

  assert.ok(plan.warnings.some((warning) => warning.includes('maxTokens was adjusted')));
});
