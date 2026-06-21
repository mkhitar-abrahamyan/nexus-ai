import assert from 'node:assert/strict';

const imports = [
  { specifier: 'nexus-ai-pro', exports: ['NexusAI', 'BaseProvider', 'NexusProviderError', 'Router'] },
  { specifier: 'nexus-ai-pro/core', exports: ['NexusAI'] },
  { specifier: 'nexus-ai-pro/streaming', exports: ['collectStream', 'createTextStream'] },
  { specifier: 'nexus-ai-pro/providers', exports: ['BaseProvider', 'NexusProviderError'] },
  { specifier: 'nexus-ai-pro/providers/openai', exports: ['OpenAIProvider'] },
  { specifier: 'nexus-ai-pro/providers/anthropic', exports: ['AnthropicProvider'] },
  { specifier: 'nexus-ai-pro/providers/errors', exports: ['NexusProviderError'] },
  { specifier: 'nexus-ai-pro/providers/google', exports: ['GoogleProvider'] },
  { specifier: 'nexus-ai-pro/providers/ollama', exports: ['OllamaProvider'] },
  { specifier: 'nexus-ai-pro/providers/openrouter', exports: ['OpenRouterProvider'] },
  { specifier: 'nexus-ai-pro/providers/groq', exports: ['GroqProvider'] },
  { specifier: 'nexus-ai-pro/providers/mistral', exports: ['MistralProvider'] },
  { specifier: 'nexus-ai-pro/providers/cohere', exports: ['CohereProvider'] },
  { specifier: 'nexus-ai-pro/security', exports: ['SecurityPipeline', 'NexusSecurityError'] },
  { specifier: 'nexus-ai-pro/optimizer', exports: ['TokenOptimizer', 'BudgetEnforcer'] },
  { specifier: 'nexus-ai-pro/context', exports: ['ContextWindowManager'] },
  { specifier: 'nexus-ai-pro/voice', exports: ['VoiceManager', 'VoiceProviderError', 'VoiceSession'] },
  { specifier: 'nexus-ai-pro/voice/openai', exports: ['OpenAIVoiceProvider'] },
  { specifier: 'nexus-ai-pro/voice/session', exports: ['VoiceSession'] },
  { specifier: 'nexus-ai-pro/telephony', exports: ['TelephonyManager', 'createVoiceTwiML'] },
  { specifier: 'nexus-ai-pro/telephony/twilio', exports: ['TwilioTelephonyProvider'] },
  { specifier: 'nexus-ai-pro/cache', exports: ['MemoryCacheAdapter'] },
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
