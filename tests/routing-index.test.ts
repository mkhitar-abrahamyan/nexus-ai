/**
 * The routing index: the auto-router plans once per configuration and pays per request only for
 * health and open circuits. Its decisions are checked against the published 2.1.0 router on random
 * configurations, so the plan changes how fast a route is found, never which route.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router as Router21 } from 'nexus-ai-pro-2-1/router';
import { AutoRouter } from '../src/router/auto-router.js';
import { Router } from '../src/router/index.js';
import type { ProviderHealthSnapshot } from '../src/ops/health.js';
import type { BaseProvider } from '../src/providers/base.js';
import type { NexusAIConfig } from '../src/types/config.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { ModelCapabilities } from '../src/types/providers.js';

/** A small deterministic generator, so a failure names a seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'mistral', 'ollama'];

function registryOf(size: number, next: () => number): Record<string, ModelCapabilities> {
  const registry: Record<string, ModelCapabilities> = {};
  for (let index = 0; index < size; index += 1) {
    const provider = PROVIDERS[index % PROVIDERS.length] as string;
    const name = provider === 'ollama' ? `ollama/m${index}` : `${provider}-m${index}${next() < 0.2 ? '-mini' : ''}`;
    registry[name] = {
      provider,
      inputModalities: next() < 0.5 ? ['text', 'image'] : ['text'],
      outputModalities: ['text'],
      streaming: next() < 0.9,
      toolCalling: next() < 0.7,
      ...(next() < 0.5 ? { structuredOutputs: next() < 0.7 } : {}),
      ...(next() < 0.4 ? { reasoning: true } : {}),
      maxContextTokens: Math.round(8_000 + next() * 400_000),
      costPer1kInput: Math.round(next() * 1000) / 100_000,
      costPer1kOutput: Math.round(next() * 4000) / 100_000,
      ...(next() < 0.3 ? { qualityScore: Math.round(next() * 100) } : {}),
      ...(next() < 0.3 ? { speedScore: Math.round(next() * 100) } : {}),
    } as ModelCapabilities;
  }
  return registry;
}

function providersOf(names: readonly string[]): Map<string, BaseProvider> {
  return new Map(names.map((name) => [name, { info: { isLocal: name === 'ollama' } } as unknown as BaseProvider]));
}

function healthOf(names: readonly string[], next: () => number): ProviderHealthSnapshot[] {
  return names.map(
    (providerName) =>
      ({ providerName, healthy: next() < 0.8, score: Math.round(next() * 100) }) as unknown as ProviderHealthSnapshot,
  );
}

const request: CompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

test('the planned router routes exactly as the 2.1.0 router on 300 random configurations', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = random(seed);
    const registry = registryOf(20 + Math.floor(next() * 60), next);
    const names = PROVIDERS.filter(() => next() < 0.75);
    if (names.length === 0) names.push('openai');
    const strategies = ['quality', 'cost', 'speed', 'privacy'] as const;
    const config: NexusAIConfig = {
      providers: {},
      models: { registry, includeDefaults: false },
      routing: {
        mode: 'auto',
        strategy: strategies[seed % strategies.length],
        ...(next() < 0.3 ? { allowModels: ['openai-*', 'anthropic-*', 'ollama/*', 'groq-m1'] } : {}),
        ...(next() < 0.3 ? { denyModels: ['*-mini', 'google-m2'] } : {}),
        ...(next() < 0.5
          ? {
              requiredCapabilities: {
                ...(next() < 0.5 ? { toolCalling: true } : {}),
                ...(next() < 0.3 ? { streaming: false } : {}),
                ...(next() < 0.3 ? { reasoning: next() < 0.5 } : {}),
                ...(next() < 0.3 ? { minContextTokens: 100_000 } : {}),
                ...(next() < 0.3 ? { maxInputCostPer1k: 0.005 } : {}),
                ...(next() < 0.3 ? { inputModalities: ['image'] } : {}),
              },
            }
          : {}),
      },
      ...(next() < 0.6 ? { health: { enabled: true } } : {}),
    } as NexusAIConfig;
    const providers = providersOf(names);
    const health = next() < 0.7 ? healthOf(names, next) : undefined;
    const openCircuits = next() < 0.4 ? names.filter(() => next() < 0.5) : undefined;

    const route = (router: { route: Router['route'] }) => {
      try {
        return router.route(request, config, providers, health, openCircuits);
      } catch (error) {
        return { error: (error as Error).message };
      }
    };
    const current = new Router();
    const expected = route(new Router21() as unknown as Router);
    assert.deepEqual(route(current), expected, `seed ${seed}`);
    // A second request reuses the plan and still agrees.
    assert.deepEqual(route(current), expected, `seed ${seed}, warm`);
  }
});

test('a plan is built once per configuration and rebuilt when the configuration is replaced', () => {
  const next = random(7);
  const config: NexusAIConfig = {
    providers: {},
    models: { registry: registryOf(100, next), includeDefaults: false },
    routing: { mode: 'auto', strategy: 'cost', requiredCapabilities: { toolCalling: true } },
  } as NexusAIConfig;
  const providers = providersOf(['openai', 'anthropic']);
  const router = new AutoRouter();
  const context = { request, config, providers };
  const first = router.route(context);
  for (let index = 0; index < 50; index += 1) router.route(context);
  assert.equal(router.planCount, 1, 'fifty requests, one plan');

  // Equal requirements in another key order share the plan.
  router.route({
    ...context,
    config: { ...config, routing: { ...config.routing, requiredCapabilities: { toolCalling: true } } } as NexusAIConfig,
  });
  assert.equal(router.planCount, 1);

  const cheaper = { ...config, routing: { ...config.routing, strategy: 'quality' } } as NexusAIConfig;
  router.route({ ...context, config: cheaper });
  assert.equal(router.planCount, 2, 'a new strategy is a new plan');
  const replaced = { ...config, models: { ...config.models, registry: { ...config.models?.registry } } };
  router.route({ ...context, config: replaced });
  assert.equal(router.planCount, 3, 'a replaced registry is a new plan');
  assert.throws(
    () => Object.assign(first.fallbacks[0] as object, { model: 'changed' }),
    TypeError,
    'attempts are frozen',
  );
});

// The strict budget, under 100 µs at p50 and 1 ms at p99, is held by `npm run bench:runtime`, which runs
// without the coverage instrumentation this suite also runs under. Here the bound is loose and the
// comparison with 2.1.0 is what matters.
test('a warm plan over 1,000 models routes in microseconds, with health and open circuits applied per request', () => {
  const next = random(42);
  const names = PROVIDERS.slice(0, 5);
  const config: NexusAIConfig = {
    providers: {},
    models: { registry: registryOf(1_000, next), includeDefaults: false },
    routing: { mode: 'auto', strategy: 'quality', requiredCapabilities: { toolCalling: true } },
    health: { enabled: true },
  } as NexusAIConfig;
  const providers = providersOf(names);
  const health = healthOf(names, next);
  const router = new Router();
  const old = new Router21() as unknown as Router;

  const time = (target: Router, runs: number, openCircuits?: string[]) => {
    const samples: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      target.route(request, config, providers, health, openCircuits);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    return {
      p50: (samples[Math.floor(runs * 0.5)] as number) * 1000,
      p99: (samples[Math.floor(runs * 0.99)] as number) * 1000,
    };
  };
  time(router, 200); // warm: builds the plan, lets the JIT settle
  const warm = time(router, 2_000);
  const withOpen = time(router, 2_000, ['groq']);
  const before = time(old, 3);
  console.log(
    `routing over 1,000 models: p50 ${warm.p50.toFixed(1)} µs, p99 ${warm.p99.toFixed(1)} µs; with an open circuit p50 ${withOpen.p50.toFixed(1)} µs; 2.1.0 p50 ${before.p50.toFixed(0)} µs`,
  );
  assert.ok(warm.p50 < 1_000, `p50 ${warm.p50.toFixed(1)} µs`);
  assert.ok(warm.p99 < 5_000, `p99 ${warm.p99.toFixed(1)} µs`);
  assert.ok(withOpen.p50 < 1_000, `p50 with an open circuit ${withOpen.p50.toFixed(1)} µs`);
  assert.ok(before.p50 > warm.p50 * 100, '2.1.0 was at least a hundred times slower');
});
