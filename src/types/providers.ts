/** What a model accepts: text, images, audio, video, or PDF documents. */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf';
/** What a model produces: text, images, or audio. */
export type OutputModality = 'text' | 'image' | 'audio';
/** Where a model is in its provider's lifecycle. */
export type ModelStatus = 'stable' | 'preview' | 'latest' | 'deprecated';
/** Which provider API a model is served through. */
export type ModelEndpoint = 'chat' | 'responses' | 'messages' | 'generateContent' | 'realtime';
/**
 * Portable reasoning effort, from none to the most the model offers. Each provider maps it to its
 * own control.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** A model the router should prefer, optionally weighted above others. */
export type RoutingModelPreference =
  | string
  | {
      model: string;
      weight?: number;
    };

/** Lifetime of a provider-side prompt cache entry. */
export type CacheTtl = '5m' | '1h';

/**
 * How a model supports prompt caching.
 *
 * `explicit` means the provider accepts caller-placed cache breakpoints. When it is false the
 * provider may still cache automatically; only caller control is unavailable.
 */
export interface PromptCachingCapability {
  /** Whether the provider accepts caller-placed cache breakpoints. */
  explicit?: boolean;
  /** Cache lifetimes the provider supports. */
  ttls?: CacheTtl[];
  /** Smallest prefix the provider will cache, in tokens. Shorter breakpoints are dropped. */
  minTokens?: number;
  /** Maximum number of caller-placed breakpoints the provider accepts. */
  maxBreakpoints?: number;
}

/**
 * Declared model behavior.
 *
 * Capability negotiation treats an omitted field as *unknown* and lets the request through, so
 * models registered by an application are never restricted by fields they do not declare. Only an
 * explicit `false`, or a value outside a declared constraint, is refused or dropped.
 */
export interface ModelCapabilities {
  /** Provider that serves the model. */
  provider?: string;
  /** Model family, for grouping versions. */
  family?: string;
  /** What the model accepts. An image in is `image`; a PDF document is `pdf`. */
  inputModalities: InputModality[];
  /** What the model produces. Almost always `['text']`; an image model adds `image`. */
  outputModalities: OutputModality[];
  /** Whether it can stream. */
  streaming: boolean;
  /** Whether it can call tools. */
  toolCalling: boolean;
  /** Whether it can guarantee output matching a JSON schema. */
  structuredOutputs?: boolean;
  /** Whether it can be forced to output valid JSON. */
  jsonMode?: boolean;
  /** Whether it reasons, and which efforts and token budget it accepts. */
  reasoning?: boolean | { efforts?: ReasoningEffort[]; maxTokens?: number };
  /** How it supports prompt caching. */
  promptCaching?: boolean | PromptCachingCapability;
  /** Whether a tool call can be forced, with `required` or a named tool. `auto` and `none` always pass. */
  toolChoice?: boolean;
  /** Whether it can make several tool calls at once. */
  parallelToolCalls?: boolean;
  /** Whether it accepts a temperature or top-p other than the provider default. */
  sampling?: boolean;
  /** Whether it honors a sampling seed. */
  seed?: boolean;
  /** Whether it accepts top-k sampling. */
  topK?: boolean;
  /** Whether it accepts frequency and presence penalties. */
  penalties?: boolean;
  /** Context window, in tokens. */
  maxContextTokens: number;
  /** Longest output, in tokens. */
  maxOutputTokens?: number;
  /** Price per 1,000 uncached input tokens, in US dollars. */
  costPer1kInput: number;
  /** Price per 1,000 output tokens, in US dollars. */
  costPer1kOutput: number;
  /** Price of a cached-prefix read. Falls back to a provider default multiplier when omitted. */
  costPer1kCachedInput?: number;
  /** Price of writing a cache entry. Falls back to a provider default multiplier when omitted. */
  costPer1kCacheWrite?: number;
  /** Relative quality, 0 to 100, used by quality routing. */
  qualityScore?: number;
  /** Relative speed, 0 to 100, used by speed routing. */
  speedScore?: number;
  /** Release date, ISO-8601. */
  release?: string;
  /** Training data cutoff, ISO-8601. */
  knowledgeCutoff?: string;
  /** Lifecycle status. */
  status?: ModelStatus;
  /** Provider APIs the model is served through. */
  endpoints?: ModelEndpoint[];
  /** ISO date this entry was last checked against provider documentation. */
  verifiedAt?: string;
  /** Where this entry was verified against. */
  source?: string;
  /** Anything else worth knowing, such as pricing caveats. */
  notes?: string;
}

/** Publication stage of a model alias. */
export type AliasStage = 'stable' | 'preview' | 'deprecated';

/** Where an alias stands and what it points to. */
export interface AliasMetadata {
  /** Whether the alias is stable, in preview, or deprecated. */
  stage: AliasStage;
  /** ISO date this alias target was last checked. */
  verifiedAt?: string;
  /** True when the alias target can change between releases, so runs are not reproducible. */
  floating?: boolean;
  /** Alias to migrate to when this one is deprecated. */
  replacement?: string;
  /** Anything else worth knowing about the alias. */
  note?: string;
}

/**
 * Default provenance for bundled registry entries that do not carry their own `verifiedAt`.
 *
 * Bundled pricing and context metadata are defaults, not financial truth. Override them through
 * `models.registry` when exact numbers matter.
 */
export const REGISTRY_PROVENANCE = {
  verifiedAt: '2026-10-02',
  source: 'provider documentation',
} as const;

/**
 * Fallback cache pricing as a multiple of the standard input rate, applied when a model does not
 * declare `costPer1kCachedInput` or `costPer1kCacheWrite`. Applications can override per model
 * through `models.registry`, or globally through `models.cachePricing`.
 */
export const DEFAULT_CACHE_PRICING: Record<string, { read: number; write: number; writeLong?: number }> = {
  anthropic: { read: 0.1, write: 1.25, writeLong: 2 },
  openai: { read: 0.1, write: 1 },
  google: { read: 0.25, write: 1 },
  deepseek: { read: 0.1, write: 1 },
};

/** A provider and the models it serves. */
export interface ProviderCapabilities {
  /** The provider's name. */
  name: string;
  /** Whether it runs locally. */
  isLocal: boolean;
  /** Its models, by name. */
  models: Record<string, ModelCapabilities>;
}

function model(capabilities: ModelCapabilities): ModelCapabilities {
  return capabilities;
}

const openaiReasoning: { efforts: ReasoningEffort[] } = {
  efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const gpt5 = (
  family: string,
  maxContextTokens: number,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  knowledgeCutoff: string,
): ModelCapabilities =>
  model({
    provider: 'openai',
    family,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: openaiReasoning,
    // OpenAI caches long prompt prefixes automatically; callers cannot place breakpoints.
    promptCaching: { explicit: false, ttls: ['5m'] },
    toolChoice: true,
    parallelToolCalls: true,
    // The OpenAI API has no top-k control; local OpenAI-compatible servers usually do.
    topK: false,
    seed: true,
    penalties: true,
    maxContextTokens,
    maxOutputTokens: 128000,
    costPer1kInput: inputPerMillion / 1000,
    costPer1kOutput: outputPerMillion / 1000,
    costPer1kCachedInput: (inputPerMillion * 0.1) / 1000,
    qualityScore,
    speedScore,
    release,
    knowledgeCutoff,
    status: 'stable',
    endpoints: ['chat', 'responses'],
  });

const anthropicEfforts: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The version at the end of a Claude family name, such as 4.6 for `claude-opus-4.6`.
 *
 * It is read from the end rather than matched by substring, which once reported the Claude 5 line
 * as non-reasoning because its name contains no "4".
 */
const claudeVersion = (family: string): number => Number.parseFloat(family.match(/(\d+(?:\.\d+)?)$/)?.[1] || '0');

/** Every Claude release from 3.7 onward supports extended thinking. */
const claudeSupportsThinking = (family: string): boolean => claudeVersion(family) >= 3.7;

/** Effort levels of the Claude models that think adaptively, by what each can reach and turn off. */
const ADAPTIVE_EFFORTS = {
  /** Thinking can be turned off, and every level up to `max` is available. */
  full: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  /** Thinking is always on. */
  alwaysOn: ['low', 'medium', 'high', 'xhigh', 'max'],
  /** The 4.6 generation, which has no `xhigh`. */
  noXhigh: ['none', 'low', 'medium', 'high', 'max'],
} satisfies Record<string, ReasoningEffort[]>;

const claude = (
  family: string,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  maxOutputTokens: number,
  release: string,
  knowledgeCutoff: string,
  maxContextTokens = 200000,
): ModelCapabilities =>
  model({
    provider: 'anthropic',
    family,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: false,
    jsonMode: false,
    // The thinking budget has to leave room for visible output inside the same limit.
    reasoning: claudeSupportsThinking(family)
      ? { efforts: anthropicEfforts, maxTokens: Math.floor(maxOutputTokens * 0.75) }
      : false,
    // Anthropic accepts caller-placed cache breakpoints, capped at four per request.
    promptCaching: { explicit: true, ttls: ['5m', '1h'], minTokens: 1024, maxBreakpoints: 4 },
    toolChoice: true,
    parallelToolCalls: true,
    topK: true,
    penalties: false,
    seed: false,
    maxContextTokens,
    maxOutputTokens,
    costPer1kInput: inputPerMillion / 1000,
    costPer1kOutput: outputPerMillion / 1000,
    costPer1kCachedInput: (inputPerMillion * 0.1) / 1000,
    costPer1kCacheWrite: (inputPerMillion * 1.25) / 1000,
    qualityScore,
    speedScore,
    release,
    knowledgeCutoff,
    status: 'stable',
    endpoints: ['messages'],
  });

/**
 * A Claude model that thinks adaptively, steered by effort: the 4.6 generation onward, all with a
 * 1M-token context.
 *
 * These models take no thinking budget, so no `reasoning.maxTokens` is declared. From 4.7 on, a
 * temperature, top-p, or top-k other than the default is rejected on every request.
 */
const claudeAdaptive = (
  family: string,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  maxOutputTokens: number,
  release: string,
  knowledgeCutoff: string,
  efforts: ReasoningEffort[],
  cacheReadMultiple = 0.1,
): ModelCapabilities => ({
  ...claude(
    family,
    inputPerMillion,
    outputPerMillion,
    qualityScore,
    speedScore,
    maxOutputTokens,
    release,
    knowledgeCutoff,
    1000000,
  ),
  reasoning: { efforts },
  costPer1kCachedInput: (inputPerMillion * cacheReadMultiple) / 1000,
  ...(claudeVersion(family) >= 4.7 ? { topK: false, sampling: false } : {}),
});

const gemini = (
  family: string,
  maxContextTokens: number,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  knowledgeCutoff: string | undefined,
  status: ModelStatus = 'stable',
): ModelCapabilities =>
  model({
    provider: 'google',
    family,
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: true,
    // Gemini caches implicitly; explicit control uses the separate cachedContents resource.
    promptCaching: { explicit: false, ttls: ['5m', '1h'] },
    toolChoice: true,
    topK: true,
    seed: true,
    penalties: true,
    maxContextTokens,
    maxOutputTokens: 65536,
    costPer1kInput: inputPerMillion / 1000,
    costPer1kOutput: outputPerMillion / 1000,
    costPer1kCachedInput: (inputPerMillion * 0.25) / 1000,
    qualityScore,
    speedScore,
    release,
    knowledgeCutoff,
    status,
    endpoints: ['generateContent'],
  });

const openAiCompatible = (
  provider: string,
  family: string,
  inputModalities: InputModality[],
  maxContextTokens: number,
  maxOutputTokens: number,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  status: ModelStatus = 'stable',
  notes?: string,
): ModelCapabilities =>
  model({
    provider,
    family,
    inputModalities,
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning:
      family.includes('reasoning') ||
      family.includes('gpt-oss') ||
      family.includes('magistral') ||
      family.includes('gemini-3'),
    toolChoice: true,
    parallelToolCalls: true,
    seed: true,
    penalties: true,
    maxContextTokens,
    maxOutputTokens,
    costPer1kInput: inputPerMillion / 1000,
    costPer1kOutput: outputPerMillion / 1000,
    qualityScore,
    speedScore,
    release,
    status,
    endpoints: ['chat'],
    notes,
  });

const cohere = (
  family: string,
  inputModalities: InputModality[],
  maxContextTokens: number,
  maxOutputTokens: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  notes?: string,
): ModelCapabilities =>
  model({
    provider: 'cohere',
    family,
    inputModalities,
    outputModalities: ['text'],
    streaming: false,
    toolCalling: true,
    structuredOutputs: false,
    jsonMode: false,
    reasoning: family.includes('reasoning'),
    maxContextTokens,
    maxOutputTokens,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    qualityScore,
    speedScore,
    release,
    status: 'stable',
    endpoints: ['chat'],
    notes:
      notes || 'Cohere pricing is deployment/plan dependent; override costs in models.registry for exact estimates.',
  });

/**
 * The bundled model registry: capabilities and prices for every model the package knows by name.
 * Defaults, not financial truth; override entries through `models.registry`.
 *
 * Models a provider has shut down are not listed. Models with an announced shutdown are marked
 * `deprecated`, and their notes give the date and the replacement.
 */
export const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  // OpenAI - current GPT-6 family. Prompts over 272K input tokens cost 2x input and 1.5x output.
  'gpt-6-astra': {
    ...gpt5('gpt-6', 1050000, 10, 50, 100, 70, '2026', '2026-04-30'),
    reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    costPer1kCacheWrite: 0.0125,
    endpoints: ['responses'],
    notes: 'OpenAI flagship for the hardest reasoning and agentic work.',
  },
  'gpt-6.1-sol': {
    ...gpt5('gpt-6.1', 1050000, 2, 10, 99, 84, '2026', '2026-04-30'),
    reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    costPer1kCachedInput: 0.0001,
    endpoints: ['responses'],
    notes: 'Near-Astra quality for coding, computer use, and professional work, at a lower price.',
  },
  'gpt-6-sol': {
    ...gpt5('gpt-6', 1050000, 2, 10, 98, 84, '2026', '2026-04-20'),
    endpoints: ['responses'],
    notes: 'Superseded by gpt-6.1-sol.',
  },
  'gpt-6-luna': {
    ...gpt5('gpt-6', 1050000, 0.1, 0.5, 90, 99, '2026', '2026-05-18'),
    endpoints: ['responses'],
    notes:
      'OpenAI model for high-volume, cost-sensitive work. Chat Completions calls tools only at reasoning effort none, so it is sent through Responses.',
  },

  // OpenAI - GPT-5.6 family
  'gpt-5.6-sol': {
    ...gpt5('gpt-5.6', 1050000, 4, 20, 97, 78, '2026-07', '2026-02-16'),
    endpoints: ['responses'],
  },
  'gpt-5.6-terra': {
    ...gpt5('gpt-5.6', 1050000, 2, 12, 94, 86, '2026-07', '2026-02-16'),
    endpoints: ['responses'],
  },
  'gpt-5.6-luna': {
    ...gpt5('gpt-5.6', 1050000, 0.2, 1.2, 88, 96, '2026-07', '2026-02-16'),
    endpoints: ['responses'],
  },

  // OpenAI - earlier GPT-5 releases
  'gpt-5.5': gpt5('gpt-5.5', 1000000, 5, 30, 96, 82, '2026', '2025-12-01'),
  'gpt-5.5-pro': {
    ...gpt5('gpt-5.5', 1050000, 30, 180, 97, 55, '2026', '2025-12-01'),
    structuredOutputs: false,
    endpoints: ['responses'],
  },
  'gpt-5.4': gpt5('gpt-5.4', 1050000, 2.5, 15, 93, 85, '2026-03', '2025-08-31'),
  'gpt-5.4-pro': {
    ...gpt5('gpt-5.4', 1050000, 30, 180, 95, 55, '2026-03', '2025-08-31'),
    structuredOutputs: false,
    endpoints: ['responses'],
  },
  'gpt-5.4-mini': gpt5('gpt-5.4', 400000, 0.75, 4.5, 90, 94, '2026-03', '2025-08-31'),
  'gpt-5.4-nano': {
    ...gpt5('gpt-5.4', 400000, 0.2, 1.25, 82, 98, '2026-03', '2025-08-31'),
    status: 'deprecated',
    notes: 'OpenAI shuts it down on 2027-04-01; migrate to gpt-6-luna.',
  },
  'gpt-5.3-codex': {
    ...gpt5('gpt-5.3', 400000, 1.75, 14, 95, 78, '2026', '2025-08-31'),
    family: 'codex',
    reasoning: { efforts: ['low', 'medium', 'high', 'xhigh'] },
    status: 'deprecated',
    endpoints: ['responses'],
    notes: 'OpenAI shuts it down on 2027-04-01; migrate to gpt-6-sol.',
  },
  'gpt-5.2': gpt5('gpt-5.2', 400000, 1.75, 14, 92, 82, '2025', '2025-08-31'),
  'gpt-5.2-pro': {
    ...gpt5('gpt-5.2', 400000, 21, 168, 94, 55, '2025', '2025-08-31'),
    endpoints: ['responses'],
  },
  'gpt-5.2-codex': {
    ...gpt5('gpt-5.2', 400000, 1.75, 14, 93, 78, '2025', '2025-08-31'),
    family: 'codex',
    reasoning: { efforts: ['low', 'medium', 'high', 'xhigh'] },
    endpoints: ['responses'],
  },
  'gpt-5.1': {
    ...gpt5('gpt-5.1', 400000, 1.25, 10, 90, 82, '2025', '2024-09-30'),
    status: 'deprecated',
    notes: 'OpenAI shuts it down on 2027-04-01; migrate to gpt-6-sol.',
  },
  'gpt-5': {
    ...gpt5('gpt-5', 400000, 1.25, 10, 88, 80, '2025', '2024-09-30'),
    status: 'deprecated',
    notes: 'OpenAI shuts it down on 2026-12-11; migrate to gpt-5.6-sol.',
  },
  'gpt-5-pro': {
    ...gpt5('gpt-5', 400000, 15, 120, 90, 50, '2025', '2024-09-30'),
    structuredOutputs: false,
    endpoints: ['responses'],
  },
  'gpt-5-mini': {
    ...gpt5('gpt-5', 400000, 0.25, 2, 84, 94, '2025', '2024-05-31'),
    status: 'deprecated',
    notes: 'OpenAI shuts it down on 2026-12-11; migrate to gpt-5.6-terra.',
  },
  'gpt-5-nano': {
    ...gpt5('gpt-5', 400000, 0.05, 0.4, 76, 99, '2025', '2024-05-31'),
    status: 'deprecated',
    notes: 'OpenAI shuts it down on 2026-12-11; migrate to gpt-5.6-luna.',
  },

  // OpenAI - GPT-4 and o-series, still deployed
  o1: model({
    provider: 'openai',
    family: 'o-series',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.06,
    qualityScore: 80,
    speedScore: 60,
    release: '2024',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4.1': model({
    provider: 'openai',
    family: 'gpt-4.1',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    costPer1kCachedInput: 0.0005,
    qualityScore: 82,
    speedScore: 80,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4.1-mini': model({
    provider: 'openai',
    family: 'gpt-4.1',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
    costPer1kCachedInput: 0.0001,
    qualityScore: 78,
    speedScore: 94,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4.1-nano': model({
    provider: 'openai',
    family: 'gpt-4.1',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    costPer1kCachedInput: 0.000025,
    qualityScore: 70,
    speedScore: 98,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4o': model({
    provider: 'openai',
    family: 'gpt-4o',
    inputModalities: ['text', 'image', 'audio'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    costPer1kCachedInput: 0.00125,
    qualityScore: 78,
    speedScore: 84,
    release: '2024',
    status: 'stable',
    endpoints: ['chat', 'responses', 'realtime'],
  }),
  'gpt-4o-mini': model({
    provider: 'openai',
    family: 'gpt-4o',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    costPer1kCachedInput: 0.000075,
    qualityScore: 72,
    speedScore: 96,
    release: '2024',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  o3: model({
    provider: 'openai',
    family: 'o-series',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    costPer1kCachedInput: 0.0005,
    qualityScore: 84,
    speedScore: 66,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'o3-pro': model({
    provider: 'openai',
    family: 'o-series',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: false,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.02,
    costPer1kOutput: 0.08,
    qualityScore: 86,
    speedScore: 40,
    release: '2025',
    status: 'stable',
    endpoints: ['responses'],
  }),
  'o3-mini': model({
    provider: 'openai',
    family: 'o-series',
    inputModalities: ['text'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    costPer1kCachedInput: 0.00055,
    qualityScore: 78,
    speedScore: 82,
    release: '2025',
    status: 'deprecated',
    endpoints: ['chat', 'responses'],
    notes: 'OpenAI shuts it down on 2026-10-23; migrate to gpt-5.6-sol.',
  }),
  'o4-mini': model({
    provider: 'openai',
    family: 'o-series',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    costPer1kCachedInput: 0.000275,
    qualityScore: 80,
    speedScore: 88,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-oss-120b': model({
    provider: 'openai',
    family: 'gpt-oss',
    inputModalities: ['text'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    maxContextTokens: 131000,
    maxOutputTokens: 32768,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    qualityScore: 78,
    speedScore: 70,
    release: '2025',
    status: 'stable',
    endpoints: [],
  }),
  'gpt-oss-20b': model({
    provider: 'openai',
    family: 'gpt-oss',
    inputModalities: ['text'],
    outputModalities: ['text'],
    streaming: true,
    toolCalling: true,
    maxContextTokens: 131000,
    maxOutputTokens: 32768,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    qualityScore: 68,
    speedScore: 88,
    release: '2025',
    status: 'stable',
    endpoints: [],
  }),

  // Anthropic - current
  'claude-fable-5-1': {
    ...claudeAdaptive(
      'claude-fable-5.1',
      10,
      50,
      100,
      62,
      128000,
      '2026-09-01',
      '2026-06',
      ADAPTIVE_EFFORTS.alwaysOn,
      0.025,
    ),
    toolChoice: false,
    notes: 'Thinking is always on. Rejects forced tool choice.',
  },
  'claude-opus-5-5': {
    ...claudeAdaptive(
      'claude-opus-5.5',
      4,
      20,
      99,
      76,
      128000,
      '2026-09-22',
      '2026-06',
      ADAPTIVE_EFFORTS.alwaysOn,
      0.05,
    ),
    toolChoice: false,
    notes: 'Thinking is always on, at effort medium by default. Rejects forced tool choice.',
  },
  'claude-sonnet-5-5': {
    ...claudeAdaptive('claude-sonnet-5.5', 2, 10, 97, 88, 128000, '2026-09-28', '2026-06', ADAPTIVE_EFFORTS.full),
    toolChoice: false,
    notes: 'Effort none turns off up-front thinking only, at effort high or below. Rejects forced tool choice.',
  },
  'claude-haiku-4-5-20251001': claude('claude-haiku-4.5', 1, 5, 86, 98, 64000, '2025-10-01', '2025-02'),

  // Anthropic - legacy, still served
  'claude-fable-5': {
    ...claudeAdaptive('claude-fable-5', 10, 50, 98, 62, 128000, '2026-06-09', '2026-01', ADAPTIVE_EFFORTS.alwaysOn),
    notes: 'Thinking is always on.',
  },
  'claude-opus-5': {
    ...claudeAdaptive('claude-opus-5', 5, 25, 98, 74, 128000, '2026-07-24', '2026-05', ADAPTIVE_EFFORTS.full),
    notes: 'Thinking turns off only at effort high or below.',
  },
  'claude-sonnet-5': claudeAdaptive(
    'claude-sonnet-5',
    2,
    10,
    95,
    88,
    128000,
    '2026-06-30',
    '2026-01',
    ADAPTIVE_EFFORTS.full,
  ),
  'claude-opus-4-8': claudeAdaptive('claude-opus-4.8', 5, 25, 96, 74, 128000, '2026', '2026-06', ADAPTIVE_EFFORTS.full),
  'claude-opus-4-7': claudeAdaptive('claude-opus-4.7', 5, 25, 95, 72, 128000, '2026', '2026-01', ADAPTIVE_EFFORTS.full),
  'claude-opus-4-6': claudeAdaptive(
    'claude-opus-4.6',
    5,
    25,
    94,
    72,
    128000,
    '2026',
    '2026-01',
    ADAPTIVE_EFFORTS.noXhigh,
  ),
  'claude-sonnet-4-6': claudeAdaptive(
    'claude-sonnet-4.6',
    3,
    15,
    92,
    88,
    64000,
    '2026',
    '2025-08',
    ADAPTIVE_EFFORTS.noXhigh,
  ),
  'claude-opus-4-5-20251101': claude('claude-opus-4.5', 5, 25, 92, 72, 64000, '2025-11-24', '2025-05'),
  'claude-sonnet-4-5-20250929': {
    ...claude('claude-sonnet-4.5', 3, 15, 90, 86, 64000, '2025-09-29', '2025-01'),
    status: 'deprecated',
    notes: 'Anthropic retires it on 2026-11-30; migrate to claude-sonnet-5-5.',
  },

  // Google Gemini - the 3.6 to 3.8 Flash prices double on 2027-01-01.
  'gemini-3.8-flash': {
    ...gemini('gemini-3.8', 1048576, 0.75, 3.75, 95, 94, '2026-09', undefined),
    notes: 'Prices double on 2027-01-01, to $1.50 input and $7.50 output per million tokens.',
  },
  'gemini-3.7-flash': {
    ...gemini('gemini-3.7', 1048576, 0.75, 3.75, 93, 94, '2026', undefined),
    notes: 'Prices double on 2027-01-01, to $1.50 input and $7.50 output per million tokens.',
  },
  'gemini-3.6-flash': {
    ...gemini('gemini-3.6', 1048576, 0.75, 3.75, 91, 94, '2026', undefined),
    notes: 'Prices double on 2027-01-01, to $1.50 input and $7.50 output per million tokens.',
  },
  'gemini-3.5-flash': gemini('gemini-3.5', 1048576, 1.5, 9, 90, 94, '2026-05', undefined),
  'gemini-3.5-flash-lite': gemini('gemini-3.5', 1048576, 0.3, 2.5, 84, 97, '2026-07', undefined),
  'gemini-3.1-flash-lite': {
    ...gemini('gemini-3.1', 1048576, 0.25, 1.5, 82, 98, '2026', undefined),
    status: 'deprecated',
    notes: 'Google shuts it down on 2027-05-07; migrate to gemini-3.5-flash-lite.',
  },
  'gemini-3.1-pro-preview': gemini('gemini-3.1', 1048576, 2, 12, 97, 76, '2026-02', undefined, 'preview'),
  'gemini-3.1-pro-preview-customtools': gemini('gemini-3.1', 1048576, 2, 12, 97, 74, '2026-02', undefined, 'preview'),
  'gemini-3-flash-preview': {
    ...gemini('gemini-3', 1048576, 0.5, 3, 88, 94, '2025-12', undefined, 'preview'),
    notes: 'Google names gemini-3.6-flash as its replacement.',
  },
  'gemini-3-pro-image': {
    ...gemini('gemini-3-image', 65536, 2, 120, 88, 70, '2025-11', undefined),
    inputModalities: ['text', 'image'],
    outputModalities: ['text', 'image'],
    toolCalling: false,
    structuredOutputs: false,
    maxOutputTokens: 32768,
    notes: 'The output price is the image rate; text output costs less.',
  },
  'gemini-3.1-flash-image': {
    ...gemini('gemini-3.1-image', 131072, 0.5, 60, 84, 86, '2026-02', undefined),
    inputModalities: ['text', 'image', 'video', 'pdf'],
    outputModalities: ['text', 'image'],
    toolCalling: false,
    structuredOutputs: false,
    maxOutputTokens: 32768,
    notes: 'The output price is the image rate; text output costs less.',
  },
  'gemini-2.5-pro': {
    ...gemini('gemini-2.5', 1048576, 1.25, 10, 86, 76, '2025-06', '2025-01'),
    status: 'deprecated',
    notes: 'Google limits it to existing users and recommends Gemini 3 for new work.',
  },
  'gemini-2.5-flash': {
    ...gemini('gemini-2.5', 1048576, 0.3, 2.5, 80, 94, '2025', '2025-01'),
    status: 'deprecated',
    notes: 'Google limits it to existing users and recommends Gemini 3 for new work.',
  },
  'gemini-2.5-flash-lite': {
    ...gemini('gemini-2.5', 1048576, 0.1, 0.4, 72, 98, '2025', '2025-01'),
    status: 'deprecated',
    notes: 'Google limits it to existing users and recommends Gemini 3 for new work.',
  },

  // Groq hosted models
  'groq/openai/gpt-oss-120b': openAiCompatible('groq', 'gpt-oss', ['text'], 131072, 65536, 0.15, 0.6, 86, 96, '2025'),
  'groq/openai/gpt-oss-20b': openAiCompatible('groq', 'gpt-oss', ['text'], 131072, 65536, 0.075, 0.3, 78, 100, '2025'),
  'groq/qwen/qwen3.8-27b': {
    ...openAiCompatible('groq', 'qwen3.8', ['text'], 131072, 16384, 0.8, 4, 84, 90, '2026', 'preview'),
    reasoning: true,
  },
  'groq/minimaxai/minimax-m2.7': {
    ...openAiCompatible(
      'groq',
      'minimax-m2',
      ['text'],
      196608,
      131072,
      0,
      0,
      86,
      88,
      '2026',
      'preview',
      'Groq prices it through sales; override costs in models.registry.',
    ),
    reasoning: true,
  },
  'groq/llama-3.3-70b-versatile': openAiCompatible(
    'groq',
    'llama-3.3',
    ['text'],
    131072,
    32768,
    0.59,
    0.79,
    76,
    92,
    '2024',
    'deprecated',
    'Groq ended on-demand access on 2026-08-16 and offers it through sales; migrate to groq/openai/gpt-oss-120b.',
  ),
  'groq/llama-3.1-8b-instant': openAiCompatible(
    'groq',
    'llama-3.1',
    ['text'],
    131072,
    131072,
    0.05,
    0.08,
    64,
    98,
    '2024',
    'deprecated',
    'Groq ended on-demand access on 2026-08-16 and offers it through sales; migrate to groq/openai/gpt-oss-20b.',
  ),
  'groq/openai/gpt-oss-safeguard-20b': openAiCompatible(
    'groq',
    'safety',
    ['text'],
    131072,
    65536,
    0.075,
    0.3,
    70,
    100,
    '2025',
    'preview',
  ),
  'groq/meta-llama/llama-prompt-guard-2-22m': openAiCompatible(
    'groq',
    'prompt-guard',
    ['text'],
    512,
    512,
    0.03,
    0.03,
    55,
    100,
    '2026',
    'preview',
  ),
  'groq/meta-llama/llama-prompt-guard-2-86m': openAiCompatible(
    'groq',
    'prompt-guard',
    ['text'],
    512,
    512,
    0.04,
    0.04,
    58,
    100,
    '2026',
    'preview',
  ),

  // Mistral AI
  'mistral/mistral-medium-2604': {
    ...openAiCompatible('mistral', 'mistral-medium-3.5', ['text', 'image'], 262144, 8192, 1.5, 7.5, 92, 78, '2026-04'),
    reasoning: true,
  },
  'mistral/mistral-small-2603': {
    ...openAiCompatible('mistral', 'mistral-small-4', ['text', 'image'], 262144, 8192, 0.15, 0.6, 84, 92, '2026-03'),
    reasoning: true,
  },
  'mistral/mistral-large-2512': openAiCompatible(
    'mistral',
    'mistral-large-3',
    ['text', 'image'],
    262144,
    8192,
    0.5,
    1.5,
    88,
    80,
    '2025-12',
  ),
  'mistral/ministral-14b-2512': openAiCompatible(
    'mistral',
    'ministral-3',
    ['text', 'image'],
    262144,
    8192,
    0.2,
    0.2,
    80,
    92,
    '2025-12',
  ),
  'mistral/ministral-8b-2512': openAiCompatible(
    'mistral',
    'ministral-3',
    ['text', 'image'],
    262144,
    8192,
    0.15,
    0.15,
    76,
    95,
    '2025-12',
  ),
  'mistral/ministral-3b-2512': openAiCompatible(
    'mistral',
    'ministral-3',
    ['text', 'image'],
    262144,
    8192,
    0.1,
    0.1,
    70,
    97,
    '2025-12',
  ),
  'mistral/codestral-2508': openAiCompatible(
    'mistral',
    'codestral',
    ['text'],
    128000,
    8192,
    0.3,
    0.9,
    84,
    86,
    '2025-08',
    'stable',
    'Code model for fill-in-the-middle and code generation.',
  ),
  'mistral/mistral-moderation-2603': openAiCompatible(
    'mistral',
    'moderation',
    ['text'],
    128000,
    4096,
    0,
    0,
    70,
    92,
    '2026-03',
    'stable',
    'Moderation model, not intended for normal chat completions.',
  ),

  // DeepSeek - prices are the peak rate; off-peak hours cost half.
  'deepseek/deepseek-flash': {
    ...openAiCompatible(
      'deepseek',
      'deepseek-v4.1-flash',
      ['text', 'image'],
      1000000,
      384000,
      0.3,
      1.2,
      88,
      90,
      '2026',
      'stable',
      'Thinks by default. Peak price; off-peak hours (outside 01:00-04:00 and 06:00-10:00 UTC on weekdays) cost half.',
    ),
    reasoning: true,
    costPer1kCachedInput: 0.000006,
  },
  'deepseek/deepseek-v4-pro': {
    ...openAiCompatible(
      'deepseek',
      'deepseek-v4-pro',
      ['text'],
      1000000,
      384000,
      1.32,
      3.96,
      93,
      74,
      '2026-08',
      'stable',
      'Thinks by default. Peak price; off-peak hours (outside 01:00-04:00 and 06:00-10:00 UTC on weekdays) cost half.',
    ),
    reasoning: true,
    costPer1kCachedInput: 0.000044,
  },

  // Local OpenAI-compatible servers
  'lmstudio/local-model': openAiCompatible(
    'lmstudio',
    'local',
    ['text'],
    8192,
    4096,
    0,
    0,
    65,
    75,
    'local',
    'stable',
    'Placeholder for LM Studio. Use an explicit lmstudio/<loaded-model> name for direct routing.',
  ),
  'llamacpp/local-model': openAiCompatible(
    'llamacpp',
    'local',
    ['text'],
    8192,
    4096,
    0,
    0,
    65,
    75,
    'local',
    'stable',
    'Placeholder for llama.cpp OpenAI-compatible server. Use an explicit llamacpp/<loaded-model> name for direct routing.',
  ),

  // Cohere
  'cohere/command-a-plus-05-2026': {
    ...cohere('command-a-plus', ['text', 'image'], 128000, 64000, 90, 74, '2026-05'),
    reasoning: true,
  },
  'cohere/command-a-03-2025': cohere('command-a', ['text'], 256000, 8000, 86, 80, '2025-03'),
  'cohere/command-a-reasoning-08-2025': cohere('command-a-reasoning', ['text'], 256000, 32000, 88, 68, '2025-08'),
  'cohere/command-a-vision-07-2025': cohere('command-a-vision', ['text', 'image'], 128000, 8000, 84, 78, '2025-07'),
  'cohere/command-a-translate-08-2025': cohere('command-a-translate', ['text'], 8000, 8000, 84, 82, '2025-08'),
  'cohere/command-r-plus-08-2024': cohere('command-r-plus', ['text'], 128000, 4000, 80, 82, '2024-08'),
  'cohere/command-r-08-2024': cohere('command-r', ['text'], 128000, 4000, 76, 92, '2024-08'),
  'cohere/command-r7b-12-2024': cohere('command-r7b', ['text'], 128000, 4000, 74, 94, '2024-12'),
  'cohere/north-mini-code-1-0': cohere('north-mini-code', ['text'], 256000, 64000, 84, 86, '2026'),
  'cohere/north-small-translate-1-0': cohere('north-small-translate', ['text'], 16000, 16000, 80, 92, '2026'),
  'cohere/c4ai-aya-expanse-32b': cohere('aya-expanse', ['text'], 128000, 4000, 76, 84, '2024'),
  'cohere/c4ai-aya-vision-32b': cohere('aya-vision', ['text', 'image'], 16000, 4000, 78, 78, '2024'),
  'cohere/tiny-aya-global': cohere('tiny-aya', ['text'], 8000, 8000, 62, 98, '2026'),
  'cohere/tiny-aya-earth': cohere('tiny-aya', ['text'], 8000, 8000, 62, 98, '2026'),
  'cohere/tiny-aya-fire': cohere('tiny-aya', ['text'], 8000, 8000, 62, 98, '2026'),
  'cohere/tiny-aya-water': cohere('tiny-aya', ['text'], 8000, 8000, 62, 98, '2026'),
};

export const MODEL_ALIASES: Record<string, string> = {
  'gpt-5.6': 'gpt-5.6-sol',
  'openai/best': 'gpt-6-astra',
  'openai/pro': 'gpt-5.5-pro',
  'openai/balanced': 'gpt-6.1-sol',
  'openai/fast': 'gpt-6-luna',
  'openai/cheap': 'gpt-6-luna',
  'openai/coding': 'gpt-6.1-sol',
  'openai/codex': 'gpt-5.3-codex',
  'anthropic/best': 'claude-fable-5-1',
  'anthropic/balanced': 'claude-sonnet-5-5',
  'anthropic/fast': 'claude-haiku-4-5-20251001',
  'google/best': 'gemini-3.1-pro-preview',
  'google/balanced': 'gemini-3.8-flash',
  'google/fast': 'gemini-3.5-flash-lite',
  'google/cheap': 'gemini-3.5-flash-lite',
  'groq/best': 'groq/openai/gpt-oss-120b',
  'groq/fast': 'groq/openai/gpt-oss-20b',
  'groq/cheap': 'groq/openai/gpt-oss-20b',
  'mistral/best': 'mistral/mistral-medium-2604',
  'mistral/balanced': 'mistral/mistral-small-2603',
  'mistral/fast': 'mistral/ministral-8b-2512',
  'mistral/cheap': 'mistral/ministral-3b-2512',
  'mistral/coding': 'mistral/codestral-2508',
  'mistral/mistral-medium-3.5': 'mistral/mistral-medium-2604',
  'mistral/mistral-small-4': 'mistral/mistral-small-2603',
  'mistral/mistral-large-3': 'mistral/mistral-large-2512',
  'deepseek/best': 'deepseek/deepseek-v4-pro',
  'deepseek/balanced': 'deepseek/deepseek-flash',
  'deepseek/fast': 'deepseek/deepseek-flash',
  'deepseek/cheap': 'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-flash': 'deepseek/deepseek-flash',
  'cohere/best': 'cohere/command-a-plus-05-2026',
  'cohere/reasoning': 'cohere/command-a-reasoning-08-2025',
  'cohere/vision': 'cohere/command-a-vision-07-2025',
  'cohere/coding': 'cohere/north-mini-code-1-0',
  'cohere/fast': 'cohere/command-r7b-12-2024',
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'claude-fable-5.0': 'claude-fable-5',
  'claude-opus-5.0': 'claude-opus-5',
  'claude-sonnet-5.0': 'claude-sonnet-5',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4-7-latest': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4-6-latest': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-5-20251101',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-opus-4-5-latest': 'claude-opus-4-5-20251101',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-latest': 'claude-sonnet-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-latest': 'claude-haiku-4-5-20251001',
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3.8-flash',
  'gemini-flash-lite-latest': 'gemini-3.5-flash-lite',
};

/**
 * Aliases whose target is chosen by quality/speed/cost intent rather than pinned to one model.
 * Their target can change in any release, so a reproducible run should pin the resolved model.
 */
const FLOATING_ALIAS_SUFFIXES = [
  '/best',
  '/balanced',
  '/fast',
  '/cheap',
  '/pro',
  '/coding',
  '/codex',
  '/reasoning',
  '/vision',
  '/compound',
];

/** An alias is in preview or deprecated when the model it resolves to is. */
function aliasStage(target: string): AliasStage {
  const status = KNOWN_MODELS[target]?.status;
  return status === 'preview' || status === 'deprecated' ? status : 'stable';
}

/**
 * Stage and provenance for every bundled alias, derived from its target so the two cannot drift.
 */
export const MODEL_ALIAS_METADATA: Record<string, AliasMetadata> = Object.fromEntries(
  Object.entries(MODEL_ALIASES).map(([alias, target]) => [
    alias,
    {
      stage: aliasStage(target),
      floating: alias.endsWith('-latest') || FLOATING_ALIAS_SUFFIXES.some((suffix) => alias.endsWith(suffix)),
      verifiedAt: REGISTRY_PROVENANCE.verifiedAt,
    } satisfies AliasMetadata,
  ]),
);

/** The provider a model name belongs to, from its prefix, or `null` when the name gives no clue. */
export function resolveProvider(model: string): string | null {
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.includes('/')) {
    const prefix = model.split('/')[0];
    if (prefix === 'azure') return 'azure-openai';
    if (prefix === 'llama.cpp') return 'llamacpp';
    if (
      [
        'ollama',
        'google',
        'groq',
        'lmstudio',
        'llamacpp',
        'azure-openai',
        'openrouter',
        'together',
        'deepseek',
        'mistral',
        'cohere',
      ].includes(prefix)
    )
      return prefix;
  }
  return null;
}
