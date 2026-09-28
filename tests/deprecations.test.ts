import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsCollector } from '../src/ops/metrics.js';
import { ProviderHealthMonitor } from '../src/ops/health.js';
import { TokenOptimizer } from '../src/optimizer/index.js';
import { GoogleProvider } from '../src/providers/google.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { SecurityPipeline } from '../src/security/index.js';

test('each deprecated option warns once per process, through the DeprecationWarning channel', async () => {
  const seen: Array<{ name: string; code?: string; message: string }> = [];
  const listener = (warning: Error & { code?: string }) => {
    seen.push({ name: warning.name, code: warning.code, message: warning.message });
  };
  process.on('warning', listener);

  const construct = () => {
    new GoogleProvider({ apiKey: 'k', projectId: 'p' });
    new OllamaProvider({ timeout: 10 });
    new MetricsCollector({ enabled: true, prometheus: true });
    new ProviderHealthMonitor({ enabled: true, latencyHalfLife: 5 });
    new TokenOptimizer({ densification: { enabled: true, preserveMarkdown: true } });
    new SecurityPipeline({
      input: { injectionDetection: { sensitivity: 0.5 }, tools: { requiresApproval: ['refund'] } },
    });
  };
  construct();
  construct();
  // Warnings are delivered on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  process.off('warning', listener);

  const codes = seen.filter((warning) => warning.name === 'DeprecationWarning').map((warning) => warning.code);
  assert.deepEqual(codes.sort(), [
    'NEXUS_DEP_DENSIFICATION_PRESERVE_MARKDOWN',
    'NEXUS_DEP_GOOGLE_PROJECT_ID',
    'NEXUS_DEP_HEALTH_LATENCY_HALF_LIFE',
    'NEXUS_DEP_INJECTION_SENSITIVITY',
    'NEXUS_DEP_METRICS_PROMETHEUS',
    'NEXUS_DEP_OLLAMA_TIMEOUT',
    'NEXUS_DEP_TOOL_REQUIRES_APPROVAL',
  ]);
  assert.match(seen.find((warning) => warning.code === 'NEXUS_DEP_OLLAMA_TIMEOUT')?.message ?? '', /removed in 2\.0/);
});

test('configuration without deprecated options warns about nothing', async () => {
  const seen: unknown[] = [];
  const listener = (warning: Error) => seen.push(warning);
  process.on('warning', listener);
  new GoogleProvider({ apiKey: 'k' });
  new SecurityPipeline('strict');
  new SecurityPipeline({ level: 'standard' });
  new TokenOptimizer();
  await new Promise((resolve) => setImmediate(resolve));
  process.off('warning', listener);
  assert.deepEqual(seen, []);
});
