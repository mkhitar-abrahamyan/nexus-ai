import type { RouterContext, RouteDecision } from './types.js';
import type { NexusAIConfig } from '../types/config.js';
import type { ModelCapabilities, RoutingModelPreference } from '../types/providers.js';
import { getModelRegistry, listModelsForProvider, resolveModel } from '../models/registry.js';

interface Candidate {
  providerName: string;
  model: string;
  weight: number;
  score: number;
  reason: string;
}

export class AutoRouter {
  route(ctx: RouterContext): RouteDecision {
    const strategy = ctx.config.routing?.strategy || 'quality';
    const candidates = this.withoutOpenCircuits(this.getCandidates(ctx), ctx).map((candidate) => ({
      ...candidate,
      score:
        this.score(candidate.model, strategy, ctx.config) +
        candidate.weight +
        this.healthScore(candidate.providerName, ctx),
      reason: `auto route by ${strategy} score`,
    }));

    candidates.sort((a, b) => b.score - a.score);

    const winner = candidates[0];
    if (!winner) {
      throw new Error('No configured providers are available for routing');
    }

    return {
      providerName: winner.providerName,
      model: winner.model,
      reason: `${winner.reason}: ${winner.model}`,
      fallbacks: candidates.slice(1).map((c) => ({ providerName: c.providerName, model: c.model })),
    };
  }

  /**
   * Drops providers whose circuit is open.
   *
   * If that would leave nothing to route to, the original list is kept instead. Every circuit being
   * open usually means a shared dependency is down rather than every provider individually, and
   * attempting one call is strictly better than failing the request without trying anything.
   */
  private withoutOpenCircuits<T extends { providerName: string }>(candidates: T[], ctx: RouterContext): T[] {
    if (!ctx.openCircuits?.length) return candidates;
    const open = new Set(ctx.openCircuits);
    const remaining = candidates.filter((candidate) => !open.has(candidate.providerName));
    return remaining.length > 0 ? remaining : candidates;
  }

  private getCandidates(ctx: RouterContext): Array<Omit<Candidate, 'score' | 'reason'>> {
    const candidates: Array<Omit<Candidate, 'score' | 'reason'>> = [];
    const configuredModels = ctx.config.routing?.candidateModels;

    if (configuredModels?.length) {
      for (const model of configuredModels) {
        const resolved = resolveModel(model, ctx.config);
        const providerName = resolved.providerName || model.split('/')[0];
        if (ctx.providers.has(providerName) && this.isAllowed(resolved.model, ctx.config)) {
          candidates.push({ providerName, model: resolved.model, weight: 0 });
        }
      }

      return candidates.filter((candidate) => this.matchesRequirements(candidate.model, ctx.config));
    }

    const preferences = ctx.config.routing?.modelPreferences?.[ctx.config.routing?.strategy || 'quality'];

    for (const providerName of ctx.providers.keys()) {
      const preferred = this.preferencesForProvider(providerName, preferences, ctx.config);
      if (preferred.length) {
        candidates.push(...preferred);
      }
    }

    return candidates.filter((candidate) => {
      return this.isAllowed(candidate.model, ctx.config) && this.matchesRequirements(candidate.model, ctx.config);
    });
  }

  private score(model: string, strategy: string, config: NexusAIConfig): number {
    const registry = getModelRegistry(config);
    const normalized = model.startsWith('ollama/') ? model.slice(7) : model;
    const caps = registry[model] || registry[normalized] || this.localFallbackCapabilities(model);

    if (strategy === 'privacy') return isLocalModel(model) ? 100 : 30;
    if (strategy === 'speed') return this.speedScore(model, caps);
    if (strategy === 'cost') return this.costScore(model, caps);
    return this.qualityScore(model, caps);
  }

  private localFallbackCapabilities(model: string): ModelCapabilities {
    return {
      modalities: ['text'],
      streaming: true,
      toolCalling: false,
      maxContextTokens: 8192,
      costPer1kInput: isLocalModel(model) ? 0 : 0.001,
      costPer1kOutput: isLocalModel(model) ? 0 : 0.003,
    };
  }

  private costScore(model: string, caps: ModelCapabilities): number {
    if (isLocalModel(model)) return 100;
    const totalCost = caps.costPer1kInput + caps.costPer1kOutput;
    return Math.max(1, 100 - totalCost * 1000);
  }

  private speedScore(model: string, caps: ModelCapabilities): number {
    if (caps.speedScore) return caps.speedScore;
    if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) return 95;
    if (isLocalModel(model)) return 80;
    return caps.streaming ? 70 : 50;
  }

  private qualityScore(model: string, caps: ModelCapabilities): number {
    if (caps.qualityScore) return caps.qualityScore;
    if (model.includes('gpt-5.5')) return 99;
    if (model.includes('gpt-5.4')) return 96;
    if (model.includes('opus') || model.includes('gpt-4o')) return 95;
    if (model.includes('sonnet')) return 90;
    if (model.includes('gemini-3')) return 94;
    if (model.includes('gemini-2.5-pro')) return 88;
    if (isLocalModel(model)) return 65;
    return Math.min(85, caps.maxContextTokens / 2000);
  }

  private preferencesForProvider(
    providerName: string,
    preferences: RoutingModelPreference[] | undefined,
    config: NexusAIConfig,
  ): Array<Omit<Candidate, 'score' | 'reason'>> {
    if (preferences?.length) {
      return preferences
        .map((preference) =>
          typeof preference === 'string'
            ? { model: preference, weight: 0 }
            : { model: preference.model, weight: preference.weight || 0 },
        )
        .map((preference) => {
          const resolved = resolveModel(preference.model, config);
          return {
            providerName: resolved.providerName || preference.model.split('/')[0],
            model: resolved.model,
            weight: preference.weight,
          };
        })
        .filter((candidate) => candidate.providerName === providerName);
    }

    const registryModels = listModelsForProvider(providerName, config);
    if (registryModels.length) {
      return registryModels
        .filter((model) => this.isProviderRunnable(providerName, model, config))
        .map((model) => ({ providerName, model, weight: 0 }));
    }

    if (providerName === 'ollama') {
      return [
        { providerName, model: 'ollama/llama3.3', weight: 0 },
        { providerName, model: 'ollama/llama3.2', weight: 0 },
        { providerName, model: 'ollama/qwen2.5', weight: 0 },
        { providerName, model: 'ollama/mistral', weight: 0 },
        { providerName, model: 'ollama/codellama', weight: 0 },
      ];
    }

    if (providerName === 'openrouter') {
      return [
        { providerName, model: 'openrouter/openai/gpt-5.4-mini', weight: 0 },
        { providerName, model: 'openrouter/anthropic/claude-sonnet-4', weight: 0 },
        { providerName, model: 'openrouter/google/gemini-2.5-flash', weight: 0 },
        { providerName, model: 'openrouter/meta-llama/llama-3.3-70b-instruct', weight: 0 },
      ];
    }

    if (providerName === 'deepseek') {
      return [
        { providerName, model: 'deepseek/deepseek-reasoner', weight: 0 },
        { providerName, model: 'deepseek/deepseek-chat', weight: 0 },
      ];
    }

    if (providerName === 'lmstudio') {
      return [{ providerName, model: 'lmstudio/local-model', weight: 0 }];
    }

    if (providerName === 'llamacpp') {
      return [{ providerName, model: 'llamacpp/local-model', weight: 0 }];
    }

    return [];
  }

  private isAllowed(model: string, config: NexusAIConfig): boolean {
    const allow = config.routing?.allowModels;
    const deny = config.routing?.denyModels || [];

    if (allow?.length && !allow.some((entry) => this.matchesModelPattern(model, entry))) return false;
    return !deny.some((entry) => this.matchesModelPattern(model, entry));
  }

  private matchesRequirements(model: string, config: NexusAIConfig): boolean {
    const requirements = config.routing?.requiredCapabilities;
    if (!requirements) return true;

    const registry = getModelRegistry(config);
    const normalized = model.startsWith('ollama/') ? model.slice(7) : model;
    const caps = registry[model] || registry[normalized] || this.localFallbackCapabilities(model);

    if (requirements.streaming !== undefined && caps.streaming !== requirements.streaming) return false;
    if (requirements.toolCalling !== undefined && caps.toolCalling !== requirements.toolCalling) return false;
    if (requirements.structuredOutputs !== undefined && caps.structuredOutputs !== requirements.structuredOutputs)
      return false;
    if (requirements.jsonMode !== undefined && caps.jsonMode !== requirements.jsonMode) return false;
    if (requirements.reasoning !== undefined && Boolean(caps.reasoning) !== requirements.reasoning) return false;
    if (requirements.minContextTokens && caps.maxContextTokens < requirements.minContextTokens) return false;
    if (requirements.maxInputCostPer1k !== undefined && caps.costPer1kInput > requirements.maxInputCostPer1k)
      return false;
    if (requirements.maxOutputCostPer1k !== undefined && caps.costPer1kOutput > requirements.maxOutputCostPer1k)
      return false;
    if (requirements.statuses?.length && caps.status && !requirements.statuses.includes(caps.status)) return false;
    if (requirements.modalities?.length) {
      for (const modality of requirements.modalities) {
        if (!caps.modalities.includes(modality)) return false;
      }
    }

    return true;
  }

  private matchesModelPattern(model: string, pattern: string): boolean {
    if (pattern === model) return true;
    if (!pattern.includes('*')) return false;
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => {
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('.*')}$`,
    );
    return regex.test(model);
  }

  private isProviderRunnable(providerName: string, model: string, config: NexusAIConfig): boolean {
    const registry = getModelRegistry(config);
    const caps = registry[model];
    if (!caps?.endpoints) return true;
    if (providerName === 'openai') return caps.endpoints.includes('chat');
    if (providerName === 'anthropic') return caps.endpoints.includes('messages');
    if (providerName === 'google') return caps.endpoints.includes('generateContent');
    return true;
  }

  private healthScore(providerName: string, ctx: RouterContext): number {
    if (!ctx.config.health?.enabled || !ctx.health?.length) return 0;
    const snapshot = ctx.health.find((item) => item.providerName === providerName);
    if (!snapshot) return 0;
    return snapshot.healthy ? snapshot.score / 10 : -100;
  }
}

function isLocalModel(model: string): boolean {
  return (
    model.startsWith('ollama/') ||
    model.startsWith('lmstudio/') ||
    model.startsWith('llamacpp/') ||
    model.startsWith('llama.cpp/')
  );
}

export function routeDirectModel(model: string, ctx: RouterContext): RouteDecision {
  const resolved = resolveModel(model, ctx.config);
  const providerName = resolved.providerName || model.split('/')[0];

  if (!ctx.providers.has(providerName)) {
    throw new Error(`Provider "${providerName}" for model "${model}" is not configured`);
  }

  return {
    providerName,
    model: resolved.model,
    reason: `direct model route → ${model}${model === resolved.model ? '' : ` resolved to ${resolved.model}`}`,
    fallbacks: [],
  };
}
