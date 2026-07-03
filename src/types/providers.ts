export type Modality = 'text' | 'vision' | 'audio' | 'video' | 'image' | 'pdf';
export type ModelStatus = 'stable' | 'preview' | 'latest' | 'deprecated';
export type ModelEndpoint = 'chat' | 'responses' | 'messages' | 'generateContent' | 'realtime';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type RoutingModelPreference =
  | string
  | {
      model: string;
      weight?: number;
    };

export interface ModelCapabilities {
  provider?: string;
  family?: string;
  modalities: Modality[];
  streaming: boolean;
  toolCalling: boolean;
  structuredOutputs?: boolean;
  jsonMode?: boolean;
  reasoning?: boolean | { efforts?: ReasoningEffort[] };
  maxContextTokens: number;
  maxOutputTokens?: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  qualityScore?: number;
  speedScore?: number;
  release?: string;
  knowledgeCutoff?: string;
  status?: ModelStatus;
  endpoints?: ModelEndpoint[];
  notes?: string;
}

export interface ProviderCapabilities {
  name: string;
  isLocal: boolean;
  models: Record<string, ModelCapabilities>;
}

function model(capabilities: ModelCapabilities): ModelCapabilities {
  return capabilities;
}

const openaiReasoning: { efforts: ReasoningEffort[] } = {
  efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
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
): ModelCapabilities => model({
  provider: 'openai',
  family,
  modalities: ['text', 'vision'],
  streaming: true,
  toolCalling: true,
  structuredOutputs: true,
  jsonMode: true,
  reasoning: openaiReasoning,
  maxContextTokens,
  maxOutputTokens: 128000,
  costPer1kInput: inputPerMillion / 1000,
  costPer1kOutput: outputPerMillion / 1000,
  qualityScore,
  speedScore,
  release,
  knowledgeCutoff,
  status: 'stable',
  endpoints: ['chat', 'responses'],
});

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
): ModelCapabilities => model({
  provider: 'anthropic',
  family,
  modalities: ['text', 'vision'],
  streaming: true,
  toolCalling: true,
  structuredOutputs: false,
  jsonMode: false,
  reasoning: family.includes('4') || family.includes('3.7'),
  maxContextTokens,
  maxOutputTokens,
  costPer1kInput: inputPerMillion / 1000,
  costPer1kOutput: outputPerMillion / 1000,
  qualityScore,
  speedScore,
  release,
  knowledgeCutoff,
  status: 'stable',
  endpoints: ['messages'],
});

const gemini = (
  family: string,
  maxContextTokens: number,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  knowledgeCutoff: string,
  status: ModelStatus = 'stable',
): ModelCapabilities => model({
  provider: 'google',
  family,
  modalities: ['text', 'vision', 'audio', 'video', 'pdf'],
  streaming: true,
  toolCalling: true,
  structuredOutputs: true,
  jsonMode: true,
  reasoning: true,
  maxContextTokens,
  maxOutputTokens: 65536,
  costPer1kInput: inputPerMillion / 1000,
  costPer1kOutput: outputPerMillion / 1000,
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
  modalities: Modality[],
  maxContextTokens: number,
  maxOutputTokens: number,
  inputPerMillion: number,
  outputPerMillion: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  status: ModelStatus = 'stable',
  notes?: string,
): ModelCapabilities => model({
  provider,
  family,
  modalities,
  streaming: true,
  toolCalling: true,
  structuredOutputs: true,
  jsonMode: true,
  reasoning: family.includes('reasoning') || family.includes('gpt-oss') || family.includes('magistral') || family.includes('gemini-3'),
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
  modalities: Modality[],
  maxContextTokens: number,
  maxOutputTokens: number,
  qualityScore: number,
  speedScore: number,
  release: string,
  notes?: string,
): ModelCapabilities => model({
  provider: 'cohere',
  family,
  modalities,
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
  notes: notes || 'Cohere pricing is deployment/plan dependent; override costs in models.registry for exact estimates.',
});

export const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  // OpenAI - current GPT-5 family
  'gpt-5.5': gpt5('gpt-5.5', 1000000, 5, 30, 99, 82, '2026', '2025-12-01'),
  'gpt-5.5-pro': {
    ...gpt5('gpt-5.5', 1050000, 30, 180, 100, 55, '2026', '2025-12-01'),
    structuredOutputs: false,
    endpoints: ['responses'],
  },
  'gpt-5.4': gpt5('gpt-5.4', 1050000, 2.5, 15, 97, 85, '2026-03', '2025-08-31'),
  'gpt-5.4-pro': {
    ...gpt5('gpt-5.4', 1050000, 30, 180, 99, 55, '2026-03', '2025-08-31'),
    structuredOutputs: false,
    endpoints: ['responses'],
  },
  'gpt-5.4-mini': gpt5('gpt-5.4', 400000, 0.75, 4.5, 92, 94, '2026-03', '2025-08-31'),
  'gpt-5.4-nano': gpt5('gpt-5.4', 400000, 0.2, 1.25, 84, 98, '2026-03', '2025-08-31'),
  'gpt-5.2': gpt5('gpt-5.2', 400000, 1.75, 14, 96, 82, '2025', '2025-08-31'),
  'gpt-5.2-pro': {
    ...gpt5('gpt-5.2', 400000, 30, 180, 98, 55, '2025', '2025-08-31'),
    endpoints: ['responses'],
  },
  'gpt-5.2-codex': {
    ...gpt5('gpt-5.2', 400000, 1.75, 14, 96, 78, '2025', '2025-08-31'),
    family: 'codex',
    endpoints: ['responses'],
  },
  'gpt-5.1': gpt5('gpt-5.1', 400000, 1.25, 10, 94, 82, '2025', '2024-09-30'),
  'gpt-5': gpt5('gpt-5', 400000, 1.25, 10, 92, 80, '2025', '2024-09-30'),
  'gpt-5-mini': gpt5('gpt-5', 400000, 0.25, 2, 88, 94, '2025', '2024-05-31'),
  'gpt-5-nano': gpt5('gpt-5', 400000, 0.05, 0.4, 78, 99, '2025', '2024-05-31'),
  'gpt-5-codex': {
    ...gpt5('gpt-5', 400000, 1.25, 10, 93, 78, '2025', '2024-09-30'),
    family: 'codex',
    endpoints: ['responses'],
  },
  'gpt-5-chat-latest': {
    ...gpt5('gpt-5', 128000, 1.25, 10, 90, 82, 'latest', '2024-09-30'),
    maxOutputTokens: 16384,
    status: 'latest',
  },

  // OpenAI - GPT-4 / reasoning legacy still commonly deployed
  'gpt-4.1': model({
    provider: 'openai',
    family: 'gpt-4.1',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    qualityScore: 88,
    speedScore: 80,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4.1-mini': model({
    provider: 'openai',
    family: 'gpt-4.1',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.0004,
    costPer1kOutput: 0.0016,
    qualityScore: 82,
    speedScore: 94,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4.1-nano': model({
    provider: 'openai',
    family: 'gpt-4.1',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 1047576,
    maxOutputTokens: 32768,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    qualityScore: 74,
    speedScore: 98,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-4o': model({
    provider: 'openai',
    family: 'gpt-4o',
    modalities: ['text', 'vision', 'audio'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.0025,
    costPer1kOutput: 0.01,
    qualityScore: 84,
    speedScore: 84,
    release: '2024',
    status: 'stable',
    endpoints: ['chat', 'responses', 'realtime'],
  }),
  'gpt-4o-mini': model({
    provider: 'openai',
    family: 'gpt-4o',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    maxContextTokens: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    qualityScore: 76,
    speedScore: 96,
    release: '2024',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'o3': model({
    provider: 'openai',
    family: 'o-series',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    qualityScore: 90,
    speedScore: 66,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'o3-mini': model({
    provider: 'openai',
    family: 'o-series',
    modalities: ['text'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    qualityScore: 84,
    speedScore: 82,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'o4-mini': model({
    provider: 'openai',
    family: 'o-series',
    modalities: ['text', 'vision'],
    streaming: true,
    toolCalling: true,
    structuredOutputs: true,
    jsonMode: true,
    reasoning: { efforts: ['low', 'medium', 'high'] },
    maxContextTokens: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.0011,
    costPer1kOutput: 0.0044,
    qualityScore: 86,
    speedScore: 88,
    release: '2025',
    status: 'stable',
    endpoints: ['chat', 'responses'],
  }),
  'gpt-oss-120b': model({
    provider: 'openai',
    family: 'gpt-oss',
    modalities: ['text'],
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
    modalities: ['text'],
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

  // Anthropic
  'claude-opus-4-7': claude('claude-opus-4.7', 5, 25, 99, 72, 128000, '2026', '2026-01', 1000000),
  'claude-opus-4-6': {
    ...claude('claude-opus-4.6', 5, 25, 98, 72, 128000, '2026', '2026-01', 1000000),
    notes: 'Anthropic docs reference claude-opus-4-6 for Claude Code and batch beta usage; verify account and platform availability.',
  },
  'claude-opus-4-5-20251101': {
    ...claude('claude-opus-4.5', 5, 25, 97, 72, 128000, '2025-11-01', '2025-08', 1000000),
    notes: 'Anthropic Claude Code Bedrock docs reference this Opus 4.5 snapshot; verify direct Claude API availability before production use.',
  },
  'claude-sonnet-4-6': claude('claude-sonnet-4.6', 3, 15, 96, 88, 64000, '2026', '2025-08', 1000000),
  'claude-haiku-4-5-20251001': claude('claude-haiku-4.5', 1, 5, 86, 98, 64000, '2025-10-01', '2025-02'),
  'claude-opus-4-1-20250805': claude('claude-opus-4.1', 15, 75, 97, 70, 32000, '2025-08-05', '2025-03'),
  'claude-opus-4-20250514': claude('claude-opus-4', 15, 75, 95, 70, 32000, '2025-05-14', '2025-03'),
  'claude-sonnet-4-20250514': claude('claude-sonnet-4', 3, 15, 92, 86, 64000, '2025-05-14', '2025-03'),
  'claude-3-7-sonnet-20250219': claude('claude-3.7', 3, 15, 89, 84, 64000, '2025-02-19', '2024-10'),
  'claude-3-5-sonnet-20241022': claude('claude-3.5', 3, 15, 86, 84, 8192, '2024-10-22', '2024-04'),
  'claude-3-5-sonnet-20240620': claude('claude-3.5', 3, 15, 84, 82, 8192, '2024-06-20', '2024-04'),
  'claude-3-5-haiku-20241022': claude('claude-haiku-3.5', 0.8, 4, 78, 96, 8192, '2024-10-22', '2024-07'),
  'claude-3-haiku-20240307': claude('claude-haiku-3', 0.25, 1.25, 68, 94, 4096, '2024-03-07', '2023-08'),

  // Google Gemini
  'gemini-3.1-pro-preview': gemini('gemini-3.1', 1048576, 2, 12, 97, 76, '2026-02', '2025-01', 'preview'),
  'gemini-3.1-pro-preview-customtools': gemini('gemini-3.1', 1048576, 2, 12, 97, 74, '2026-02', '2025-01', 'preview'),
  'gemini-3.1-flash-lite-preview': gemini('gemini-3.1', 1048576, 0.1, 0.4, 86, 98, '2026', '2025-01', 'preview'),
  'gemini-3-pro-preview': {
    ...gemini('gemini-3', 1048576, 2, 12, 96, 76, '2025-11', '2025-01', 'preview'),
    status: 'deprecated',
    notes: 'Deprecated and shut down by Google on 2026-03-09; migrate to gemini-3.1-pro-preview.',
  },
  'gemini-3-flash-preview': gemini('gemini-3', 1048576, 0.5, 3, 90, 94, '2025-12', '2025-01', 'preview'),
  'gemini-3-pro-image-preview': {
    ...gemini('gemini-3-image', 65536, 2, 12, 88, 70, '2025-11', '2025-01', 'preview'),
    modalities: ['text', 'vision', 'image'],
    toolCalling: false,
  },
  'gemini-2.5-pro': gemini('gemini-2.5', 1048576, 1.25, 10, 92, 76, '2025-06', '2025-01'),
  'gemini-2.5-flash': gemini('gemini-2.5', 1048576, 0.3, 2.5, 86, 94, '2025', '2025-01'),
  'gemini-2.5-flash-lite': gemini('gemini-2.5', 1048576, 0.1, 0.4, 76, 98, '2025', '2025-01'),
  'gemini-2.5-flash-lite-preview-09-2025': gemini('gemini-2.5', 1048576, 0.1, 0.4, 76, 98, '2025-09', '2025-01', 'preview'),
  'gemini-2.0-flash': gemini('gemini-2.0', 1048576, 0.1, 0.4, 78, 94, '2025-02', '2024-08'),
  'gemini-1.5-pro': {
    ...gemini('gemini-1.5', 2000000, 1.25, 5, 80, 70, '2024', '2024'),
    status: 'deprecated',
  },
  'gemini-1.5-flash': {
    ...gemini('gemini-1.5', 1000000, 0.075, 0.3, 72, 90, '2024', '2024'),
    status: 'deprecated',
  },

  // Groq hosted models and systems
  'groq/openai/gpt-oss-120b': openAiCompatible('groq', 'gpt-oss', ['text'], 131072, 65536, 0.15, 0.6, 86, 96, '2025'),
  'groq/openai/gpt-oss-20b': openAiCompatible('groq', 'gpt-oss', ['text'], 131072, 65536, 0.075, 0.3, 78, 100, '2025'),
  'groq/llama-3.3-70b-versatile': openAiCompatible('groq', 'llama-3.3', ['text'], 131072, 32768, 0.59, 0.79, 80, 92, '2024'),
  'groq/llama-3.1-8b-instant': openAiCompatible('groq', 'llama-3.1', ['text'], 131072, 131072, 0.05, 0.08, 68, 98, '2024'),
  'groq/groq/compound': openAiCompatible('groq', 'compound', ['text'], 131072, 8192, 0, 0, 82, 94, '2026', 'stable', 'Groq Compound is a hosted agentic system with built-in tools; pricing is not token-metered in the model table.'),
  'groq/groq/compound-mini': openAiCompatible('groq', 'compound', ['text'], 131072, 8192, 0, 0, 76, 96, '2026', 'stable', 'Groq Compound Mini is a hosted agentic system with built-in tools; pricing is not token-metered in the model table.'),
  'groq/meta-llama/llama-4-scout-17b-16e-instruct': openAiCompatible('groq', 'llama-4', ['text', 'vision'], 131072, 8192, 0.11, 0.34, 78, 97, '2026', 'preview'),
  'groq/qwen/qwen3-32b': openAiCompatible('groq', 'qwen3', ['text'], 131072, 40960, 0.29, 0.59, 76, 90, '2026', 'preview'),
  'groq/openai/gpt-oss-safeguard-20b': openAiCompatible('groq', 'safety', ['text'], 131072, 65536, 0.075, 0.3, 70, 100, '2025', 'preview'),
  'groq/meta-llama/llama-prompt-guard-2-22m': openAiCompatible('groq', 'prompt-guard', ['text'], 512, 512, 0.03, 0.03, 55, 100, '2026', 'preview'),
  'groq/meta-llama/llama-prompt-guard-2-86m': openAiCompatible('groq', 'prompt-guard', ['text'], 512, 512, 0.04, 0.04, 58, 100, '2026', 'preview'),

  // Mistral AI
  'mistral/mistral-medium-3-5': openAiCompatible('mistral', 'mistral-medium-3.5', ['text', 'vision', 'pdf'], 256000, 8192, 1.5, 7.5, 90, 78, '2026-04'),
  'mistral/mistral-small-2603': openAiCompatible('mistral', 'mistral-small-4', ['text', 'vision'], 256000, 8192, 0.2, 0.6, 82, 92, '2026-03', 'stable', 'Pricing varies by deployment; override costs in models.registry if needed.'),
  'mistral/mistral-large-2512': openAiCompatible('mistral', 'mistral-large-3', ['text', 'vision'], 256000, 8192, 2, 6, 88, 76, '2025-12', 'stable', 'Pricing varies by deployment; override costs in models.registry if needed.'),
  'mistral/devstral-2512': openAiCompatible('mistral', 'devstral-2', ['text'], 256000, 8192, 0.4, 2, 86, 84, '2025-12', 'stable', 'Code-agent model.'),
  'mistral/codestral-2508': openAiCompatible('mistral', 'codestral', ['text'], 256000, 8192, 0.3, 0.9, 84, 86, '2025-08', 'stable', 'Code model. Pricing varies by deployment; override costs in models.registry if needed.'),
  'mistral/magistral-medium-2509': openAiCompatible('mistral', 'magistral-medium-1.2', ['text', 'vision'], 128000, 8192, 2, 5, 88, 70, '2025-09', 'stable', 'Reasoning model. Pricing varies by deployment; override costs in models.registry if needed.'),
  'mistral/mistral-moderation-2603': openAiCompatible('mistral', 'moderation', ['text'], 128000, 4096, 0, 0, 70, 92, '2026-03', 'stable', 'Moderation model, not intended for normal chat completions.'),

  // DeepSeek
  'deepseek/deepseek-chat': openAiCompatible('deepseek', 'deepseek-chat', ['text'], 64000, 8192, 0, 0, 82, 84, 'stable', 'stable', 'Pricing and limits vary by DeepSeek account; override costs in models.registry for exact estimates.'),
  'deepseek/deepseek-reasoner': {
    ...openAiCompatible('deepseek', 'deepseek-reasoner', ['text'], 64000, 8192, 0, 0, 86, 70, 'stable', 'stable', 'Reasoning model. Override costs in models.registry for exact estimates.'),
    reasoning: true,
  },

  // Local OpenAI-compatible servers
  'lmstudio/local-model': openAiCompatible('lmstudio', 'local', ['text'], 8192, 4096, 0, 0, 65, 75, 'local', 'stable', 'Placeholder for LM Studio. Use an explicit lmstudio/<loaded-model> name for direct routing.'),
  'llamacpp/local-model': openAiCompatible('llamacpp', 'local', ['text'], 8192, 4096, 0, 0, 65, 75, 'local', 'stable', 'Placeholder for llama.cpp OpenAI-compatible server. Use an explicit llamacpp/<loaded-model> name for direct routing.'),

  // Cohere
  'cohere/command-a-03-2025': cohere('command-a', ['text'], 256000, 8000, 86, 80, '2025-03'),
  'cohere/command-a-reasoning-08-2025': cohere('command-a-reasoning', ['text'], 256000, 32000, 88, 68, '2025-08'),
  'cohere/command-a-vision-07-2025': cohere('command-a-vision', ['text', 'vision'], 128000, 8000, 84, 78, '2025-07'),
  'cohere/command-a-translate-08-2025': cohere('command-a-translate', ['text'], 8000, 8000, 84, 82, '2025-08'),
  'cohere/command-r7b-12-2024': cohere('command-r7b', ['text'], 128000, 4000, 74, 94, '2024-12'),
  'cohere/c4ai-aya-expanse-32b': cohere('aya-expanse', ['text'], 128000, 4000, 76, 84, '2024'),
  'cohere/c4ai-aya-vision-32b': cohere('aya-vision', ['text', 'vision'], 16000, 4000, 78, 78, '2024'),
  'cohere/tiny-aya-global': cohere('tiny-aya', ['text'], 8000, 8000, 62, 98, '2026'),
};

export const MODEL_ALIASES: Record<string, string> = {
  'openai/best': 'gpt-5.5',
  'openai/pro': 'gpt-5.5-pro',
  'openai/balanced': 'gpt-5.4',
  'openai/fast': 'gpt-5.4-mini',
  'openai/cheap': 'gpt-5.4-nano',
  'openai/coding': 'gpt-5.5',
  'openai/codex': 'gpt-5-codex',
  'anthropic/best': 'claude-opus-4-7',
  'anthropic/balanced': 'claude-sonnet-4-6',
  'anthropic/fast': 'claude-haiku-4-5-20251001',
  'google/best': 'gemini-3.1-pro-preview',
  'google/balanced': 'gemini-2.5-pro',
  'google/fast': 'gemini-3-flash-preview',
  'google/cheap': 'gemini-2.5-flash-lite',
  'groq/best': 'groq/openai/gpt-oss-120b',
  'groq/fast': 'groq/openai/gpt-oss-20b',
  'groq/cheap': 'groq/llama-3.1-8b-instant',
  'groq/compound': 'groq/groq/compound',
  'mistral/best': 'mistral/mistral-medium-3-5',
  'mistral/balanced': 'mistral/mistral-large-2512',
  'mistral/fast': 'mistral/mistral-small-2603',
  'mistral/coding': 'mistral/devstral-2512',
  'mistral/mistral-small-4': 'mistral/mistral-small-2603',
  'mistral/mistral-large-3': 'mistral/mistral-large-2512',
  'mistral/devstral-2': 'mistral/devstral-2512',
  'deepseek/best': 'deepseek/deepseek-reasoner',
  'deepseek/balanced': 'deepseek/deepseek-chat',
  'deepseek/fast': 'deepseek/deepseek-chat',
  'cohere/best': 'cohere/command-a-03-2025',
  'cohere/reasoning': 'cohere/command-a-reasoning-08-2025',
  'cohere/vision': 'cohere/command-a-vision-07-2025',
  'cohere/fast': 'cohere/command-r7b-12-2024',
  'claude-opus-4.7': 'claude-opus-4-7',
  'claude-opus-4-7-latest': 'claude-opus-4-7',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-opus-4-6-latest': 'claude-opus-4-6',
  'claude-opus-4.5': 'claude-opus-4-5-20251101',
  'claude-opus-4-5': 'claude-opus-4-5-20251101',
  'claude-opus-4-5-latest': 'claude-opus-4-5-20251101',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6-latest': 'claude-sonnet-4-6',
  'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-latest': 'claude-haiku-4-5-20251001',
  'claude-opus-4.1': 'claude-opus-4-1-20250805',
  'claude-opus-4-1': 'claude-opus-4-1-20250805',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-opus-4-0': 'claude-opus-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-sonnet-4-0': 'claude-sonnet-4-20250514',
  'claude-sonnet-3.7': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet-latest': 'claude-3-7-sonnet-20250219',
  'claude-sonnet-3.5': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
  'claude-haiku-3.5': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest': 'claude-3-5-haiku-20241022',
  'gemini-pro-latest': 'gemini-3.1-pro-preview',
  'gemini-flash-latest': 'gemini-3-flash-preview',
  'gemini-flash-lite-latest': 'gemini-3.1-flash-lite-preview',
};

export function resolveProvider(model: string): string | null {
  if (
    model.startsWith('gpt-')
    || model.startsWith('o1')
    || model.startsWith('o3')
    || model.startsWith('o4')
  ) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.includes('/')) {
    const prefix = model.split('/')[0];
    if (prefix === 'azure') return 'azure-openai';
    if (prefix === 'llama.cpp') return 'llamacpp';
    if (['ollama', 'google', 'groq', 'lmstudio', 'llamacpp', 'azure-openai', 'openrouter', 'together', 'deepseek', 'mistral', 'cohere'].includes(prefix)) return prefix;
  }
  return null;
}
