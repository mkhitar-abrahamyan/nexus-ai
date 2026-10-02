import {
  NexusAI,
  OperationDeniedError,
  createNexus,
  createNexusConfig,
  defineNexusConfig,
  tool,
  toolOutput,
  type CompletionRequest,
  type NexusAIConfig,
  type OperationOutcome,
} from 'nexus-ai-pro';
import { budgetLedger } from 'nexus-ai-pro/lifecycle';
import { listKnownModels } from 'nexus-ai-pro/models';

// The root holds the client, its config builders, its types, its errors, and its lifecycle.
const config: NexusAIConfig = defineNexusConfig({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY || 'dev-key' },
  },
  routing: { mode: 'direct' },
  defaultModel: 'gpt-5.4-mini',
  security: 'off',
  lifecycle: {
    authorize: (operation) => operation.userId !== 'blocked-user',
    budget: budgetLedger({ limit: 25, period: 'day' }),
    hooks: {
      onFinish: (operation, outcome: OperationOutcome) => {
        console.log(`${operation.family}.${operation.operation}: ${outcome.status}`);
      },
    },
  },
});

const request: CompletionRequest = {
  model: 'auto',
  messages: [{ role: 'user', content: 'hello' }],
};

const ai = createNexus(config);
const builderAi = createNexusConfig().openai('dev-key').direct('gpt-5.4-mini').create();
const clock = tool({
  name: 'clock',
  description: 'Return a placeholder time, with the reading as text.',
  parameters: { type: 'object', properties: {} },
  execute: async () => toolOutput('It is noon.'),
});

void NexusAI;
void OperationDeniedError;
void request;
void builderAi;
void clock;
void ai.lifecycle;
console.log(listKnownModels().slice(0, 3));
