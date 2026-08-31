import assert from 'node:assert/strict';

const imports = [
  {
    specifier: 'nexus-ai-pro',
    exports: ['NexusAI', 'createNexus', 'createNexusConfig', 'BaseProvider', 'NexusProviderError', 'Router'],
  },
  { specifier: 'nexus-ai-pro/core', exports: ['NexusAI'] },
  { specifier: 'nexus-ai-pro/streaming', exports: ['collectStream', 'createTextStream'] },
  { specifier: 'nexus-ai-pro/config', exports: ['NexusConfigBuilder', 'createNexusConfig', 'defineNexusConfig'] },
  { specifier: 'nexus-ai-pro/providers', exports: ['BaseProvider', 'NexusProviderError'] },
  { specifier: 'nexus-ai-pro/providers/base', exports: ['BaseProvider', 'NexusProviderError'] },
  { specifier: 'nexus-ai-pro/providers/openai', exports: ['OpenAIProvider'] },
  { specifier: 'nexus-ai-pro/providers/anthropic', exports: ['AnthropicProvider'] },
  { specifier: 'nexus-ai-pro/providers/errors', exports: ['NexusProviderError'] },
  { specifier: 'nexus-ai-pro/providers/google', exports: ['GoogleProvider'] },
  { specifier: 'nexus-ai-pro/providers/ollama', exports: ['OllamaProvider'] },
  { specifier: 'nexus-ai-pro/providers/openrouter', exports: ['OpenRouterProvider'] },
  { specifier: 'nexus-ai-pro/providers/groq', exports: ['GroqProvider'] },
  { specifier: 'nexus-ai-pro/providers/mistral', exports: ['MistralProvider'] },
  { specifier: 'nexus-ai-pro/providers/cohere', exports: ['CohereProvider'] },
  { specifier: 'nexus-ai-pro/providers/deepseek', exports: ['DeepSeekProvider'] },
  { specifier: 'nexus-ai-pro/providers/azure-openai', exports: ['AzureOpenAIProvider'] },
  { specifier: 'nexus-ai-pro/providers/lmstudio', exports: ['LMStudioProvider'] },
  { specifier: 'nexus-ai-pro/providers/llamacpp', exports: ['LlamaCppProvider'] },
  { specifier: 'nexus-ai-pro/providers/type-guards', exports: ['isRecord', 'getString'] },
  { specifier: 'nexus-ai-pro/security', exports: ['SecurityPipeline', 'NexusSecurityError'] },
  { specifier: 'nexus-ai-pro/optimizer', exports: ['TokenOptimizer', 'BudgetEnforcer'] },
  { specifier: 'nexus-ai-pro/context', exports: ['ContextWindowManager'] },
  { specifier: 'nexus-ai-pro/voice', exports: ['VoiceManager', 'VoiceProviderError', 'VoiceSession'] },
  { specifier: 'nexus-ai-pro/voice/openai', exports: ['OpenAIVoiceProvider'] },
  { specifier: 'nexus-ai-pro/voice/session', exports: ['VoiceSession'] },
  { specifier: 'nexus-ai-pro/images', exports: ['ImageManager', 'ImageProviderError'] },
  { specifier: 'nexus-ai-pro/images/assets', exports: ['MemoryAssetStore', 'AssetStoreCapacityError'] },
  { specifier: 'nexus-ai-pro/images/mock', exports: ['MockImageProvider'] },
  { specifier: 'nexus-ai-pro/images/openai', exports: ['OpenAIImageProvider', 'OpenAIImageProviderError'] },
  {
    specifier: 'nexus-ai-pro/embeddings',
    exports: ['EmbeddingManager', 'EmbeddingProviderError', 'MockEmbeddingProvider', 'OpenAIEmbeddingProvider'],
  },
  {
    specifier: 'nexus-ai-pro/embeddings/adapters',
    exports: ['OpenAIEmbeddingProvider', 'CohereEmbeddingProvider', 'OllamaEmbeddingProvider'],
  },
  { specifier: 'nexus-ai-pro/embeddings/mock', exports: ['MockEmbeddingProvider'] },
  { specifier: 'nexus-ai-pro/embeddings/models', exports: ['KNOWN_EMBEDDING_MODELS', 'resolveEmbeddingModel'] },
  {
    specifier: 'nexus-ai-pro/operations',
    exports: ['OperationRunner', 'MemoryOperationStore', 'LocalOperationHandle', 'OperationCancelledError'],
  },
  { specifier: 'nexus-ai-pro/operations/adapters', exports: ['RedisOperationStore', 'BullMQOperationDispatcher'] },
  { specifier: 'nexus-ai-pro/operations/webhooks', exports: ['signOperationWebhook', 'verifyOperationWebhook'] },
  {
    specifier: 'nexus-ai-pro/realtime',
    exports: [
      'RealtimeSession',
      'createRealtimeSession',
      'createRealtimeAgent',
      'defineTool',
      'OpenAIRealtimeProvider',
      'MockRealtimeTransport',
    ],
  },
  { specifier: 'nexus-ai-pro/realtime/session', exports: ['RealtimeSession', 'createRealtimeSession'] },
  { specifier: 'nexus-ai-pro/realtime/tools', exports: ['RealtimeToolExecutor', 'defineTool'] },
  {
    specifier: 'nexus-ai-pro/realtime/conversation',
    exports: ['createRealtimeConversation', 'exportRealtimeConversation', 'reduceRealtimeConversation'],
  },
  { specifier: 'nexus-ai-pro/realtime/openai-webrtc', exports: ['OpenAIWebRTCTransport'] },
  { specifier: 'nexus-ai-pro/realtime/openai-websocket', exports: ['OpenAIWebSocketTransport'] },
  {
    specifier: 'nexus-ai-pro/realtime/openai-server',
    exports: ['createOpenAIRealtimeCall', 'createOpenAIRealtimeClientSecret'],
  },
  { specifier: 'nexus-ai-pro/realtime/mock', exports: ['MockRealtimeTransport'] },
  {
    specifier: 'nexus-ai-pro/telephony',
    exports: ['TelephonyManager', 'createVoiceTwiML', 'createTelephonyRealtimeBridge'],
  },
  {
    specifier: 'nexus-ai-pro/telephony/realtime-bridge',
    exports: ['createTelephonyRealtimeBridge', 'twilioRealtimeAudioOptions'],
  },
  { specifier: 'nexus-ai-pro/telephony/twilio', exports: ['TwilioTelephonyProvider'] },
  { specifier: 'nexus-ai-pro/cache', exports: ['MemoryCacheAdapter'] },
  { specifier: 'nexus-ai-pro/cache/adapters', exports: ['MemoryCacheAdapter'] },
  { specifier: 'nexus-ai-pro/cache/memory-cache', exports: ['MemoryCache', 'createCacheKey'] },
  { specifier: 'nexus-ai-pro/cache/semantic-cache', exports: ['SemanticCache'] },
  { specifier: 'nexus-ai-pro/models', exports: ['getModelRegistry', 'resolveModel'] },
  { specifier: 'nexus-ai-pro/rag', exports: ['ingestDocuments', 'ingestText'] },
  { specifier: 'nexus-ai-pro/evals', exports: ['EvalRunner', 'LLMJudge'] },
  { specifier: 'nexus-ai-pro/evals/judge', exports: ['LLMJudge', 'createLLMJudgeEval'] },
  { specifier: 'nexus-ai-pro/jobs', exports: ['JobQueue'] },
  { specifier: 'nexus-ai-pro/jobs/batch', exports: ['runBatch'] },
  { specifier: 'nexus-ai-pro/jobs/queue', exports: ['JobQueue'] },
  { specifier: 'nexus-ai-pro/jobs/durable-adapters', exports: ['RedisQueueAdapter', 'BullMQQueueAdapter'] },
  { specifier: 'nexus-ai-pro/workflows', exports: ['summarizeVerifyFormat', 'ragAnswer'] },
];

for (const item of imports) {
  const module = await import(item.specifier);
  for (const exportName of item.exports) {
    assert.ok(exportName in module, `${item.specifier} should export ${exportName}`);
  }
  console.log(`ok - ${item.specifier}`);
}

// The package is authored as ESM but ships a CommonJS build so require()-based consumers
// (NestJS and other tsc "module": "commonjs" apps) can load it without a dynamic import shim.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

for (const item of imports) {
  const module = require(item.specifier);
  for (const exportName of item.exports) {
    assert.ok(exportName in module, `require("${item.specifier}") should export ${exportName}`);
  }
  console.log(`ok - require(${item.specifier})`);
}
