import type { NexusAIConfig } from '../types/config.js';
import type { CostEstimate } from '../types/planning.js';
import type { CacheTtl, ModelCapabilities } from '../types/providers.js';
import { DEFAULT_CACHE_PRICING } from '../types/providers.js';
import { resolveModel } from '../models/registry.js';
import { DEFAULT_CURRENCY, formatCost } from './cost-budget.js';

/**
 * Budget enforcement lives in `optimizer/budget.ts`, which carries no registry dependency, and is
 * re-exported here so every existing import of this module keeps resolving.
 */
export { CostBudgetError, DEFAULT_CURRENCY, assertWithinCostBudget, formatCost } from './cost-budget.js';

/** Input for `estimateCost()`. */
export interface CostEstimateInput {
  /** The model, or an alias. */
  model: string;
  /** Input tokens billed at the standard rate. */
  inputTokens: number;
  /** Output tokens. Defaults to 0. */
  outputTokens?: number;
  /** Tokens the provider served from its prompt cache, billed at the cached-read rate. */
  cachedReadTokens?: number;
  /** Tokens the provider wrote into its prompt cache, billed at the cache-write rate. */
  cachedWriteTokens?: number;
  /** Cache lifetime the request asked for; long-lived writes cost more on some providers. */
  cacheTtl?: CacheTtl;
  /** Application registry entries and prices. */
  config?: Pick<NexusAIConfig, 'models'>;
}

/**
 * Resolves the per-1k prices for cached reads and cache writes.
 *
 * An explicit price on the registry entry always wins. Otherwise the rate is derived from the
 * standard input price using a provider default multiplier, which an application can override
 * through `models.cachePricing`. A long-lived write falls back to the multiplier path because the
 * declared `costPer1kCacheWrite` describes the short-lived rate.
 */
function cacheRates(
  capabilities: ModelCapabilities | undefined,
  config: Pick<NexusAIConfig, 'models'> | undefined,
  ttl: CacheTtl | undefined,
): { read: number; write: number } {
  if (!capabilities) return { read: 0, write: 0 };

  const overrides = config?.models?.cachePricing;
  const defaults = DEFAULT_CACHE_PRICING[capabilities.provider || ''];
  const readMultiplier = overrides?.read ?? defaults?.read;
  const writeMultiplier = overrides?.write ?? defaults?.write;
  const longWriteMultiplier = overrides?.writeLong ?? defaults?.writeLong;

  // An application-supplied multiplier is an explicit instruction, so it outranks the bundled
  // per-model price, which is itself only a default.
  const read =
    overrides?.read !== undefined
      ? capabilities.costPer1kInput * overrides.read
      : (capabilities.costPer1kCachedInput ??
        (readMultiplier !== undefined ? capabilities.costPer1kInput * readMultiplier : 0));

  const longWrite = ttl === '1h' && longWriteMultiplier !== undefined;
  const write =
    overrides?.write !== undefined && !longWrite
      ? capabilities.costPer1kInput * overrides.write
      : longWrite
        ? capabilities.costPer1kInput * (longWriteMultiplier as number)
        : (capabilities.costPer1kCacheWrite ??
          (writeMultiplier !== undefined ? capabilities.costPer1kInput * writeMultiplier : 0));

  return { read, write };
}

/**
 * Prices a request from the model registry, with cached reads and writes on their own lines.
 * Unknown models cost 0.
 */
export function estimateCost(input: CostEstimateInput): CostEstimate {
  const resolved = resolveModel(input.model, input.config);
  const caps = resolved.capabilities;
  const outputTokens = input.outputTokens ?? 0;
  const cachedReadTokens = input.cachedReadTokens ?? 0;
  const cachedWriteTokens = input.cachedWriteTokens ?? 0;
  const inputCost = caps ? (input.inputTokens / 1000) * caps.costPer1kInput : 0;
  const outputCost = caps ? (outputTokens / 1000) * caps.costPer1kOutput : 0;

  // Skip the cache-rate lookup entirely on the common path where nothing was cached.
  let cachedReadCost = 0;
  let cachedWriteCost = 0;
  if (cachedReadTokens > 0 || cachedWriteTokens > 0) {
    const rates = cacheRates(caps, input.config, input.cacheTtl);
    cachedReadCost = (cachedReadTokens / 1000) * rates.read;
    cachedWriteCost = (cachedWriteTokens / 1000) * rates.write;
  }

  const totalCost = inputCost + outputCost + cachedReadCost + cachedWriteCost;

  return {
    model: resolved.model,
    inputTokens: input.inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    cachedReadTokens: cachedReadTokens || undefined,
    cachedWriteTokens: cachedWriteTokens || undefined,
    cachedReadCost: cachedReadTokens ? cachedReadCost : undefined,
    cachedWriteCost: cachedWriteTokens ? cachedWriteCost : undefined,
    totalCost,
    currency: DEFAULT_CURRENCY,
    formatted: formatCost(totalCost),
  };
}
