import { OpenAIProvider } from 'nexus-ai-pro/providers/openai';
import { AnthropicProvider } from 'nexus-ai-pro/providers/anthropic';
import { GoogleProvider } from 'nexus-ai-pro/providers/google';
import { OllamaProvider } from 'nexus-ai-pro/providers/ollama';
import { GroqProvider } from 'nexus-ai-pro/providers/groq';
import { MistralProvider } from 'nexus-ai-pro/providers/mistral';
import { CohereProvider } from 'nexus-ai-pro/providers/cohere';
import { OpenRouterProvider } from 'nexus-ai-pro/providers/openrouter';
import { DeepSeekProvider } from 'nexus-ai-pro/providers/deepseek';
import { AzureOpenAIProvider } from 'nexus-ai-pro/providers/azure-openai';
import { LMStudioProvider } from 'nexus-ai-pro/providers/lmstudio';
import { LlamaCppProvider } from 'nexus-ai-pro/providers/llamacpp';

const providers = [
  new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY || 'dev-key' }),
  new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY || 'dev-key' }),
  new GoogleProvider({ apiKey: process.env.GOOGLE_API_KEY || 'dev-key' }),
  new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' }),
  new GroqProvider({ apiKey: process.env.GROQ_API_KEY || 'dev-key' }),
  new MistralProvider({ apiKey: process.env.MISTRAL_API_KEY || 'dev-key' }),
  new CohereProvider({ apiKey: process.env.COHERE_API_KEY || 'dev-key' }),
  new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY || 'dev-key' }),
  new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY || 'dev-key' }),
  new AzureOpenAIProvider({
    apiKey: process.env.AZURE_OPENAI_API_KEY || 'dev-key',
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || 'https://example.openai.azure.com',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'chat',
  }),
  new LMStudioProvider({ baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1' }),
  new LlamaCppProvider({ baseUrl: process.env.LLAMA_CPP_BASE_URL || 'http://localhost:8080/v1' }),
];

console.log(providers.map((provider) => provider.info.name));
