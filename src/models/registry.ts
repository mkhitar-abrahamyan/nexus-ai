import type { NexusAIConfig } from '../types/config.js';
import { KNOWN_MODELS, MODEL_ALIASES, resolveProvider, type ModelCapabilities } from '../types/providers.js';

export interface ResolvedModel {
  requestedModel: string;
  model: string;
  providerName: string | null;
  capabilities?: ModelCapabilities;
}

export function resolveModelAlias(model: string, aliases: Record<string, string> = {}): string {
  return aliases[model] || MODEL_ALIASES[model] || model;
}

export function getModelRegistry(config?: Pick<NexusAIConfig, 'models'>): Record<string, ModelCapabilities> {
  return {
    ...(config?.models?.includeDefaults === false ? {} : KNOWN_MODELS),
    ...(config?.models?.registry || {}),
  };
}

export function getModelAliases(config?: Pick<NexusAIConfig, 'models'>): Record<string, string> {
  return {
    ...MODEL_ALIASES,
    ...(config?.models?.aliases || {}),
  };
}

export function resolveModel(model: string, config?: Pick<NexusAIConfig, 'models'>): ResolvedModel {
  const aliases = getModelAliases(config);
  const registry = getModelRegistry(config);
  const resolved = resolveModelAlias(model, aliases);
  const normalized = resolved.startsWith('ollama/') ? resolved.slice(7) : resolved;

  return {
    requestedModel: model,
    model: resolved,
    providerName: resolveProvider(resolved) || (resolved.includes('/') ? resolved.split('/')[0] : null),
    capabilities: registry[resolved] || registry[normalized],
  };
}

export function listKnownModels(config?: Pick<NexusAIConfig, 'models'>): string[] {
  return Object.keys(getModelRegistry(config)).sort();
}

export function listModelsForProvider(providerName: string, config?: Pick<NexusAIConfig, 'models'>): string[] {
  const registry = getModelRegistry(config);
  return Object.entries(registry)
    .filter(([model, capabilities]) => {
      return capabilities.provider === providerName || resolveProvider(model) === providerName;
    })
    .map(([model]) => model)
    .sort();
}

export function getModelCapabilities(
  model: string,
  config?: Pick<NexusAIConfig, 'models'>,
): ModelCapabilities | undefined {
  return resolveModel(model, config).capabilities;
}
