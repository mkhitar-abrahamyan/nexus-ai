import type { CompletionRequest } from '../types/messages.js';
import type { NexusAIConfig } from '../types/config.js';
import type { BaseProvider } from '../providers/base.js';
import type { RouteDecision, RouterContext } from './types.js';
import { AutoRouter, routeDirectModel } from './auto-router.js';
import { RulesRouter } from './rules-router.js';
import type { ProviderHealthSnapshot } from '../ops/health.js';

export class Router {
  private autoRouter = new AutoRouter();
  private rulesRouter = new RulesRouter();

  route(
    request: CompletionRequest,
    config: NexusAIConfig,
    providers: Map<string, BaseProvider>,
    health?: ProviderHealthSnapshot[],
  ): RouteDecision {
    const ctx: RouterContext = { request, config, providers, health };
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

export type { RouteDecision, RouterContext } from './types.js';
export { FailoverExecutor } from './failover.js';
