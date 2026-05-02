import type { RouterContext, RouteDecision } from './types.js';
import { resolveModel } from '../models/registry.js';

export class RulesRouter {
  route(ctx: RouterContext): RouteDecision | null {
    const rules = ctx.config.routing?.rules;
    if (!rules || rules.length === 0) return null;

    for (const rule of rules) {
      if (rule.when === '*' || this.matches(rule.when, ctx)) {
        const resolved = resolveModel(rule.use, ctx.config);
        const providerName = resolved.providerName || rule.use.split('/')[0];

        if (ctx.providers.has(providerName)) {
          return {
            providerName,
            model: resolved.model,
            reason: `matched routing rule -> ${rule.use}${rule.use === resolved.model ? '' : ` resolved to ${resolved.model}`}`,
            fallbacks: [],
          };
        }
      }
    }

    return null;
  }

  private matches(conditions: Record<string, unknown>, ctx: RouterContext): boolean {
    for (const [key, expected] of Object.entries(conditions)) {
      const actual = this.readConditionValue(key, ctx);

      if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
        if (!this.matchesOperator(actual, expected as Record<string, unknown>)) return false;
        continue;
      }

      if (actual !== expected) return false;
    }

    return true;
  }

  private readConditionValue(key: string, ctx: RouterContext): unknown {
    if (key === 'model') return ctx.request.model;
    if (key === 'userId') return ctx.request.userId;
    if (key === 'hasTools') return Boolean(ctx.request.tools?.length);
    if (key === 'messageCount') return ctx.request.messages.length;
    if (key === 'containsPII') return false;
    if (key === 'taskType') return ctx.request.metadata?.taskType;
    return ctx.request.metadata?.[key];
  }

  private matchesOperator(actual: unknown, operators: Record<string, unknown>): boolean {
    for (const [op, expected] of Object.entries(operators)) {
      if (op === 'gt' && !(Number(actual) > Number(expected))) return false;
      if (op === 'gte' && !(Number(actual) >= Number(expected))) return false;
      if (op === 'lt' && !(Number(actual) < Number(expected))) return false;
      if (op === 'lte' && !(Number(actual) <= Number(expected))) return false;
      if (op === 'eq' && actual !== expected) return false;
      if (op === 'in' && Array.isArray(expected) && !expected.includes(actual)) return false;
    }

    return true;
  }
}
