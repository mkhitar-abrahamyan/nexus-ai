import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsCollector } from '../src/ops/metrics.js';
import { ProviderHealthMonitor } from '../src/ops/health.js';
import { TokenOptimizer } from '../src/optimizer/index.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { SecurityPipeline } from '../src/security/index.js';
import { warnDeprecated } from '../src/utils/deprecation.js';

test('a deprecation warns once per code, through the DeprecationWarning channel', async () => {
  const seen: Array<{ name: string; code?: string; message: string }> = [];
  const listener = (warning: Error & { code?: string }) => {
    seen.push({ name: warning.name, code: warning.code, message: warning.message });
  };
  process.on('warning', listener);
  warnDeprecated('NEXUS_DEP_TEST_ONE', 'first is deprecated');
  warnDeprecated('NEXUS_DEP_TEST_ONE', 'first is deprecated');
  warnDeprecated('NEXUS_DEP_TEST_TWO', 'second is deprecated');
  // Warnings are delivered on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  process.off('warning', listener);

  assert.deepEqual(
    seen.filter((warning) => warning.name === 'DeprecationWarning').map((warning) => warning.code),
    ['NEXUS_DEP_TEST_ONE', 'NEXUS_DEP_TEST_TWO'],
  );
});

test('the options 2.0 removed are gone and warn about nothing', async () => {
  const seen: unknown[] = [];
  const listener = (warning: Error) => seen.push(warning);
  process.on('warning', listener);
  // A JavaScript caller that still passes them is not refused: they never did anything.
  const removed = {
    google: { apiKey: 'k', projectId: 'p' },
    ollama: { timeout: 10 },
    metrics: { enabled: true, prometheus: true },
    health: { enabled: true, latencyHalfLife: 5 },
    optimizer: { densification: { enabled: true, preserveMarkdown: true } },
    security: { input: { injectionDetection: { sensitivity: 0.5 }, tools: { requiresApproval: ['refund'] } } },
  } as const;
  new GoogleProvider(removed.google as never);
  new OllamaProvider(removed.ollama as never);
  new MetricsCollector(removed.metrics as never);
  new ProviderHealthMonitor(removed.health as never);
  new TokenOptimizer(removed.optimizer as never);
  new SecurityPipeline(removed.security as never);
  new SecurityPipeline('strict');
  await new Promise((resolve) => setImmediate(resolve));
  process.off('warning', listener);
  assert.deepEqual(seen, []);
});
