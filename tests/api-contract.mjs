import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const root = await import('nexus-ai-pro');

/**
 * The 2.0 root: the core client, its config builders, the errors it throws, its lifecycle, and the
 * tool helpers. Exactly these, so nothing a family owns can creep back onto the root.
 */
const expectedRootExports = [
  'BudgetExceededError',
  'CostBudgetError',
  'LIFECYCLE_STAGES',
  'NexusAI',
  'NexusCapabilityError',
  'NexusConfigBuilder',
  'NexusProviderError',
  'NexusRateLimitError',
  'NexusSecurityError',
  'OperationDeniedError',
  'OperationLifecycle',
  'ResponseFormatError',
  'TokenBudgetError',
  'buildMeta',
  'buildUsage',
  'collectStream',
  'costAmount',
  'createNexus',
  'createNexusConfig',
  'createTextStream',
  'defineNexusConfig',
  'ensureUsageAndCost',
  'mapStream',
  'normalizeCreateNexusConfig',
  'priceUsage',
  'tool',
  'toolOutput',
];
/** A few of the names 2.0 moved off the root, which must stay off it. */
const movedOffRoot = ['AgentLoop', 'BaseProvider', 'MemoryVectorStore', 'createGraph', 'SecurityPipeline', 'Router'];

const expectedSubpaths = [
  '.',
  './core',
  './streaming',
  './runtime',
  './config',
  './providers',
  './providers/anthropic',
  './providers/azure-openai',
  './providers/base',
  './providers/cohere',
  './providers/deepseek',
  './providers/errors',
  './providers/google',
  './providers/groq',
  './providers/llamacpp',
  './providers/lmstudio',
  './providers/mistral',
  './providers/ollama',
  './providers/openai',
  './providers/openrouter',
  './providers/type-guards',
  './security',
  './optimizer',
  './context',
  './voice',
  './voice/openai',
  './voice/session',
  './images',
  './images/assets',
  './images/mock',
  './images/openai',
  './images/google',
  './images/comfyui',
  './images/transform',
  './images/inputs',
  './images/moderation',
  './images/evals',
  './embeddings',
  './embeddings/adapters',
  './embeddings/mock',
  './embeddings/models',
  './operations',
  './operations/adapters',
  './operations/webhooks',
  './graph',
  './graph/functional',
  './graph/visualize',
  './graph/lint',
  './sqlite',
  './sqlite/operations',
  './sqlite/store',
  './sqlite/vectors',
  './sqlite/migrations',
  './agent',
  './agent/permissions',
  './agent/sandbox',
  './agent/middleware',
  './deep-agent',
  './store',
  './store/redis',
  './mcp',
  './context-hub',
  './insights',
  './mcp/registry',
  './protocols/ag-ui',
  './protocols/a2a',
  './protocols/acp',
  './tracing',
  './tracing/otlp',
  './tracing/rollups',
  './evaluate',
  './postgres',
  './postgres/operations',
  './postgres/store',
  './postgres/vectors',
  './postgres/fulltext',
  './postgres/traces',
  './postgres/evaluate',
  './postgres/migrations',
  './postgres/rollups',
  './postgres/circuits',
  './postgres/tenancy',
  './postgres/prompts',
  './server',
  './server/remote',
  './grounding',
  './connectors',
  './ops',
  './pipeline',
  './router',
  './testing',
  './adapter-kit',
  './next',
  './rag/files',
  './optimizer/cost',
  './server/deployments',
  './server/tenancy',
  './server/auth',
  './tenancy',
  './doctor',
  './prompts',
  './prompts/client',
  './prompts/registry',
  './prompts/file',
  './prompts/redis',
  './ops/circuit-store',
  './testing/record',
  './ops/circuit-breaker',
  './ops/rate-limit-adapters',
  './batch',
  './batch/openai',
  './batch/anthropic',
  './batch/mock',
  './images/stores',
  './realtime',
  './realtime/session',
  './realtime/tools',
  './realtime/conversation',
  './realtime/openai-webrtc',
  './realtime/openai-websocket',
  './realtime/openai-server',
  './realtime/mock',
  './telephony',
  './telephony/realtime-bridge',
  './telephony/twilio',
  './cache',
  './cache/adapters',
  './cache/memory-cache',
  './cache/semantic-cache',
  './models',
  './rag',
  './rag/qdrant',
  './rag/redis',
  './rag/pinecone',
  './rag/weaviate',
  './rag/chroma',
  './rag/elasticsearch',
  './rag/retrievers',
  './rag/rerankers',
  './rag/pipeline',
  './loaders',
  './loaders/text',
  './loaders/markdown',
  './loaders/html',
  './loaders/csv',
  './loaders/json',
  './loaders/pdf',
  './loaders/web',
  './loaders/git',
  './evals',
  './evals/judge',
  './jobs',
  './jobs/batch',
  './jobs/durable-adapters',
  './jobs/queue',
  './lifecycle',
  './workflows',
  './capabilities',
];

assert.deepEqual(Object.keys(root).sort(), [...expectedRootExports].sort(), 'the root exports exactly the core');
for (const exportName of movedOffRoot) {
  assert.equal(exportName in root, false, `${exportName} moved to a subpath in 2.0 and stays off the root`);
}

for (const subpath of expectedSubpaths) {
  assert.ok(subpath in packageJson.exports, `package exports should include ${subpath}`);
  const entry = packageJson.exports[subpath];

  assert.equal(entry.import.default.endsWith('.js'), true, `${subpath} should expose ESM import`);
  assert.equal(entry.import.types.endsWith('.d.ts'), true, `${subpath} should expose ESM declarations`);
  assert.equal(entry.require.default.endsWith('.js'), true, `${subpath} should expose a CommonJS require`);
  assert.equal(entry.require.types.endsWith('.d.ts'), true, `${subpath} should expose CommonJS declarations`);

  // Each condition must resolve to its own build, or TypeScript reports TS1479 when a CommonJS
  // consumer requires the package and lands on ESM declarations.
  assert.equal(entry.import.default.startsWith('./dist/'), true, `${subpath} ESM import should use dist`);
  assert.equal(entry.require.default.startsWith('./dist-cjs/'), true, `${subpath} require should use dist-cjs`);
  assert.equal(entry.require.types.startsWith('./dist-cjs/'), true, `${subpath} require types should use dist-cjs`);

  // moduleResolution "node10" ignores "exports", so subpath types come from typesVersions instead.
  if (subpath !== '.') {
    const bare = subpath.replace(/^\.\//, '');
    assert.ok(packageJson.typesVersions['*'][bare], `typesVersions should map ${bare} for node10 resolution`);
  }
}

assert.deepEqual(Object.keys(packageJson.exports).sort(), expectedSubpaths.sort());
assert.equal(
  Object.keys(packageJson.exports).some((subpath) => subpath.includes('*')),
  false,
);

for (const realtimeExport of [
  'RealtimeSession',
  'createRealtimeSession',
  'OpenAIWebRTCTransport',
  'OpenAIWebSocketTransport',
]) {
  assert.equal(realtimeExport in root, false, `${realtimeExport} should remain opt-in through realtime subpaths`);
}

for (const embeddingIntegrationExport of [
  'MockEmbeddingProvider',
  'OpenAIEmbeddingProvider',
  'OllamaEmbeddingProvider',
]) {
  assert.equal(
    embeddingIntegrationExport in root,
    false,
    `${embeddingIntegrationExport} should remain opt-in through the embeddings subpath`,
  );
}

for (const optInFamilyExport of [
  'createAgent',
  'MemoryStore',
  'RedisStore',
  'McpClient',
  'McpServer',
  'toMermaid',
  'Tracer',
  'MemoryTraceStore',
  'evaluate',
  'PostgresStore',
  'PostgresOperationStore',
  'PostgresTraceStore',
  'MemoryCircuitStateStore',
  'RedisCircuitStateStore',
  'recordingFetch',
  'replayFetch',
]) {
  assert.equal(optInFamilyExport in root, false, `${optInFamilyExport} should remain opt-in through its subpath`);
}

for (const imageIntegrationExport of [
  'MockImageProvider',
  'OpenAIImageProvider',
  'MemoryAssetStore',
  'GoogleImageProvider',
  'ComfyUIImageProvider',
  'PngMaskTransformer',
  'ImageInputResolver',
  'createOpenAIVisualModeration',
  'MediaEvalRunner',
]) {
  assert.equal(
    imageIntegrationExport in root,
    false,
    `${imageIntegrationExport} should remain opt-in through image subpaths`,
  );
}

const rootSource = readFileSync(path.join(repoRoot, 'dist', 'index.js'), 'utf8');
assert.equal(
  /(?:from|import\s*)\s*['"].*\/realtime\//.test(rootSource),
  false,
  'root import graph should exclude realtime',
);
assert.equal(
  /(?:from|import\s*)\s*['"].*\/images\/(?:assets|mock|openai|google|comfyui|transform|codec|inputs|moderation|evals)/.test(
    rootSource,
  ),
  false,
  'root import graph should exclude optional image integrations',
);

assert.equal(packageJson.type, 'module');
assert.equal(packageJson.sideEffects, false);
assert.equal(packageJson.engines.node, '>=22.0.0');
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages[''].version, packageJson.version);

console.log('API contract test passed.');
