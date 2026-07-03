import {
  NexusAI,
  createNexus,
  createNexusConfig,
  defineNexusConfig,
  OpenAIProvider,
  DeepSeekProvider,
  LMStudioProvider,
  TokenOptimizer,
  SecurityPipeline,
  EvalRunner,
  tool,
  listKnownModels,
  type CompletionRequest,
  type NexusAIConfig,
} from 'nexus-ai-pro';

const config: NexusAIConfig = defineNexusConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY || 'dev-key' },
  },
  routing: { mode: 'direct' },
  defaultModel: 'gpt-5.4-mini',
  security: 'off',
});

const request: CompletionRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hello' }],
};

const ai = createNexus(config);
const builderAi = createNexusConfig().openai('dev-key').direct('gpt-5.4-mini').create();
const optimizer = new TokenOptimizer();
const security = new SecurityPipeline('standard');
const evals = new EvalRunner(ai);
const clock = tool({
  name: 'clock',
  description: 'Return a placeholder time.',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ now: 'demo' }),
});

void NexusAI;
void OpenAIProvider;
void DeepSeekProvider;
void LMStudioProvider;
void request;
void builderAi;
void optimizer;
void security;
void evals;
void clock;
console.log(listKnownModels().slice(0, 3));
