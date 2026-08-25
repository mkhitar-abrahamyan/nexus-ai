import type { NexusAIConfig } from '../types/config.js';
import {
  KNOWN_MODELS,
  MODEL_ALIAS_METADATA,
  MODEL_ALIASES,
  REGISTRY_PROVENANCE,
  resolveProvider,
  type AliasMetadata,
  type ModelCapabilities,
} from '../types/providers.js';

export interface ResolvedModel {
  requestedModel: string;
  model: string;
  providerName: string | null;
  capabilities?: ModelCapabilities;
  /** Present when the requested name was an alias rather than a concrete model. */
  alias?: AliasMetadata;
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

/**
 * Stage and provenance for every alias, with application-registered metadata layered on top.
 *
 * An alias registered through `models.aliases` without metadata is reported as stable, because an
 * application pinning its own alias has already made that choice deliberately.
 */
export function getAliasMetadata(config?: Pick<NexusAIConfig, 'models'>): Record<string, AliasMetadata> {
  return {
    ...MODEL_ALIAS_METADATA,
    ...(config?.models?.aliasMetadata || {}),
  };
}

/**
 * Resolves an alias and looks up model capabilities.
 *
 * This runs on every completion, so it reads the bundled and application maps directly rather than
 * merging them into a new object first. `getModelRegistry()` and `getModelAliases()` remain the
 * merged views for listing and inspection.
 */
export function resolveModel(model: string, config?: Pick<NexusAIConfig, 'models'>): ResolvedModel {
  const models = config?.models;
  const resolved = models?.aliases?.[model] || MODEL_ALIASES[model] || model;
  const normalized = resolved.startsWith('ollama/') ? resolved.slice(7) : resolved;
  const custom = models?.registry;
  const bundled = models?.includeDefaults === false ? undefined : KNOWN_MODELS;

  return {
    requestedModel: model,
    model: resolved,
    providerName: resolveProvider(resolved) || (resolved.includes('/') ? resolved.split('/')[0] : null),
    capabilities:
      custom?.[resolved] || custom?.[normalized] || bundled?.[resolved] || bundled?.[normalized] || undefined,
    alias: resolved === model ? undefined : models?.aliasMetadata?.[model] || MODEL_ALIAS_METADATA[model],
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

export interface ModelProvenance {
  /** The name that was requested, which may be an alias. */
  requestedModel: string;
  /** The concrete model the request resolves to. */
  model: string;
  providerName: string | null;
  verifiedAt: string;
  source: string;
  alias?: AliasMetadata;
  capabilities?: ModelCapabilities;
}

/**
 * Reports where a model entry came from and when it was last checked.
 *
 * Bundled entries fall back to the registry-wide provenance date, so `verifiedAt` is always a real
 * date rather than an absent field a caller has to special-case.
 */
export function describeModel(model: string, config?: Pick<NexusAIConfig, 'models'>): ModelProvenance {
  const resolved = resolveModel(model, config);
  return {
    requestedModel: resolved.requestedModel,
    model: resolved.model,
    providerName: resolved.providerName,
    verifiedAt: resolved.capabilities?.verifiedAt || REGISTRY_PROVENANCE.verifiedAt,
    source: resolved.capabilities?.source || REGISTRY_PROVENANCE.source,
    alias: resolved.alias,
    capabilities: resolved.capabilities,
  };
}

export interface RegistryFreshness {
  verifiedAt: string;
  ageDays: number;
  stale: boolean;
  maxAgeDays: number;
  /** Entries carrying their own `verifiedAt` that are older than the window. */
  staleModels: string[];
}

const DEFAULT_MAX_AGE_DAYS = 180;
const MS_PER_DAY = 86_400_000;

/**
 * Measures how old the bundled registry data is.
 *
 * Model metadata and pricing drift silently as providers change their lineups, so a release check
 * can fail on this rather than discovering the drift from a wrong cost estimate in production.
 */
export function checkRegistryFreshness(
  options: { now?: Date; maxAgeDays?: number; config?: Pick<NexusAIConfig, 'models'> } = {},
): RegistryFreshness {
  const now = options.now || new Date();
  const maxAgeDays = options.maxAgeDays ?? options.config?.models?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const baseline = Date.parse(REGISTRY_PROVENANCE.verifiedAt);
  const ageDays = Math.floor((now.getTime() - baseline) / MS_PER_DAY);

  const staleModels: string[] = [];
  for (const [name, capabilities] of Object.entries(getModelRegistry(options.config))) {
    if (!capabilities.verifiedAt) continue;
    const entryAge = Math.floor((now.getTime() - Date.parse(capabilities.verifiedAt)) / MS_PER_DAY);
    if (entryAge > maxAgeDays) staleModels.push(name);
  }

  return {
    verifiedAt: REGISTRY_PROVENANCE.verifiedAt,
    ageDays,
    stale: ageDays > maxAgeDays || staleModels.length > 0,
    maxAgeDays,
    staleModels: staleModels.sort(),
  };
}

/** Throws when the bundled registry has not been verified inside the configured window. */
export function assertRegistryFreshness(
  options: { now?: Date; maxAgeDays?: number; config?: Pick<NexusAIConfig, 'models'> } = {},
): RegistryFreshness {
  const freshness = checkRegistryFreshness(options);
  if (!freshness.stale) return freshness;

  const detail = freshness.staleModels.length ? ` Stale entries: ${freshness.staleModels.join(', ')}.` : '';
  throw new Error(
    `Model registry was last verified ${freshness.ageDays} days ago (${freshness.verifiedAt}), ` +
      `which exceeds the ${freshness.maxAgeDays}-day window.${detail}`,
  );
}
