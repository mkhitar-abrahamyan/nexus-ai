import type { NexusAIConfig } from '../types/config.js';
import type { CacheTtl } from '../types/providers.js';
import type { ResponseCost, ResponseMeta, TokenUsage } from '../types/response.js';
import { DEFAULT_CURRENCY, estimateCost, formatCost } from '../optimizer/cost.js';
import { generateRequestId } from '../utils/ids.js';

/** Token counts as a provider reported them, for `buildUsage()`. */
export interface UsageInput {
  /**
   * Prompt tokens billed at the standard input rate, excluding anything served from or written to
   * the provider cache. Adapters whose provider reports one combined prompt total must subtract
   * the cached counts before passing them here, so each token is priced exactly once.
   */
  inputTokens?: number;
  /** Completion tokens, reasoning included. */
  outputTokens?: number;
  /** Prompt tokens the provider served from its cache instead of processing again. */
  cachedReadTokens?: number;
  /** Prompt tokens the provider stored into its cache on this call. */
  cachedWriteTokens?: number;
  /** Share of `outputTokens` the provider attributes to internal reasoning. */
  reasoningTokens?: number;
}

/**
 * Normalizes provider token counts into the portable `TokenUsage` shape.
 *
 * Cached and reasoning counts are only carried when the provider actually reported them, so a
 * zero and an unknown stay distinguishable.
 */
export function buildUsage(input: UsageInput): TokenUsage {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cachedReadTokens = input.cachedReadTokens;
  const cachedWriteTokens = input.cachedWriteTokens;

  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    reasoningTokens: input.reasoningTokens,
    totalTokens: inputTokens + outputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0),
  };
}

/** Options for `priceUsage()`. */
export interface PriceUsageOptions {
  /** The model to price against. */
  model: string;
  /** The usage to price. */
  usage: TokenUsage;
  /** Cache lifetime the writes were made with, which some providers price differently. */
  cacheTtl?: CacheTtl;
  /** Application registry entries and prices. */
  config?: Pick<NexusAIConfig, 'models'>;
  /** Set when the provider returned an authoritative charge rather than a local estimate. */
  reported?: number;
}

/** Prices a normalized usage record, keeping each token class on its own line. */
export function priceUsage(options: PriceUsageOptions): ResponseCost {
  if (options.reported !== undefined) {
    return { amount: options.reported, currency: DEFAULT_CURRENCY, basis: 'reported' };
  }

  const estimate = estimateCost({
    model: options.model,
    inputTokens: options.usage.inputTokens,
    outputTokens: options.usage.outputTokens,
    cachedReadTokens: options.usage.cachedReadTokens,
    cachedWriteTokens: options.usage.cachedWriteTokens,
    cacheTtl: options.cacheTtl,
    config: options.config,
  });

  return {
    amount: estimate.totalCost,
    currency: estimate.currency || DEFAULT_CURRENCY,
    basis: 'estimated',
    input: estimate.inputCost,
    output: estimate.outputCost,
    cachedRead: estimate.cachedReadCost,
    cachedWrite: estimate.cachedWriteCost,
  };
}

/** Options for `buildMeta()`: the provider's token counts plus the call's context. */
export interface BuildMetaOptions extends UsageInput {
  /** The provider that answered. */
  provider: string;
  /** The model that answered. */
  model: string;
  /** How long the call took, in milliseconds. */
  latencyMs: number;
  /** Cache lifetime the writes were made with. */
  cacheTtl?: CacheTtl;
  /** Application registry entries and prices. */
  config?: Pick<NexusAIConfig, 'models'>;
  /** Request id. Defaults to a generated one. */
  requestId?: string;
}

/**
 * Builds a complete `ResponseMeta` from provider token counts.
 *
 * Every adapter shares this so pricing, cached-token accounting, and the deprecated formatted
 * string stay consistent instead of being re-derived per provider.
 */
export function buildMeta(options: BuildMetaOptions): ResponseMeta {
  const usage = buildUsage(options);
  const cost = priceUsage({
    model: options.model,
    usage,
    cacheTtl: options.cacheTtl,
    config: options.config,
  });

  return {
    requestId: options.requestId || generateRequestId(),
    providerUsed: options.provider,
    modelUsed: options.model,
    latencyMs: options.latencyMs,
    // The legacy field keeps its original meaning: every prompt token, cached or not.
    tokensInput: usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
    tokensOutput: usage.outputTokens,
    tokensSaved: 0,
    estimatedCost: formatCost(cost.amount),
    usage,
    cost,
    cacheHit: false,
    guardrailsApplied: [],
  };
}

/**
 * Guarantees `usage` and `cost` on a response built by a custom provider that predates them.
 *
 * Returns the same object when nothing is missing, so the normal path does no work.
 */
export function ensureUsageAndCost(meta: ResponseMeta, config?: Pick<NexusAIConfig, 'models'>): ResponseMeta {
  if (meta.usage && meta.cost) return meta;

  const usage = meta.usage || buildUsage({ inputTokens: meta.tokensInput, outputTokens: meta.tokensOutput });
  const cost = meta.cost || priceUsage({ model: meta.modelUsed, usage, config });

  meta.usage = usage;
  meta.cost = cost;
  return meta;
}

/** Numeric cost for metrics and budgets, without parsing the formatted display string. */
export function costAmount(meta: ResponseMeta): number {
  if (meta.cost) return meta.cost.amount;
  const parsed = Number.parseFloat(meta.estimatedCost.replace('$', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
