import { NexusAI } from 'nexus-ai-pro';

async function main() {
  const ai = new NexusAI({
    providers: {
      openai: process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : undefined,
      ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },
    },
    routing: {
      mode: 'direct',
    },
    defaultModel: process.env.NEXUS_MODEL || (process.env.OPENAI_API_KEY ? 'gpt-5.4-mini' : 'ollama/llama3.2'),
    security: 'off',
    tokenOptimizer: {
      enabled: false,
    },
    cache: {
      enabled: false,
    },
    pipeline: {
      enabled: false,
      trace: false,
      includeTraceInResponse: false,
    },
    metrics: {
      enabled: false,
    },
  });

  const response = await ai.complete({
    model: 'auto',
    messages: [
      { role: 'user', content: 'Explain nexus-ai-pro in one sentence.' },
    ],
  });

  console.log(response.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
