import { NexusAI, tool } from 'nexus-ai-pro';

const getCurrentTime = tool({
  name: 'get_current_time',
  description: 'Get the current ISO timestamp.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async () => ({ now: new Date().toISOString() }),
});

const calculate = tool<{ expression: string }>({
  name: 'calculate',
  description: 'Evaluate a simple arithmetic expression. Only supports numbers and arithmetic operators.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Arithmetic expression like 2 + 2 * 10' },
    },
    required: ['expression'],
  },
  execute: async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      throw new Error('Unsafe expression');
    }

    return { result: Function(`"use strict"; return (${expression})`)() };
  },
});

async function main() {
  const ai = new NexusAI({
    providers: {
      openai: process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : undefined,
      anthropic: process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : undefined,
      ollama: { baseUrl: 'http://localhost:11434' },
    },
    routing: {
      mode: 'auto',
      strategy: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY ? 'quality' : 'privacy',
    },
    security: 'standard',
    tokenOptimizer: {
      densification: { enabled: true },
      budget: { enabled: true, maxInputTokens: 4000, onExceeded: 'densify' },
    },
    debug: true,
  });

  const result = await ai.agent({
    model: 'auto',
    goal: 'What time is it now, and what is 12 * 7 + 5? Use tools when needed.',
    tools: [getCurrentTime, calculate],
    maxIterations: 5,
    onStep: (step) => {
      console.log(`[${step.iteration}] ${step.type}: ${step.message}`);
      if (step.toolName) console.log(`  tool=${step.toolName}`, step.toolArgs, step.toolResult);
    },
  });

  console.log('\nFinal answer:\n');
  console.log(result.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
