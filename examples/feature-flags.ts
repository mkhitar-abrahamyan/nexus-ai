import { NexusAI, guardrailPolicy } from 'nexus-ai-pro';

function envFlag(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

async function main() {
  const enableGuardrails = envFlag('NEXUS_GUARDRAILS');
  const enableCache = envFlag('NEXUS_CACHE');
  const enableTrace = envFlag('NEXUS_TRACE');

  const ai = new NexusAI({
    providers: {
      openai: process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : undefined,
      ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },
    },
    routing: {
      mode: process.env.NEXUS_MODEL ? 'direct' : 'auto',
      strategy: process.env.OPENAI_API_KEY ? 'quality' : 'privacy',
    },
    defaultModel: process.env.NEXUS_MODEL,
    security: enableGuardrails ? guardrailPolicy('enterprise-strict') : 'off',
    tokenOptimizer: {
      enabled: envFlag('NEXUS_OPTIMIZER'),
      densification: { enabled: envFlag('NEXUS_DENSIFY') },
      budget: {
        enabled: envFlag('NEXUS_TOKEN_BUDGET'),
        maxInputTokens: 4000,
        onExceeded: 'densify',
      },
    },
    cache: {
      enabled: enableCache,
      strategy: 'exact',
      ttlSeconds: 300,
    },
    pipeline: {
      enabled: enableTrace,
      trace: enableTrace,
      includeTraceInResponse: enableTrace,
    },
    metrics: {
      enabled: envFlag('NEXUS_METRICS'),
    },
  });

  const response = await ai.complete({
    model: 'auto',
    messages: [
      { role: 'user', content: 'Give me a short production checklist for an AI endpoint.' },
    ],
  });

  console.log(response.content);
  if (response.meta.pipeline) {
    console.log('\nPipeline steps:', response.meta.pipeline.steps.map((step) => step.name));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
