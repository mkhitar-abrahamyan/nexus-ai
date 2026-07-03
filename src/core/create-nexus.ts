import { NexusAI } from './nexus.js';
import type {
  AzureOpenAIProviderConfig,
  CohereProviderConfig,
  DeepSeekProviderConfig,
  GoogleProviderConfig,
  GroqProviderConfig,
  LMStudioProviderConfig,
  LlamaCppProviderConfig,
  MistralProviderConfig,
  NexusAIConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  ProvidersConfig,
} from '../types/config.js';

export type CreateNexusProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | 'groq'
  | 'mistral'
  | 'cohere'
  | 'openrouter'
  | 'deepseek'
  | 'azureOpenAI'
  | 'lmstudio'
  | 'llamaCpp';

export interface CreateNexusOptions extends Omit<Partial<NexusAIConfig>, 'providers'> {
  providers?: ProvidersConfig;
  provider?: CreateNexusProvider;
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  model?: string;
}

/**
 * Creates a `NexusAI` instance from either the full production config or a small beginner shorthand.
 *
 * Use the full `NexusAIConfig` when you need routing, retries, budgets, hooks, or multiple providers.
 * Use the shorthand when you only want one provider and one model.
 *
 * @example
 * ```ts
 * const ai = createNexus({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   model: 'gpt-5.4-mini',
 * });
 * ```
 */
export function createNexus(config: NexusAIConfig | CreateNexusOptions = { providers: {} }): NexusAI {
  return new NexusAI(normalizeCreateNexusConfig(config));
}

/**
 * Converts the beginner shorthand accepted by `createNexus()` into a normal `NexusAIConfig`.
 */
export function normalizeCreateNexusConfig(config: NexusAIConfig | CreateNexusOptions): NexusAIConfig {
  const options = config as CreateNexusOptions;
  const providers = {
    ...(options.providers || {}),
    ...providerFromShorthand(options),
  };
  const defaultModel = options.defaultModel || options.model;
  const routing = options.routing || (defaultModel ? { mode: 'direct' as const } : undefined);

  const normalized: NexusAIConfig = {
    ...(options as Partial<NexusAIConfig>),
    providers: Object.keys(providers).length ? providers : providersFromEnv(),
    ...(routing ? { routing } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  };

  delete (normalized as NexusAIConfig & { provider?: unknown }).provider;
  delete (normalized as NexusAIConfig & { apiKey?: unknown }).apiKey;
  delete (normalized as NexusAIConfig & { baseUrl?: unknown }).baseUrl;
  delete (normalized as NexusAIConfig & { endpoint?: unknown }).endpoint;
  delete (normalized as NexusAIConfig & { deployment?: unknown }).deployment;
  delete (normalized as NexusAIConfig & { apiVersion?: unknown }).apiVersion;
  delete (normalized as NexusAIConfig & { model?: unknown }).model;

  return normalized;
}

function providerFromShorthand(options: CreateNexusOptions): ProvidersConfig {
  if (!options.provider) return {};

  switch (options.provider) {
    case 'openai':
      return { openai: openAIConfig(options) };
    case 'anthropic':
      return { anthropic: { apiKey: options.apiKey || env('ANTHROPIC_API_KEY') || '' } };
    case 'google':
      return { google: googleConfig(options) };
    case 'ollama':
      return { ollama: localConfig(options, 'OLLAMA_BASE_URL', 'http://localhost:11434') };
    case 'groq':
      return { groq: groqConfig(options) };
    case 'mistral':
      return { mistral: mistralConfig(options) };
    case 'cohere':
      return { cohere: cohereConfig(options) };
    case 'openrouter':
      return { openrouter: openRouterConfig(options) };
    case 'deepseek':
      return { deepseek: deepSeekConfig(options) };
    case 'azureOpenAI':
      return { azureOpenAI: azureConfig(options) };
    case 'lmstudio':
      return { lmstudio: localConfig(options, 'LMSTUDIO_BASE_URL', 'http://localhost:1234/v1') };
    case 'llamaCpp':
      return { llamaCpp: localConfig(options, 'LLAMA_CPP_BASE_URL', 'http://localhost:8080/v1') };
  }
}

function providersFromEnv(): ProvidersConfig {
  const providers: ProvidersConfig = {};
  const openai = env('OPENAI_API_KEY');
  const anthropic = env('ANTHROPIC_API_KEY');
  const google = env('GOOGLE_API_KEY');
  const groq = env('GROQ_API_KEY');
  const mistral = env('MISTRAL_API_KEY');
  const cohere = env('COHERE_API_KEY');
  const openrouter = env('OPENROUTER_API_KEY');
  const deepseek = env('DEEPSEEK_API_KEY');

  if (openai) providers.openai = { apiKey: openai };
  if (anthropic) providers.anthropic = { apiKey: anthropic };
  if (google) providers.google = { apiKey: google };
  if (groq) providers.groq = { apiKey: groq };
  if (mistral) providers.mistral = { apiKey: mistral };
  if (cohere) providers.cohere = { apiKey: cohere };
  if (openrouter) providers.openrouter = { apiKey: openrouter };
  if (deepseek) providers.deepseek = { apiKey: deepseek };
  if (env('OLLAMA_BASE_URL')) providers.ollama = { baseUrl: env('OLLAMA_BASE_URL') };
  if (env('LMSTUDIO_BASE_URL')) providers.lmstudio = { baseUrl: env('LMSTUDIO_BASE_URL') };
  if (env('LLAMA_CPP_BASE_URL')) providers.llamaCpp = { baseUrl: env('LLAMA_CPP_BASE_URL') };

  const azureApiKey = env('AZURE_OPENAI_API_KEY');
  const azureEndpoint = env('AZURE_OPENAI_ENDPOINT');
  const azureDeployment = env('AZURE_OPENAI_DEPLOYMENT');
  if (azureApiKey && azureEndpoint && azureDeployment) {
    providers.azureOpenAI = {
      apiKey: azureApiKey,
      endpoint: azureEndpoint,
      deployment: azureDeployment,
      apiVersion: env('AZURE_OPENAI_API_VERSION'),
    };
  }

  return providers;
}

function openAIConfig(options: CreateNexusOptions): OpenAIProviderConfig {
  return {
    apiKey: options.apiKey || env('OPENAI_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function googleConfig(options: CreateNexusOptions): GoogleProviderConfig {
  return {
    apiKey: options.apiKey || env('GOOGLE_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function groqConfig(options: CreateNexusOptions): GroqProviderConfig {
  return {
    apiKey: options.apiKey || env('GROQ_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function mistralConfig(options: CreateNexusOptions): MistralProviderConfig {
  return {
    apiKey: options.apiKey || env('MISTRAL_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function cohereConfig(options: CreateNexusOptions): CohereProviderConfig {
  return {
    apiKey: options.apiKey || env('COHERE_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function openRouterConfig(options: CreateNexusOptions): OpenRouterProviderConfig {
  return {
    apiKey: options.apiKey || env('OPENROUTER_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function deepSeekConfig(options: CreateNexusOptions): DeepSeekProviderConfig {
  return {
    apiKey: options.apiKey || env('DEEPSEEK_API_KEY') || '',
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function azureConfig(options: CreateNexusOptions): AzureOpenAIProviderConfig {
  return {
    apiKey: options.apiKey || env('AZURE_OPENAI_API_KEY') || '',
    endpoint: options.endpoint || env('AZURE_OPENAI_ENDPOINT') || '',
    deployment: options.deployment || env('AZURE_OPENAI_DEPLOYMENT') || '',
    apiVersion: options.apiVersion || env('AZURE_OPENAI_API_VERSION'),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
}

function localConfig<T extends OllamaProviderConfig | LMStudioProviderConfig | LlamaCppProviderConfig>(
  options: CreateNexusOptions,
  envName: string,
  defaultBaseUrl: string,
): T {
  return {
    baseUrl: options.baseUrl || env(envName) || defaultBaseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  } as T;
}

function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}
