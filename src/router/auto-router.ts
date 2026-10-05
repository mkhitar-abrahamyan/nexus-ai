import type { RouterContext, RouteAttempt, RouteDecision } from './types.js';
import type { NexusAIConfig } from '../types/config.js';
import type { ModelCapabilities, RoutingModelPreference } from '../types/providers.js';
import { getModelRegistry, listModelsForProvider, resolveModel } from '../models/registry.js';

interface Candidate {
  providerName: string;
  model: string;
  weight: number;
}

/** A candidate as a plan keeps it: everything about it that does not change between requests. */
interface PlannedCandidate {
  readonly providerName: string;
  readonly model: string;
  /** The strategy score plus the preference weight: every part of the score but health. */
  readonly base: number;
  /** Its place in generation order, which breaks a tie exactly as the stable sort before plans did. */
  readonly index: number;
  /** The attempt handed out in `fallbacks`, shared by every decision and frozen so none can change it. */
  readonly attempt: Readonly<RouteAttempt>;
}

/** The part of routing that only changes when the configuration does. */
interface RoutePlan {
  readonly strategy: string;
  /** Every candidate, best base score first. */
  readonly ranked: readonly PlannedCandidate[];
  /** The same candidates per provider, each best first, for re-ranking by health without a sort. */
  readonly byProvider: ReadonlyMap<string, readonly PlannedCandidate[]>;
}

/** Plans kept per router. A client has one routing configuration; a few spare cover reconfiguration. */
const PLAN_LIMIT = 16;

/** Boolean capabilities a requirement can name, each one bit. */
const BOOLEAN_CAPABILITIES = ['streaming', 'toolCalling', 'structuredOutputs', 'jsonMode', 'reasoning'] as const;

/**
 * Ranks configured providers' models for a request routed as `auto`.
 *
 * Everything that depends only on configuration — which models are candidates, which pass the
 * allow and deny lists and the capability requirements, and how each scores for the strategy — is
 * computed once into a plan and kept until the configuration changes. A request pays only for what
 * can differ between requests: which circuits are open, and provider health.
 */
export class AutoRouter {
  private readonly plans = new Map<string, RoutePlan>();
  private readonly patterns = new Map<string, RegExp | null>();
  private readonly registryIds = new WeakMap<object, number>();

  /** Routes one request: the best candidate first, every other as a fallback in order. */
  route(ctx: RouterContext): RouteDecision {
    const plan = this.plan(ctx);
    const ranked = this.rank(plan, ctx);
    const winner = ranked[0];
    if (!winner) {
      throw new Error('No configured providers are available for routing');
    }
    return {
      providerName: winner.providerName,
      model: winner.model,
      reason: `auto route by ${plan.strategy} score: ${winner.model}`,
      fallbacks: ranked.slice(1).map((candidate) => candidate.attempt),
    };
  }

  /** Plans cached by this router, for tests and diagnostics. */
  get planCount(): number {
    return this.plans.size;
  }

  /** The plan for a request's configuration, built on first use and kept until the configuration changes. */
  private plan(ctx: RouterContext): RoutePlan {
    const key = this.planKey(ctx);
    const cached = this.plans.get(key);
    if (cached) {
      // Refreshed, so the least recently used plan is the one dropped.
      this.plans.delete(key);
      this.plans.set(key, cached);
      return cached;
    }
    const plan = this.buildPlan(ctx);
    this.plans.set(key, plan);
    if (this.plans.size > PLAN_LIMIT) this.plans.delete(this.plans.keys().next().value as string);
    return plan;
  }

  /**
   * What a plan depends on, normalized into a string: the routing settings, the model settings, and
   * the configured providers. A registry is identified by its object, so replacing
   * `models.registry` builds a new plan; changing one in place does not.
   */
  private planKey(ctx: RouterContext): string {
    const routing = ctx.config.routing;
    const models = ctx.config.models;
    const providers: string[] = [];
    for (const [name, provider] of ctx.providers)
      providers.push(`${name}${provider.info?.isLocal === true ? '+local' : ''}`);
    return JSON.stringify([
      routing?.strategy ?? 'quality',
      routing?.candidateModels ?? null,
      routing?.modelPreferences ?? null,
      routing?.allowModels ?? null,
      routing?.denyModels ?? null,
      normalizedRequirements(routing?.requiredCapabilities),
      models?.includeDefaults ?? null,
      models?.aliases ?? null,
      models?.registry ? this.registryId(models.registry) : 0,
      providers,
    ]);
  }

  private registryId(registry: object): number {
    let id = this.registryIds.get(registry);
    if (id === undefined) {
      id = this.registryIds.get(this.registryIds) ?? 1;
      this.registryIds.set(registry, id);
      this.registryIds.set(this.registryIds, id + 1);
    }
    return id;
  }

  private buildPlan(ctx: RouterContext): RoutePlan {
    const strategy = ctx.config.routing?.strategy || 'quality';
    // The merged registry is built once per plan, not once per candidate.
    const registry = getModelRegistry(ctx.config);
    const requirements = compileRequirements(ctx.config.routing?.requiredCapabilities);
    const candidates = this.getCandidates(ctx, registry, requirements);
    const planned: PlannedCandidate[] = candidates.map((candidate, index) => ({
      providerName: candidate.providerName,
      model: candidate.model,
      base:
        this.score(
          candidate.model,
          strategy,
          registry,
          ctx.providers.get(candidate.providerName)?.info?.isLocal === true,
        ) + candidate.weight,
      index,
      attempt: Object.freeze({ providerName: candidate.providerName, model: candidate.model }),
    }));
    const ranked = [...planned].sort(byScore);
    const byProvider = new Map<string, PlannedCandidate[]>();
    for (const candidate of ranked) {
      const list = byProvider.get(candidate.providerName);
      if (list) list.push(candidate);
      else byProvider.set(candidate.providerName, [candidate]);
    }
    return { strategy, ranked, byProvider };
  }

  /**
   * The plan's candidates in order for this request. Providers whose circuit is open are left out,
   * unless that would leave nothing: every circuit open usually means a shared dependency is down,
   * and one attempt is strictly better than failing without trying. Health moves a whole provider
   * up or down, so the per-provider lists are merged by their adjusted scores rather than re-sorted.
   */
  private rank(plan: RoutePlan, ctx: RouterContext): readonly PlannedCandidate[] {
    let excluded: Set<string> | undefined;
    if (ctx.openCircuits?.length) {
      const open = new Set(ctx.openCircuits);
      if (plan.ranked.some((candidate) => !open.has(candidate.providerName))) excluded = open;
    }
    const offsets = this.healthOffsets(ctx);
    if (!offsets) {
      return excluded ? plan.ranked.filter((candidate) => !excluded.has(candidate.providerName)) : plan.ranked;
    }

    const lists: Array<{ list: readonly PlannedCandidate[]; offset: number; at: number }> = [];
    let total = 0;
    for (const [providerName, list] of plan.byProvider) {
      if (excluded?.has(providerName)) continue;
      lists.push({ list, offset: offsets.get(providerName) ?? 0, at: 0 });
      total += list.length;
    }
    const merged = new Array<PlannedCandidate>(total);
    for (let position = 0; position < total; position += 1) {
      let best = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestIndex = Number.POSITIVE_INFINITY;
      for (let which = 0; which < lists.length; which += 1) {
        const head = lists[which] as { list: readonly PlannedCandidate[]; offset: number; at: number };
        const candidate = head.list[head.at];
        if (!candidate) continue;
        const score = candidate.base + head.offset;
        if (score > bestScore || (score === bestScore && candidate.index < bestIndex)) {
          best = which;
          bestScore = score;
          bestIndex = candidate.index;
        }
      }
      const chosen = lists[best] as { list: readonly PlannedCandidate[]; at: number };
      merged[position] = chosen.list[chosen.at] as PlannedCandidate;
      chosen.at += 1;
    }
    return merged;
  }

  private getCandidates(
    ctx: RouterContext,
    registry: Record<string, ModelCapabilities>,
    requirements: CompiledRequirements | undefined,
  ): Candidate[] {
    const candidates: Candidate[] = [];
    const configuredModels = ctx.config.routing?.candidateModels;
    const passes = (model: string) => !requirements || this.matchesRequirements(model, registry, requirements);

    if (configuredModels?.length) {
      for (const model of configuredModels) {
        const resolved = resolveModel(model, ctx.config);
        const providerName = resolved.providerName || (model.split('/')[0] as string);
        if (ctx.providers.has(providerName) && this.isAllowed(resolved.model, ctx.config)) {
          candidates.push({ providerName, model: resolved.model, weight: 0 });
        }
      }

      return candidates.filter((candidate) => passes(candidate.model));
    }

    const preferences = ctx.config.routing?.modelPreferences?.[ctx.config.routing?.strategy || 'quality'];

    for (const providerName of ctx.providers.keys()) {
      const preferred = this.preferencesForProvider(providerName, preferences, ctx.config, registry);
      if (preferred.length) {
        candidates.push(...preferred);
      }
    }

    return candidates.filter((candidate) => this.isAllowed(candidate.model, ctx.config) && passes(candidate.model));
  }

  /**
   * Scores a model for a strategy. For privacy, a model counts as local when its name says so or when
   * its provider was configured with `isLocal`, which is how a self-hosted OpenAI-compatible server
   * is preferred without renaming its models.
   */
  private score(
    model: string,
    strategy: string,
    registry: Record<string, ModelCapabilities>,
    providerIsLocal = false,
  ): number {
    const caps = this.capabilitiesOf(model, registry);

    if (strategy === 'privacy') return providerIsLocal || isLocalModel(model) ? 100 : 30;
    if (strategy === 'speed') return this.speedScore(model, caps);
    if (strategy === 'cost') return this.costScore(model, caps);
    return this.qualityScore(model, caps);
  }

  private capabilitiesOf(model: string, registry: Record<string, ModelCapabilities>): ModelCapabilities {
    const normalized = model.startsWith('ollama/') ? model.slice(7) : model;
    return registry[model] || registry[normalized] || this.localFallbackCapabilities(model);
  }

  private localFallbackCapabilities(model: string): ModelCapabilities {
    return {
      inputModalities: ['text'],
      outputModalities: ['text'],
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
    registry: Record<string, ModelCapabilities>,
  ): Candidate[] {
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
            providerName: resolved.providerName || (preference.model.split('/')[0] as string),
            model: resolved.model,
            weight: preference.weight,
          };
        })
        .filter((candidate) => candidate.providerName === providerName);
    }

    const registryModels = listModelsForProvider(providerName, config);
    if (registryModels.length) {
      return registryModels
        .filter((model) => this.isProviderRunnable(providerName, model, registry))
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
        { providerName, model: 'openrouter/anthropic/claude-haiku-4.5', weight: 0 },
        { providerName, model: 'openrouter/google/gemini-2.5-flash', weight: 0 },
        { providerName, model: 'openrouter/meta-llama/llama-3.3-70b-instruct', weight: 0 },
      ];
    }

    if (providerName === 'deepseek') {
      return [
        { providerName, model: 'deepseek/deepseek-v4-pro', weight: 0 },
        { providerName, model: 'deepseek/deepseek-flash', weight: 0 },
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

  /** Whether a model meets the routing requirements: the boolean ones as two bitmask tests, the rest by value. */
  private matchesRequirements(
    model: string,
    registry: Record<string, ModelCapabilities>,
    requirements: CompiledRequirements,
  ): boolean {
    const caps = this.capabilitiesOf(model, registry);
    const { mustBe, mustNotBe } = capabilityMasks(caps);
    if ((mustBe & requirements.mustBe) !== requirements.mustBe) return false;
    if ((mustNotBe & requirements.mustNotBe) !== requirements.mustNotBe) return false;

    const source = requirements.source;
    if (source.minContextTokens && caps.maxContextTokens < source.minContextTokens) return false;
    if (source.maxInputCostPer1k !== undefined && caps.costPer1kInput > source.maxInputCostPer1k) return false;
    if (source.maxOutputCostPer1k !== undefined && caps.costPer1kOutput > source.maxOutputCostPer1k) return false;
    if (source.statuses?.length && caps.status && !source.statuses.includes(caps.status)) return false;
    if (source.inputModalities?.some((modality) => !caps.inputModalities.includes(modality))) return false;
    if (source.outputModalities?.some((modality) => !caps.outputModalities.includes(modality))) return false;

    return true;
  }

  /** Whether a model name matches an allow or deny entry, with `*` as a wildcard. Patterns are compiled once. */
  private matchesModelPattern(model: string, pattern: string): boolean {
    if (pattern === model) return true;
    let regex = this.patterns.get(pattern);
    if (regex === undefined) {
      regex = pattern.includes('*')
        ? new RegExp(
            `^${pattern
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*')}$`,
          )
        : null;
      this.patterns.set(pattern, regex);
    }
    return regex ? regex.test(model) : false;
  }

  private isProviderRunnable(
    providerName: string,
    model: string,
    registry: Record<string, ModelCapabilities>,
  ): boolean {
    const caps = registry[model];
    if (!caps?.endpoints) return true;
    if (providerName === 'openai') return caps.endpoints.includes('chat');
    if (providerName === 'anthropic') return caps.endpoints.includes('messages');
    if (providerName === 'google') return caps.endpoints.includes('generateContent');
    return true;
  }

  /** Each provider's health adjustment for this request, or nothing when health does not apply. */
  private healthOffsets(ctx: RouterContext): Map<string, number> | undefined {
    if (!ctx.config.health?.enabled || !ctx.health?.length) return undefined;
    const offsets = new Map<string, number>();
    for (const snapshot of ctx.health) {
      // The first snapshot of a provider counts, as a search for it would find.
      if (offsets.has(snapshot.providerName)) continue;
      offsets.set(snapshot.providerName, snapshot.healthy ? snapshot.score / 10 : -100);
    }
    return offsets;
  }
}

type Requirements = NonNullable<NonNullable<NexusAIConfig['routing']>['requiredCapabilities']>;

/** Requirements with their boolean part as bitmasks: bits a model must have true, and bits it must have false. */
interface CompiledRequirements {
  mustBe: number;
  mustNotBe: number;
  source: Requirements;
}

function compileRequirements(requirements: Requirements | undefined): CompiledRequirements | undefined {
  if (!requirements) return undefined;
  let mustBe = 0;
  let mustNotBe = 0;
  BOOLEAN_CAPABILITIES.forEach((name, bit) => {
    const wanted = requirements[name];
    if (wanted === true) mustBe |= 1 << bit;
    else if (wanted === false) mustNotBe |= 1 << bit;
  });
  return { mustBe, mustNotBe, source: requirements };
}

/**
 * A model's boolean capabilities as bitmasks, matching how requirements were always compared: a
 * capability is true or false only when the registry says so exactly, except `reasoning`, which an
 * absent entry makes false.
 */
function capabilityMasks(caps: ModelCapabilities): { mustBe: number; mustNotBe: number } {
  let mustBe = 0;
  let mustNotBe = 0;
  BOOLEAN_CAPABILITIES.forEach((name, bit) => {
    const value = name === 'reasoning' ? Boolean(caps.reasoning) : caps[name];
    if (value === true) mustBe |= 1 << bit;
    else if (value === false) mustNotBe |= 1 << bit;
  });
  return { mustBe, mustNotBe };
}

/** Requirements in a fixed key order, so two equal requirement objects share a plan. */
function normalizedRequirements(requirements: Requirements | undefined): unknown {
  if (!requirements) return null;
  return Object.keys(requirements)
    .sort()
    .map((key) => [key, requirements[key as keyof Requirements]]);
}

/** Best score first; equal scores keep generation order. */
function byScore(a: PlannedCandidate, b: PlannedCandidate): number {
  return b.base - a.base || a.index - b.index;
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
