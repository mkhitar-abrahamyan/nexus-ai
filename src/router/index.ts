import type { CompletionRequest } from '../types/messages.js';
import type { NexusAIConfig } from '../types/config.js';
import type { BaseProvider } from '../providers/base.js';
import { resolveModel } from '../models/registry.js';
import type { RouteAttempt, RouteDecision, RouterContext } from './types.js';
import { AutoRouter, routeDirectModel } from './auto-router.js';
import { RulesRouter } from './rules-router.js';
import type { ProviderHealthSnapshot } from '../ops/health.js';

/**
 * Chooses where a request goes: a direct model, a matching rule, or the auto-router's ranking, with
 * the fallbacks `routing.fallback` adds on top.
 */
export class Router {
  private autoRouter = new AutoRouter();
  private rulesRouter = new RulesRouter();

  /** Routes one request. Throws when a directly named model's provider is not configured. */
  route(
    request: CompletionRequest,
    config: NexusAIConfig,
    providers: Map<string, BaseProvider>,
    health?: ProviderHealthSnapshot[],
    openCircuits?: readonly string[],
  ): RouteDecision {
    const ctx: RouterContext = { request, config, providers, health, openCircuits };
    return withConfiguredFallbacks(this.choose(ctx), ctx);
  }

  private choose(ctx: RouterContext): RouteDecision {
    const { request, config } = ctx;
    const routingMode = config.routing?.mode || 'auto';

    if (request.model !== 'auto') {
      return routeDirectModel(request.model, ctx);
    }

    if (routingMode === 'rules' || routingMode === 'hybrid') {
      const decision = this.rulesRouter.route(ctx);
      if (decision) return decision;
      if (routingMode === 'rules') return this.autoRouter.route(ctx);
    }

    if (routingMode === 'hybrid') {
      return this.autoRouter.route(ctx);
    }

    if (routingMode === 'direct') {
      const model = config.defaultModel;
      if (!model) throw new Error('routing.mode="direct" requires config.defaultModel');
      return routeDirectModel(model, { ...ctx, request: { ...request, model } });
    }

    return this.autoRouter.route(ctx);
  }
}

/**
 * Applies `routing.fallback` to a decision.
 *
 * `onTimeout` and `onRateLimit` limit the first attempt and name what to try right after it;
 * `onError` models are tried once everything the router chose has failed. A model whose provider is
 * not configured, whose circuit is open, or which is already in the list is skipped rather than tried
 * twice.
 */
function withConfiguredFallbacks(decision: RouteDecision, ctx: RouterContext): RouteDecision {
  const fallback = ctx.config.routing?.fallback;
  if (!fallback) return decision;

  const seen = new Set(
    [decision, ...decision.fallbacks].map((attempt) => `${attempt.providerName}\u0000${attempt.model}`),
  );
  const resolve = (model: string): RouteAttempt | undefined => {
    const resolved = resolveModel(model, ctx.config);
    const providerName = resolved.providerName || (model.split('/')[0] as string);
    if (!ctx.providers.has(providerName) || ctx.openCircuits?.includes(providerName)) return undefined;
    const key = `${providerName}\u0000${resolved.model}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    return { providerName, model: resolved.model };
  };

  const next = [fallback.onTimeout?.fallbackTo, fallback.onRateLimit?.thenFallbackTo]
    .filter((model): model is string => Boolean(model))
    .map(resolve)
    .filter((attempt): attempt is RouteAttempt => attempt !== undefined);
  const last = (fallback.onError ?? [])
    .map(resolve)
    .filter((attempt): attempt is RouteAttempt => attempt !== undefined);
  const primary: RouteDecision['primary'] = {
    ...(fallback.onTimeout ? { timeoutMs: fallback.onTimeout.after } : {}),
    ...(fallback.onRateLimit
      ? { rateLimit: { retryAfterMs: fallback.onRateLimit.retryAfter, maxRetries: fallback.onRateLimit.maxRetries } }
      : {}),
  };

  return {
    ...decision,
    ...(Object.keys(primary).length ? { primary: { ...decision.primary, ...primary } } : {}),
    fallbacks: [...next, ...decision.fallbacks, ...last],
  };
}

export type { RouteAttempt, RouteDecision, RouterContext } from './types.js';
export { FailoverExecutor } from './failover.js';
