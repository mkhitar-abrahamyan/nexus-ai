import type { CompletionRequest } from '../types/messages.js';
import type { CapabilityPolicy, CapabilityWarning, CapabilityWarningAction } from '../types/capabilities.js';
import type { CacheTtl, ModelCapabilities, PromptCachingCapability, ReasoningEffort } from '../types/providers.js';

/**
 * Thrown under the `strict` capability policy when a request asks for something the target model
 * does not declare support for.
 */
export class NexusCapabilityError extends Error {
  readonly feature: string;
  readonly model: string;
  readonly provider?: string;
  readonly requested?: unknown;

  constructor(options: { feature: string; model: string; provider?: string; requested?: unknown; reason: string }) {
    const target = options.provider ? `${options.provider}/${options.model}` : options.model;
    super(`${target} cannot honor "${options.feature}": ${options.reason}`);
    this.name = 'NexusCapabilityError';
    this.feature = options.feature;
    this.model = options.model;
    this.provider = options.provider;
    this.requested = options.requested;
  }
}

export interface NegotiationResult<T> {
  value: T;
  warnings: CapabilityWarning[];
}

export interface NegotiateOptions {
  /** Defaults to `warn`. */
  policy?: CapabilityPolicy;
  provider?: string;
}

/** Shared empty result so the common path allocates nothing. */
const NO_WARNINGS: CapabilityWarning[] = Object.freeze([] as CapabilityWarning[]) as CapabilityWarning[];

const DEFAULT_POLICY: CapabilityPolicy = 'warn';

/**
 * Reconciles a completion request against the target model's declared capabilities.
 *
 * Nothing is checked unless the request actually sets the corresponding option, and the request
 * object is only copied when something has to change, so an ordinary call pays no allocation and
 * no traversal. An option the model does not mention is passed through untouched: absence of a
 * declaration means the registry does not know, not that the provider refuses.
 */
export function negotiateCompletionRequest(
  request: CompletionRequest,
  capabilities: ModelCapabilities | undefined,
  options: NegotiateOptions = {},
): NegotiationResult<CompletionRequest> {
  const policy = request.capabilityPolicy || options.policy || DEFAULT_POLICY;
  if (policy === 'off' || !capabilities) {
    return { value: request, warnings: NO_WARNINGS };
  }

  const warnings: CapabilityWarning[] = [];
  let draft: CompletionRequest | undefined;
  const mutable = (): CompletionRequest => {
    draft ??= { ...request };
    return draft;
  };

  const refuse = (
    feature: string,
    requested: unknown,
    reason: string,
    apply: (target: CompletionRequest) => void,
    action: CapabilityWarningAction = 'dropped',
    adjustedTo?: unknown,
  ): void => {
    if (policy === 'strict') {
      throw new NexusCapabilityError({
        feature,
        model: request.model,
        provider: options.provider,
        requested,
        reason,
      });
    }
    apply(mutable());
    warnings.push({
      feature,
      model: request.model,
      provider: options.provider,
      requested,
      action,
      adjustedTo,
      reason,
    });
  };

  if (request.tools?.length && capabilities.toolCalling === false) {
    refuse('tools', request.tools.length, 'the model does not support tool calling', (target) => {
      target.tools = undefined;
      target.toolChoice = undefined;
      target.parallelToolCalls = undefined;
    });
  }

  if (request.toolChoice !== undefined && capabilities.toolChoice === false) {
    refuse('toolChoice', request.toolChoice, 'the model does not support tool-choice control', (target) => {
      target.toolChoice = undefined;
    });
  }

  if (request.parallelToolCalls !== undefined && capabilities.parallelToolCalls === false) {
    refuse(
      'parallelToolCalls',
      request.parallelToolCalls,
      'the model does not expose a parallel tool-call switch',
      (target) => {
        target.parallelToolCalls = undefined;
      },
    );
  }

  if (request.reasoning) {
    negotiateReasoning(request, capabilities, refuse);
  }

  if (request.cache?.mode === 'explicit') {
    negotiateCache(request, capabilities, refuse);
  }

  if (request.responseFormat?.type === 'json_schema' && capabilities.structuredOutputs === false) {
    const downgrade = capabilities.jsonMode !== false;
    refuse(
      'responseFormat.type',
      'json_schema',
      downgrade
        ? 'the model does not support schema-constrained output; sent as plain JSON mode instead'
        : 'the model does not support structured outputs',
      (target) => {
        target.responseFormat = downgrade ? { type: 'json' } : undefined;
      },
      downgrade ? 'adjusted' : 'dropped',
      downgrade ? 'json' : undefined,
    );
  } else if (request.responseFormat?.type === 'json' && capabilities.jsonMode === false) {
    refuse('responseFormat.type', 'json', 'the model does not support a JSON output mode', (target) => {
      target.responseFormat = undefined;
    });
  }

  if (request.seed !== undefined && capabilities.seed === false) {
    refuse('seed', request.seed, 'the model does not support seeded sampling', (target) => {
      target.seed = undefined;
    });
  }

  if (request.topK !== undefined && capabilities.topK === false) {
    refuse('topK', request.topK, 'the model does not support top-k sampling', (target) => {
      target.topK = undefined;
    });
  }

  if (
    (request.frequencyPenalty !== undefined || request.presencePenalty !== undefined) &&
    capabilities.penalties === false
  ) {
    refuse(
      'penalties',
      { frequencyPenalty: request.frequencyPenalty, presencePenalty: request.presencePenalty },
      'the model does not support frequency or presence penalties',
      (target) => {
        target.frequencyPenalty = undefined;
        target.presencePenalty = undefined;
      },
    );
  }

  const maxOutputTokens = capabilities.maxOutputTokens;
  if (request.maxTokens !== undefined && maxOutputTokens !== undefined && request.maxTokens > maxOutputTokens) {
    refuse(
      'maxTokens',
      request.maxTokens,
      `the model caps output at ${maxOutputTokens} tokens`,
      (target) => {
        target.maxTokens = maxOutputTokens;
      },
      'adjusted',
      maxOutputTokens,
    );
  }

  return { value: draft ?? request, warnings: warnings.length ? warnings : NO_WARNINGS };
}

type Refuse = (
  feature: string,
  requested: unknown,
  reason: string,
  apply: (target: CompletionRequest) => void,
  action?: CapabilityWarningAction,
  adjustedTo?: unknown,
) => void;

function negotiateReasoning(request: CompletionRequest, capabilities: ModelCapabilities, refuse: Refuse): void {
  const reasoning = capabilities.reasoning;
  if (reasoning === false) {
    refuse('reasoning', request.reasoning, 'the model does not support reasoning controls', (target) => {
      target.reasoning = undefined;
    });
    return;
  }

  if (typeof reasoning !== 'object') return;

  const requestedEffort = request.reasoning?.effort;
  const efforts = reasoning.efforts;
  if (requestedEffort && efforts && !efforts.includes(requestedEffort)) {
    const fallback = nearestEffort(requestedEffort, efforts);
    refuse(
      'reasoning.effort',
      requestedEffort,
      `the model accepts ${efforts.join(', ')}`,
      (target) => {
        target.reasoning = { ...target.reasoning, effort: fallback };
      },
      'adjusted',
      fallback,
    );
  }

  const requestedBudget = request.reasoning?.maxTokens;
  const budgetCap = reasoning.maxTokens ?? capabilities.maxOutputTokens;
  if (requestedBudget !== undefined && budgetCap !== undefined && requestedBudget > budgetCap) {
    refuse(
      'reasoning.maxTokens',
      requestedBudget,
      `the model caps the thinking budget at ${budgetCap} tokens`,
      (target) => {
        target.reasoning = { ...target.reasoning, maxTokens: budgetCap };
      },
      'adjusted',
      budgetCap,
    );
  }
}

function negotiateCache(request: CompletionRequest, capabilities: ModelCapabilities, refuse: Refuse): void {
  const caching = capabilities.promptCaching;
  if (caching === false) {
    refuse('cache.mode', 'explicit', 'the model does not support prompt caching', (target) => {
      target.cache = { ...target.cache, mode: 'off' };
    });
    return;
  }

  const detail: PromptCachingCapability | undefined = typeof caching === 'object' ? caching : undefined;

  if (detail?.explicit === false || caching === true) {
    refuse(
      'cache.mode',
      'explicit',
      'the provider manages prompt caching automatically and does not accept caller-placed breakpoints',
      (target) => {
        target.cache = { ...target.cache, mode: 'auto' };
      },
      'adjusted',
      'auto',
    );
    return;
  }

  const requestedTtl = request.cache?.ttl;
  const ttls = detail?.ttls;
  if (requestedTtl && ttls?.length && !ttls.includes(requestedTtl)) {
    const fallback: CacheTtl = ttls[0];
    refuse(
      'cache.ttl',
      requestedTtl,
      `the model supports ${ttls.join(', ')}`,
      (target) => {
        target.cache = { ...target.cache, ttl: fallback };
      },
      'adjusted',
      fallback,
    );
  }
}

const EFFORT_ORDER: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Picks the supported effort closest to what was asked for, so `warn` mode degrades sensibly. */
function nearestEffort(requested: ReasoningEffort, supported: ReasoningEffort[]): ReasoningEffort | undefined {
  const target = EFFORT_ORDER.indexOf(requested);
  if (target < 0) return supported[0];

  let best: ReasoningEffort | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
