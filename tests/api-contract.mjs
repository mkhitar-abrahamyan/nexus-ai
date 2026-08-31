import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const root = await import('nexus-ai-pro');

const expectedRootExports = [
  'AgentLoop',
  'AnthropicProvider',
  'AuditLogger',
  'AzureOpenAIProvider',
  'BaseProvider',
  'BudgetEnforcer',
  'BullMQOperationDispatcher',
  'BullMQQueueAdapter',
  'CohereProvider',
  'CostBudgetError',
  'ContextWindowManager',
  'DeepSeekProvider',
  'EMBEDDING_MODEL_ALIASES',
  'EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES',
  'EMBEDDING_REGISTRY_PROVENANCE',
  'EmbeddingCapabilityError',
  'EmbeddingError',
  'EmbeddingManager',
  'EmbeddingModelNotFoundError',
  'EmbeddingProviderError',
  'EmbeddingProviderNotFoundError',
  'EmbeddingProviderResponseError',
  'EmbeddingValidationError',
  'EvalRunner',
  'FailoverExecutor',
  'GUARDRAIL_POLICIES',
  'GoogleProvider',
  'GroqProvider',
  'IMAGE_PROVIDER_CONFORMANCE_FIXTURES',
  'InMemoryMetrics',
  'InputGuard',
  'InjectionDetector',
  'ImageManager',
  'ImageProviderError',
  'JobQueue',
  'KNOWN_EMBEDDING_MODELS',
  'KNOWN_MODELS',
  'LMStudioProvider',
  'LlamaCppProvider',
  'MemoryCache',
  'MemoryOperationStore',
  'MemoryCacheAdapter',
  'LocalOperationHandle',
  'MemoryVectorStore',
  'MetricsCollector',
  'MistralProvider',
  'MODEL_ALIAS_METADATA',
  'NexusAI',
  'NexusCapabilityError',
  'NexusProviderError',
  'NexusRateLimitError',
  'NexusSecurityError',
  'OllamaProvider',
  'OpenAIProvider',
  'OpenRouterProvider',
  'OpenTelemetryMetricsSink',
  'OPERATION_WEBHOOK_SIGNATURE_HEADER',
  'OperationCancelledError',
  'OperationConflictError',
  'OperationError',
  'OperationExpiredError',
  'OperationLeaseLostError',
  'OperationNotFoundError',
  'OperationRunner',
  'OperationSerializationError',
  'OperationTransitionError',
  'OpenTelemetryTraceExporter',
  'OutputGuard',
  'PIIDetector',
  'PROVIDER_CONFORMANCE_FIXTURES',
  'PipelineRunner',
  'PromptDensifier',
  'ProviderHealthMonitor',
  'RateLimiter',
  'RedisCacheAdapter',
  'RedisOperationStore',
  'RedisQueueAdapter',
  'ResponseFormatError',
  'Router',
  'SEMANTIC_INJECTION_CALIBRATION_SET',
  'SchemaValidator',
  'SecurityPipeline',
  'SemanticCache',
  'SemanticInjectionClassifier',
  'TelephonyCapabilityError',
  'TelephonyManager',
  'TelephonyProviderError',
  'Tokenizer',
  'TokenBudgetError',
  'TERMINAL_OPERATION_STATUSES',
  'TokenOptimizer',
  'ToolExecutor',
  'UploadScanner',
  'VoiceCapabilityError',
  'VoiceManager',
  'VoiceProviderError',
  'VoiceSession',
  'asJsonOnly',
  'allowedTransitions',
  'assertRegistryFreshness',
  'assertSerializableRecord',
  'assertTransition',
  'assertWithinCostBudget',
  'biasScore',
  'buildMeta',
  'buildUsage',
  'calculateEvalMetrics',
  'canTransition',
  'calibrateSemanticInjectionClassifier',
  'checkRegistryFreshness',
  'costAmount',
  'deliverOperationWebhook',
  'describeModel',
  'describeOperationError',
  'ensureUsageAndCost',
  'formatCost',
  'getAliasMetadata',
  'negotiateCompletionRequest',
  'priceEmbeddingUsage',
  'priceUsage',
  'classifyRoute',
  'codeReviewWorkflow',
  'collectStream',
  'compareAndDecide',
  'completeVerified',
  'completeWithSelfConsistency',
  'contextualPrecision',
  'contextualRecall',
  'cosineSimilarity',
  'createCacheKey',
  'createCohereEmbeddingProvider',
  'createFetchUrlTool',
  'createLLMJudgeEval',
  'createGeminiEmbeddingProvider',
  'createHashEmbeddings',
  'createNexus',
  'createNexusConfig',
  'createNexusRouteHandler',
  'createOcrExtractor',
  'createOpenAIEmbeddingProvider',
  'createPdfExtractor',
  'createPipelineContext',
  'createSearchTool',
  'createTextStream',
  'createVoiceTwiML',
  'defineNexusConfig',
  'estimateEmbeddingCost',
  'exactMatch',
  'extractCitations',
  'extractFacts',
  'extractStructured',
  'f1Score',
  'faithfulness',
  'getEmbeddingModelAliases',
  'getEmbeddingModelCapabilities',
  'getEmbeddingModelRegistry',
  'getModelAliases',
  'getModelCapabilities',
  'getModelRegistry',
  'guardrailPolicy',
  'hardenPrompt',
  'ingestDocuments',
  'isClaimable',
  'isSettled',
  'isTerminalOperationStatus',
  'ingestFilesAfterScan',
  'ingestText',
  'legalReviewWorkflow',
  'lexicalEntailment',
  'listEmbeddingModels',
  'listEmbeddingModelsForProvider',
  'listKnownModels',
  'listModelsForProvider',
  'LLMJudge',
  'mapStream',
  'normalizeCreateNexusConfig',
  'passAtK',
  'perplexity',
  'policyAdherence',
  'parseJudgeResponse',
  'ragAnswer',
  'refusalRate',
  'resolveEmbeddingModel',
  'resolveModel',
  'resolveModelAlias',
  'resolveProvider',
  'runBatch',
  'runEmbeddingProviderConformance',
  'runImageProviderConformance',
  'runProviderConformance',
  'salesQualificationWorkflow',
  'scanUploads',
  'selectGraphFacts',
  'signOperationWebhook',
  'selectMostConsistent',
  'semanticSimilarity',
  'summarizeVerifyFormat',
  'supportTriageWorkflow',
  'textSimilarity',
  'toEmbeddingFunction',
  'tokensPerSecond',
  'tool',
  'toxicityScore',
  'validateCitations',
  'verifyOperationWebhook',
  'verifyAgainstContext',
  'withFactualDefaults',
  'withKnowledgeGraphContext',
  'withRagContext',
];

const expectedSubpaths = [
  '.',
  './core',
  './streaming',
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
  './embeddings',
  './embeddings/adapters',
  './embeddings/mock',
  './embeddings/models',
  './operations',
  './operations/adapters',
  './operations/webhooks',
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
  './evals',
  './evals/judge',
  './jobs',
  './jobs/batch',
  './jobs/durable-adapters',
  './jobs/queue',
  './workflows',
  './capabilities',
];

for (const exportName of expectedRootExports) {
  assert.ok(exportName in root, `root export should include ${exportName}`);
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

for (const imageIntegrationExport of ['MockImageProvider', 'OpenAIImageProvider', 'MemoryAssetStore']) {
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
  /(?:from|import\s*)\s*['"].*\/images\/(?:assets|mock|openai)/.test(rootSource),
  false,
  'root import graph should exclude optional image integrations',
);

assert.equal(packageJson.type, 'module');
assert.equal(packageJson.sideEffects, false);
assert.equal(packageJson.engines.node, '>=22.0.0');
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages[''].version, packageJson.version);

console.log('API contract test passed.');
