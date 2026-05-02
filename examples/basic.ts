import { NexusAI } from 'nexus-ai-pro';

async function main() {
  const ai = new NexusAI({
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
      openai: process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : undefined,
      anthropic: process.env.ANTHROPIC_API_KEY
        ? { apiKey: process.env.ANTHROPIC_API_KEY }
        : undefined,
    },
    routing: {
      mode: 'auto',
      strategy: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? 'quality' : 'privacy',
    },
    debug: true,
  });

  const response = await ai.complete({
    model: 'auto',
    messages: [
      { role: 'user', content: 'Explain what nexus-ai-pro is in 2 short bullets.' },
    ],
  });

  console.log('\nResponse:\n');
  console.log(response.content);
  console.log('\nMeta:\n');
  console.log(response.meta);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
