import { createNexus } from 'nexus-ai-pro';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('Set OPENAI_API_KEY before running this example.');
}

const ai = createNexus({
  provider: 'openai',
  apiKey,
  model: 'gpt-5.4-mini',
  security: 'standard',
});

const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Explain model routing in one sentence.' }],
});

console.log(response.content);
