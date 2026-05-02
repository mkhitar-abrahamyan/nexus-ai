import {
  AnthropicProvider,
  CohereProvider,
  GoogleProvider,
  GroqProvider,
  MistralProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  runProviderConformance,
  type BaseProvider,
} from '../src/index.js';

const providers: Array<{ name: string; model: string; provider: BaseProvider }> = [];

if (process.env.OPENAI_API_KEY) {
  providers.push({
    name: 'openai',
    model: process.env.OPENAI_CONFORMANCE_MODEL || 'gpt-5.4-mini',
    provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  });
}

if (process.env.ANTHROPIC_API_KEY) {
  providers.push({
    name: 'anthropic',
    model: process.env.ANTHROPIC_CONFORMANCE_MODEL || 'claude-sonnet-4',
    provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  });
}

if (process.env.GOOGLE_API_KEY) {
  providers.push({
    name: 'google',
    model: process.env.GOOGLE_CONFORMANCE_MODEL || 'gemini-2.5-flash',
    provider: new GoogleProvider({ apiKey: process.env.GOOGLE_API_KEY }),
  });
}

if (process.env.GROQ_API_KEY) {
  providers.push({
    name: 'groq',
    model: process.env.GROQ_CONFORMANCE_MODEL || 'groq/openai/gpt-oss-20b',
    provider: new GroqProvider({ apiKey: process.env.GROQ_API_KEY }),
  });
}

if (process.env.MISTRAL_API_KEY) {
  providers.push({
    name: 'mistral',
    model: process.env.MISTRAL_CONFORMANCE_MODEL || 'mistral/mistral-small-2603',
    provider: new MistralProvider({ apiKey: process.env.MISTRAL_API_KEY }),
  });
}

if (process.env.COHERE_API_KEY) {
  providers.push({
    name: 'cohere',
    model: process.env.COHERE_CONFORMANCE_MODEL || 'cohere/command-r7b-12-2024',
    provider: new CohereProvider({ apiKey: process.env.COHERE_API_KEY }),
  });
}

if (process.env.OPENROUTER_API_KEY) {
  providers.push({
    name: 'openrouter',
    model: process.env.OPENROUTER_CONFORMANCE_MODEL || 'openrouter/openai/gpt-5.4-mini',
    provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY }),
  });
}

if (process.env.OLLAMA_CONFORMANCE === 'true') {
  providers.push({
    name: 'ollama',
    model: process.env.OLLAMA_CONFORMANCE_MODEL || 'ollama/llama3.2',
    provider: new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' }),
  });
}

if (!providers.length) {
  console.log('No real provider credentials configured; skipping real conformance.');
  process.exit(0);
}

const allResults = [];
for (const item of providers) {
  const results = await runProviderConformance(item.name, item.provider, {
    model: item.model,
    testStream: process.env.CONFORMANCE_TEST_STREAM === 'true',
    testHealth: true,
  });
  allResults.push(...results);
}

const failed = allResults.filter((result) => !result.completeOk || result.streamOk === false || result.healthOk === false);
console.log(JSON.stringify(allResults, null, 2));

if (failed.length) process.exit(1);
