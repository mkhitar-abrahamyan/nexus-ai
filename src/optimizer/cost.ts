import type { NexusAIConfig } from '../types/config.js';
import type { CostEstimate } from '../types/planning.js';
import type { CacheTtl, ModelCapabilities } from '../types/providers.js';
import { DEFAULT_CACHE_PRICING } from '../types/providers.js';
import { resolveModel } from '../models/registry.js';

export interface CostEstimateInput {
  model: string;
  inputTokens: number;
  outputTokens?: number;
  /** Tokens the provider served from its prompt cache, billed at the cached-read rate. */
  cachedReadTokens?: number;
  /** Tokens the provider wrote into its prompt cache, billed at the cache-write rate. */
  cachedWriteTokens?: number;
  /** Cache lifetime the request asked for; long-lived writes cost more on some providers. */
  cacheTtl?: CacheTtl;
  config?: Pick<NexusAIConfig, 'models'>;
}

export class CostBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostBudgetError';
  }
}

export const DEFAULT_CURRENCY = 'USD';

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

/** Formats an amount the way `ResponseMeta.estimatedCost` has always presented it. */
export function formatCost(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

export function assertWithinCostBudget(estimate: CostEstimate, maxEstimatedCost?: number): void {
  if (maxEstimatedCost === undefined) return;
  if (estimate.totalCost > maxEstimatedCost) {
    throw new CostBudgetError(
      `Estimated cost ${estimate.formatted} exceeds maxEstimatedCost $${maxEstimatedCost.toFixed(4)}`,
    );
  }
}
