import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseProvider } from '../src/providers/base.js';
import { NexusProviderError } from '../src/providers/errors.js';
import { FailoverExecutor, Router } from '../src/router/index.js';
import type { NexusAIConfig } from '../src/types/config.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';

function response(provider: string): NexusResponse {
  return {
    content: provider,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'r',
      providerUsed: provider,
      modelUsed: `${provider}/m`,
      latencyMs: 0,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      estimatedCost: '$0.00',
      cacheHit: false,
      guardrailsApplied: [],
    },
  };
}

class ScriptedProvider extends BaseProvider {
  calls = 0;
  constructor(
    readonly info: { name: string; isLocal: boolean },
    private readonly behave: (call: number, request: CompletionRequest) => Promise<NexusResponse>,
  ) {
    super();
  }
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    this.calls += 1;
    return this.behave(this.calls, request);
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}

const down = (name: string) =>
  new ScriptedProvider({ name, isLocal: true }, async () => {
    throw new NexusProviderError({ message: 'overloaded', provider: name, model: 'm', category: 'server-error' });
  });
const up = (name: string) => new ScriptedProvider({ name, isLocal: true }, async () => response(name));
const request: CompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

function route(config: Partial<NexusAIConfig>, providers: Map<string, BaseProvider>, openCircuits: string[] = []) {
  return new Router().route(request, { providers: {}, ...config } as NexusAIConfig, providers, [], openCircuits);
}

test('routing.fallback.onError gives rules-based routing a failover it never had', async () => {
  const providers = new Map<string, BaseProvider>([
    ['alpha', down('alpha')],
    ['beta', up('beta')],
  ]);
  const rulesOnly = route({ routing: { mode: 'rules', rules: [{ when: '*', use: 'alpha/m1' }] } }, providers);
  assert.deepEqual(rulesOnly.fallbacks, [], 'a matched rule used to have nothing to fall back to');

  const decision = route(
    { routing: { mode: 'rules', rules: [{ when: '*', use: 'alpha/m1' }], fallback: { onError: ['beta/m2'] } } },
    providers,
  );
  assert.deepEqual(decision.fallbacks, [{ providerName: 'beta', model: 'beta/m2' }]);
  const answer = await new FailoverExecutor().complete(request, decision, providers);
  assert.equal(answer.content, 'beta');
});

test('configured fallbacks skip missing providers, open circuits, and duplicates', () => {
  const providers = new Map<string, BaseProvider>([
    ['alpha', up('alpha')],
    ['beta', up('beta')],
    ['gamma', up('gamma')],
  ]);
  const decision = route(
    {
      routing: {
        mode: 'rules',
        rules: [{ when: '*', use: 'alpha/m1' }],
        fallback: { onError: ['alpha/m1', 'missing/m9', 'beta/m2', 'gamma/m3', 'beta/m2'] },
      },
    },
    providers,
    ['gamma'],
  );
  assert.deepEqual(
    decision.fallbacks.map((attempt) => attempt.model),
    ['beta/m2'],
  );
});

test('routing.fallback.onTimeout gives up on a slow first attempt and tries its fallback next', async () => {
  const slow = new ScriptedProvider(
    { name: 'alpha', isLocal: true },
    (_call, req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
      }),
  );
  const providers = new Map<string, BaseProvider>([
    ['alpha', slow],
    ['beta', up('beta')],
  ]);
  const decision = route(
    {
      routing: {
        mode: 'rules',
        rules: [{ when: '*', use: 'alpha/m1' }],
        fallback: { onTimeout: { after: 30, fallbackTo: 'beta/m2' } },
      },
    },
    providers,
  );
  assert.equal(decision.primary?.timeoutMs, 30);
  const started = Date.now();
  const answer = await new FailoverExecutor().complete(request, decision, providers, { timeoutMs: 60_000 });
  assert.equal(answer.content, 'beta');
  assert.ok(Date.now() - started < 5_000, 'the first attempt used its own timeout, not the request-wide one');
});

test('routing.fallback.onRateLimit retries a rate-limited first attempt, then falls back', async () => {
  const config: Partial<NexusAIConfig> = {
    routing: {
      mode: 'rules',
      rules: [{ when: '*', use: 'alpha/m1' }],
      fallback: { onRateLimit: { retryAfter: 5, maxRetries: 2, thenFallbackTo: 'beta/m2' } },
    },
  };
  const rateLimited = () =>
    new NexusProviderError({ message: '429', provider: 'alpha', model: 'm', category: 'rate-limit', status: 429 });

  const limited = new ScriptedProvider({ name: 'alpha', isLocal: true }, async () => {
    throw rateLimited();
  });
  const providers = new Map<string, BaseProvider>([
    ['alpha', limited],
    ['beta', up('beta')],
  ]);
  const answer = await new FailoverExecutor().complete(request, route(config, providers), providers);
  assert.equal(answer.content, 'beta');
  assert.equal(limited.calls, 3, 'one attempt and two retries, although retries are off by default');

  const recovering = new ScriptedProvider({ name: 'alpha', isLocal: true }, async (call) => {
    if (call === 1) throw rateLimited();
    return response('alpha');
  });
  const second = new Map<string, BaseProvider>([
    ['alpha', recovering],
    ['beta', up('beta')],
  ]);
  const recovered = await new FailoverExecutor().complete(request, route(config, second), second);
  assert.equal(recovered.content, 'alpha', 'a provider that recovers within the retries keeps the request');
});

test('privacy routing prefers a provider configured with isLocal, not only local model-name prefixes', () => {
  const cloud = new ScriptedProvider({ name: 'cloud', isLocal: false }, async () => response('cloud'));
  const onPrem = new ScriptedProvider({ name: 'onprem', isLocal: true }, async () => response('onprem'));
  const providers = new Map<string, BaseProvider>([
    ['cloud', cloud],
    ['onprem', onPrem],
  ]);
  const decision = route(
    { routing: { mode: 'auto', strategy: 'privacy', candidateModels: ['cloud/big', 'onprem/llama-70b'] } },
    providers,
  );
  assert.equal(decision.providerName, 'onprem');
});
